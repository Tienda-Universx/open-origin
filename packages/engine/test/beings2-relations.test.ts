/**
 * Relationships of beings@2 (ADR 0024, docs/architecture/mind.md "Relationships", "Beliefs" steps 1
 * and 3, "Time, salience, and forgetting", "Provenance and taints", and "Events"): familiarity is a
 * law that credits seconds of co-presence, not decisions; a relationship exists only after a
 * perception; and `relate`, the last kind of operation, changes affinity and trust within
 * `relations.delta`, citing a record that involves the other being, whose lineage the relationship
 * takes and passes downstream.
 */
import { describe, expect, test } from "bun:test";
import { type beings, type EngineEvent, mind } from "../src/index.ts";
import { beingOf, runTo } from "./support/beings-world.ts";
import {
  type Cell,
  eventsAt,
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
} from "./support/beings2-world.ts";
import { belief, heard, mindOf, own, relationship, seen } from "./support/mind-records.ts";

const LONG = 6_000_000;
const SEARCH: Cell = [-128, -128];

/** Two cells where beings may stand, two apart in a row: always in sight of each other. */
const [A, B] = standingPair(SEARCH, [2, 0], (a) => standable([a[0] + 3, a[1]]));
/** A cell three east of A, where a being may stand, a little farther from it than B. */
const C: Cell = [A[0] + 3, A[1]];
/** A cell where a being stands out of sight of A: 20 cells east of a standable cell. */
const [FAR_A, FAR] = standingPair(SEARCH, [20, 0], () => true);

/** The relationships of the being `id` of `world`. */
const relationsOf = (world: Parameters<typeof beingOf>[0], id: number) =>
  (beingOf(world, id) as beings.Being2).mind.relations;

/** The laws of life@2 with their one species' `relations` and `perception` changed. */
const lawsWith = (change: {
  readonly relations?: Partial<mind.MindLaws["relations"]>;
  readonly perception?: Partial<beings.Perception>;
  readonly mind?: Partial<mind.MindLaws["mind"]>;
}) =>
  life2With((species) => ({
    ...species,
    relations: { ...species.relations, ...change.relations },
    perception: { ...species.perception, ...change.perception },
    mind: { ...species.mind, ...change.mind },
  }));

/**
 * The decay of the salience formula (mind.md, "Time, salience, and forgetting"), written here
 * apart from the engine: `w` after `seconds` with the half-life `half`.
 */
function decayed(w: number, seconds: number, half: number): number {
  const k = Math.floor(seconds / half);
  if (k >= 30) return 0;
  const a = Math.floor(w / 2 ** k);
  return a - Math.floor(((a - Math.floor(a / 2)) * (seconds % half)) / half);
}

