import {
  beings,
  type CanonicalValue,
  type Command,
  createWorld,
  readView,
  type Seed,
  type StepResult,
  step,
  type World,
  worldgen,
} from "@open-origin/engine";
import {
  type BeingsWorld,
  PREPARED,
  testGenesis,
} from "../../../engine/test/support/beings-world.ts";
import { being2, chunksOf } from "../../../engine/test/support/beings2-world.ts";
import type { SuiteRuleset } from "../../../engine/test/support/determinism-records.ts";
import { mindRuleset, SUBJECT_DAY, SUBJECT_LIFE, SUBJECT_SPECIES } from "./mind-ruleset.ts";

/**
 * The determinism subject of `mind@1` (docs/architecture/mind.md, "Verification plan"; plan §11.2,
 * tests 11 and 12): three beings of `mind@1` around the corner of four chunks of the engine's test
 * genesis, whose day lasts 100 ticks, under SUBJECT_LIFE: a hungry one and a sated one in chunk
 * (3, −1), full at its room of two, and a sated one in chunk (2, −1), with food in sight and traits
 * that differ. Over SUBJECT_TICKS ticks they greet and tell one another what they believe; they
 * forage, walk into a chunk that did not exist, and into the full chunk, which loses the contest
 * for room; they forget what faded and revise what they see contradicted; dusk falls and the day
 * turns. Research injects a false claim, which its being hears and believes.
 */

export const SUBJECT_TICKS = 105;
export const SUBJECT_SEEDS: readonly [Seed, Seed] = [
  [5, 8],
  [13, 21],
];

/** The tick of the injection: its being is chosen and found by a run of the ticks before it. */
const INJECTION_TICK = 30;

/** The being research injects a false claim into. */
const INJECTED = 2;

type Placed = {
  readonly cell: readonly [number, number];
  readonly nutrition: number;
  readonly rest: number;
  readonly traits: beings.Traits2;
};

/** Traits of `sociability`, `credulity`, and `retention`, the others neutral. */
const traits = (sociability: number, credulity: number, retention: number): beings.Traits2 => ({
  appetite: 1000,
  sleepiness: 1000,
  curiosity: 1000,
  sociability,
  credulity,
  retention,
});

/** The three beings, by id from 1. */
const PLACED: readonly Placed[] = [
  { cell: [97, -31], nutrition: 560_000, rest: 960_000, traits: traits(1100, 1150, 1000) },
  { cell: [99, -29], nutrition: 900_000, rest: 960_000, traits: traits(1200, 950, 850) },
  { cell: [94, -30], nutrition: 880_000, rest: 960_000, traits: traits(1150, 1100, 1200) },
];

/** The initial chunks of the subject: its beings, each with an empty mind. */
function subjectChunks(): { [key: string]: beings.BeingsChunk } {
  return chunksOf(
    PLACED.map(({ cell, nutrition, rest, traits: drawn }, index) =>
      being2(index + 1, cell, { needs: { nutrition, rest }, traits: drawn }),
    ),
  );
}

/**
 * The subject's world at tick 0 with `seed`, running `ruleset`, under audit when `audit` is true:
 * the world factory of the determinism suite.
 */
export function mindWorld(seed: Seed, ruleset: SuiteRuleset, audit: boolean): World {
  const chunks = subjectChunks();
  const global = {
    ...beings.beingsGlobal(testGenesis(), SUBJECT_LIFE),
    occupancy: Object.keys(chunks).sort(),
  };
  return createWorld(
    {
      seed,
      simSecondsPerTick: 12,
      global: global as unknown as CanonicalValue,
      chunks: chunks as unknown as { [key: string]: CanonicalValue },
      ruleset,
    },
    { audit },
  );
}

/** The being `id` of `world`; throws when there is none. */
function subjectBeing(world: World, id: number): beings.Being2 {
  const view = readView(world as BeingsWorld);
  for (const key of view.readGlobal().occupancy)
    for (const being of view.readChunk(key)?.beings ?? [])
      if (being.id === id) return being as beings.Being2;
  throw new Error(`the subject has no being ${id}`);
}

/**
 * The script of the subject: at INJECTION_TICK, research tells INJECTED, at the cell where it
 * stands, that the food of its own cell is of band 2 when its window cues it otherwise, else of
 * band 0. A run of the ticks before it finds the cell and the cue: commands of a tick change
 * nothing before it, so the run with the injection is that run until then.
 */
