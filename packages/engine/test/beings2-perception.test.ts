/**
 * Perception and the senses of beings@2 (ADR 0024, docs/architecture/mind.md "Perception"): other
 * beings within sight, by day or dim by the light against `perception.dimBelow`; attention, the K
 * nearest by Chebyshev distance, then id; only C0 members of each; the state at the start of the
 * tick, after its commands and before any being moves; nothing heard until T5-6; and the view of
 * the mind, built by mind.viewOf, which no taint and no C3 kind or bit ever reaches.
 */
import { describe, expect, test } from "bun:test";
import { type beings, type Command, mind, worldgen } from "../src/index.ts";
import {
  behavior,
  findCell,
  lightAt,
  PREPARED,
  runTo,
  spawn,
  walkMs,
  windowAt,
} from "./support/beings-world.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  gateMind,
  life2With,
  type Senses2,
} from "./support/beings2-world.ts";
import { belief, external, foodAt, heard, mindOf, relationship } from "./support/mind-records.ts";

type Cell = readonly [number, number];

/** What a brain sensed at a decision, with the id of the being that decided. */
type Sensed = { readonly id: number; readonly senses: Senses2 };

/** A brain that idles for ten minutes at every decision and records what it sensed. */
function recorder(sink: Sensed[]) {
  return brain2((senses) => {
    sink.push({ id: senses.self.id, senses });
    return { steps: [{ kind: "idle", ms: 600_000 }], wakeWhen: {}, behavior: behavior("rest") };
  });
}

/** The first row of `length` dry cells eastward, scanning from `from`, where beings may stand. */
function dryRow(from: Cell, length: number): Cell[] {
  const level = worldgen.liquidLevel(worldgen.genesisOf(PREPARED));
  for (let y = from[1]; y < from[1] + 64; y += 1) {
    for (let x = from[0]; x < from[0] + 64; x += 1) {
      const rect = { x, y, width: length, height: 1 };
      const { elevation } = worldgen.sampleSurface(PREPARED, rect, 0);
      if (elevation.every((value) => value >= level))
        return Array.from({ length }, (_, n) => [x + n, y] as const);
    }
  }
  throw new Error(`no row of ${length} dry cells near ${from}`);
}

/** Five dry cells in a row, a chunk away from the origin's edges. */
const ROW = dryRow([4, 4], 5);
const cellAt = (n: number): Cell => ROW[n] as Cell;

/** The spawns at tick 1 of beings on `cells`, in order: ids 1, 2, and so on. */
const spawnsOn = (cells: readonly Cell[], tick = 1): Command[] =>
  cells.map((cell, seq) => spawn(tick, { species: "s1", cell: [cell[0], cell[1]] }, seq));

/** Laws of life@2 whose perception is `perception`. */
const seeing = (perception: beings.Perception) =>
  life2With((species) => ({
    ...species,
    perception,
    speech: {
      ...species.speech,
      range: Math.max(1, Math.min(species.speech.range, perception.sight.dim)),
    },
  }));

/** The ids the being 1 perceived at its first decision in a world of `cells` under `life`. */
function perceivedBy(life: beings.LifeConfig2, cells: readonly Cell[]): number[] {
  const sink: Sensed[] = [];
  const world = beings2World({ controllers: { s1: recorder(sink) }, life });
  runTo(world, 2, spawnsOn(cells));
  const first = sink.find(({ id }) => id === 1);
  return first?.senses.perceived.beings.map(({ id }) => id) ?? [];
}

