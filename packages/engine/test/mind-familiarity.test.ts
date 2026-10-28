/**
 * Familiarity and relationships as a law (docs/architecture/mind.md, "Relationships"): seconds of
 * co-presence credited exactly within `relations.gap`, decay over a longer absence, saturation,
 * the familiarity a view shows, and a full store that always admits a being met for the first time.
 */
import { describe, expect, test } from "bun:test";
import { mind } from "../src/index.ts";
import { belief, contextAt, lawsWith, mindOf, relationship } from "./support/mind-records.ts";

const {
  familiarity,
  familiarSeconds,
  familiaritySaturation,
  INT31_MAX,
  perceive,
  perceivedAgain,
  relationshipWith,
} = mind;

/** `subject` after perceiving `who` at each of `ticks`, in order. */
function perceivedAt(
  subject: mind.Mind,
  who: number,
  ticks: readonly number[],
  laws?: mind.MindLaws,
): mind.Mind {
  return ticks.reduce(
    (current, tick) => perceive(current, who, contextAt(tick, laws)).mind,
    subject,
  );
}

describe("perceive", () => {
  test("creates a relationship at a first perception, which adds nothing", () => {
    const { mind: after, created, displaced } = perceive(mindOf(), 42, contextAt(500));
    expect(after.relations).toEqual([relationship(1, 42, { seen: 500 })]);
    expect(after.next).toBe(2);
    expect(created).toBe(1);
    expect(displaced).toEqual([]);
    expect(relationshipWith(after, 42)?.id).toBe(1);
    expect(relationshipWith(after, 43)).toBeUndefined();
  });

  test("credits the seconds since the last perception exactly, not the perceptions", () => {
    const after = perceivedAt(mindOf(), 42, [1, 11, 26, 601]);
    expect(after.relations[0]).toMatchObject({ f: 600, seen: 601 });
    // Seconds, not ticks: three seconds per tick triple the credit.
    const slow = [1, 11, 21].reduce(
      (current, tick) =>
        perceive(current, 42, contextAt(tick, undefined, { secondsPerTick: 3 })).mind,
      mindOf(),
    );
    expect(slow.relations[0]?.f).toBe(60);
  });

  test("gives a being that decides every tick what one deciding every minute gets", () => {
    const everyTick = perceivedAt(
      mindOf(),
      42,
      Array.from({ length: 601 }, (_, tick) => tick + 1),
    );
    const everyMinute = perceivedAt(
      mindOf(),
      42,
      Array.from({ length: 11 }, (_, minute) => minute * 60 + 1),
    );
    expect(everyTick.relations).toEqual(everyMinute.relations);
    expect(everyTick.relations[0]?.f).toBe(600);
  });

  test("decays over a whole absence longer than the gap, and adds nothing for it", () => {
    const known = mindOf({ relations: [relationship(1, 42, { f: 4000, seen: 1 })] });
    // Exactly the gap is still co-presence; one more second is an absence.
    expect(perceive(known, 42, contextAt(601)).mind.relations[0]?.f).toBe(4600);
    const absent = perceive(known, 42, contextAt(602)).mind.relations[0];
    expect(absent).toMatchObject({ f: 3999, seen: 602 });
    // One half-life of absence halves it; retention does not scale that half-life.
    const half = perceive(known, 42, contextAt(756_001, undefined, { retention: 500 })).mind;
    expect(half.relations[0]?.f).toBe(2000);
  });

  test("saturates at ⌈1000 / rate⌉ seconds", () => {
    const laws = mind.defaultMindLaws();
    expect(familiaritySaturation(laws.relations.rate)).toBe(7200);
    const near = mindOf({ relations: [relationship(1, 42, { f: 7000, seen: 1 })] });
    expect(perceive(near, 42, contextAt(500)).mind.relations[0]?.f).toBe(7200);
  });

  test("credits nothing at the first perception of a being only heard, whose seen is 0", () => {
    // A message created the relationship (mind.md, "Relationships"): no perception happened, so
    // the seconds since then were never co-presence, however few they are.
    const heard = mindOf({ relations: [relationship(1, 42)] });
    for (const tick of [1, 10, 600, 601]) {
      const met = perceive(heard, 42, contextAt(tick));
      expect(met.mind.relations).toEqual([relationship(1, 42, { f: 0, seen: tick })]);
      expect(met.created).toBeUndefined();
    }
    // From then on, the seconds since that first perception count as any others.
    const after = perceivedAt(heard, 42, [10, 70]);
    expect(after.relations[0]).toMatchObject({ f: 60, seen: 70 });
  });

  test("keeps the other relationships as they are", () => {
    const subject = mindOf({ relations: [relationship(1, 41, { f: 5 }), relationship(2, 42)] });
    const after = perceive(subject, 42, contextAt(10)).mind;
    expect(after.relations[0]).toBe(subject.relations[0]);
  });
});