describe("familiarity", () => {
  /** Being 1 idles `ms` at each decision beside being 2, which idles long; its relationship by tick. */
  const together = (ms: number, ticks: number) => {
    const world = beings2World({
      controllers: { s1: brain2((s) => (s.self.id === 1 ? idling(ms) : idling(LONG))) },
      chunks: chunksOf([being2(1, A), being2(2, B)]),
    });
    const byTick: mind.Relationship[] = [];
    for (let tick = 1; tick <= ticks; tick += 1) {
      runTo(world, tick);
      const [held] = relationsOf(world, 1);
      if (held === undefined) throw new Error(`no relationship at tick ${tick}`);
      byTick[tick] = held;
    }
    return byTick;
  };

  test("is equal for idles of 1 ms and of 60 s at the ticks both decide", () => {
    // 1 ms decides at every tick; 60 s, five ticks of 12 s, at ticks 1, 6, 11, and so on.
    const often = together(1, 61);
    const seldom = together(60_000, 61);
    for (let k = 0; k <= 12; k += 1) {
      const tick = 1 + 5 * k;
      expect(often[tick]).toEqual(seldom[tick] as mind.Relationship);
      expect(seldom[tick]).toMatchObject({ who: 2, f: 60 * k, seen: tick });
    }
    // Not vacuous: between those ticks only the being that decides often was seen to perceive.
    expect(often[3]).toMatchObject({ f: 24, seen: 3 });
    expect(seldom[3]).toMatchObject({ f: 0, seen: 1 });
  });

  test("adds nothing at a first perception, which creates the relationship at affinity 0, trust 500", () => {
    const world = beings2World({
      controllers: { s1: brain2(() => idling(LONG)) },
      chunks: chunksOf([being2(1, A), being2(2, B)]),
    });
    const events = runTo(world, 1);
    expect(relationsOf(world, 1)).toEqual([
      { id: 1, who: 2, f: 0, seen: 1, aff: 0, tr: 500, tn: 0, talk: 0, turns: 0 },
    ]);
    expect(eventsOf(events, "mind.changed", 1).map(({ payload }) => payload)).toEqual([
      { id: 1, encoded: [], formed: [], revised: [], dropped: [], forgot: [], related: [1] },
    ]);
    expect(eventsOf(events, "mind.provenance", 1).map(({ payload }) => payload)).toEqual([
      { id: 1, records: [{ id: 1, tn: 0, ex: 0, ev: [] }], exposure: 0 },
    ]);
  });

  /**
   * Being 1 holds a relationship with being 2 of `f` 3,600 seconds seen at tick 1, idles until
   * `tick`, and then perceives being 2, under a gap of 600 s and a half-life of 600 s.
   */
  const afterAbsence = (tick: number) => {
    const held = mindOf({ relations: [relationship(1, 2, { f: 3600, seen: 1 })] });
    const first = {
      ...being2(1, A, { mind: held }),
      activity: { kind: "idle" as const, start: 0, ms: tick * 12_000 },
      wake: tick,
    };
    const world = beings2World({
      controllers: { s1: brain2(() => idling(LONG)) },
      life: lawsWith({ relations: { gap: 600, halfLife: 600 } }),
      chunks: chunksOf([first, being2(2, B)]),
    });
    runTo(world, tick);
    return relationsOf(world, 1)[0];
  };

  test("credits an absence of at most relations.gap, exactly", () => {
    // 50 ticks of 12 s: 600 s, the gap itself.
    expect(afterAbsence(51)).toMatchObject({ f: 3600 + 600, seen: 51 });
  });

  test("decays over a longer absence and adds nothing: familiarity lost stays lost", () => {
    // 51 ticks: 612 s, one more tick than the gap.
    expect(afterAbsence(52)).toMatchObject({ f: decayed(3600, 612, 600), seen: 52 });
    expect(decayed(3600, 612, 600)).toBe(1782);
    expect(afterAbsence(201)).toMatchObject({ f: decayed(3600, 2400, 600), seen: 201 });
  });

  test("adds nothing at the first perception of a being only heard before: seen 0", () => {
    // A message left being 1 a relationship with being 2 and no perception (mind.md,
    // "Relationships"); being 2 stands in sight when being 1 next decides, at tick 5.
    const held = mindOf({ relations: [relationship(1, 2)] });
    const first = {
      ...being2(1, A, { mind: held }),
      activity: { kind: "idle" as const, start: 0, ms: 5 * 12_000 },
      wake: 5,
    };
    const world = beings2World({
      controllers: { s1: brain2((s) => (s.self.id === 1 ? idling(1) : idling(LONG))) },
      chunks: chunksOf([first, being2(2, B)]),
    });
    runTo(world, 5);
    expect(relationsOf(world, 1)).toEqual([relationship(1, 2, { f: 0, seen: 5 })]);
    // The next perception counts the seconds since that one: one tick, 12 s.
    runTo(world, 6);
    expect(relationsOf(world, 1)).toEqual([relationship(1, 2, { f: 12, seen: 6 })]);
  });
});

