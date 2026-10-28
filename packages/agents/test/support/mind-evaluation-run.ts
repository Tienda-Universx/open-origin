import {
  beings,
  type Command,
  digest,
  encodeSnapshot,
  readView,
  type StepResult,
} from "@open-origin/engine";
import {
  chunksById,
  LedgerOracle,
  MindInvariants,
} from "../../../engine/test/support/beings2-fuzz.ts";
import { type TickRecord, tickRecord } from "../../../engine/test/support/determinism-records.ts";
import { mindController } from "../../src/index.ts";
import { runScenario } from "./metrics.ts";
import {
  EVALUABLE,
  type EvaluationInput,
  type EvaluationOutput,
  type KeptRun,
  type MindRecord,
  type Problems,
  VARIANTS,
} from "./mind-evaluation.ts";
import { LedgerItems } from "./mind-ledger.ts";
import { diverse, MindObserver, type MindRun } from "./mind-metrics.ts";
import { type Scenario2, type SpawnPayload2, scenario2From } from "./mind-scenario.ts";
import { amnesicLife, SoakObserver } from "./mind-soak.ts";
import { SCENARIO_SPS, terrainOf } from "./scenario.ts";

/**
 * The run of an evaluation (mind-evaluation.ts), in the process that calls it: the child process
 * runs it for the tests and the soak, and the tests of the harness run short ones in process. The
 * invariants of the minds and the ledger oracle check every tick that changed a chunk or emitted
 * an event, and in it every being of the chunks it wrote: a being of a chunk no step wrote holds
 * the record it held at its last check, every message, delivery, and change of its mind writes its
 * chunk, so its checks would repeat, and a tick that wrote nothing leaves every mind as it was.
 */

/** Why `input` is no run an evaluation may make; empty when it is one. */
export function evaluationProblems(input: EvaluationInput): string[] {
  const variant = input.variant ?? "mind@1";
  const problems: string[] = [];
  if (!EVALUABLE.includes(input.label))
    problems.push(`${input.label} is not a label an evaluation may run: ${EVALUABLE.join(", ")}`);
  if (!(VARIANTS as readonly string[]).includes(variant))
    problems.push(`${variant} is not a brain an evaluation may run: ${VARIANTS.join(", ")}`);
  if (!Number.isSafeInteger(input.ticks) || input.ticks < 1)
    problems.push(`${input.ticks} is not a positive number of ticks`);
  if (variant === "amnesic" && input.falseClaim === true)
    problems.push("the false claim runs under mind@1 only");
  return problems;
}

/**
 * The chunks of a world as the read view copies them, read again only where a step wrote: a chunk
 * no step wrote holds what it held, so its copy stands. Reading every chunk at every tick that
 * changed the world would cost more than the run itself.
 */
class ChunkMirror {
  readonly #world: Scenario2["world"];
  #chunks: Map<string, beings.BeingsChunk>;
  #beings: Map<number, beings.Being2> | undefined;
  #written = new Map<number, beings.Being2>();

  constructor(world: Scenario2["world"]) {
    this.#world = world;
    this.#chunks = chunksById(world);
  }

  /** The chunks as they stand. */
  get chunks(): ReadonlyMap<string, beings.BeingsChunk> {
    return this.#chunks;
  }

