/**
 * The ledger of the minds of beings@2 (ADR 0024, docs/architecture/mind.md "Time, salience, and
 * forgetting", "Provenance and taints", "The tick of beings@2", and "Events"): a decision with
 * changes to a mind emits one `mind.changed` (C1) and one `mind.provenance` (C3), after the being's
 * other events of the second phase, and a decision without changes emits neither; forgetting is
 * applied when the being decides, before its brain gets the view, and stays when the intention is
 * rejected; the view is the same whether the being decided often or seldom; taints flow downstream
 * and the exposure grows; and a mind is written anew only by a decision that changed it.
 */
import { describe, expect, test } from "bun:test";
import { beings, type EngineEvent, type mind } from "../src/index.ts";
import { behavior, beingOf, findCell, runTo, walkMs } from "./support/beings-world.ts";
import {
  type Cell,
  type Committed,
  cellOf,
  eventsAt,
  eventsOf,
  idling,
  isFirst,
  standable,
  watchedWorld,
} from "./support/beings2-mind.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  life2With,
  type Senses2,
} from "./support/beings2-world.ts";
import { belief, heard, mindOf, own } from "./support/mind-records.ts";

const LONG = 6_000_000;

/** A cell where a being may stand, from which it can walk four steps east. */
const CELL: Cell = findCell([-128, -128], 256, {
  food: 0,
  accept: (cell, window) => standable(cell) && walkMs(window, "0000") !== undefined,
});

/** A proposition of the test brains' namespace. */
const concept = (name: string, n: number): mind.Proposition => ({ p: `t1.${name}`, a: [{ n }] });

/** Laws of life@2 whose `mind` is changed by `change`. */
const lawsOf = (change: Partial<mind.MindLaws["mind"]>) =>
  life2With((species) => ({ ...species, mind: { ...species.mind, ...change } }));

/** The mind events of `events`, as type and payload. */
const mindEvents = (events: readonly EngineEvent[]) =>
  events.filter(({ type }) => type.startsWith("mind.")).map(({ type, payload }) => [type, payload]);

