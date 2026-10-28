import { utf8Length } from "../../src/canonical/utf8.ts";
import { IssueList } from "../../src/errors.ts";
import {
  beings,
  type Command,
  canonicalize,
  type EngineEvent,
  mind,
  readView,
  worldgen,
} from "../../src/index.ts";
import { type BeingsWorld, baseFood, behavior, windowAt } from "./beings-world.ts";
import { bandOf, standable } from "./beings2-mind.ts";
import { BEHAVIORS, brain2, type Senses2, SPECIES2 } from "./beings2-world.ts";
import { Sfc32 } from "./sfc32.ts";

/**
 * The fuzz of the minds of beings@2 with the ledger oracle (ADR 0024, docs/architecture/mind.md
 * "Verification plan"): a chaotic brain that proposes valid and invalid mental operations, the
 * invariants a mind must hold after every tick, checked against the state of the tick before and
 * the commands and events of the tick, and an oracle that rebuilds the taints, the citations, and
 * the exposure of every live record from the events of the ledger alone. Every helper here reads
 * the world through readView, which copies, and keeps its own records apart from the state.
 */

type Cell = readonly [number, number];
type Being2 = beings.Being2;
type Mind = mind.Mind;

/** The largest mind's byte budget, with the largest values (mind.md, "Cost"). */
export const MIND_BYTES = 6000;

/** The kinds of activity of beings@2, whose index a `being` episode holds. */
const ACTIVITIES = ["eat", "idle", "sleep", "walk"] as const;

/** The window's radius around a being. */
const RADIUS = (windowAt([0, 0]).side - 1) / 2;

/** The Chebyshev distance between two cells. */
const distance = (a: Cell, b: Cell) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** Whether `whole` holds every bit of `part`. */
const covers = (whole: number, part: number) => (whole | part) === whole;

// The chaotic brain.

/** The direction of DIRECTIONS that steps from `from` toward `to`, or a random one there. */
function toward(from: Cell, to: Cell, random: Sfc32): number {
  const dx = Math.sign(to[0] - from[0]);
  const dy = Math.sign(to[1] - from[1]);
  const index = beings.DIRECTIONS.findIndex(([x, y]) => x === dx && y === dy);
  return index < 0 ? random.below(8) : index;
}

/** The steps of a chaotic decision: a step that drifts toward `home`, an idle, or a meal. */
function stepsOf(senses: Senses2, random: Sfc32, home: Cell): beings.PlanStep[] {
  const roll = random.below(10);
  if (roll < 5) {
    const [x = 0, y = 0] = senses.self.cell;
    const d = random.below(3) === 0 ? random.below(8) : toward([x, y], home, random);
    return [{ kind: "walk", dirs: String(d).repeat(1 + random.below(2)) }];
  }
  if (roll < 8) return [{ kind: "idle", ms: 1 + random.below(36_000) }];
  return [{ kind: "eat", untilNutrition: beings.NEED_MAX }];
}

/** A local id the brain may cite: one of `ids`, the predicted `next` ones, or a bogus one. */
function anyId(ids: readonly number[], next: number, random: Sfc32): number {
  const roll = random.below(10);
  if (roll === 0) return 1 + random.below(next + 4);
  if (roll < 3 || ids.length === 0) return next + random.below(3);
  return ids[random.below(ids.length)] as number;
}

/** One to three citations, sometimes none, from `ids`. */
function citations(ids: readonly number[], next: number, random: Sfc32, min = 0): number[] {
  const count = min + random.below(4 - min);
  return Array.from({ length: count }, () => anyId(ids, next, random));
}

/** A percept of the decision, valid most of the time. */
function perceptOf(senses: Senses2, random: Sfc32): unknown {
  const { beings: seen, heard } = senses.perceived;
  const [x = 0, y = 0] = senses.self.cell;
  switch (random.below(5)) {
    case 0:
      return { being: random.below(seen.length + 1) };
    case 1:
      return { heard: random.below(heard.length + 1) };
    case 2:
      return { outcome: true };
    default:
      return { food: [x + random.below(5) - 2, y + random.below(5) - 2] };
  }
}