describe("a relationship", () => {
  test("exists only after a perception: a being out of sight leaves none", () => {
    const world = beings2World({
      controllers: { s1: brain2(() => idling(1)) },
      chunks: chunksOf([being2(1, FAR_A), being2(2, FAR)]),
    });
    runTo(world, 30);
    expect(relationsOf(world, 1)).toEqual([]);
    expect(relationsOf(world, 2)).toEqual([]);
  });

  test("is created for the perceived beings in the order attention keeps them, nearest first", () => {
    const world = beings2World({
      controllers: { s1: brain2(() => idling(LONG)) },
      chunks: chunksOf([being2(1, A), being2(2, C), being2(3, B)]),
    });
    runTo(world, 1);
    expect(relationsOf(world, 1).map(({ id, who }) => [id, who])).toEqual([
      [1, 3],
      [2, 2],
    ]);
  });

  test("is not created for a being attention leaves out", () => {
    const world = beings2World({
      controllers: { s1: brain2(() => idling(LONG)) },
      life: lawsWith({ perception: { attention: 1 } }),
      chunks: chunksOf([being2(1, A), being2(2, C), being2(3, B)]),
    });
    runTo(world, 1);
    expect(relationsOf(world, 1).map(({ who }) => who)).toEqual([3]);
  });

  test("of a newcomer always enters a full store, which evicts the least familiar", () => {
    const held = mindOf({
      relations: [
        relationship(1, 40, { f: 100, seen: 1 }),
        relationship(2, 41, { f: 50, seen: 1 }),
      ],
      beliefs: [belief(3, { ev: [2] })],
    });
    const world = beings2World({
      controllers: { s1: brain2(() => idling(LONG)) },
      life: lawsWith({ mind: { relations: 2 } }),
      chunks: chunksOf([being2(1, A, { mind: held }), being2(2, B)]),
    });
    const events = runTo(world, 1);
    expect(relationsOf(world, 1).map(({ id, who }) => [id, who])).toEqual([
      [1, 40],
      [4, 2],
    ]);
    expect(eventsOf(events, "mind.changed", 1)[0]?.payload).toMatchObject({
      forgot: [{ id: 2, beliefs: [3] }],
      related: [4],
    });
  });

  test("is not created once local ids have run out", () => {
    const held = { ...mind.newMind(0), next: mind.INT31_MAX };
    const world = beings2World({
      controllers: { s1: brain2(() => idling(LONG)) },
      chunks: chunksOf([being2(1, A, { mind: held }), being2(2, B)]),
    });
    runTo(world, 1);
    expect(relationsOf(world, 1)).toEqual([]);
  });
});

/**
 * The speaker of a message in the inbox: a tell from being 41, which being 1 neither perceives nor
 * knows, tainted human-external and implementation-leak, in a mind the host placed. A relationship
 * created from a message records that no perception happened: `seen` 0 and `f` 0.
 */
describe("the speaker of a message in the inbox", () => {
  const message: mind.InboxMessage = {
    who: 41,
    t: 0,
    cell: [A[0], A[1]],
    act: "tell",
    p: { p: "t1.food-at", a: [{ c: [1, 1] }] },
    band: 1,
    tn: 2,
    ex: 4,
  };
  const held = mindOf({ inbox: [message], exposure: 6 });

  test("gets a relationship at step 1, with only its creation in the ledger", () => {
    const { being, events } = relateOnce({}, { held });
    expect(being.mind.inbox).toEqual([]);
    // No perception happened: seen is 0, which no tick a world computes can be.
    expect(being.mind.relations).toEqual([relationship(1, 41, { f: 0, seen: 0 })]);
    const changed = eventsAt(events, 1).find(([type]) => type === "mind.changed");
    expect(changed?.[1]).toMatchObject({ related: [1] });
  });

  test("of a known speaker changes nothing: hearing is no co-presence, so step 1 only creates", () => {
    const known = relationship(1, 41, { f: 100, seen: 1, aff: 20, tr: 700 });
    const { being, events } = relateOnce({}, { held: { ...held, next: 2, relations: [known] } });
    expect(being.mind.relations).toEqual([known]);
    const changed = eventsAt(events, 1).find(([type]) => type === "mind.changed");
    expect(changed?.[1]).toMatchObject({ related: [] });
  });

  test("leaves the message's taints on the heard episode a remember makes of it", () => {
    const { being, events } = relateOnce(
      { remember: [{ percept: { heard: 0 }, w: 500 }] },
      { held },
    );
    expect(being.mind.episodes).toHaveLength(1);
    expect(being.mind.episodes[0]).toMatchObject({ id: 2, kind: "heard", who: 41, tn: 2, ex: 4 });
    const provenance = eventsAt(events, 1).find(([type]) => type === "mind.provenance");
    expect(provenance?.[1]).toMatchObject({
      records: [
        { id: 1, tn: 0, ex: 0, ev: [] },
        { id: 2, tn: 2, ex: 4, ev: [] },
      ],
      exposure: 6,
    });
  });
});