describe("perceiving other beings", () => {
  // The being 1 stands at ROW[0]; the others at distances 1, 3, and 4 along the row.
  const cells = [cellAt(0), cellAt(1), cellAt(3), cellAt(4)];

  test("by day, sees every being within sight.day cells and none beyond", () => {
    const life = seeing({ sight: { day: 3, dim: 1 }, dimBelow: 0, attention: 8 });
    expect(perceivedBy(life, cells)).toEqual([2, 3]);
  });

  test("in dim light, sees within sight.dim cells", () => {
    const life = seeing({ sight: { day: 3, dim: 1 }, dimBelow: 0x10_0000, attention: 8 });
    expect(perceivedBy(life, cells)).toEqual([2]);
  });

  test("is dim exactly when the light of the instant is below dimBelow", () => {
    const light = lightAt(2);
    const at = (dimBelow: number) =>
      perceivedBy(seeing({ sight: { day: 3, dim: 1 }, dimBelow, attention: 8 }), cells);
    expect(at(light)).toEqual([2, 3]);
    expect(at(light + 1)).toEqual([2]);
  });

  test("keeps the attention nearest, by distance, then id", () => {
    // Ids 2 to 5: at distance 2, 1, 1 (west), and 0 (the same cell).
    const around = [cellAt(1), cellAt(3), cellAt(2), cellAt(0), cellAt(1)];
    const at = (attention: number) =>
      perceivedBy(seeing({ sight: { day: 4, dim: 4 }, dimBelow: 0, attention }), around);
    expect(at(8)).toEqual([5, 3, 4, 2]);
    expect(at(2)).toEqual([5, 3]);
    expect(at(0)).toEqual([]);
  });

  test("gives only what an observer could see: id, species, cell, and the kind of activity", () => {
    const sink: Sensed[] = [];
    const world = beings2World({ controllers: { s1: recorder(sink) } });
    runTo(world, 2, spawnsOn([cellAt(0), cellAt(2)]));
    expect(sink.find(({ id }) => id === 1)?.senses.perceived).toEqual({
      beings: [{ id: 2, species: "s1", cell: [...cellAt(2)], activity: "idle" }],
      heard: [],
    });
  });

  test("sees a being spawned at the tick of the decision: commands apply before the system", () => {
    const sink: Sensed[] = [];
    const world = beings2World({ controllers: { s1: recorder(sink) } });
    runTo(world, 2, [...spawnsOn([cellAt(0)]), ...spawnsOn([cellAt(1)], 2)]);
    expect(sink.find(({ id }) => id === 1)?.senses.perceived.beings.map(({ id }) => id)).toEqual([
      2,
    ]);
  });
});

describe("perception from the state at the start of the tick", () => {
  /** A cell with passable steps east and north, and the milliseconds of the step east. */
  const START = findCell([4, 4], 48, {
    food: 0,
    accept: (_cell, window) =>
      walkMs(window, "0") !== undefined && walkMs(window, "2") !== undefined,
  });
  const STEP_MS = (walkMs(windowAt(START), "0") as number[])[0] as number;
  /** The tick at which a step east started at tick 2 arrives. */
  const ARRIVAL = 2 + Math.ceil(STEP_MS / 12_000);

  test("shows a being that moves at this tick where it stood, walking on its step", () => {
    const sink: Sensed[] = [];
    const controller = brain2((senses) => {
      const first = senses.self.outcome.result === "none";
      if (senses.self.id === 1 && first)
        return { steps: [{ kind: "walk", dirs: "0" }], wakeWhen: {}, behavior: behavior("travel") };
      if (senses.self.id === 2) sink.push({ id: 2, senses });
      const ms = senses.self.id === 2 && first ? (ARRIVAL - 2) * 12_000 : 6_000_000;
      return { steps: [{ kind: "idle", ms }], wakeWhen: {}, behavior: behavior("rest") };
    });
    const world = beings2World({ controllers: { s1: controller } });
    const watcher: Cell = [START[0], START[1] + 1];
    const events = runTo(world, ARRIVAL, spawnsOn([START, watcher]));
    // The walker, processed first at ARRIVAL, ended its walk there; the watcher decided after it.
    expect(
      events
        .filter((event) => event.tick === ARRIVAL && event.type === "being.finished")
        .map(({ payload }) => payload),
    ).toContainEqual({ id: 1, activity: "walk", result: "done", reason: "" });
    expect(sink.map(({ senses }) => senses.perceived.beings)).toEqual([
      [{ id: 1, species: "s1", cell: [...START], activity: "idle" }],
      [{ id: 1, species: "s1", cell: [...START], activity: "walk", direction: 0 }],
    ]);
    expect(ARRIVAL).toBeGreaterThan(2);
  });
});

