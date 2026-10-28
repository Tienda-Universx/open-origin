import {
  beings,
  type Command,
  canonicalize,
  type EngineEvent,
  type mind,
  readView,
  type StepResult,
  worldgen,
} from "@open-origin/engine";
import { ablationA, ablationB, formationsOf } from "./mind-ablation.ts";
import type { Senses2 } from "./mind-senses.ts";
import type { ScenarioWorld } from "./scenario.ts";

/**
 * The measures of the soak of T5 (docs/architecture/mind.md, "Evaluation", the informative
 * hypotheses and the ablation of whole decisions), taken in a run of the evaluation's child process
 * (mind-evaluation-child.ts), which bench/mind-soak.ts starts on each held-out label:
 *
 * - **memory**: each hungry spell, from the first decision with nutrition below 500,000 and a food
 *   cue of 0 in every cell of the window, after the being's last bite, to its next bite;
 * - **credulity**: each belief formed from testimony, and whether its claim is false one day after
 *   it formed, by the reference truth: the band of the effective food of the species' deposit at its
 *   cell then, from the terrain and the chunks' depletion;
 * - **a false claim**: at tick 6,300 (1 L), `mind.inject` gives the being of lowest id `m1.food-at`
 *   with band 2 at the nearest cell, by Chebyshev distance of at least 5, then y, then x, that is
 *   passable and has no food, with `human-external` only; then the life of that belief over 2 L;
 * - **the ablations** (a) and (b) on every decision of the being of lowest id that proposed a belief
 *   operation, replayed at the end of the run with the run's own brain.
 */

/** The tick of the false claim, and how long after it the claim is followed. */
export const CLAIM_TICK = 6_300;
export const CLAIM_SPAN = 12_600;
/** The being the false claim and the ablations follow: the one of lowest id. */
const FIRST = 1;
/** Nutrition below which a being is hungry, for the memory hypothesis. */
const HUNGRY = 500_000;
/** One simulated day of the scenario, after which a belief from testimony is judged. */
const DAY_TICKS = 6_300;

/** A belief formed from testimony and its claim, judged one day later. */
type Testimony = { readonly being: number; readonly tick: number; readonly p: mind.Proposition };

/** The life of the false claim's belief. */
export type ClaimLife = {
  readonly being: number;
  readonly target: readonly [number, number] | undefined;
  /** The tick the being believed it, and at what confidence; undefined when it never did. */
  believed?: { readonly tick: number; readonly cr: number };
  /** The first tick it held the belief below 500, and the tick the belief left its mind, and how. */
  below500?: number;
  left?: { readonly tick: number; readonly how: "dropped" | "forgotten" };
  /** Whether it was revised below 500, or dropped, within 2 L of the injection. */
  corrected: boolean;
};

/** What the soak measured in one run. */
export type SoakRecord = {
  /** Each hungry spell that ended in a bite, in ticks, and how many were still open at the end. */
  readonly spells: readonly number[];
  readonly openSpells: number;
  /** Beliefs formed from testimony, by being, and how many of them were false one day later. */
  readonly testimony: readonly {
    readonly being: number;
    readonly judged: number;
    readonly false: number;
  }[];
  readonly claim?: ClaimLife;
  readonly ablation?: {
    readonly decisions: number;
    readonly operations: number;
    readonly removable: number;
    readonly misses: readonly string[];
  };
};

/** The cell and band of an `m1.food-at` claim, or undefined for any other proposition. */
function claimOf(
  p: mind.Proposition,
): { readonly cell: readonly [number, number]; readonly v: number } | undefined {
  const term = p.a[0] as { c?: readonly [number, number] } | undefined;
  if (p.p !== "m1.food-at" || p.neg === true || term?.c === undefined || p.v === undefined)
    return undefined;
  return { cell: term.c, v: p.v };
}

/** What the reference truth reads: the terrain, the species, and the seconds of a tick. */
type Ground = {
  readonly prepared: worldgen.PreparedGenesis;
  readonly species: beings.Species2;
  readonly sps: number;
};

/** The units of the species' deposit at `cell` before any being ate. */
function depositOf(ground: Ground, cell: readonly [number, number]): number {
  const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
  return worldgen.sampleSurface(ground.prepared, rect, ground.species.diet.deposit).deposit[0] ?? 0;
}

/** The band of the effective food at `cell` in `world` after the tick `tick`: the reference truth. */
export function trueBand(
  world: ScenarioWorld,
  ground: Ground,
  cell: readonly [number, number],
  tick: number,
): number {
  const key = `${worldgen.chunkOfCell(cell[0])},${worldgen.chunkOfCell(cell[1])}`;
  const index = worldgen.cellOffset(cell[1]) * worldgen.CHUNK_CELLS + worldgen.cellOffset(cell[0]);
  const entry = readView(world)
    .readChunk(key)
    ?.depletion.find((candidate) => candidate.cell === index);
  const base = depositOf(ground, cell);
  const taken =
    entry === undefined
      ? 0
      : beings.takenAt(entry, ground.species.regrowth, (tick - entry.since) * ground.sps);
  const food = Math.max(0, base - taken);
  const { cue } = ground.species.diet;
  if (food >= cue.plenty) return 2;
  return food >= cue.some ? 1 : 0;
}