describe("familiarity", () => {
  const ctx = (tick: number) => contextAt(tick);

  test("is min(1000, ⌊rate · f⌋) within the gap, and 1000 from the saturation", () => {
    expect(familiarity(relationship(1, 42, { f: 3600 }), ctx(0))).toBe(500);
    expect(familiarity(relationship(1, 42, { f: 7199 }), ctx(0))).toBe(999);
    expect(familiarity(relationship(1, 42, { f: 7200 }), ctx(0))).toBe(1000);
    expect(familiarity(relationship(1, 42, { f: 3600, seen: 0 }), ctx(600))).toBe(500);
  });

  test("shows the decay of an absence longer than the gap before the next perception", () => {
    const absent = relationship(1, 42, { f: 7200, seen: 0 });
    expect(familiarSeconds(absent, ctx(756_000))).toBe(3600);
    expect(familiarity(absent, ctx(756_000))).toBe(500);
    expect(familiarity(absent, ctx(30 * 756_000))).toBe(0);
  });

  test("perceivedAgain is the update a perception makes", () => {
    const known = relationship(1, 42, { f: 100, seen: 10 });
    expect(perceivedAgain(known, ctx(20))).toEqual({ ...known, f: 110, seen: 20 });
  });
});

describe("a full store of relationships", () => {
  const laws = lawsWith({ relations: 2 });

  test("admits a new being and evicts the lowest familiarity, then the oldest seen, then the lowest id", () => {
    const subject = mindOf({
      relations: [
        relationship(1, 41, { f: 3600, seen: 100 }),
        relationship(2, 42, { f: 360, seen: 100 }),
      ],
      beliefs: [belief(3, { ev: [2], src: 4 })],
    });
    const { mind: after, created, displaced } = perceive(subject, 43, contextAt(100, laws));
    expect(after.relations.map((held) => held.id)).toEqual([1, 4]);
    expect(created).toBe(4);
    expect(after.beliefs[0]).toMatchObject({ ev: [], lost: 1 });
    expect(displaced).toEqual([{ id: 2, beliefs: [3] }]);
    const even = mindOf({
      relations: [relationship(1, 41, { seen: 100 }), relationship(2, 42, { seen: 90 })],
    });
    expect(perceive(even, 43, contextAt(100, laws)).mind.relations.map((held) => held.id)).toEqual([
      1, 3,
    ]);
    const same = mindOf({
      relations: [relationship(1, 41, { seen: 100 }), relationship(2, 42, { seen: 100 })],
    });
    expect(perceive(same, 43, contextAt(100, laws)).mind.relations.map((held) => held.id)).toEqual([
      2, 3,
    ]);
  });

  test("ranks by familiarity at the moment, with the decay of an absence", () => {
    // Relationship 1 was more familiar but has been absent two half-lives: 7200 → 1800 seconds.
    const subject = mindOf({
      relations: [
        relationship(1, 41, { f: 7200, seen: 0 }),
        relationship(2, 42, { f: 3000, seen: 1_512_000 }),
      ],
    });
    const after = perceive(subject, 43, contextAt(1_512_000, laws)).mind;
    expect(after.relations.map((held) => held.id)).toEqual([2, 3]);
  });

  test("holds no relationship when the law gives no room, nor once ids have run out", () => {
    const none = perceive(mindOf(), 42, contextAt(0, lawsWith({ relations: 0 })));
    expect(none).toEqual({ mind: mindOf(), displaced: [] });
    const exhausted = { ...mindOf(), next: INT31_MAX };
    expect(perceive(exhausted, 42, contextAt(0)).mind).toBe(exhausted);
  });
});