describe("the view of a mind in the senses", () => {
  /** The context of a decision at `tick` of a being of neutral traits under the default laws. */
  const contextAt = (tick: number): mind.MindContext => ({
    moment: { tick, secondsPerTick: 12 },
    laws: mind.defaultMindLaws(),
    retention: 1000,
  });

  test("is mind.viewOf of the mind the chunk holds, at the tick of the decision", () => {
    const sink: Sensed[] = [];
    const placed = being2(1, cellAt(0), { mind: gateMind() });
    const world = beings2World({ controllers: { s1: recorder(sink) }, chunks: chunksOf([placed]) });
    runTo(world, 1);
    expect(sink[0]?.senses.mind).toEqual(mind.viewOf(gateMind(), contextAt(1)));
  });

  test("never holds a taint, the exposure, the kind external, or the evidence bit 8", () => {
    const tainted = mindOf({
      episodes: [heard(1, 41, { tn: 2, ex: 4 }), external(2, { tn: 2 })],
      beliefs: [belief(3, { ev: [1, 2], tn: 2, ex: 4, who: 41, src: 10 })],
      relations: [relationship(4, 41, { tn: 1 })],
      inbox: [{ who: 41, t: 0, cell: [1, 1], act: "tell", p: foodAt(1, 1), band: 1, tn: 2, ex: 4 }],
      exposure: 7,
    });
    const sink: Sensed[] = [];
    const placed = being2(1, cellAt(0), { mind: tainted });
    const world = beings2World({ controllers: { s1: recorder(sink) }, chunks: chunksOf([placed]) });
    runTo(world, 1);
    const senses = sink[0]?.senses as Senses2;
    expect(senses.mind).toEqual(mind.viewOf(tainted, contextAt(1)));
    expect(forbiddenIn(senses)).toEqual([]);
    expect(senses.mind.beliefs[0]?.src).toBe(2);
    expect(senses.mind.episodes.map(({ kind }) => kind)).toEqual(["heard", "heard"]);
  });

  test("gives self the members of T4's senses with six traits, and no mind", () => {
    const sink: Sensed[] = [];
    const world = beings2World({ controllers: { s1: recorder(sink) } });
    runTo(world, 2, spawnsOn([cellAt(0)]));
    const self = sink[0]?.senses.self;
    expect(Object.keys(self ?? {}).sort()).toEqual([
      "activity",
      "behavior",
      "cell",
      "condition",
      "cooldowns",
      "health",
      "id",
      "needs",
      "outcome",
      "species",
      "traits",
    ]);
    expect(Object.keys(self?.traits ?? {}).sort()).toEqual([
      "appetite",
      "credulity",
      "curiosity",
      "retention",
      "sleepiness",
      "sociability",
    ]);
    expect(Object.keys(sink[0]?.senses ?? {}).sort()).toEqual([
      "draws",
      "light",
      "mind",
      "perceived",
      "self",
      "window",
    ]);
  });
});

/**
 * Every place in `value` where something a brain must never see appears: a member `tn`, `ex`,
 * `exposure`, or `inbox`; a kind `external`; or a `src` with the evidence bit 8.
 */
function forbiddenIn(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => forbiddenIn(entry, `${path}/${index}`));
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return [];
  return Object.entries(value).flatMap(([key, member]) => [
    ...(isForbidden(key, member) ? [`${path}/${key}`] : []),
    ...forbiddenIn(member, `${path}/${key}`),
  ]);
}

/** Whether the member `key` holding `member` is something a brain must never see. */
function isForbidden(key: string, member: unknown): boolean {
  if (["tn", "ex", "exposure", "inbox"].includes(key)) return true;
  if (key === "kind") return member === "external";
  return key === "src" && typeof member === "number" && (member & 8) !== 0;
}