export function subjectScript(): readonly (readonly Command[])[] {
  const world = mindWorld(SUBJECT_SEEDS[0], mindRuleset(), false);
  for (let tick = 1; tick < INJECTION_TICK; tick += 1) step(world, []);
  const { cell } = subjectBeing(world, INJECTED);
  const [x, y] = cell;
  const view = readView(world as BeingsWorld);
  const window = beings.senseWindow({
    prepared: PREPARED,
    species: SUBJECT_SPECIES,
    center: [x, y],
    view: { readChunk: (key) => view.readChunk(key) as beings.BeingsChunk | undefined },
    nowSeconds: view.tick * 12,
    simSecondsPerTick: 12,
  });
  const radius = (window.side - 1) / 2;
  const cue = window.foodCue[radius * window.side + radius];
  const payload = {
    being: INJECTED,
    cell: [x, y],
    p: { p: "m1.food-at", a: [{ c: [x, y] }], v: cue === 2 ? 0 : 2 },
    taints: 0,
  };
  const inject: Command = {
    applyTick: INJECTION_TICK,
    seq: 0,
    type: "mind.inject",
    origin: { kind: "admin" },
    payload,
  };
  return Array.from({ length: SUBJECT_TICKS }, (_, index) =>
    index + 1 === INJECTION_TICK ? [inject] : [],
  );
}

/** The ticks at which something the suite cuts at first happened in a run of the subject. */
export type Landmarks = {
  act: number;
  delivery: number;
  forgetting: number;
  revision: number;
  injection: number;
  room: number;
  chunk: number;
  dusk: number;
  day: number;
};

/** The first tick of the second day of the subject's world, and the first tick of its first dusk. */
const DAY_TICK = SUBJECT_DAY / 12;
const DUSK_TICK = duskTick();

/** The first tick whose light is dim after a tick whose light was not: sight falls to its dim. */
function duskTick(): number {
  const light = (tick: number) => worldgen.radiance(PREPARED, { tick, simSecondsPerTick: 12 });
  const { dimBelow } = SUBJECT_SPECIES.perception;
  for (let tick = 1; tick <= SUBJECT_TICKS; tick += 1)
    if (light(tick) < dimBelow && light(tick - 1) >= dimBelow) return tick;
  throw new Error("no dusk falls within the subject's run");
}

/** What an event of the beings marks: the first act, contest for room, delivery, or injection. */
const MARKS: Readonly<
  Record<string, (event: { activity?: string; reason?: string }) => keyof Landmarks | undefined>
> = {
  "being.started": ({ activity }) => (activity === "talk" ? "act" : undefined),
  "being.finished": ({ reason }) => (reason === "crowded" ? "room" : undefined),
  "speech.delivered": () => "delivery",
  "mind.injected": () => "injection",
};

/** What a `mind.changed` marks: a forgetting, a revision, both, or neither. */
function changed(payload: { forgot: readonly unknown[]; revised: readonly unknown[] }) {
  const marks: (keyof Landmarks)[] = [];
  if (payload.forgot.length > 0) marks.push("forgetting");
  if (payload.revised.length > 0) marks.push("revision");
  return marks;
}

/** The landmarks an event of a step marks. */
function landmarksOf({ type, payload }: StepResult["events"][number]): (keyof Landmarks)[] {
  if (type === "mind.changed") return changed(payload as Parameters<typeof changed>[0]);
  const mark = MARKS[type]?.(payload as { activity?: string; reason?: string });
  return mark === undefined ? [] : [mark];
}

/** A tracker of the landmarks of a run, fed each step and the world after it. */
export function landmarkTracker() {
  const found: Landmarks = {
    act: 0,
    delivery: 0,
    forgetting: 0,
    revision: 0,
    injection: 0,
    room: 0,
    chunk: 0,
    dusk: DUSK_TICK,
    day: DAY_TICK,
  };
  const firstAt = (name: keyof Landmarks, tick: number) => {
    if (found[name] === 0) found[name] = tick;
  };
  let chunks: ReadonlySet<string> | undefined;
  const track = (result: StepResult, world: World) => {
    for (const landmark of result.events.flatMap(landmarksOf)) firstAt(landmark, result.tick);
    const keys = new Set(readView(world).chunkKeys());
    if (chunks !== undefined && [...keys].some((key) => !chunks?.has(key)))
      firstAt("chunk", result.tick);
    chunks = keys;
  };
  return { found, track };
}