/** A random operation of a random kind. */
function anyOperation(senses: Senses2, random: Sfc32): [string, unknown] {
  const view = senses.mind;
  const ids = [...view.episodes, ...view.beliefs, ...view.relations].map(({ id }) => id);
  const beliefIds = view.beliefs.map(({ id }) => id);
  const next = view.next;
  const p = { p: `t1.c${random.below(4)}`, a: [{ n: random.below(4) }], v: random.below(3) };
  const whos = [...view.relations.map(({ who }) => who), 99_999];
  switch (random.below(6)) {
    case 0:
      return ["remember", { percept: perceptOf(senses, random), w: random.below(1001) }];
    case 1:
      return ["recall", anyId(ids, next, random)];
    case 2:
      return [
        "believe",
        { p, cr: random.below(1001), ev: citations(ids, next, random), rule: "c" },
      ];
    case 3:
      return [
        "revise",
        {
          id: anyId(beliefIds, next, random),
          cr: random.below(1001),
          ev: citations(ids, next, random, 1),
        },
      ];
    case 4:
      return ["drop", anyId(beliefIds, next, random)];
    default:
      return [
        "relate",
        {
          who: whos[random.below(whos.length)],
          aff: random.below(501) - 250,
          because: citations(ids, next, random, 1),
        },
      ];
  }
}

/** The mental operations of a decision, built kind by kind, with the ids its new records take. */
class Operations {
  readonly #next: number;
  readonly #kinds: Record<string, unknown[]> = {};

  constructor(next: number) {
    this.#next = next;
  }

  /** Adds `op` to the operations of `kind`. */
  add(kind: string, op: unknown): void {
    this.#kinds[kind] = [...(this.#kinds[kind] ?? []), op];
  }

  /** Adds a `remember` of `percept`; returns the id its episode takes, since remembers come first. */
  keep(percept: unknown, w: number): number {
    this.add("remember", { percept, w });
    return this.#next + (this.#kinds.remember?.length ?? 0) - 1;
  }

  get mind(): beings.MindIntention {
    return this.#kinds as beings.MindIntention;
  }
}

/**
 * Relates, half the time, a perceived being, citing the episode it remembers of it and what
 * `alsoOf` adds, which may carry taints into the relationship; a quarter of those times, it
 * relates the same being again in the decision. Returns the being it related.
 */
function relateSeen(ops: Operations, senses: Senses2, random: Sfc32): number | undefined {
  const seen = senses.perceived.beings;
  if (seen.length === 0 || random.below(2) === 0) return undefined;
  const index = random.below(seen.length);
  const id = ops.keep({ being: index }, random.below(1001));
  const who = (seen[index] as beings.PerceivedBeing).id;
  const change = () => random.below(501) - 250;
  ops.add("relate", { who, aff: change(), tr: change(), because: [id, ...alsoOf(senses, random)] });
  if (random.below(4) === 0) ops.add("relate", { who, tr: change(), because: [id] });
  return who;
}

/**
 * What a relate cites besides its encounter: a heard episode when the being holds one, which
 * carries the taints of a message, or else, half the time, one of its beliefs.
 */
function alsoOf(senses: Senses2, random: Sfc32): number[] {
  const { beliefs, episodes } = senses.mind;
  const heard = episodes.filter(({ kind }) => kind === "heard");
  const from = heard.length > 0 ? heard : beliefs;
  if (from.length === 0 || (heard.length === 0 && random.below(2) === 0)) return [];
  return [(from[random.below(from.length)] as (typeof from)[number]).id];
}

/** Believes what it hears, citing the message it remembers. */
function believeHeard(ops: Operations, senses: Senses2, random: Sfc32): void {
  if (senses.perceived.heard.length === 0) return;
  const id = ops.keep({ heard: 0 }, 300 + random.below(700));
  const p = { p: `t1.told${random.below(3)}`, a: [{ n: random.below(3) }] };
  ops.add("believe", { p, cr: random.below(1001), ev: [id], rule: "told" });
}

/** A third of the time, believes the food of its cell, or revises its first belief with it. */
function observeFood(ops: Operations, senses: Senses2, random: Sfc32): void {
  if (random.below(3) !== 0) return;
  const [x = 0, y = 0] = senses.self.cell;
  const id = ops.keep({ food: [x, y] }, random.below(1001));
  const [held] = senses.mind.beliefs;
  if (held !== undefined && random.below(2) === 0)
    ops.add("revise", { id: held.id, cr: random.below(1001), ev: [id] });
  else
    ops.add("believe", { p: { p: "t1.food", a: [{ c: [x, y] }] }, cr: 800, ev: [id], rule: "saw" });
}

/**
 * Believes something of a being it knows, citing their relationship, so that a relate that taints
 * the relationship must pass the taint on to the belief: half the time of the being `related`, the
 * one this decision relates after the belief applies, and else a quarter of the time of any.
 */
