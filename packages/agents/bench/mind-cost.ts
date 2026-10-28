/**
 * The cost of `mind@1` (docs/architecture/mind.md, "Cost"; plan §10.3 and §10.4): manual, never
 * run by `bun test`, because it measures wall-clock time. It runs the named scenarios of T4's
 * benchmark (scale.ts), on the same terrain and the same cells, under beings@2 with `mind@1` and
 * the frozen default laws of life@2, audit off, and prints Markdown tables of indicative numbers.
 *
 *   bun packages/agents/bench/mind-cost.ts [dispersed concentrated sleeping speech] [--ticks N]
 *
 * The words name the groups, all four by default:
 *
 * - `dispersed`: 10, 100, and 1,000 beings, one to a chunk, timed over one simulated day, with one
 *   decision end to end (T4's method) and the share of the beings' writes that change only the
 *   body, not the mind (the evidence plan §10.4 asks for the entity section of T7);
 * - `concentrated`: 10 beings in 3 × 3 chunks, who see each other, for 500 ticks, with the same;
 * - `sleeping`: ten beings of `mind@1` alone and beside 1,000 sleeping beings, stepped in turn for
 *   1,000 ticks: the marginal cost of a sleeping being;
 * - `speech`: 50 and 500 pairs of beings that greet each other at every decision, for 50 ticks,
 *   within their quota of 64 acts a day: the time per act; and 50 speakers on the cell of one idle
 *   hearer for two days: the hearer's decisions that hearing caused, by day, against
 *   `speech.wakesPerDay`.
 *
 * The speech group runs a scripted talker with quotas wide enough to talk at every decision, since
 * `mind@1` says at most two acts in a talk window: it measures what an act costs the engine, not
 * how often `mind@1` speaks. `--ticks N` times N ticks of every scenario instead of its own number.
 * Any other argument, or one given twice, is an error, and exits with code 2. On a shared machine,
 * run it at low priority: `nice -n 19 bun packages/agents/bench/mind-cost.ts`.
 */
import {
  beings,
  type Command,
  canonicalize,
  createWorld,
  type EngineEvent,
  readView,
  step,
  worldgen,
} from "@open-origin/engine";
import { sleeper } from "../../engine/test/support/beings-cost.ts";
import { BEHAVIORS, CONCEPTS } from "../../engine/test/support/beings2-world.ts";
import { mindController } from "../src/index.ts";
import { labelSeeds } from "../test/support/scenario.ts";
import { decisionCost, median, nsPerWake, quantile } from "./beings.ts";
import { type GateDraw, gateDraws } from "./gate.ts";
import {
  BENCH_LABEL,
  type BenchWorld,
  benchCenter,
  type Cell,
  concentratedCells,
  DAY_TICKS,
  dispersedCells,
  measureRun,
  PREPARED,
  type Run,
  SPS,
  sleepingCells,
  timedStep,
} from "./scale.ts";

const GROUPS = ["dispersed", "concentrated", "sleeping", "speech"] as const;
export type Group = (typeof GROUPS)[number];

/** What the arguments ask for: the groups, and the ticks to time instead of each scenario's own. */
export type Arguments = { readonly groups: readonly Group[]; readonly ticks: number | undefined };

/** The value of `--ticks`, `text`: a positive safe integer; throws otherwise. */
function ticksOf(text: string | undefined): number {
  if (text === undefined || !/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new Error(`--ticks needs a positive integer, not "${text ?? ""}"`);
  return Number(text);
}

/** Reads the arguments; throws an Error that says what is wrong. */
export function parseArguments(argv: readonly string[]): Arguments {
  const groups: Group[] = [];
  let ticks: number | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    if (arg === "--ticks" && ticks === undefined) {
      ticks = ticksOf(argv[at + 1]);
      at += 1;
    } else if ((GROUPS as readonly string[]).includes(arg) && !groups.includes(arg as Group)) {
      groups.push(arg as Group);
    } else {
      throw new Error(
        `unknown or repeated argument "${arg}": give ${GROUPS.join(", ")}, --ticks N`,
      );
    }
  }
  return { groups: groups.length > 0 ? groups : [...GROUPS], ticks };
}