/**
 * The mind of the relate tests: being 40 perceived (1), food (2), a tell heard from 40 with `tn`
 * human-external and `ex` implementation-leak (3), the relationship with 40 (4), a belief citing
 * it (5), and a belief citing that one (6).
 */
const HELD = mindOf({
  episodes: [seen(1, 40), own(2), heard(3, 40, { tn: 2, ex: 4 })],
  relations: [relationship(4, 40, { aff: 100, tr: 600 })],
  beliefs: [belief(5, { ev: [4], src: 4 }), belief(6, { ev: [5], src: 4, dp: 2 })],
});

/** The first decision of being 1, alone at A, holding `held` and proposing `ops`. */
function relateOnce(
  ops: unknown,
  options: { readonly held?: mind.Mind; readonly life?: beings.LifeConfig2 } = {},
) {
  const world = beings2World({
    controllers: {
      s1: brain2((s: Senses2) =>
        isFirst(s) ? ({ ...idling(LONG), mind: ops } as beings.Intention2) : idling(LONG),
      ),
    },
    chunks: chunksOf([being2(1, A, { mind: options.held ?? HELD })]),
    ...(options.life === undefined ? {} : { life: options.life }),
  });
  const events = runTo(world, 1);
  return { being: beingOf(world, 1) as beings.Being2, events };
}