function believeKnown(
  ops: Operations,
  senses: Senses2,
  random: Sfc32,
  related: number | undefined,
): void {
  const { relations } = senses.mind;
  const mine = relations.find(({ who }) => who === related);
  let known = mine !== undefined && random.below(2) === 0 ? mine : undefined;
  if (known === undefined && relations.length > 0 && random.below(4) === 0)
    known = relations[random.below(relations.length)];
  if (known === undefined) return;
  const p = { p: "t1.kin", a: [{ e: known.who }] };
  ops.add("believe", { p, cr: random.below(1001), ev: [known.id], rule: "knew" });
}

/**
 * The mental operations of a chaotic decision: a plausible core, which relates a perceived being,
 * believes what it hears, believes or revises from the food of its cell, each citing what it
 * remembers in the same decision, and believes something of a being it knows; and, sometimes,
 * random ones after it.
 */
function operationsOf(senses: Senses2, random: Sfc32): beings.MindIntention {
  const ops = new Operations(senses.mind.next);
  const related = relateSeen(ops, senses, random);
  believeHeard(ops, senses, random);
  observeFood(ops, senses, random);
  believeKnown(ops, senses, random, related);
  const extra = random.below(3) === 0 ? 1 + random.below(2) : 0;
  for (let index = 0; index < extra; index += 1) ops.add(...anyOperation(senses, random));
  return ops.mind;
}

/**
 * A brain of beings@2 that decides at random from its own draws, so it is a pure function of its
 * senses: steps that drift toward `home`, where beings crowd, and mental operations of every kind,
 * valid and invalid, which relate perceived beings and remember and believe what they hear.
 */
export function chaosBrain(home: Cell): beings.Controller2 {
  return brain2((senses) => {
    const [a = 0, b = 0] = senses.draws;
    const random = new Sfc32((a ^ Math.imul(b, 0x9e37_79b9)) >>> 0);
    const steps = stepsOf(senses, random, home);
    const kind = BEHAVIORS[random.below(BEHAVIORS.length - 1)] as string;
    return {
      steps,
      wakeWhen: {},
      behavior: behavior(kind),
      mind: operationsOf(senses, random),
    };
  });
}

// The world, its injections, and its readings.

/** Every being of `world`, by id. */
export function beingsById(world: BeingsWorld): Map<number, Being2> {
  const view = readView(world);
  const found = new Map<number, Being2>();
  for (const key of view.readGlobal().occupancy)
    for (const being of view.readChunk(key)?.beings ?? []) found.set(being.id, being as Being2);
  return found;
}

/** What the fuzz knows of a tick: the beings before and after it, its commands, and its events. */
export type TickRecord = {
  readonly tick: number;
  readonly before: ReadonlyMap<number, Being2>;
  readonly after: ReadonlyMap<number, Being2>;
  /** The chunks before the tick, for the food of a cell. */
  readonly chunks: ReadonlyMap<string, beings.BeingsChunk>;
  readonly commands: readonly Command[];
  readonly events: readonly EngineEvent[];
};

/** The chunks of `world`, by key, as the read view copies them. */
export function chunksById(world: BeingsWorld): Map<string, beings.BeingsChunk> {
  const view = readView(world);
  const found = new Map<string, beings.BeingsChunk>();
  for (const key of view.chunkKeys()) {
    const chunk = view.readChunk(key);
    if (chunk !== undefined) found.set(key, chunk as beings.BeingsChunk);
  }
  return found;
}

/**
 * The injections of a tick, drawn from `random` over the beings of `living`: most valid, some to
 * the wrong cell, from an inhabitant, or with taints beyond the three.
 */
export function injectionsAt(
  tick: number,
  living: ReadonlyMap<number, Being2>,
  random: Sfc32,
): Command[] {
  const ids = [...living.keys()];
  const commands: Command[] = [];
  const count = random.below(8) === 0 ? 1 + random.below(3) : 0;
  for (let seq = 0; seq < count && ids.length > 0; seq += 1) {
    const target = living.get(ids[random.below(ids.length)] as number) as Being2;
    const roll = random.below(20);
    const [x, y] = target.cell;
    const cell = roll === 0 ? [x + 1, y] : [x, y];
    const origin: Command["origin"] =
      roll === 1 ? { kind: "inhabitant", actor: target.id } : { kind: "admin" };
    const taints = roll === 2 ? 8 : random.below(8);
    const p = { p: "m1.food-at", a: [{ c: [x + random.below(9) - 4, y] }], v: random.below(3) };
    const payload = { being: target.id, cell, p, taints };
    commands.push({ applyTick: tick, seq, type: "mind.inject", origin, payload });
  }
  return commands;
}