const WARM_UP = 100;
const SEEDS = labelSeeds(BENCH_LABEL);
const ms = (ns: number) => (ns / 1e6).toFixed(3);
const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** The seconds of the benchmark genesis' day, which `mind@1` is built with. */
const DAY_SECONDS = worldgen.genesisOf(PREPARED).laws.day.length;

/**
 * A world of the benchmark at tick 0 under beings@2, audit off: `brain`, `mind@1` by default,
 * timed and counted, for the first species of `life`, the frozen default laws of life@2 unless
 * given, and the brains of `extra` for the others.
 */
export function benchWorld2(options: {
  readonly life?: beings.LifeConfig2;
  readonly brain?: beings.Controller2;
  readonly extra?: { readonly [species: string]: beings.Controller2 };
}): BenchWorld {
  const life = options.life ?? beings.defaultLife2();
  const species = life.species[0] as beings.Species2;
  const inner = options.brain ?? mindController({ species, dayLength: DAY_SECONDS });
  const record = { decisions: 0, times: [] as number[] };
  const controller: beings.Controller2 = {
    ...inner,
    decide: (senses) => {
      const start = Bun.nanoseconds();
      const intention = inner.decide(senses);
      record.times.push(Bun.nanoseconds() - start);
      record.decisions += 1;
      return intention;
    },
  };
  const world = createWorld(
    {
      seed: SEEDS.world,
      simSecondsPerTick: SPS,
      global: beings.beingsGlobal(worldgen.genesisOf(PREPARED), life),
      chunks: {},
      ruleset: beings.createBeingsRuleset({
        controllers: { [species.id]: controller, ...options.extra },
        rules: "beings@2",
      }),
    },
    { audit: false },
  );
  return { world: world as BenchWorld["world"], brain: record };
}

/** Spawns at tick 1 of `species` on `cells`, with the needs and six traits of `draws`. */
export function spawns2Of(
  species: string,
  cells: readonly Cell[],
  draws: readonly GateDraw[],
): Command[] {
  return cells.map((cell, seq) => {
    const draw = draws[seq] as GateDraw;
    return {
      applyTick: 1,
      seq,
      type: "beings.spawn",
      origin: { kind: "admin" },
      payload: { species, cell: [cell[0], cell[1]], needs: draw.needs, traits: draw.traits },
    };
  });
}

/** The draws of the active beings: the needs and traits of T5's order, from the label's seed. */
const activeDraws = (count: number) => gateDraws(count, SEEDS.spawn);

/**
 * What the writes of a run changed: each being whose record a tick changed, and whether its mind
 * changed with it; and the bytes of the body and of the mind of those writes.
 */
export type Writes = { beings: number; bodyOnly: number; bodyBytes: number; mindBytes: number };

/** The canonical text of a being's body (every member but `mind`) and of its mind. */
function parts(being: beings.Being2): { readonly body: string; readonly mind: string } {
  const { mind, ...body } = being;
  return { body: canonicalize(body as never), mind: canonicalize(mind as never) };
}

/**
 * Counts in `writes` the beings of the chunks `keys` of `world` whose record changed since `known`
 * last held them, and whether their mind changed; updates `known`.
 */
export function countWrites(
  world: BenchWorld["world"],
  keys: readonly string[],
  known: Map<number, { readonly body: string; readonly mind: string }>,
  writes: Writes,
): void {
  const view = readView(world);
  const encoder = new TextEncoder();
  for (const key of keys)
    for (const being of view.readChunk(key)?.beings ?? []) {
      const now = parts(being as beings.Being2);
      const was = known.get(being.id);
      known.set(being.id, now);
      if (was === undefined || (was.body === now.body && was.mind === now.mind)) continue;
      writes.beings += 1;
      if (was.mind === now.mind) writes.bodyOnly += 1;
      writes.bodyBytes += encoder.encode(now.body).length;
      writes.mindBytes += encoder.encode(now.mind).length;
    }
}