/** Whether a being of `species` may stand at `cell`: inside the world and no deeper than it wades. */
function passable(ground: Ground, cell: readonly [number, number]): boolean {
  if (cell[0] < worldgen.MIN_CELL || cell[0] > worldgen.MAX_CELL) return false;
  if (cell[1] < worldgen.MIN_CELL || cell[1] > worldgen.MAX_CELL) return false;
  const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
  const surface = worldgen.sampleSurface(ground.prepared, rect, ground.species.diet.deposit);
  const level = worldgen.liquidLevel(worldgen.genesisOf(ground.prepared));
  const depth = Math.max(0, level - (surface.elevation[0] ?? 0));
  return depth <= ground.species.locomotion.maxWade;
}

/**
 * The target of the false claim for a being at `from`: the nearest cell by Chebyshev distance of
 * at least 5, then y, then x, that is passable and whose deposit holds no food.
 */
export function claimTarget(
  ground: Ground,
  from: readonly [number, number],
): [number, number] | undefined {
  for (let d = 5; d <= 64; d += 1) {
    const ring: [number, number][] = [];
    for (let dy = -d; dy <= d; dy += 1)
      for (let dx = -d; dx <= d; dx += 1)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === d) ring.push([from[0] + dx, from[1] + dy]);
    ring.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const found = ring.find((cell) => passable(ground, cell) && depositOf(ground, cell) === 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The proposition of the false claim at `cell`. */
const claimAt = (cell: readonly [number, number]): mind.Proposition => ({
  p: "m1.food-at",
  a: [{ c: [cell[0], cell[1]] }],
  v: 2,
});

/** A decision of the being of lowest id that proposed a belief operation. */
type Recorded = { readonly senses: Senses2; readonly intention: beings.Intention2 };

/** The observer of the soak's measures in one run. */
export class SoakObserver {
  readonly #ground: Ground;
  readonly #falseClaim: boolean;
  #tick = 0;
  readonly #hungry = new Map<number, number>();
  readonly #spells: number[] = [];
  readonly #testimony: Testimony[] = [];
  readonly #judged = new Map<number, { judged: number; false: number }>();
  readonly #recorded: Recorded[] = [];
  #brain: beings.Controller2 | undefined;
  #claim: ClaimLife | undefined;

  constructor(ground: Ground, falseClaim: boolean) {
    this.#ground = ground;
    this.#falseClaim = falseClaim;
  }

  /** `inner`, whose decisions the soak reads, deciding unchanged. */
  controller(inner: beings.Controller2): beings.Controller2 {
    this.#brain = inner;
    return {
      ...inner,
      decide: (senses) => {
        const intention = inner.decide(senses);
        this.#decided(senses, intention);
        return intention;
      },
    };
  }

  /** A hungry spell that opens, and a decision of the first being with a belief operation. */
  #decided(senses: Senses2, intention: beings.Intention2): void {
    const { id, needs } = senses.self;
    const blind = senses.window.foodCue.every((cue) => cue === 0);
    if (needs.nutrition < HUNGRY && blind && !this.#hungry.has(id))
      this.#hungry.set(id, this.#tick + 1);
    if (id === FIRST && formationsOf(senses, intention).length > 0)
      this.#recorded.push({ senses, intention });
  }

  /** The command of tick `tick`: the false claim at CLAIM_TICK, when the run makes it. */
  commandsAt(world: ScenarioWorld, tick: number): Command[] {
    if (!this.#falseClaim || tick !== CLAIM_TICK) return [];
    const being = beingOf(world, FIRST);
    const target = being === undefined ? undefined : claimTarget(this.#ground, being.cell);
    this.#claim = { being: FIRST, target, corrected: false };
    if (being === undefined || target === undefined) return [];
    const payload = {
      being: FIRST,
      cell: [being.cell[0], being.cell[1]],
      p: claimAt(target),
      taints: 2,
    };
    return [{ applyTick: tick, seq: 0, type: "mind.inject", origin: { kind: "admin" }, payload }];
  }

  /** A belief formed from testimony at `tick`, judged one day later. */
  told(being: number, tick: number, p: mind.Proposition): void {
    this.#testimony.push({ being, tick, p });
  }

  /** Reads the step `result` of `world`. */
  observe(world: ScenarioWorld, result: StepResult): void {
    this.#tick = result.tick;
    for (const { type, payload } of result.events) {
      const { id } = payload as { id: number };
      if (type !== "being.ate" || !this.#hungry.has(id)) continue;
      this.#spells.push(result.tick - (this.#hungry.get(id) as number));
      this.#hungry.delete(id);
    }
    this.#judge(world, result.tick);
    if (this.#claim?.target !== undefined) this.#follow(world, result);
  }

  /** Judges the testimonies formed one day before `tick` against the truth after it. */
  #judge(world: ScenarioWorld, tick: number): void {
    for (const testimony of this.#testimony) {
      if (testimony.tick + DAY_TICKS !== tick) continue;
      const claim = claimOf(testimony.p);
      const judged = this.#judged.get(testimony.being) ?? { judged: 0, false: 0 };
      this.#judged.set(testimony.being, judged);
      judged.judged += 1;
      if (claim === undefined || trueBand(world, this.#ground, claim.cell, tick) !== claim.v)
        judged.false += 1;
    }
  }

  /** Follows the false claim's belief in the mind of its being, for 2 L after the injection. */
  #follow(world: ScenarioWorld, result: StepResult): void {
    const claim = this.#claim as ClaimLife;
    if (result.tick > CLAIM_TICK + CLAIM_SPAN || claim.left !== undefined) return;
    if (!changedFirst(result.events)) return;
    const text = canonicalize(claimAt(claim.target as [number, number]) as never);
    const belief = beingOf(world, FIRST)?.mind.beliefs.find(
      (held) => canonicalize(held.p as never) === text,
    );
    if (belief === undefined) leftClaim(claim, result);
    else heldClaim(claim, belief.cr, result.tick);
  }

  /** What the soak measured, the ablations replayed now with the run's brain. */
  finish(): SoakRecord {
    const testimony = [...this.#judged].map(([being, judged]) => ({ being, ...judged }));
    return {
      spells: this.#spells,
      openSpells: this.#hungry.size,
      testimony: testimony.sort((a, b) => a.being - b.being),
      ...(this.#claim === undefined ? {} : { claim: this.#claim }),
      ...(this.#brain === undefined ? {} : { ablation: ablations(this.#recorded, this.#brain) }),
    };
  }
}

/** Whether the mind of the being of lowest id changed in `events`. */
const changedFirst = (events: readonly EngineEvent[]) =>
  events.some(
    ({ type, payload }) => type === "mind.changed" && (payload as { id: number }).id === FIRST,
  );

/** The claim's belief held at `cr` after `tick`: when it was believed, and when below 500. */
function heldClaim(claim: ClaimLife, cr: number, tick: number): void {
  claim.believed ??= { tick, cr };
  if (cr >= 500 || claim.below500 !== undefined) return;
  claim.below500 = tick;
  claim.corrected = true;
}

/** The claim's belief no longer held after the step `result`: dropped, or forgotten. */
function leftClaim(claim: ClaimLife, result: StepResult): void {
  if (claim.believed === undefined) return;
  const dropped = droppedBy(result.events);
  claim.left = { tick: result.tick, how: dropped ? "dropped" : "forgotten" };
  if (dropped) claim.corrected = true;
}

/** Whether the being of lowest id dropped a belief in `events`. */
function droppedBy(events: readonly EngineEvent[]): boolean {
  return events.some(({ type, payload }) => {
    const changed = payload as { id: number; dropped?: readonly number[] };
    return type === "mind.changed" && changed.id === FIRST && (changed.dropped?.length ?? 0) > 0;
  });
}

/** The being `id` of `world`, or undefined. */
function beingOf(world: ScenarioWorld, id: number): beings.Being2 | undefined {
  const view = readView(world);
  for (const key of view.readGlobal().occupancy)
    for (const being of view.readChunk(key)?.beings ?? [])
      if (being.id === id) return being as beings.Being2;
  return undefined;
}

/** The ablations (a) and (b) of every recorded decision, with `brain`. */
function ablations(recorded: readonly Recorded[], brain: beings.Controller2) {
  const decide = (senses: Senses2) => brain.decide(senses);
  const misses: string[] = [];
  let operations = 0;
  let removable = 0;
  for (const { senses, intention } of recorded) {
    operations += formationsOf(senses, intention).length;
    const a = ablationA(senses, intention, decide);
    removable += a.removable;
    for (const miss of a.misses) misses.push(`(a) ${JSON.stringify(miss)}`);
    for (const miss of ablationB(senses, intention, decide))
      misses.push(`(b) ${JSON.stringify(miss)}`);
  }
  return { decisions: recorded.length, operations, removable, misses };
}

/** The laws of the amnesic ablation: every capacity of `mind` at 0, and `speech.perDay` at 0. */
export function amnesicLife(): beings.LifeConfig2 {
  const life = beings.defaultLife2();
  const species = life.species[0] as beings.Species2;
  const mindLaws = { ...species.mind, episodes: 0, beliefs: 0, relations: 0, inbox: 0 };
  const speech = { ...species.speech, perDay: 0 };
  return { ...life, species: [{ ...species, mind: mindLaws, speech }] };
}