/** An injection the engine accepted: the being, the tick, and its message's proposition and lineage. */
type Accepted = {
  readonly being: number;
  readonly cell: Cell;
  readonly tick: number;
  readonly p: unknown;
  readonly tn: number;
};

/** The injections of `record` that no rejection of its tick names. */
function acceptedOf(record: TickRecord): Accepted[] {
  const refused = record.events
    .filter(({ type }) => type === "engine.command_rejected")
    .map(({ payload }) => (payload as { seq: number }).seq);
  return record.commands
    .filter(({ seq }) => !refused.includes(seq))
    .map(({ payload }) => {
      const { being, cell, p, taints } = payload as {
        being: number;
        cell: Cell;
        p: unknown;
        taints: number;
      };
      return { being, cell, tick: record.tick, p, tn: taints | mind.TAINTS.humanExternal };
    });
}

/**
 * Reports an accepted injection that was not addressed to a being standing at its cell when the
 * tick began, the only being it may reach.
 */
function checkAddressed(
  accepted: readonly Accepted[],
  record: TickRecord,
  problems: string[],
): void {
  for (const it of accepted) {
    const target = record.before.get(it.being);
    if (target === undefined || target.cell[0] !== it.cell[0] || target.cell[1] !== it.cell[1])
      problems.push(`tick ${record.tick}: an injection reached ${it.being}, not at ${it.cell}`);
  }
}

/**
 * Why the relationship of `held` that a provenance `entry` lists was related against the rules:
 * cited records no longer live, none of which involves its being, or a lineage without theirs.
 */
function relatedProblems(held: Mind, entry: Provenance["records"][number]): string[] {
  const relationship = held.relations.find((r) => r.id === entry.id);
  if (relationship === undefined || entry.ev.length === 0) return [];
  const cited = entry.ev.map((local) => mind.recordOf(held, local));
  const live = cited.filter((it): it is mind.MindRecord => it !== undefined);
  const problems: string[] = [];
  if (live.length < cited.length) problems.push("cites a record no longer live");
  if (!live.some((it) => mind.involves(it, relationship.who)))
    problems.push(`was related citing no record of ${relationship.who}`);
  if (!live.every((it) => covers(relationship.tn, mind.taintsOf(it).tn)))
    problems.push("lacks the lineage of what it cites");
  return problems;
}

/** Reports each relationship a `relate` of the tick changed against the rules, by its evidence. */
function checkRelated(record: TickRecord, problems: string[]): void {
  for (const { type, payload } of record.events) {
    if (type !== "mind.provenance") continue;
    const { id, records } = payload as Provenance;
    const held = record.after.get(id)?.mind;
    if (held === undefined) continue;
    for (const entry of records)
      for (const problem of relatedProblems(held, entry))
        problems.push(`tick ${record.tick}, being ${id}: relationship ${entry.id} ${problem}`);
  }
}

/** Reports a chunk holding more beings than its capacity after the tick. */
function checkCapacity(record: TickRecord, capacity: number, problems: string[]): void {
  const counts = new Map<string, number>();
  for (const being of record.after.values())
    counts.set(chunkOf(being.cell), (counts.get(chunkOf(being.cell)) ?? 0) + 1);
  for (const [key, count] of counts)
    if (count > capacity) problems.push(`tick ${record.tick}: chunk ${key} holds ${count}`);
}

// The invariants.

/** Reports a problem of one being at one tick. */
type Report = (problem: string) => void;