/** A run of `mind@1` beings on `cells`, timed, and the writes of its timed ticks. */
function mindRun(cells: readonly Cell[], measured: number): { run: Run; writes: Writes } {
  const bench = benchWorld2({});
  const writes: Writes = { beings: 0, bodyOnly: 0, bodyBytes: 0, mindBytes: 0 };
  const known = new Map<number, { readonly body: string; readonly mind: string }>();
  const run = measureRun(bench, spawns2Of("s1", cells, activeDraws(cells.length)), {
    warmUp: WARM_UP,
    measured,
    after: (result) => countWrites(bench.world, result.changedChunks, known, writes),
  });
  return { run, writes };
}

const RUN_HEADER = [
  "| Scenario | Ticks timed | Median ms | p99 ms | µs per wake | Decisions per being and day | KB hashed per tick, median / p99 | `mind@1` median / p99 µs | One decision end to end: ticks decided, not; ms | Writes timed | Body only | Body B / mind B per write |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
];

/** The row of a run. */
function runRow(name: string, { run, writes }: { run: Run; writes: Writes }): string {
  const times = run.samples.map((sample) => sample.ns);
  const hashed = run.samples.map((sample) => sample.hashed);
  const decisions = sum(run.samples.map((sample) => sample.decisions));
  const cost = decisionCost(run);
  const perWrite = (bytes: number) => (writes.beings === 0 ? 0 : bytes / writes.beings).toFixed(0);
  return `| ${[
    name,
    run.samples.length,
    ms(median(times)),
    ms(quantile(times, 0.99)),
    (nsPerWake(run.samples) / 1e3).toFixed(1),
    ((decisions * DAY_TICKS) / (run.samples.length * run.beings)).toFixed(1),
    `${kb(median(hashed))} / ${kb(quantile(hashed, 0.99))}`,
    `${(median(run.decideNs) / 1e3).toFixed(0)} / ${(quantile(run.decideNs, 0.99) / 1e3).toFixed(0)}`,
    `${cost.decided.length}, ${cost.undecided.length}; ${ms(cost.ns)}`,
    writes.beings,
    `${writes.bodyOnly} (${((100 * writes.bodyOnly) / Math.max(1, writes.beings)).toFixed(1)}%)`,
    `${perWrite(writes.bodyBytes)} / ${perWrite(writes.mindBytes)}`,
  ].join(" | ")} |`;
}

/** The dispersed runs, over one simulated day unless `--ticks` says otherwise. */
function dispersed(options: Arguments): void {
  console.log(`\n${RUN_HEADER.join("\n")}`);
  for (const size of [10, 100, 1_000]) {
    const run = mindRun(dispersedCells(size, benchCenter()), options.ticks ?? DAY_TICKS);
    console.log(runRow(`dispersed ${size.toLocaleString("en-US")}`, run));
  }
}

/** Ten beings in 3 × 3 chunks, who see each other, for 500 ticks. */
function concentrated(options: Arguments): void {
  console.log(`\n${RUN_HEADER.join("\n")}`);
  const run = mindRun(concentratedCells(10, 3, benchCenter()), options.ticks ?? 500);
  console.log(runRow("concentrated 10, 3 × 3", run));
}

/** The sleeping species of the sleeping worlds: the sleeper's window of radius 1, and its laws. */
function sleepingLife(): beings.LifeConfig2 {
  const base = beings.defaultLife2();
  const active = base.species[0] as beings.Species2;
  const asleep: beings.Species2 = {
    ...structuredClone(active),
    id: "s2",
    senses: { radius: 1 },
    perception: { ...active.perception, sight: { day: 1, dim: 1 } },
    speech: { ...active.speech, range: 1 },
  };
  return { ...base, species: [active, asleep] };
}

/** The sleeper of T4 as a brain of beings@2: it sleeps to full rest, then idles six hours. */
function sleeper2(): beings.Controller2 {
  const inner = sleeper();
  return {
    brain: inner.brain,
    behaviors: BEHAVIORS,
    concepts: CONCEPTS,
    decide: (senses) => inner.decide(senses),
  };
}