describe("the events of a decision that changed a mind", () => {
  /**
   * A mind whose episode 1 fades by tick 1, cited by the belief 3, which the belief 4 cites; the
   * episode 2 is a tell heard with taints, `tn` human-external and `ex` implementation-leak.
   */
  const held = mindOf({
    episodes: [own(1, { w: 49 }), heard(2, 40, { tn: 2, ex: 4 })],
    beliefs: [belief(3, { ev: [1] }), belief(4, { ev: [3], dp: 2 })],
  });
  const ops: beings.MindIntention = {
    remember: [{ percept: { food: [CELL[0], CELL[1]] }, w: 400 }],
    believe: [
      { p: concept("told", 1), cr: 700, ev: [2], rule: "told" },
      { p: concept("guess", 1), cr: 600, ev: [], rule: "guess" },
      { p: concept("told", 1), cr: 800, ev: [5], rule: "again" },
    ],
    revise: [{ id: 3, cr: 100, ev: [2] }],
    drop: [7],
  };
  const run = () => {
    const placed = [
      being2(1, CELL, { mind: held }),
      being2(2, CELL, { mind: structuredClone(held) }),
    ];
    const world = beings2World({
      controllers: { s1: brain2((senses) => (isFirst(senses) ? idling(LONG, ops) : idling(LONG))) },
      life: lawsOf({ ops: 8 }),
      chunks: chunksOf(placed),
    });
    return { world, events: runTo(world, 1) };
  };

  test("are mind.changed and mind.provenance, exact, after each being's other events, by id", () => {
    const { events } = run();
    const changed = (id: number) => ({
      id,
      encoded: [5],
      formed: [
        { id: 6, rule: "told" },
        { id: 7, rule: "guess" },
      ],
      revised: [{ id: 6, rule: "again" }, { id: 3 }],
      dropped: [7],
      forgot: [{ id: 1, beliefs: [3] }],
      related: [],
    });
    const provenance = (id: number) => ({
      id,
      records: [
        { id: 3, tn: 2, ex: 7, ev: [2] },
        { id: 4, tn: 2, ex: 7, ev: [3] },
        { id: 5, tn: 0, ex: 0, ev: [] },
        { id: 6, tn: 2, ex: 7, ev: [2, 5] },
      ],
      exposure: 3,
    });
    expect(eventsAt(events, 1)).toEqual([
      ["being.started", { id: 1, activity: "idle" }],
      ["mind.changed", changed(1)],
      ["mind.provenance", provenance(1)],
      ["being.started", { id: 2, activity: "idle" }],
      ["mind.changed", changed(2)],
      ["mind.provenance", provenance(2)],
    ]);
  });

  test("list in forgot what faded at step 1 first, then what a full store evicted", () => {
    // Episode 2 fades at tick 1; remembering two more then fills the store of eight, which evicts
    // episode 1, the lowest salience left. Both are cited by belief 9.
    const full = mindOf({
      episodes: [
        own(1, { w: 60 }),
        own(2, { w: 49 }),
        ...[3, 4, 5, 6, 7, 8].map((id) => own(id, { w: 500 })),
      ],
      beliefs: [belief(9, { ev: [1, 2] })],
    });
    const remember = [0, 1].map((dx) => ({
      percept: { food: [CELL[0] + dx, CELL[1]] as const },
      w: 500,
    }));
    const world = beings2World({
      controllers: {
        s1: brain2((s) => (isFirst(s) ? idling(LONG, { remember }) : idling(LONG))),
      },
      chunks: chunksOf([being2(1, CELL, { mind: full })]),
    });
    const [changed] = eventsOf(runTo(world, 1), "mind.changed", 1);
    expect(changed?.payload).toMatchObject({
      encoded: [10, 11],
      forgot: [
        { id: 2, beliefs: [9] },
        { id: 1, beliefs: [9] },
      ],
    });
    expect((beingOf(world, 1) as beings.Being2).mind.beliefs[0]).toMatchObject({ ev: [], lost: 2 });
  });

  test("leave the mind they record: taints flowed downstream, the exposure grew, links were cut", () => {
    const { world } = run();
    const after = (beingOf(world, 1) as beings.Being2).mind;
    expect(after.exposure).toBe(3);
    expect(after.next).toBe(8);
    expect(after.episodes.map(({ id }) => id)).toEqual([2, 5]);
    expect(
      after.beliefs.map(({ id, tn, ex, ev, lost, src }) => ({ id, tn, ex, ev, lost, src })),
    ).toEqual([
      { id: 3, tn: 2, ex: 7, ev: [2], lost: 1, src: 3 },
      { id: 4, tn: 2, ex: 7, ev: [3], lost: 0, src: 1 },
      { id: 6, tn: 2, ex: 7, ev: [2, 5], lost: 0, src: 3 },
    ]);
    expect(after.beliefs.find(({ id }) => id === 6)?.who).toBe(40);
  });

  test("hold no taint, exposure, or C3 kind in mind.changed, the event of class C1", () => {
    const { events } = run();
    const classes = beings.EVENT_CLASSES;
    expect(classes.find(({ type }) => type === "mind.changed")?.class).toBe("C1");
    expect(classes.find(({ type }) => type === "mind.provenance")?.class).toBe("C3");
    for (const [, payload] of mindEvents(events).filter(([type]) => type === "mind.changed")) {
      const text = JSON.stringify(payload);
      for (const secret of ['"tn"', '"ex"', '"exposure"', '"external"'])
        expect(text).not.toContain(secret);
    }
  });

  test("are emitted for a decision that only recalls, which changed a mind, with nothing listed", () => {
    const world = beings2World({
      controllers: {
        s1: brain2((s) => (isFirst(s) ? idling(LONG, { recall: [2] }) : idling(LONG))),
      },
      chunks: chunksOf([being2(1, CELL, { mind: mindOf({ episodes: [heard(2, 40)] }) })]),
    });
    expect(mindEvents(runTo(world, 1))).toEqual([
      [
        "mind.changed",
        { id: 1, encoded: [], formed: [], revised: [], dropped: [], forgot: [], related: [] },
      ],
      ["mind.provenance", { id: 1, records: [], exposure: 0 }],
    ]);
  });

  test("are none for a decision, accepted or rejected, that changed nothing", () => {
    const steady = mindOf({ episodes: [own(1)], beliefs: [belief(2, { ev: [1] })] });
    for (const proposed of [
      idling(LONG),
      idling(LONG, { recall: [9] }),
      { ...idling(LONG), steps: [] },
    ]) {
      const world = beings2World({
        controllers: { s1: brain2((s) => (isFirst(s) ? (proposed as never) : idling(LONG))) },
        chunks: chunksOf([being2(1, CELL, { mind: steady })]),
      });
      const events = runTo(world, 30);
      expect(mindEvents(events)).toEqual([]);
      expect((beingOf(world, 1) as beings.Being2).mind).toEqual(steady);
    }
  });
});