/** The effective food of `cell` at `tick` from the chunks before it: the deposit less what was taken. */
function foodAt(chunks: ReadonlyMap<string, beings.BeingsChunk>, cell: Cell, tick: number): number {
  const key = `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;
  const index = worldgen.cellOffset(cell[1]) * worldgen.CHUNK_CELLS + worldgen.cellOffset(cell[0]);
  const entry = chunks.get(key)?.depletion.find((candidate) => candidate.cell === index);
  if (entry === undefined) return baseFood(cell);
  const missing = beings.takenAt(entry, SPECIES2.regrowth, (tick - entry.since) * 12);
  return Math.max(baseFood(cell) - missing, 0);
}

/** The chunk key of `cell`. */
const chunkOf = (cell: Cell) => `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;

/** Reports every invariant of the mind layer `held` breaks, and every capacity and byte budget. */
function checkBounds(held: Mind, laws: mind.MindLaws["mind"], report: Report): void {
  const issues = new IssueList();
  mind.checkMind(held, "/mind", issues);
  for (const issue of issues.issues) report(`${issue.path} ${issue.message}`);
  const stores = [
    ["episodes", held.episodes.length, laws.episodes],
    ["beliefs", held.beliefs.length, laws.beliefs],
    ["relations", held.relations.length, laws.relations],
    ["inbox", held.inbox.length, laws.inbox],
  ] as const;
  for (const [name, size, capacity] of stores)
    if (size > capacity) report(`holds ${size} ${name}, more than ${capacity}`);
  const bytes = utf8Length(canonicalize(held));
  if (bytes > MIND_BYTES) report(`the mind takes ${bytes} bytes, more than ${MIND_BYTES}`);
}

/** Reports what shrank from `old` to `held`: `next`, the exposure, a record's taints or `src`. */
function checkGrowth(held: Mind, old: Mind, report: Report): void {
  if (held.next < old.next) report(`next fell from ${old.next} to ${held.next}`);
  if (!covers(held.exposure, old.exposure)) report("the exposure shrank");
  for (const { id } of [...held.episodes, ...held.beliefs, ...held.relations]) {
    const prior = mind.recordOf(old, id);
    const now = mind.recordOf(held, id) as mind.MindRecord;
    if (prior === undefined) continue;
    const [a, b] = [mind.taintsOf(prior), mind.taintsOf(now)];
    if (!covers(b.tn, a.tn) || !covers(b.ex, a.ex)) report(`the taints of ${id} shrank`);
    if (prior.store === "beliefs" && !covers((now.record as mind.Belief).src, prior.record.src))
      report(`the src of ${id} shrank`);
  }
}

/** Why a `being` episode made at this tick is not a being perceived in the state of the tick. */
function beingProblem(
  self: Being2,
  episode: mind.BeingEpisode,
  record: TickRecord,
): string | undefined {
  const other = record.before.get(episode.who);
  if (other === undefined) return `perceived ${episode.who}, who is not in the world`;
  const same =
    other.cell[0] === episode.cell[0] &&
    other.cell[1] === episode.cell[1] &&
    ACTIVITIES[episode.v] === other.activity.kind &&
    distance(other.cell, self.cell) <= SPECIES2.perception.sight.day;
  return same ? undefined : `perceived ${episode.who} unlike the state of the tick`;
}

/** Why an observation of food or a being, made at this tick, is not its percept. */
function observationProblem(
  self: Being2,
  episode: mind.OwnEpisode | mind.BeingEpisode,
  record: TickRecord,
): string | undefined {
  if (episode.t !== record.tick) return `happened at ${episode.t}, not at the decision`;
  if (distance(episode.cell, self.cell) > RADIUS) return "lies outside the window";
  if (episode.kind === "being") return beingProblem(self, episode, record);
  const band = bandOf(foodAt(record.chunks, episode.cell, record.tick));
  return band === episode.v ? undefined : `has the band ${episode.v}, not ${band}`;
}

/** What the invariants remember across ticks. */
export class MindInvariants {
  readonly #laws: beings.LifeConfig2;
  readonly #injections: Accepted[] = [];
  /** The units each being's current meal ate, and those of the meals that ended, by being/tick. */
  readonly #meal = new Map<number, number>();
  readonly #meals = new Map<string, number>();
  /** The outcomes every being held at the end of each tick, by being/tick of the outcome. */
  readonly #outcomes = new Map<string, beings.Outcome>();
  /** Counts of what the fuzz exercised, so that a pass is not vacuous. */
  readonly seen = {
    external: 0,
    relations: 0,
    /** Relates applied: relationships the ledger lists with what they cited. */
    related: 0,
    /** Relates that gave their relationship a taint it lacked. */
    tainted: 0,
    /** Of those, the ones a belief cites, which the taint had to flow to. */
    flowed: 0,
    beliefs: 0,
    crowded: 0,
    injected: 0,
  };

  constructor(laws: beings.LifeConfig2) {
    this.#laws = laws;
  }

  /** Every problem of `record`, after the tick, each naming its tick and being. */
  check(record: TickRecord): string[] {
    const accepted = acceptedOf(record);
    this.#injections.push(...accepted);
    for (const event of record.events) this.#readEvent(event, record);
    const problems: string[] = [];
    checkAddressed(accepted, record, problems);
    checkRelated(record, problems);
    checkCapacity(record, this.#laws.capacity, problems);
    const laws = (this.#laws.species[0] as beings.Species2).mind;
    for (const [id, being] of record.after) {
      const report: Report = (problem) =>
        problems.push(`tick ${record.tick}, being ${id}: ${problem}`);
      const before = record.before.get(id);
      checkBounds(being.mind, laws, report);
      if (before !== undefined) checkGrowth(being.mind, before.mind, report);
      this.#checkExposure(being, report);
      this.#checkNew(being, record, report);
      this.#outcomes.set(`${id}/${being.outcome.tick}`, being.outcome);
    }
    return problems;
  }

  /** The exposure holds the lineage of every message delivered to the being, from its delivery on. */
  #checkExposure(being: Being2, report: Report): void {
    for (const { being: to, tn, tick } of this.#injections)
      if (to === being.id && !covers(being.mind.exposure, tn))
        report(`the exposure lacks the injection of tick ${tick}`);
  }

  /** Keeps the meals and counts of an event of the tick. */
  #readEvent({ type, payload }: EngineEvent, record: TickRecord): void {
    const event = payload as { id: number; activity?: string; units?: number; reason?: string };
    if (event.activity === "eat") this.#readMeal(type, event.id, record.tick);
    if (type === "being.ate")
      this.#meal.set(event.id, (this.#meal.get(event.id) ?? 0) + (event.units ?? 0));
    if (type === "being.finished" && event.reason === "crowded") this.seen.crowded += 1;
    if (type === "mind.injected") this.seen.injected += 1;
    if (type === "mind.provenance")
      for (const entry of (payload as Provenance).records)
        this.#countRelate(event.id, entry, record);
  }

  /** Counts `entry` of the being `id`'s provenance when it is a relationship a relate changed. */
  #countRelate(id: number, entry: Provenance["records"][number], record: TickRecord): void {
    const held = record.after.get(id)?.mind;
    if (held === undefined || entry.ev.length === 0) return;
    if (!held.relations.some((relationship) => relationship.id === entry.id)) return;
    this.seen.related += 1;
    const was = record.before.get(id)?.mind.relations.find((r) => r.id === entry.id)?.tn ?? 0;
    if ((entry.tn & ~was) === 0) return;
    this.seen.tainted += 1;
    if (held.beliefs.some((belief) => belief.ev.includes(entry.id))) this.seen.flowed += 1;
  }

  /** A meal of the being `id` starts or ends with an event of `type` at `tick`. */
  #readMeal(type: string, id: number, tick: number): void {
    if (type === "being.started") this.#meal.set(id, 0);
    if (type === "being.finished") this.#meals.set(`${id}/${tick}`, this.#meal.get(id) ?? 0);
  }

  /** The records the tick created: each equal to a percept, a delivery, or a perception of it. */
  #checkNew(being: Being2, record: TickRecord, report: Report): void {
    const before = record.before.get(being.id);
    const from = before?.mind.next ?? 1;
    for (const episode of being.mind.episodes) {
      const problem = episode.id < from ? undefined : this.#episodeProblem(being, episode, record);
      if (problem !== undefined) report(`episode ${episode.id} ${problem}`);
    }
    for (const relationship of being.mind.relations.filter(({ id }) => id >= from)) {
      this.seen.relations += 1;
      const other = record.before.get(relationship.who);
      if (other === undefined || distance(other.cell, being.cell) > SPECIES2.perception.sight.day)
        report(`relationship ${relationship.id} with ${relationship.who}, never perceived`);
    }
    this.seen.beliefs += being.mind.beliefs.filter(({ id }) => id >= from).length;
  }

  /** Why `episode`, made at this tick, is not what the being perceived; undefined when it is. */
  #episodeProblem(self: Being2, episode: mind.Episode, record: TickRecord): string | undefined {
    switch (episode.kind) {
      case "heard":
        return "is heard, with no speech";
      case "external":
        return this.#externalProblem(self, episode, record.tick);
      case "ate":
        return this.#ateProblem(self, episode);
      case "failed":
        return this.#failedProblem(self, episode, record);
      default:
        return observationProblem(self, episode, record);
    }
  }

  #externalProblem(self: Being2, episode: mind.ExternalEpisode, tick: number): string | undefined {
    this.seen.external += 1;
    const text = canonicalize(episode.p);
    const delivered = this.#injections.some(
      (it) =>
        it.being === self.id &&
        it.tick <= tick &&
        it.tn === episode.tn &&
        canonicalize(it.p as never) === text,
    );
    return delivered && episode.t === tick ? undefined : "matches no injection delivered to it";
  }

  #ateProblem(self: Being2, episode: mind.OwnEpisode): string | undefined {
    const units = this.#meals.get(`${self.id}/${episode.t}`);
    if (units !== undefined && Math.min(units, 0x10_0000) === episode.v) return undefined;
    return `ate ${episode.v}, not ${units}`;
  }

  #failedProblem(self: Being2, episode: mind.OwnEpisode, record: TickRecord): string | undefined {
    const reason = mind.FAILURES[episode.v];
    const finished = record.events.some(({ type, payload }) => {
      const event = payload as { id: number; result: string; reason: string };
      return type === "being.finished" && event.id === self.id && event.reason === reason;
    });
    const held = this.#outcomes.get(`${self.id}/${episode.t}`) ?? self.outcome;
    if (finished || (held.result === "failed" && held.reason === reason)) return undefined;
    return `failed with ${reason}, which no outcome of tick ${episode.t} had`;
  }
}