/**
 * Ten beings of `mind@1` alone and beside 1,000 sleeping beings, each in its own chunk, the
 * sleepers spawned at tick 1 with full nutrition and rest 400,000, so that none wakes before tick
 * 1,325; stepped in turn: the marginal cost of a sleeping being is the median, over the timed
 * ticks, of the difference between the two worlds' ticks, divided by 1,000.
 */
function sleeping(options: Arguments): void {
  const active = dispersedCells(10, benchCenter());
  const asleep = sleepingCells(1_000, active, benchCenter());
  const life = sleepingLife();
  const extra = { s2: sleeper2() };
  const draws = activeDraws(10);
  const sleepers = asleep.map((cell, seq) => ({
    applyTick: 1,
    seq: 10 + seq,
    type: "beings.spawn",
    origin: { kind: "admin" } as const,
    payload: {
      species: "s2",
      cell: [cell[0], cell[1]],
      needs: { nutrition: beings.NEED_MAX, rest: 400_000 },
      traits: (draws[0] as GateDraw).traits,
    },
  }));
  const benches = [benchWorld2({ life, extra }), benchWorld2({ life, extra })];
  timedStep((benches[0] as BenchWorld).world, spawns2Of("s1", active, draws));
  timedStep((benches[1] as BenchWorld).world, [...spawns2Of("s1", active, draws), ...sleepers]);
  for (let tick = 2; tick <= 1 + WARM_UP; tick += 1)
    for (const { world } of benches) step(world, []);
  const times: [number[], number[]] = [[], []];
  for (let round = 0; round < (options.ticks ?? 1_000); round += 1)
    benches.forEach(({ world }, index) => {
      times[index as 0 | 1].push(timedStep(world, []).ms * 1e6);
    });
  const [alone, beside] = times;
  const marginal = median(beside.map((ns, tick) => ns - (alone[tick] ?? 0))) / asleep.length;
  console.log(
    "\n| Sleeping beings | Median ms | p99 ms | Marginal ns per sleeping being and tick |",
  );
  console.log("|---|---|---|---|");
  console.log(`| 0 | ${ms(median(alone))} | ${ms(quantile(alone, 0.99))} | - |`);
  console.log(
    `| ${asleep.length.toLocaleString("en-US")} | ${ms(median(beside))} | ${ms(quantile(beside, 0.99))} | ${marginal.toFixed(1)} |`,
  );
}

/** Quotas wide enough that a talker may speak at every decision: the speech group's laws. */
function talkingLife(radius: number): beings.LifeConfig2 {
  const base = beings.defaultLife2();
  const species = base.species[0] as beings.Species2;
  const sight = Math.min(radius, species.perception.sight.day);
  return {
    ...base,
    species: [
      {
        ...species,
        senses: { radius },
        perception: { ...species.perception, sight: { day: sight, dim: Math.min(sight, 3) } },
        speech: { ...species.speech, perDay: 64, wakesPerDay: 8, turns: 8, cooldown: 1 },
      },
    ],
  };
}

/** The Chebyshev distance between two cells. */
const chebyshev = (a: readonly number[], b: readonly number[]) =>
  Math.max(
    Math.abs((a[0] as number) - (b[0] as number)),
    Math.abs((a[1] as number) - (b[1] as number)),
  );

/**
 * A scripted talker: it greets the nearest being it perceives within `speech.range` that is
 * awake, `to` when given, and otherwise idles for `idleMs`.
 */
function talker(idleMs: number, to?: number): beings.Controller2 {
  return {
    brain: "talker@1",
    behaviors: BEHAVIORS,
    concepts: CONCEPTS,
    decide: (senses) => {
      const near = senses.perceived.beings.find(
        (being) =>
          (to === undefined || being.id === to) &&
          being.activity !== "sleep" &&
          chebyshev(being.cell, senses.self.cell) <= 3,
      );
      const behavior = { kind: near === undefined ? "rest" : "x", since: 0, heading: 0 };
      if (near === undefined)
        return { steps: [{ kind: "idle", ms: idleMs }], wakeWhen: {}, behavior };
      return { steps: [{ kind: "talk", to: near.id, act: "greet" }], wakeWhen: {}, behavior };
    },
  };
}