describe("decisions", () => {
  test("happen at most once per being and tick, on every path that reaches one", () => {
    // Walks that end, planned meals that cannot start, and wake conditions: each reaches a decision.
    const restless = brain2((senses) => {
      const [a = 0, b = 0] = senses.draws;
      const wakeWhen = a % 3 === 0 ? { nutritionBelow: senses.self.needs.nutrition - 1 } : {};
      if (a % 4 === 0 && walkMs(senses.window as beings.SensedWindow, "0") !== undefined)
        return { steps: [{ kind: "walk", dirs: "0" }], wakeWhen, behavior: behavior("travel") };
      return {
        steps: [
          { kind: "idle", ms: 1 + (b % 30_000) },
          { kind: "eat", untilNutrition: beings.NEED_MAX },
        ],
        wakeWhen,
        behavior: behavior("eat"),
        mind: { remember: [{ percept: { food: cellOf(senses) }, w: 1 + (b % 900) }] },
      };
    });
    const decided: number[] = [];
    const counting: beings.Controller2 = {
      ...restless,
      decide: (senses) => {
        decided.push(senses.self.id);
        return restless.decide(senses);
      },
    };
    const cells = [0, 1, 2, 3].map((dx): Cell => [CELL[0] + dx, CELL[1]]).filter(standable);
    const world = beings2World({
      controllers: { s1: counting },
      chunks: chunksOf(cells.map((cell, index) => being2(index + 1, cell))),
    });
    let decisions = 0;
    for (let tick = 1; tick <= 300; tick += 1) {
      decided.length = 0;
      runTo(world, tick);
      decisions += decided.length;
      expect([tick, decided.length]).toEqual([tick, new Set(decided).size]);
    }
    expect(decisions).toBeGreaterThan(300);
  });
});