describe("relate", () => {
  test("moves affinity and trust, takes the lineage of what it cites, and passes it downstream", () => {
    const { being, events } = relateOnce({
      relate: [{ who: 40, aff: 200, tr: -200, because: [1, 3] }],
    });
    expect(being.outcome.result).not.toBe("rejected");
    expect(being.mind.relations).toEqual([relationship(4, 40, { aff: 300, tr: 400, tn: 2 })]);
    // The relationship has no exposure of its own: the beliefs take its lineage only.
    expect(being.mind.beliefs.map(({ id, tn, ex }) => [id, tn, ex])).toEqual([
      [5, 2, 0],
      [6, 2, 0],
    ]);
    expect(being.mind.episodes.find(({ id }) => id === 1)?.r).toBe(1);
    expect(being.mind.exposure).toBe(0);
    const mindEvents = eventsAt(events, 1).filter(([type]) => type.startsWith("mind."));
    expect(mindEvents).toEqual([
      [
        "mind.changed",
        { id: 1, encoded: [], formed: [], revised: [], dropped: [], forgot: [], related: [4] },
      ],
      [
        "mind.provenance",
        {
          id: 1,
          records: [
            { id: 4, tn: 2, ex: 0, ev: [1, 3] },
            { id: 5, tn: 2, ex: 0, ev: [4] },
            { id: 6, tn: 2, ex: 0, ev: [5] },
          ],
          exposure: 0,
        },
      ],
    ]);
  });

  test("saturates affinity and trust at their bounds, and allows a change of exactly relations.delta", () => {
    const held = mindOf({
      episodes: [seen(1, 40)],
      relations: [relationship(2, 40, { aff: 900, tr: 100 })],
    });
    const { being } = relateOnce(
      { relate: [{ who: 40, aff: 200, tr: -200, because: [1] }] },
      { held },
    );
    expect(being.mind.relations[0]).toMatchObject({ aff: 1000, tr: 0 });
  });

  test("twice on one being in a decision applies both, and the ledger names the relationship once", () => {
    const { being, events } = relateOnce({
      relate: [
        { who: 40, aff: 100, because: [1] },
        { who: 40, tr: -100, because: [3, 1] },
      ],
    });
    expect(being.outcome.result).not.toBe("rejected");
    expect(being.mind.relations).toEqual([relationship(4, 40, { aff: 200, tr: 500, tn: 2 })]);
    const mindEvents = eventsAt(events, 1).filter(([type]) => type.startsWith("mind."));
    expect(mindEvents).toEqual([
      [
        "mind.changed",
        { id: 1, encoded: [], formed: [], revised: [], dropped: [], forgot: [], related: [4] },
      ],
      [
        "mind.provenance",
        {
          id: 1,
          records: [
            { id: 4, tn: 2, ex: 0, ev: [1, 3] },
            { id: 5, tn: 2, ex: 0, ev: [4] },
            { id: 6, tn: 2, ex: 0, ev: [5] },
          ],
          exposure: 0,
        },
      ],
    ]);
  });

  test("is the last kind of operation: it may cite a belief formed in the same decision", () => {
    const { being } = relateOnce({
      believe: [{ p: { p: "t1.kind", a: [{ e: 40 }] }, cr: 700, ev: [3], rule: "told" }],
      relate: [{ who: 40, tr: 50, because: [7] }],
    });
    expect(being.mind.beliefs.find(({ id }) => id === 7)).toMatchObject({ who: 40, tn: 2 });
    expect(being.mind.relations[0]).toMatchObject({ tr: 650, tn: 2 });
  });

  const rejections: { name: string; ops: unknown; reason: string }[] = [
    {
      name: "a change of affinity beyond relations.delta",
      ops: { relate: [{ who: 40, aff: 201, because: [1] }] },
      reason: "mind_malformed",
    },
    {
      name: "a change of trust beyond relations.delta",
      ops: { relate: [{ who: 40, tr: -201, because: [1] }] },
      reason: "mind_malformed",
    },
    {
      name: "no citation",
      ops: { relate: [{ who: 40, because: [] }] },
      reason: "mind_malformed",
    },
    {
      name: "four citations",
      ops: { relate: [{ who: 40, because: [1, 2, 3, 5] }] },
      reason: "mind_malformed",
    },
    {
      name: "a citation given twice",
      ops: { relate: [{ who: 40, because: [1, 1] }] },
      reason: "mind_malformed",
    },
    {
      name: "a who that is not an entity id",
      ops: { relate: [{ who: 0, because: [1] }] },
      reason: "mind_malformed",
    },
    {
      name: "a member relate does not have",
      ops: { relate: [{ who: 40, because: [1], f: 10 }] },
      reason: "mind_malformed",
    },
    {
      name: "a citation of a record the mind does not hold",
      ops: { relate: [{ who: 40, because: [1, 99] }] },
      reason: "unknown_record",
    },
    {
      name: "a being the mind holds no relationship with",
      ops: { relate: [{ who: 41, because: [1] }] },
      reason: "unknown_record",
    },
    {
      name: "citations of which none involves who: food, the relationship, a belief without who",
      ops: { relate: [{ who: 40, because: [2, 4, 5] }] },
      reason: "premise_order",
    },
  ];
  for (const { name, ops, reason } of rejections) {
    test(`rejects ${name} as ${reason}, and applies no operation of the intention`, () => {
      // The remember, valid, would apply first: the rejection comes from relate alone.
      const { being } = relateOnce({
        remember: [{ percept: { food: [A[0], A[1]] }, w: 1 }],
        ...(ops as object),
      });
      expect(being.outcome).toEqual({ result: "rejected", tick: 1, reason });
      expect(being.mind).toEqual(HELD);
    });
  }

  test("applies with the other operations of its intention when it is valid", () => {
    const { being } = relateOnce({
      remember: [{ percept: { food: [A[0], A[1]] }, w: 1 }],
      relate: [{ who: 40, because: [1] }],
    });
    expect(being.mind.episodes.map(({ id }) => id)).toEqual([1, 2, 3, 7]);
    expect(being.mind.relations[0]).toMatchObject({ aff: 100, tr: 600, tn: 0 });
  });

  test("of a being met in this decision cites the episode a remember made of it", () => {
    const world = beings2World({
      controllers: {
        s1: brain2((s) =>
          isFirst(s) && s.self.id === 1
            ? idling(LONG, {
                remember: [{ percept: { being: 0 }, w: 500 }],
                relate: [{ who: 2, aff: 50, because: [s.mind.next] }],
              })
            : idling(LONG),
        ),
      },
      chunks: chunksOf([being2(1, A), being2(2, B)]),
    });
    const events: EngineEvent[] = runTo(world, 1);
    expect(relationsOf(world, 1)).toEqual([relationship(1, 2, { seen: 1, aff: 50 })]);
    expect(eventsOf(events, "mind.changed", 1)[0]?.payload).toMatchObject({
      encoded: [2],
      related: [1],
    });
  });
});
