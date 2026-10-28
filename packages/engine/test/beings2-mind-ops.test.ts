/**
 * The mental operations of beings@2 (ADR 0024, docs/architecture/mind.md "Perception" and
 * "Beliefs"), through real intentions in real worlds: `remember` makes episodes the engine copies
 * from the percepts of the decision, which the brain only references; new records take their ids
 * from `next` in the order of their kinds; `recall`, `believe`, `revise`, and `drop` apply through
 * the mind layer; every reason of the table of rejections comes from an intention that fails; the
 * operations are atomic; and brain output that is hostile is refused before anything is copied.
 */
import { describe, expect, test } from "bun:test";
import { beings, type EngineEvent, mind, readView, worldgen } from "../src/index.ts";
import {
  type BeingsWorld,
  baseFood,
  behavior,
  beingOf,
  beingsWorld,
  chunkOf,
  findCell,
  runTo,
  spawn,
  windowAt,
} from "./support/beings-world.ts";
import {
  bandOf,
  baseBand,
  type Cell,
  cellOf,
  eventsOf,
  idling,
  isFirst,
  standable,
  standingPair,
} from "./support/beings2-mind.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  life2With,
  type Senses2,
  SPECIES2,
} from "./support/beings2-world.ts";
import { belief, mindOf, own, relationship, seen } from "./support/mind-records.ts";

/** A long idle, after which nothing else happens in these tests. */
const LONG = 6_000_000;

/** The index of `idle` in the kinds of activity of beings@2: eat, idle, sleep, walk. */
const IDLE = 1;

/** The corner of the region these tests search: food is sparse in the test genesis. */
const SEARCH: Cell = [-128, -128];

/** A cell where a being may stand, with food under it. */
const CELL: Cell = findCell(SEARCH, 256, { food: 40, accept: (cell) => standable(cell) });

/** The corner of a region around CELL, where food is. */
const NEAR: Cell = [CELL[0] - 16, CELL[1] - 16];

/** The window's radius around a being: half its side, less the center. */
const RADIUS = (windowAt(CELL).side - 1) / 2;

/** A food-at proposition of the test brains' namespace, at `cell`, with the band `band`. */
const foodAt = (cell: Cell, band: number): mind.Proposition => ({
  p: "t1.food-at",
  a: [{ c: [cell[0], cell[1]] }],
  v: band,
});

/**
 * The mind of these tests: an episode of food (1), a perceived being (2), a belief citing the
 * first (3), a belief citing that belief (4), and a relationship (5); `next` is 6.
 */
const HELD = mindOf({
  episodes: [own(1, { cell: [CELL[0], CELL[1]] }), seen(2, 40)],
  beliefs: [belief(3, { ev: [1] }), belief(4, { ev: [3], dp: 2 })],
  relations: [relationship(5, 40)],
});

/** A brain that proposes `first` at its first decision, and a long idle after it. */
function proposing(first: (senses: Senses2) => unknown) {
  return brain2((senses) => (isFirst(senses) ? (first(senses) as never) : idling(LONG)));
}

/** The being 1 holding `held` on `cell`, after its first decision at tick 1, and the events. */
function decideOnce(
  first: (senses: Senses2) => unknown,
  options: { readonly held?: mind.Mind; readonly life?: beings.LifeConfig2 } = {},
): { readonly being: beings.Being2; readonly events: EngineEvent[] } {
  const placed = [being2(1, CELL, { mind: options.held ?? HELD })];
  const world = beings2World({
    controllers: { s1: proposing(first) },
    chunks: chunksOf(placed),
    ...(options.life === undefined ? {} : { life: options.life }),
  });
  const events = runTo(world, 1);
  return { being: beingOf(world, 1) as beings.Being2, events };
}

/** The first decision of the being 1 holding `held` with the mental operations `ops`. */
const withOps = (ops: unknown, options: Parameters<typeof decideOnce>[1] = {}) =>
  decideOnce(() => ({ ...idling(LONG), mind: ops }), options);