describe("forgetting", () => {
  /**
   * An episode of importance 100 that, with a half-life of 24 s, fades from the third tick, and a
   * pinned one that never fades.
   */
  const fading = mindOf({
    episodes: [own(1, { w: 100 }), own(2, { w: 950 })],
    beliefs: [belief(3, { ev: [1, 2] })],
  });
  const quick = lawsOf({ halfLife: { episode: 24, belief: 302_400 } });

  test("happens at a decision, before the view, and stays when the intention is rejected", () => {
    const sensed: Senses2[] = [];
    const brain = brain2((senses) => {
      sensed.push(senses);
      // At its first decision the being walks; at the next it tries to recall what faded.
      if (isFirst(senses))
        return {
          steps: [{ kind: "walk", dirs: "0000" }],
          wakeWhen: {},
          behavior: behavior("travel"),
        };
      return idling(LONG, { recall: [1] });
    });
    const world = beings2World({
      controllers: { s1: brain },
      life: quick,
      chunks: chunksOf([being2(1, CELL, { mind: fading })]),
    });
    const events = runTo(world, 40);
    const [first, second] = sensed;
    if (first === undefined || second === undefined) throw new Error("the being decided once");
    // At tick 1 the episode 1 had not faded yet: the view showed it, and nothing was forgotten.
    expect(first.mind.episodes.map(({ id }) => id)).toEqual([1, 2]);
    const [rejected] = eventsOf(events, "being.intention_rejected", 1);
    if (rejected === undefined) throw new Error("the recall was not rejected");
    const decided = rejected.tick;
    expect(decided).toBeGreaterThan(3);
    // At the second decision it had: gone from the view the brain got, and the recall is refused.
    expect(second.mind.episodes.map(({ id }) => id)).toEqual([2]);
    expect(second.mind.beliefs[0]).toMatchObject({ id: 3, ev: [2], lost: 1 });
    expect(rejected.payload).toEqual({ id: 1, reason: "unknown_record" });
    expect(eventsAt(events, decided).slice(-3)).toEqual([
      ["being.intention_rejected", { id: 1, reason: "unknown_record" }],
      [
        "mind.changed",
        {
          id: 1,
          encoded: [],
          formed: [],
          revised: [],
          dropped: [],
          forgot: [{ id: 1, beliefs: [3] }],
          related: [],
        },
      ],
      ["mind.provenance", { id: 1, records: [], exposure: 0 }],
    ]);
    expect(mindEvents(events.filter(({ tick }) => tick !== decided))).toEqual([]);
    const after = (beingOf(world, 1) as beings.Being2).mind;
    expect(after.episodes.map(({ id }) => id)).toEqual([2]);
    expect(after.beliefs[0]).toMatchObject({ ev: [2], lost: 1 });
  });

  test("stays when the intention is malformed, and its operations are never read", () => {
    const brain = brain2((senses) =>
      isFirst(senses)
        ? { steps: [{ kind: "walk", dirs: "0000" }], wakeWhen: {}, behavior: behavior("travel") }
        : { ...idling(LONG, { recall: [2] }), steps: [] },
    );
    const world = beings2World({
      controllers: { s1: brain },
      life: quick,
      chunks: chunksOf([being2(1, CELL, { mind: fading })]),
    });
    const events = runTo(world, 40);
    const [rejected] = eventsOf(events, "being.intention_rejected", 1);
    if (rejected === undefined) throw new Error("the intention was not rejected");
    expect(rejected.payload).toEqual({ id: 1, reason: "malformed" });
    const forgot = [{ id: 1, beliefs: [3] }];
    expect(eventsAt(events, rejected.tick).slice(-3)).toEqual([
      ["being.intention_rejected", { id: 1, reason: "malformed" }],
      [
        "mind.changed",
        { id: 1, encoded: [], formed: [], revised: [], dropped: [], forgot, related: [] },
      ],
      ["mind.provenance", { id: 1, records: [], exposure: 0 }],
    ]);
    const after = (beingOf(world, 1) as beings.Being2).mind;
    // Forgotten, and the recall of the pinned episode never applied: its anchor is still 0.
    expect(after.episodes).toEqual([fading.episodes[1] as mind.Episode]);
  });

  test("leaves the mind of a wake that does not decide the very value the state held", () => {
    const seen: Committed[] = [];
    const walker = brain2((senses) =>
      isFirst(senses)
        ? { steps: [{ kind: "walk", dirs: "0000" }], wakeWhen: {}, behavior: behavior("travel") }
        : idling(LONG),
    );
    const world = watchedWorld({
      controllers: { s1: walker },
      life: quick,
      chunks: chunksOf([being2(1, CELL, { mind: fading })]),
      seen,
    });
    const events = runTo(world, 40);
    const [changed] = eventsOf(events, "mind.changed", 1);
    if (changed === undefined) throw new Error("the being never forgot");
    const walking = seen.filter(({ tick, activity }) => tick >= 1 && activity === "walk");
    // The walk woke the being at its arrivals without a decision: several commits, one mind,
    // which still held the episode that had faded from the third tick on.
    expect(new Set(walking.map(({ tick }) => tick)).size).toBeGreaterThan(2);
    expect(new Set(walking.map(({ mind: held }) => held)).size).toBe(1);
    expect(walking.every(({ mind: held }) => (held as mind.Mind).episodes.length === 2)).toBe(true);
    // The decision at the end of the walk forgot it, at that tick, and wrote one new mind.
    const after = seen.filter(({ tick }) => tick >= changed.tick);
    const [decided] = after;
    expect(decided?.activity).toBe("idle");
    expect(new Set(after.map(({ mind: held }) => held)).size).toBe(1);
    expect((decided?.mind as mind.Mind | undefined)?.episodes.map(({ id }) => id)).toEqual([2]);
    expect(walking.at(-1)?.tick).toBeLessThan(changed.tick);
  });

  test("gives the same view at the ticks two worlds decide, however often each decided", () => {
    // Episodes that fade at different moments of the run, a pinned one, and beliefs citing them.
    const rich = mindOf({
      episodes: [
        own(1, { w: 60 }),
        own(2, { w: 200 }),
        own(3, { w: 999 }),
        own(4, { w: 520, t: 5, r: 5 }),
      ],
      beliefs: [
        belief(5, { ev: [1, 2] }),
        belief(6, { ev: [5, 4], dp: 2 }),
        belief(7, { ev: [3], cr: 100 }),
      ],
    });
    const life = lawsOf({ halfLife: { episode: 600, belief: 1200 } });
    /** The view at each tick the being decided, and its mind at every tick, idling `ms` each time. */
    const run = (ms: number) => {
      const sensed: unknown[] = [];
      const brain = brain2((senses) => {
        sensed.push(senses.mind);
        return idling(ms);
      });
      const world = beings2World({
        controllers: { s1: brain },
        life,
        chunks: chunksOf([being2(1, CELL, { mind: rich })]),
      });
      const views = new Map<number, unknown>();
      const minds = new Map<number, mind.Mind>();
      for (let tick = 1; tick <= 301; tick += 1) {
        const before = sensed.length;
        runTo(world, tick);
        if (sensed.length > before) views.set(tick, sensed.at(-1));
        minds.set(tick, (beingOf(world, 1) as beings.Being2).mind);
      }
      return { views, minds };
    };
    const often = run(12_000);
    const seldom = run(600_000);
    const common = [...seldom.views.keys()].filter((tick) => often.views.has(tick));
    expect(common).toEqual([1, 51, 101, 151, 201, 251, 301]);
    expect(often.views.size).toBe(301);
    for (const tick of common) {
      expect([tick, often.views.get(tick)]).toEqual([tick, seldom.views.get(tick)]);
      expect([tick, often.minds.get(tick)]).toEqual([tick, seldom.minds.get(tick)]);
    }
    // Not vacuous: records faded within the run, and the frequent decider forgot them sooner.
    expect(seldom.minds.get(301)?.episodes.map(({ id }) => id)).toEqual([3]);
    expect(often.minds.get(30)?.episodes.length).toBe(3);
    expect(seldom.minds.get(30)?.episodes.length).toBe(4);
  });
});