// The ledger oracle.

/** What the oracle knows of a live record: its store and its taints and citations. */
type Known = { store: "episodes" | "beliefs" | "relations"; tn: number; ex: number; ev: number[] };

type MindChanged = {
  readonly id: number;
  readonly encoded: readonly number[];
  readonly formed: readonly { readonly id: number }[];
  readonly dropped: readonly number[];
  readonly forgot: readonly { readonly id: number; readonly beliefs: readonly number[] }[];
  readonly related: readonly number[];
};

type Provenance = {
  readonly id: number;
  readonly records: readonly { id: number; tn: number; ex: number; ev: number[] }[];
  readonly exposure: number;
};

/** One being's mind as the ledger tells it. */
type Ledgered = {
  readonly records: Map<number, Known>;
  exposure: number;
  /** The stores of the records the last mind.changed created. */
  pending: Map<number, Known["store"]>;
};

/** The ids `cited` without `gone`. */
const without = (cited: readonly number[], gone: number) => cited.filter((id) => id !== gone);

/** Whether `ids` name each record once, by increasing id. */
const increasing = (ids: readonly number[]) =>
  ids.every((id, index) => index === 0 || (ids[index - 1] as number) < id);

/**
 * Why the lists of an event of the ledger that mind.md orders by increasing id, `related` and the
 * records of `mind.provenance`, are not in that order: they name each record once, by increasing id.
 */