/** Steps `bench` `ticks` times after its spawns: the time of the steps, and the acts uttered. */
function talkRun(bench: BenchWorld, spawns: readonly Command[], ticks: number) {
  timedStep(bench.world, spawns);
  let ns = 0;
  let acts = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    const { result, ms: took } = timedStep(bench.world, []);
    ns += took * 1e6;
    acts += result.events.filter((event) => event.type === "speech.uttered").length;
  }
  return { ns, acts };
}

/**
 * The speech group: pairs of talkers, both of a pair on the best cell of its own chunk, chunks two
 * apart, at 50 and at 500 pairs; and 50 talkers around one idle hearer, whose decisions caused by
 * hearing are counted by day.
 */
function speech(options: Arguments): void {
  console.log("\n| Pairs | Ticks | Acts | ms per tick | µs per act |");
  console.log("|---|---|---|---|---|");
  for (const pairs of [50, 500]) {
    const cells = dispersedCells(pairs, benchCenter()).flatMap((cell) => [cell, cell]);
    const bench = benchWorld2({ life: talkingLife(4), brain: talker(60_000) });
    const ticks = options.ticks ?? 50;
    const { ns, acts } = talkRun(bench, spawns2Of("s1", cells, activeDraws(cells.length)), ticks);
    console.log(
      `| ${pairs} | ${ticks} | ${acts} | ${ms(ns / ticks)} | ${(acts === 0 ? 0 : ns / acts / 1e3).toFixed(1)} |`,
    );
  }
  hearer(options);
}

/** Counts the acts delivered to being 1 in `events`, and its decisions that hearing caused, by day. */
function countHeard(
  events: readonly EngineEvent[],
  tick: number,
  heard: Map<string, number>,
): void {
  for (const { type, payload } of events) {
    const event = payload as { id: number; to?: number; reason?: string };
    if (type === "speech.delivered" && event.to === 1)
      heard.set("delivered", (heard.get("delivered") ?? 0) + 1);
    if (type !== "being.finished" || event.id !== 1 || event.reason !== "heard") continue;
    // A wake by hearing at t + 1 counts in the day of the delivery at t.
    const day = `day ${Math.floor(((tick - 1) * SPS) / DAY_SECONDS)}`;
    heard.set(day, (heard.get(day) ?? 0) + 1);
  }
}

/**
 * 50 talkers on the cell of one hearer, being 1, which idles six hours at every decision, for two
 * days: the acts delivered to it, and its decisions that hearing caused, by day.
 */
function hearer(options: Arguments): void {
  const [center] = dispersedCells(1, benchCenter()) as [Cell];
  const cells: Cell[] = Array.from({ length: 51 }, () => center);
  const life = talkingLife(4);
  const talk = talker(60_000, 1);
  const idle = talker(21_600_000, 0);
  const brain: beings.Controller2 = {
    ...talk,
    decide: (senses) => (senses.self.id === 1 ? idle : talk).decide(senses),
  };
  const bench = benchWorld2({ life, brain });
  step(bench.world, spawns2Of("s1", cells, activeDraws(cells.length)));
  const heard = new Map<string, number>();
  const ticks = options.ticks ?? 2 * DAY_TICKS;
  for (let tick = 2; tick <= ticks + 1; tick += 1)
    countHeard(step(bench.world, []).events, tick, heard);
  const { wakesPerDay } = (life.species[0] as beings.Species2).speech;
  console.log(
    `\n50 talkers around one hearer, ${ticks} ticks: ${[...heard].map(([what, count]) => `${what} ${count}`).join(", ")} (speech.wakesPerDay ${wakesPerDay})`,
  );
}

if (import.meta.main) {
  let options: Arguments;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`mind-cost: ${(error as Error).message}`);
    process.exit(2);
  }
  console.log(
    `Bun ${Bun.version}; terrain of ${BENCH_LABEL}; beings@2, mind@1, the frozen laws of life@2 (seal ${beings.lifeSeal2(beings.defaultLife2())})`,
  );
  const run = { dispersed, concentrated, sleeping, speech };
  for (const group of options.groups) run[group](options);
  console.log(`\npeak resident memory: ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
}