  /** Every being of the world, by id, as it stands. */
  get beings(): ReadonlyMap<number, beings.Being2> {
    if (this.#beings !== undefined) return this.#beings;
    const found = new Map<number, beings.Being2>();
    for (const chunk of this.#chunks.values())
      for (const being of chunk.beings) found.set(being.id, being as beings.Being2);
    this.#beings = found;
    return found;
  }

  /** The beings of the chunks the last step wrote, by id: the only records it may have changed. */
  get written(): ReadonlyMap<number, beings.Being2> {
    return this.#written;
  }

  /** Reads again the chunks `keys`, which a step wrote; the chunks before stay as they were. */
  update(keys: readonly string[]): void {
    this.#written = new Map();
    if (keys.length === 0) return;
    const view = readView(this.#world);
    const chunks = new Map(this.#chunks);
    for (const key of keys) {
      const chunk = view.readChunk(key);
      if (chunk === undefined) chunks.delete(key);
      else chunks.set(key, chunk as beings.BeingsChunk);
      for (const being of chunk?.beings ?? []) this.#written.set(being.id, being as beings.Being2);
    }
    this.#chunks = chunks;
    this.#beings = undefined;
  }
}

/** The first problems of a kind, and how many there were. */
const problemsOf = (list: readonly string[]): Problems => ({
  count: list.length,
  first: list.slice(0, 5),
});

/** One run of the evaluation, with every observer it reads the world with. */
class EvaluationRun {
  readonly input: EvaluationInput;
  readonly scenario: Scenario2;
  readonly soak: SoakObserver | undefined;
  readonly observer = new MindObserver();
  readonly ledger: LedgerItems;
  readonly invariants: MindInvariants;
  readonly oracle = new LedgerOracle();
  readonly found = { rules: [] as string[], oracle: [] as string[], invariants: [] as string[] };
  readonly checksums: string[] = [];
  readonly records: TickRecord[] = [];
  checkedTicks = 0;
  /** The commands of the tick being stepped, which the invariants read: the spawns at tick 1. */
  commands: readonly Command[];
  readonly mirror: ChunkMirror;
  snapshot: string | undefined;
  final: string | undefined;

  constructor(input: EvaluationInput) {
    this.input = input;
    const life = input.variant === "amnesic" ? amnesicLife() : beings.defaultLife2();
    const terrain = terrainOf(input.label);
    const species = life.species[0] as beings.Species2;
    const ground = { prepared: terrain.prepared, species, sps: SCENARIO_SPS };
    const measured = input.soak === true || input.falseClaim === true;
    const soak = measured ? new SoakObserver(ground, input.falseClaim === true) : undefined;
    this.soak = soak;
    this.ledger = new LedgerItems((being, tick, p) => soak?.told(being, tick, p));
    this.scenario = scenario2From(terrain, {
      life,
      controller: (laws, dayLength) => {
        const brain = mindController({ species: laws, dayLength });
        const inner = soak === undefined ? brain : soak.controller(brain);
        return this.observer.controller(this.ledger.controller(inner));
      },
    });
    const { world } = this.scenario;
    const laws = readView(world).readGlobal().life as beings.LifeConfig2;
    this.invariants = new MindInvariants(laws, {
      prepared: terrain.prepared,
      simSecondsPerTick: SCENARIO_SPS,
    });
    this.observer.start(world, this.ids);
    this.commands = this.scenario.spawns;
    this.mirror = new ChunkMirror(world);
  }

  /** The ids of the scenario's beings, from 1 in spawn order. */
  get ids(): number[] {
    return this.scenario.payloads.map((_, index) => index + 1);
  }

  /** The commands of `tick` after the first: the false claim, when the run makes it. */
  commandsAt(tick: number): readonly Command[] {
    this.commands = this.soak?.commandsAt(this.scenario.world, tick) ?? [];
    return this.commands;
  }

  /** The beings and chunks before the last step, kept when the mirror read what it wrote. */
  before:
    | {
        readonly tick: number;
        readonly beings: ReadonlyMap<number, beings.Being2>;
        readonly chunks: ReadonlyMap<string, beings.BeingsChunk>;
      }
    | undefined;

  /** Reads into the mirror, once, what the step `result` wrote: the runner and onStep share it. */
  sync(result: StepResult): ReadonlyMap<number, beings.Being2> {
    if (this.before?.tick !== result.tick) {
      this.before = { tick: result.tick, beings: this.mirror.beings, chunks: this.mirror.chunks };
      this.mirror.update(result.changedChunks);
    }
    return this.mirror.beings;
  }

  /** Reads what one step did. */
  onStep(result: StepResult): void {
    const { world } = this.scenario;
    this.checksums.push(result.checksum);
    this.sync(result);
    const before = this.before as NonNullable<typeof this.before>;
    const after = () => this.mirror.beings;
    this.observer.observe(result, after);
    this.ledger.observe(result, after);
    this.soak?.observe(world, result);
    if (result.changedChunks.length > 0 || result.events.length > 0) this.check(result, before);
    this.keep(result);
  }

  /** Checks the invariants and the oracle after a tick that changed the world. */
  check(
    result: StepResult,
    before: {
      readonly beings: ReadonlyMap<number, beings.Being2>;
      readonly chunks: ReadonlyMap<string, beings.BeingsChunk>;
    },
  ): void {
    this.checkedTicks += 1;
    const after = this.mirror.written;
    const { tick, events } = result;
    const record = {
      tick,
      before: before.beings,
      after,
      chunks: before.chunks,
      commands: this.commands,
      events,
    };
    this.found.invariants.push(...this.invariants.check(record));
    this.found.oracle.push(...this.oracle.read(events), ...this.oracle.compare(after, tick));
  }

  /** Keeps the snapshot after `keep.at`, the records after it, and the final snapshot. */
  keep(result: StepResult): void {
    const { keep } = this.input;
    if (keep === undefined) return;
    const { world } = this.scenario;
    if (result.tick === keep.at) this.snapshot = encodeSnapshot(world);
    if (result.tick <= keep.at || result.tick > keep.at + keep.ticks) return;
    this.records.push(tickRecord(result));
    if (result.tick === keep.at + keep.ticks) this.final = encodeSnapshot(world);
  }

  /** The minds of the run, by being: the ledger's items and the observer's tallies. */
  minds(observed: MindRun): MindRecord[] {
    const tallies = this.ledger.finish(this.ids);
    return this.ids.map((id, index) => {
      const tally = observed.tallies.get(id);
      if (tally === undefined) throw new Error(`the observer has no tally of being ${id}`);
      return {
        ledger: tallies[index] as (typeof tallies)[number],
        proposed: [
          tally.foodEpisodes,
          tally.beingEpisodes,
          tally.seenBeliefs,
          tally.toldBeliefs,
          tally.revisedDown,
          tally.trustChecks,
        ],
        greeted: tally.greeted,
        wasGreeted: tally.wasGreeted,
        acts: tally.acts,
        seeks: tally.seeks,
        relationsAtEnd: tally.relationsAtEnd,
        beliefsAtEnd: tally.beliefsAtEnd.length,
        credulity: (this.scenario.payloads[index] as SpawnPayload2).traits.credulity,
      };
    });
  }

  /** What the run kept for a resume, when it kept it all. */
  kept(): KeptRun | undefined {
    const { snapshot, final, records } = this;
    return snapshot === undefined || final === undefined ? undefined : { snapshot, records, final };
  }

  /** Runs the scenario to its last tick and returns what it found. */
  run(): EvaluationOutput {
    const { input, scenario } = this;
    const commandsAt = (tick: number) => this.commandsAt(tick);
    const beingsAfter = (result: StepResult) => this.sync(result);
    const record = runScenario(
      { ...scenario, commandsAt, beingsAfter },
      input.ticks,
      { decisions: () => this.observer.run.decisions },
      (result) => this.onStep(result),
    );
    const observed = this.observer.finish(input.ticks);
    this.found.rules.push(...observed.ruleProblems);
    const kept = this.kept();
    return {
      label: input.label,
      variant: input.variant ?? "mind@1",
      ticks: input.ticks,
      record,
      minds: this.minds(observed),
      conversations: observed.conversations,
      diverse: diverse(observed),
      integrity: {
        priorSuspect: this.ledger.priorSuspect,
        rules: problemsOf(this.found.rules),
        oracle: problemsOf(this.found.oracle),
        invariants: problemsOf(this.found.invariants),
        checkedTicks: this.checkedTicks,
      },
      seen: { ...this.invariants.seen },
      trail: digest(this.checksums),
      ...(kept === undefined ? {} : { kept }),
      ...(this.soak === undefined ? {} : { soak: this.soak.finish() }),
    };
  }
}

/**
 * The run of `input`: the T5 scenario of its label with every observer of the evaluation, audit
 * off. Throws, naming every problem, for an input that is no run an evaluation may make.
 */
export function evaluate(input: EvaluationInput): EvaluationOutput {
  const problems = evaluationProblems(input);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return new EvaluationRun(input).run();
}