function orderProblems(type: string, payload: unknown): string[] {
  if (type === "mind.changed") {
    const { related } = payload as MindChanged;
    return increasing(related) ? [] : [`related ${related.join(",")} is not by increasing id`];
  }
  if (type !== "mind.provenance") return [];
  const ids = (payload as Provenance).records.map(({ id }) => id);
  return increasing(ids) ? [] : [`records ${ids.join(",")} are not by increasing id`];
}

/** Reports each belief of `ledgered` that does not contain the taints of what it cites. */
function checkClosure(ledgered: Ledgered, report: Report): void {
  for (const [id, known] of ledgered.records) {
    if (known.store !== "beliefs") continue;
    for (const cited of known.ev) {
      const premise = ledgered.records.get(cited);
      if (premise === undefined) report(`belief ${id} cites ${cited}, not live in the ledger`);
      else if (!covers(known.tn, premise.tn) || !covers(known.ex, premise.ex))
        report(`belief ${id} does not contain the taints of ${cited}`);
    }
  }
}

/**
 * The ledger oracle: from `mind.changed` and `mind.provenance` alone, the events an accepted
 * `mind.injected` comes with, it rebuilds the live records of every mind, with their `tn`, `ex`,
 * and citations, and every exposure; it checks that taints and exposures only grow and that each
 * belief contains what it cites; and it compares what it rebuilt with the state.
 */
export class LedgerOracle {
  readonly #minds = new Map<number, Ledgered>();