/** A valid `remember` of the food under the being, which an operation after it may undo. */
const REMEMBER_FOOD = { percept: { food: [CELL[0], CELL[1]] }, w: 500 };

describe("remember", () => {
  test("gives two beings in different situations different episodes, each equal to its percept", () => {
    const [a, b] = standingPair(NEAR, [2, 0], (x, y) => baseBand(x) === 2 && baseBand(y) < 2);
    const sensed: Senses2[] = [];
    const brain = brain2((senses) => {
      if (!isFirst(senses)) return idling(LONG);
      sensed.push(senses);
      const remember = [
        { percept: { food: cellOf(senses) }, w: 500 },
        { percept: { being: 0 }, w: 600 },
      ];
      return idling(LONG, { remember });
    });
    const placed = [being2(1, a), being2(2, b)];
    const world = beings2World({ controllers: { s1: brain }, chunks: chunksOf(placed) });
    runTo(world, 1);
    const expected = (cell: Cell, other: Cell, who: number): mind.Episode[] => [
      { id: 1, kind: "food", t: 1, cell: [cell[0], cell[1]], v: baseBand(cell), w: 500, r: 1 },
      { id: 2, kind: "being", t: 1, cell: [other[0], other[1]], who, v: IDLE, w: 600, r: 1 },
    ];
    const first = beingOf(world, 1) as beings.Being2;
    const second = beingOf(world, 2) as beings.Being2;
    expect(first.mind.episodes).toEqual(expected(a, b, 2));
    expect(second.mind.episodes).toEqual(expected(b, a, 1));
    expect(first.mind.episodes).not.toEqual(second.mind.episodes);
    expect([first.mind.next, second.mind.next]).toEqual([3, 3]);
    // Each episode is the percept the brain was given: the cue at the center, the being it saw.
    for (const [index, senses] of sensed.entries()) {
      const held = (index === 0 ? first : second).mind.episodes;
      const center = RADIUS * senses.window.side + RADIUS;
      const other = senses.perceived.beings[0] as beings.PerceivedBeing;
      expect(held[0]).toMatchObject({ v: senses.window.foodCue[center] });
      expect(held[1]).toMatchObject({ cell: other.cell, who: other.id, v: IDLE });
    }
  });

  test("makes an observation whose belief traces back to a percept matching the state of its tick", () => {
    // Food of band 2 that one bite of 25 units brings below `plenty`.
    const cell = findCell(SEARCH, 256, {
      food: SPECIES2.diet.cue.plenty,
      accept: (at) => standable(at) && bandOf(baseFood(at) - SPECIES2.diet.biteUnits) < 2,
    });
    const brain = brain2((senses) => {
      if (isFirst(senses))
        return {
          steps: [{ kind: "eat", untilNutrition: beings.NEED_MAX }],
          wakeWhen: {},
          behavior: behavior("eat"),
        };
      if (senses.self.outcome.units === undefined || senses.mind.beliefs.length > 0)
        return idling(LONG);
      const { next } = senses.mind;
      const center = RADIUS * senses.window.side + RADIUS;
      const band = senses.window.foodCue[center] as number;
      const here = cellOf(senses);
      return idling(LONG, {
        remember: [
          { percept: { food: here }, w: 300 },
          { percept: { outcome: true }, w: 300 },
        ],
        believe: [{ p: foodAt(here, band), cr: 900, ev: [next, next + 1], rule: "saw-food" }],
      });
    });
    const placed = [
      being2(1, cell, {
        mind: mind.newMind(0),
        needs: { nutrition: 850_000, rest: beings.NEED_MAX },
      }),
    ];
    const world = beings2World({ controllers: { s1: brain }, chunks: chunksOf(placed) });
    const events = runTo(world, 40);
    const [ate] = eventsOf(events, "being.ate", 1);
    const [changed] = eventsOf(events, "mind.changed", 1);
    if (ate === undefined || changed === undefined)
      throw new Error("the being neither ate nor believed");
    const decided = changed.tick;
    const held = (beingOf(world, 1) as beings.Being2).mind;
    // The state at the start of the deciding tick: the cell less what the meal took, regrown since.
    const entry = depletionAt(world, cell);
    const missing = beings.takenAt(entry, SPECIES2.regrowth, (decided - entry.since) * 12);
    const band = bandOf(Math.max(0, baseFood(cell) - missing));
    expect(band).not.toBe(baseBand(cell));
    expect(held.episodes).toEqual([
      { id: 1, kind: "food", t: decided, cell: [...cell], v: band, w: 500, r: decided },
      {
        id: 2,
        kind: "ate",
        t: ate.tick,
        cell: [...cell],
        v: SPECIES2.diet.biteUnits,
        w: 500,
        r: decided,
      },
    ]);
    expect(held.beliefs).toEqual([
      {
        id: 3,
        p: foodAt(cell, band),
        cr: 900,
        src: mind.EVIDENCE.seen,
        ev: [1, 2],
        lost: 0,
        tn: 0,
        ex: 0,
        dp: 1,
        u: decided,
      },
    ]);
  });

  test("copies a perceived being, the food of a cell of the window, and the outcome, never the brain's", () => {
    // A brain that writes over every percept it was given before it proposes.
    const [a, b] = standingPair([0, 0], [1, 1], () => true);
    const brain = brain2((senses) => {
      if (!isFirst(senses)) return idling(LONG);
      const writable = senses as unknown as {
        perceived: { beings: { cell: number[]; id: number; activity: string }[] };
        window: { foodCue: Uint8Array };
      };
      const [other] = writable.perceived.beings;
      if (other !== undefined) {
        other.cell[0] = 999;
        other.id = 999;
        other.activity = "walk";
      }
      writable.window.foodCue.fill(2);
      const [x, y] = cellOf(senses);
      const edge: Cell = [x + RADIUS, y - RADIUS];
      return idling(LONG, {
        remember: [
          { percept: { being: 0 }, w: 10 },
          { percept: { food: edge }, w: 20 },
        ],
      });
    });
    const world = beings2World({
      controllers: { s1: brain },
      chunks: chunksOf([being2(1, a), being2(2, b)]),
    });
    runTo(world, 1);
    const edge: Cell = [a[0] + RADIUS, a[1] - RADIUS];
    const window = windowAt(a);
    const cue = window.foodCue[window.side - 1] as number;
    // Not vacuous: what the brain wrote over its copies differs from what the engine perceived.
    expect(cue).not.toBe(2);
    expect((beingOf(world, 1) as beings.Being2).mind.episodes).toEqual([
      { id: 1, kind: "being", t: 1, cell: [...b], who: 2, v: 1, w: 10, r: 1 },
      { id: 2, kind: "food", t: 1, cell: [...edge], v: cue, w: 20, r: 1 },
    ]);
  });

  test("makes a failed episode of a failed outcome, with the index of its reason, and its tick", () => {
    // An eat step on a cell with no food fails at once: the being decides again at the next tick.
    const barren = findBarren();
    const brain = brain2((senses) => {
      if (isFirst(senses))
        return {
          steps: [{ kind: "eat", untilNutrition: 10 }],
          wakeWhen: {},
          behavior: behavior("eat"),
        };
      if (senses.mind.episodes.length > 0) return idling(LONG);
      return idling(LONG, { remember: [{ percept: { outcome: true }, w: 400 }] });
    });
    const world = beings2World({
      controllers: { s1: brain },
      chunks: chunksOf([being2(1, barren)]),
    });
    runTo(world, 20);
    const [episode] = (beingOf(world, 1) as beings.Being2).mind.episodes;
    const outcome = beingOf(world, 1).outcome;
    expect(episode).toMatchObject({
      kind: "failed",
      cell: [...barren],
      v: mind.FAILURES.indexOf("no_food"),
      w: 400,
    });
    expect(outcome.result).toBe("failed");
    expect(episode?.t).toBe(outcome.tick);
  });

  test("saturates the units of an ate episode at 2^20, the largest value an episode holds", () => {
    // A meal of 2^21 units: valid laws allow more than 2^20, e.g. two bites of 600,000.
    const meal = { result: "done", tick: 0, reason: "", units: 2 ** 21 };
    const placed = [{ ...being2(1, CELL, { mind: HELD }), outcome: meal }];
    const brain = brain2((senses) =>
      senses.mind.next === HELD.next
        ? idling(LONG, { remember: [{ percept: { outcome: true }, w: 500 }] })
        : idling(LONG),
    );
    const world = beings2World({ controllers: { s1: brain }, chunks: chunksOf(placed) });
    runTo(world, 1);
    expect((beingOf(world, 1) as beings.Being2).mind.episodes.at(-1)).toEqual({
      id: 6,
      kind: "ate",
      t: 0,
      cell: [CELL[0], CELL[1]],
      v: mind.MIND_BOUNDS.value.max,
      w: 500,
      r: 1,
    });
  });

  test("caps a new importance below the pin level once the pins are taken", () => {
    const pinned = mindOf({
      episodes: [own(1, { w: 950 }), own(2, { w: 900 })],
      beliefs: [],
    });
    const { being } = withOps(
      { remember: [{ percept: { food: [...CELL] }, w: 1000 }] },
      { held: pinned },
    );
    expect(being.mind.episodes.map(({ id, w }) => [id, w])).toEqual([
      [1, 950],
      [2, 900],
      [3, 899],
    ]);
  });

  test("evicts from a full store the lowest salience, the new episode included, which keeps its id", () => {
    const full = mindOf({
      episodes: Array.from({ length: 8 }, (_, n) => own(n + 1, { w: 500 + n })),
    });
    const { being, events } = withOps(
      { remember: [{ percept: { food: [...CELL] }, w: 100 }] },
      { held: full },
    );
    expect(being.mind.episodes.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(being.mind.next).toBe(10);
    expect(eventsOf(events, "mind.changed", 1).map(({ payload }) => payload)).toEqual([
      {
        id: 1,
        encoded: [9],
        formed: [],
        revised: [],
        dropped: [],
        forgot: [{ id: 9, beliefs: [] }],
        related: [],
      },
    ]);
  });
});

describe("the ids of new records", () => {
  test("follow `next` in the order of the kinds, so a brain cites records it creates by prediction", () => {
    const held = mindOf({
      next: 10,
      episodes: [own(3, { cell: [CELL[0], CELL[1]] })],
      beliefs: [belief(7, { ev: [3] })],
    });
    const { being } = decideOnce(
      (senses) =>
        idling(LONG, {
          // Given before `remember`, `believe` still applies after it, so 10 and 11 exist.
          believe: [
            {
              p: foodAt(CELL, 1),
              cr: 600,
              ev: [senses.mind.next, senses.mind.next + 1],
              rule: "a",
            },
            { p: foodAt(CELL, 2), cr: 700, ev: [senses.mind.next + 2, 7], rule: "b" },
          ],
          remember: [
            { percept: { food: [CELL[0], CELL[1]] }, w: 300 },
            { percept: { food: [CELL[0] + 1, CELL[1]] }, w: 300 },
          ],
        }),
      { held },
    );
    expect(being.mind.next).toBe(14);
    expect(being.mind.episodes.map(({ id }) => id)).toEqual([3, 10, 11]);
    expect(being.mind.beliefs.map(({ id, ev, dp }) => [id, ev, dp])).toEqual([
      [7, [3], 1],
      [12, [10, 11], 1],
      [13, [12, 7], 2],
    ]);
  });
});

describe("recall, believe, revise, and drop", () => {
  test("recall refreshes an episode: its importance grows by `recall` from its salience, anchored now", () => {
    const { being } = withOps({ recall: [1] });
    expect(being.mind.episodes[0]).toMatchObject({ id: 1, w: 700, r: 1 });
    expect(being.mind.episodes[1]).toEqual(HELD.episodes[1] as mind.Episode);
  });

  test("believe, revise, and drop apply in that order through the mind layer", () => {
    const { being } = withOps({
      drop: [4],
      revise: [{ id: 3, cr: 300, ev: [2] }],
      believe: [{ p: foodAt(CELL, 2), cr: 800, ev: [3, 5], rule: "infer" }],
    });
    expect(being.mind.beliefs).toEqual([
      { ...(HELD.beliefs[0] as mind.Belief), cr: 300, src: 1, ev: [1, 2], u: 1 },
      {
        id: 6,
        p: foodAt(CELL, 2),
        cr: 800,
        src: mind.EVIDENCE.inferred,
        ev: [3, 5],
        lost: 0,
        tn: 0,
        ex: 0,
        dp: 2,
        u: 1,
      },
    ]);
  });

  test("accepts a concept of the observables of the catalog, and an empty set of operations", () => {
    const observable = { p: "obs.deposit.0", a: [{ c: [CELL[0], CELL[1]] }], v: 30 };
    const { being } = withOps({ believe: [{ p: observable, cr: 500, ev: [1], rule: "measure" }] });
    expect(being.mind.beliefs.at(-1)).toMatchObject({ id: 6, p: observable });
    for (const none of [{}, { remember: [], recall: [], believe: [], revise: [], drop: [] }]) {
      const { being: unchanged, events } = withOps(none);
      expect(unchanged.mind).toEqual(HELD);
      expect(unchanged.outcome.result).toBe("none");
      expect(events.filter(({ type }) => type.startsWith("mind."))).toEqual([]);
    }
  });
});

/** A standable cell with no food: an eat step there fails at once. */
function findBarren(): Cell {
  for (let y = 0; y < 128; y += 1)
    for (let x = 0; x < 128; x += 1) if (standable([x, y]) && baseFood([x, y]) === 0) return [x, y];
  throw new Error("no barren standable cell near the origin");
}

/** The depletion entry of `cell` in `world`; throws when the cell was never eaten from. */
function depletionAt(world: BeingsWorld, cell: Cell): beings.Depletion {
  const chunk = readView(world).readChunk(chunkOf(cell));
  const index = worldgen.cellOffset(cell[1]) * worldgen.CHUNK_CELLS + worldgen.cellOffset(cell[0]);
  const entry = chunk?.depletion.find((candidate) => candidate.cell === index);
  if (entry === undefined) throw new Error(`no depletion at ${cell}`);
  return entry;
}

/** The outcome, rejection events, and mind after a first decision with the operations `ops`. */
function rejection(ops: unknown, options: Parameters<typeof decideOnce>[1] = {}) {
  const { being, events } = withOps(ops, options);
  return {
    outcome: being.outcome,
    rejected: eventsOf(events, "being.intention_rejected", 1).map(({ payload }) => payload),
    mindEvents: events.filter(({ type }) => type.startsWith("mind.")).length,
    mind: being.mind,
    behavior: being.behavior,
  };
}

/** The cases of the table of rejections: a name, the operations, the reason, and the laws. */
type Case = {
  readonly name: string;
  readonly ops: unknown;
  readonly reason: string;
  readonly held?: mind.Mind;
  readonly life?: beings.LifeConfig2;
};

/** A belief operation of the test namespace on the food under the being, citing `ev`. */
const believing = (ev: readonly number[], change: object = {}) => ({
  p: foodAt(CELL, 2),
  cr: 500,
  ev,
  rule: "test-rule",
  ...change,
});

/** Laws whose deepest inference is 2. */
const shallow = life2With((species) => ({ ...species, mind: { ...species.mind, depth: 2 } }));

/** A mind whose ids have run out: `next` is 2^31 − 1. */
const EXHAUSTED = { ...HELD, next: mind.INT31_MAX };

/** Each case is preceded by a valid `remember`, which the failure undoes with everything else. */
const CASES: readonly Case[] = [
  { name: "relate, which arrives in T5-5b", ops: { relate: [] }, reason: "mind_malformed" },
  { name: "a member mind does not have", ops: { forget: [1] }, reason: "mind_malformed" },
  { name: "a mind that is not a record", ops: [], reason: "mind_malformed" },
  { name: "a kind that is not a list", ops: { recall: 1 }, reason: "mind_malformed" },
  {
    name: "more operations in all than mind.ops",
    ops: { recall: [1, 1, 1, 1] },
    reason: "mind_malformed",
  },
  {
    name: "more operations of one kind than mind.ops",
    ops: { recall: [1, 1, 1, 1, 1] },
    reason: "mind_malformed",
  },
  {
    name: "an importance above 1000",
    ops: { remember: [{ percept: { outcome: true }, w: 1001 }] },
    reason: "mind_malformed",
  },
  {
    name: "a percept of two members",
    ops: { remember: [{ percept: { being: 0, outcome: true }, w: 1 }] },
    reason: "mind_malformed",
  },
  {
    name: "a percept of the outcome that is not true",
    ops: { remember: [{ percept: { outcome: false }, w: 1 }] },
    reason: "mind_malformed",
  },
  {
    name: "a food percept outside the world",
    ops: { remember: [{ percept: { food: [2 ** 31, 0] }, w: 1 }] },
    reason: "mind_malformed",
  },
  {
    name: "an unknown member of an operation",
    ops: { remember: [{ percept: { outcome: true }, w: 1, why: 1 }] },
    reason: "mind_malformed",
  },
  {
    name: "a rule that is not an identifier",
    ops: { believe: [believing([1], { rule: "Saw Food" })] },
    reason: "mind_malformed",
  },
  {
    name: "a rule of 33 characters",
    ops: { believe: [believing([1], { rule: "r".repeat(33) })] },
    reason: "mind_malformed",
  },
  {
    name: "a concept of another namespace",
    ops: { believe: [believing([1], { p: { p: "m1.food-at", a: [{ c: [0, 0] }] } })] },
    reason: "mind_malformed",
  },
  {
    name: "obs. and no observable of the catalog",
    ops: { believe: [believing([1], { p: { p: "obs.nothing", a: [{ n: 1 }] } })] },
    reason: "mind_malformed",
  },
  {
    name: "a proposition with no terms",
    ops: { believe: [believing([1], { p: { p: "t1.x", a: [] } })] },
    reason: "mind_malformed",
  },
  { name: "four citations", ops: { believe: [believing([1, 2, 3, 5])] }, reason: "mind_malformed" },
  { name: "a citation repeated", ops: { believe: [believing([1, 1])] }, reason: "mind_malformed" },
  { name: "a local id of 0", ops: { recall: [0] }, reason: "mind_malformed" },
  {
    name: "a confidence below 0",
    ops: { revise: [{ id: 3, cr: -1, ev: [2] }] },
    reason: "mind_malformed",
  },
  {
    name: "a belief once ids have run out",
    ops: { believe: [believing([1])] },
    reason: "mind_malformed",
    held: EXHAUSTED,
  },
  {
    name: "an episode once ids have run out",
    ops: { remember: [{ percept: { food: [...CELL] }, w: 1 }] },
    reason: "mind_malformed",
    held: EXHAUSTED,
  },
  {
    name: "recall of an id the mind does not hold",
    ops: { recall: [99] },
    reason: "unknown_record",
  },
  { name: "recall of a belief", ops: { recall: [3] }, reason: "unknown_record" },
  {
    name: "a being not perceived",
    ops: { remember: [{ percept: { being: 0 }, w: 1 }] },
    reason: "unknown_record",
  },
  {
    name: "a message, before speech",
    ops: { remember: [{ percept: { heard: 0 }, w: 1 }] },
    reason: "unknown_record",
  },
  {
    name: "a cell outside the window",
    ops: { remember: [{ percept: { food: [CELL[0] + RADIUS + 1, CELL[1]] }, w: 1 }] },
    reason: "unknown_record",
  },
  {
    name: "an outcome with no episode: the spawn's none",
    ops: { remember: [{ percept: { outcome: true }, w: 1 }] },
    reason: "unknown_record",
  },
  {
    name: "a belief citing a record not held",
    ops: { believe: [believing([99])] },
    reason: "unknown_record",
  },
  {
    name: "a revision of a belief not held",
    ops: { revise: [{ id: 99, cr: 1, ev: [1] }] },
    reason: "unknown_record",
  },
  {
    name: "a revision of an episode",
    ops: { revise: [{ id: 1, cr: 1, ev: [2] }] },
    reason: "unknown_record",
  },
  { name: "a drop of a belief not held", ops: { drop: [99] }, reason: "unknown_record" },
  { name: "a drop of an episode", ops: { drop: [1] }, reason: "unknown_record" },
  { name: "a belief dropped twice", ops: { drop: [4, 4] }, reason: "unknown_record" },
  {
    name: "a revision citing a belief of a higher id",
    ops: { revise: [{ id: 3, cr: 1, ev: [4] }] },
    reason: "premise_order",
  },
  {
    name: "a revision citing itself",
    ops: { revise: [{ id: 4, cr: 1, ev: [4] }] },
    reason: "premise_order",
  },
  {
    name: "a revision with nothing new",
    ops: { revise: [{ id: 3, cr: 1, ev: [1] }] },
    reason: "premise_order",
  },
  {
    name: "a revision with no evidence",
    ops: { revise: [{ id: 3, cr: 1, ev: [] }] },
    reason: "premise_order",
  },
  {
    name: "a belief deeper than mind.depth",
    ops: { believe: [believing([4])] },
    reason: "depth_exceeded",
    life: shallow,
  },
  {
    name: "a revision that deepens a belief beyond mind.depth",
    ops: { revise: [{ id: 6, cr: 1, ev: [4] }] },
    reason: "depth_exceeded",
    held: { ...HELD, beliefs: [...HELD.beliefs, belief(6)], next: 7 },
    life: shallow,
  },
];

describe("the rejections of mental operations", () => {
  test.each(CASES.map((one) => [one.name, one] as const))("%s", (_, one) => {
    const ops = one.ops;
    const withRemember =
      typeof ops === "object" && ops !== null && !Array.isArray(ops) && !("remember" in ops)
        ? { ...ops, remember: [REMEMBER_FOOD] }
        : ops;
    // A mind whose ids ran out cannot take the extra episode.
    const tight = one.held === EXHAUSTED;
    const held = one.held ?? HELD;
    const options = { held, ...(one.life === undefined ? {} : { life: one.life }) };
    const result = rejection(tight ? ops : withRemember, options);
    expect(result.outcome).toEqual({ result: "rejected", tick: 1, reason: one.reason });
    expect(result.rejected).toEqual([{ id: 1, reason: one.reason }]);
    // Atomic: nothing applied, the remember before it included, and nothing faded at tick 1.
    expect(result.mind).toEqual(held);
    expect(result.mindEvents).toBe(0);
    expect(result.behavior).toEqual({ kind: "none", since: 0, heading: 0 });
  });

  test("applies the same operations once the failing one is removed: the rejections are not vacuous", () => {
    const valid = {
      remember: [REMEMBER_FOOD],
      believe: [believing([1])],
      revise: [{ id: 3, cr: 100, ev: [2] }],
    };
    const applied = rejection(valid);
    expect(applied.outcome.result).toBe("none");
    expect(applied.mind.next).toBe(8);
    expect(applied.mindEvents).toBe(2);
    const failing = rejection({ ...valid, drop: [99] });
    expect(failing.outcome.reason).toBe("unknown_record");
    expect(failing.mind).toEqual(HELD);
  });

  test("rejects a malformed body before its operations, and its operations before its walk", () => {
    const both = decideOnce(() => ({
      ...idling(LONG),
      behavior: behavior("dance"),
      mind: { relate: [] },
    }));
    expect(both.being.outcome.reason).toBe("malformed");
    const blocked = decideOnce(() => ({
      steps: [{ kind: "walk", dirs: "0".repeat(64) }],
      wakeWhen: {},
      behavior: behavior("travel"),
      mind: { relate: [] },
    }));
    expect(blocked.being.outcome.reason).toBe("mind_malformed");
    const walk = decideOnce(() => ({
      steps: [{ kind: "walk", dirs: "0".repeat(64) }],
      wakeWhen: {},
      behavior: behavior("travel"),
      mind: { recall: [99] },
    }));
    expect(walk.being.outcome.reason).toBe("walk_blocked");
  });
});

describe("hostile mental operations", () => {
  test("refuse a list too long for any legal operations before reading any of its entries", () => {
    let reads = 0;
    const entries = Array.from({ length: 100_000 }, () => ({ percept: { outcome: true }, w: 1 }));
    const counted = new Proxy(entries, {
      getOwnPropertyDescriptor(target, key) {
        if (key !== "length") reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(rejection({ remember: counted }).outcome.reason).toBe("mind_malformed");
    expect(reads).toBe(0);
    const sparse: unknown[] = [];
    sparse.length = 2 ** 32 - 1;
    expect(rejection({ recall: sparse }).outcome.reason).toBe("mind_malformed");
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`k${n}`, n]));
    expect(rejection({ remember: [{ percept: wide, w: 1 }] }).outcome.reason).toBe(
      "mind_malformed",
    );
    expect(rejection({ believe: [believing([1], { rule: "r".repeat(65) })] }).outcome.reason).toBe(
      "mind_malformed",
    );
  });

  test("refuse what is not canonical as malformed, as the rest of an intention", () => {
    const getter = {
      get w() {
        return 1;
      },
      percept: { outcome: true },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const throwing = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    // é as e and a combining acute accent: not in NFC.
    const decomposed = String.fromCharCode(0x65, 0x301);
    const shared = { percept: { outcome: true }, w: 1 };
    const cases: unknown[] = [
      { remember: [getter] },
      { remember: [revoked.proxy] },
      revoked.proxy,
      throwing,
      { believe: [believing([1], { rule: decomposed })] },
      { remember: [shared, shared] },
      { recall: [1.5] },
    ];
    for (const ops of cases) expect(rejection(ops).outcome.reason).toBe("malformed");
    const accessor = decideOnce(() => {
      const intention = idling(LONG);
      Object.defineProperty(intention, "mind", { enumerable: true, get: () => ({}) });
      return intention;
    });
    expect(accessor.being.outcome.reason).toBe("malformed");
  });

  test("accept a benign Proxy of a valid record, which the copy reads through its descriptors", () => {
    const proxied = new Proxy({ recall: [1] }, {});
    expect(rejection(proxied).mind.episodes[0]).toMatchObject({ id: 1, w: 700, r: 1 });
  });
});

describe("beings@1", () => {
  test("still rejects an intention with a mind member as malformed", () => {
    const world = beingsWorld({
      controllers: {
        s1: {
          brain: "mindful@1",
          decide: () => ({ ...idling(LONG), mind: {} }) as beings.Intention,
        },
      },
    });
    runTo(world, 2, [spawn(1, { species: "s1", cell: [CELL[0], CELL[1]] })]);
    expect(beingOf(world, 1).outcome).toEqual({ result: "rejected", tick: 2, reason: "malformed" });
  });
});