  #of(id: number): Ledgered {
    const found = this.#minds.get(id) ?? { records: new Map(), exposure: 0, pending: new Map() };
    this.#minds.set(id, found);
    return found;
  }

  /** Reads the events of a tick, in order; returns the problems it found in them. */
  read(events: readonly EngineEvent[]): string[] {
    const problems: string[] = [];
    for (const { type, payload, tick } of events) {
      for (const problem of orderProblems(type, payload))
        problems.push(`tick ${tick}, being ${(payload as { id: number }).id}: ${problem}`);
      if (type === "mind.changed") this.#changed(payload as MindChanged);
      if (type !== "mind.provenance") continue;
      const event = payload as Provenance;
      this.#provenance(event, (problem) =>
        problems.push(`tick ${tick}, being ${event.id}: ${problem}`),
      );
    }
    return problems;
  }

  #changed(event: MindChanged): void {
    const ledgered = this.#of(event.id);
    const pending = new Map<number, Known["store"]>();
    for (const id of event.encoded) pending.set(id, "episodes");
    for (const { id } of event.formed) pending.set(id, "beliefs");
    for (const id of event.related) if (!ledgered.records.has(id)) pending.set(id, "relations");
    ledgered.pending = pending;
    for (const gone of event.forgot) {
      ledgered.records.delete(gone.id);
      for (const citer of gone.beliefs) {
        const known = ledgered.records.get(citer);
        if (known !== undefined) known.ev = without(known.ev, gone.id);
      }
    }
    for (const dropped of event.dropped) {
      ledgered.records.delete(dropped);
      for (const known of ledgered.records.values()) known.ev = without(known.ev, dropped);
    }
  }

  #provenance(event: Provenance, report: Report): void {
    const ledgered = this.#of(event.id);
    for (const entry of event.records) {
      const known = ledgered.records.get(entry.id);
      const store = known?.store ?? ledgered.pending.get(entry.id);
      if (store === undefined) report(`provenance of ${entry.id}, which no mind.changed created`);
      else if (known !== undefined && (!covers(entry.tn, known.tn) || !covers(entry.ex, known.ex)))
        report(`the ledger shrank the taints of ${entry.id}`);
      if (store !== undefined)
        ledgered.records.set(entry.id, { store, tn: entry.tn, ex: entry.ex, ev: [...entry.ev] });
    }
    if (!covers(event.exposure, ledgered.exposure)) report("the ledger shrank the exposure");
    ledgered.exposure = event.exposure;
    ledgered.pending = new Map();
    checkClosure(ledgered, report);
  }

  /** Every difference between what the ledger rebuilt and the minds of `living`. */
  compare(living: ReadonlyMap<number, Being2>, tick: number): string[] {
    const problems: string[] = [];
    for (const [id, being] of living) {
      const report: Report = (problem) => problems.push(`tick ${tick}, being ${id}: ${problem}`);
      const ledgered = this.#of(id);
      const held = being.mind;
      const live = [...held.episodes, ...held.beliefs, ...held.relations]
        .map((record) => record.id)
        .sort((a, b) => a - b);
      const rebuilt = [...ledgered.records.keys()].sort((a, b) => a - b);
      if (canonicalize(live) !== canonicalize(rebuilt))
        report(`the state holds ${live}, the ledger ${rebuilt}`);
      if (held.exposure !== ledgered.exposure)
        report(`the exposure is ${held.exposure}, the ledger's ${ledgered.exposure}`);
      for (const local of live)
        compareRecord(mind.recordOf(held, local) as mind.MindRecord, ledgered, report);
    }
    return problems;
  }
}

/** Reports what the ledger holds of `record` unlike the state: its store, taints, or citations. */
function compareRecord(record: mind.MindRecord, ledgered: Ledgered, report: Report): void {
  const known = ledgered.records.get(record.record.id);
  if (known === undefined) return;
  const taints = mind.taintsOf(record);
  const { id } = record.record;
  if (known.store !== record.store || known.tn !== taints.tn || known.ex !== taints.ex)
    report(
      `record ${id} is ${record.store} ${taints.tn}/${taints.ex}, the ledger's ${known.store} ${known.tn}/${known.ex}`,
    );
  if (record.store === "beliefs" && canonicalize(record.record.ev) !== canonicalize(known.ev))
    report(`belief ${id} cites ${record.record.ev}, the ledger ${known.ev}`);
}

/**
 * `count` cells near `home` where beings may stand, every other one, half west of the column of
 * `home` and half from it east, so that the two chunks a border at that column divides hold as
 * many beings each.
 */
export function cellsNear(home: Cell, count: number): Cell[] {
  const sides: Cell[][] = [[], []];
  for (let dy = -8; dy <= 8; dy += 2)
    for (let dx = -8; dx <= 8; dx += 2) {
      const cell: Cell = [home[0] + dx, home[1] + dy];
      const side = sides[dx < 0 ? 0 : 1] as Cell[];
      if (side.length < count / 2 && standable(cell)) side.push(cell);
    }
  const cells = [...(sides[0] as Cell[]), ...(sides[1] as Cell[])];
  if (cells.length < count) throw new Error(`only ${cells.length} standable cells near ${home}`);
  return cells;
}
