/**
 * The byte budget of a mind (docs/architecture/mind.md, "Cost"): the largest mind, built exactly,
 * with values typical of v0.1 and with the largest values, pinned at the sizes measured while
 * planning and held to their bounds. Every record is of its largest kind: each episode a `heard`
 * episode of a `tell` and each message a `tell`, with every optional member; every belief with
 * `who` and three citations; every relationship full; and propositions with `neg`. Members whose
 * values the specification does not name take the widest value of their domain, as in the
 * measurement: importance, confidence, trust, and affinity at ±1000, taints at 7, sources at 15,
 * familiarity at 2^22 seconds, `turns` at 8, and the daily counts at 64; `lost` takes the width of
 * a local id, and the day of the quota the width of a tick.
 */
import { describe, expect, test } from "bun:test";
import { utf8Length } from "../src/canonical/utf8.ts";
import { canonicalize, mind } from "../src/index.ts";

/** The values that change between the two largest minds. */
type Widths = {
  readonly coordinate: number;
  readonly tick: number;
  /** The highest local id: `next` is one more, and the 22 records take the ids below it. */
  readonly lastId: number;
  readonly entity: number;
  readonly proposition: () => mind.Proposition;
};

/** The largest mind at the capacities of the default laws: 8, 8, 6, and 2. */
function largestMind(widths: Widths): mind.Mind {
  const { coordinate, tick, lastId, entity } = widths;
  const firstId = lastId - 21;
  const cell = (): mind.Cell => [coordinate, coordinate];
  const episodes = Array.from(
    { length: 8 },
    (_, index): mind.Episode => ({
      id: firstId + index,
      kind: "heard",
      t: tick,
      cell: cell(),
      who: entity,
      act: "tell",
      p: widths.proposition(),
      band: 2,
      tn: 7,
      ex: 7,
      w: 1000,
      r: tick,
    }),
  );
  const beliefs = Array.from(
    { length: 8 },
    (_, index): mind.Belief => ({
      id: firstId + 8 + index,
      p: widths.proposition(),
      cr: 1000,
      src: 15,
      who: entity,
      ev: [firstId, firstId + 1, firstId + 2],
      lost: lastId,
      tn: 7,
      ex: 7,
      dp: 1,
      u: tick,
    }),
  );
  const relations = Array.from(
    { length: 6 },
    (_, index): mind.Relationship => ({
      id: firstId + 16 + index,
      who: entity - index,
      f: 0x40_0000,
      seen: tick,
      aff: -1000,
      tr: 1000,
      tn: 7,
      talk: tick,
      turns: 8,
    }),
  );
  const inbox = Array.from(
    { length: 2 },
    (): mind.InboxMessage => ({
      who: entity,
      t: tick,
      cell: cell(),
      act: "tell",
      p: widths.proposition(),
      band: 2,
      tn: 7,
      ex: 7,
    }),
  );
  return {
    next: lastId + 1,
    episodes,
    beliefs,
    relations,
    inbox,
    exposure: 7,
    quota: { day: tick, said: 64, woken: 64 },
  };
}

const bytesOf = (value: unknown): number => utf8Length(canonicalize(value));

/** Values typical of v0.1: coordinates −99,999, ticks 99,999,999, local ids 999, entities 99,999. */
const TYPICAL: Widths = {
  coordinate: -99_999,
  tick: 99_999_999,
  lastId: 998,
  entity: 99_999,
  proposition: () => ({ p: "m1.food-at", a: [{ c: [-99_999, -99_999] }], v: 2, neg: true }),
};

/** The largest values: coordinates −2^31, ticks and entity ids 2^53 − 1, local ids 2^31 − 1. */
const LARGEST: Widths = {
  coordinate: -0x8000_0000,
  tick: Number.MAX_SAFE_INTEGER,
  lastId: 0x7fff_fffe,
  entity: Number.MAX_SAFE_INTEGER,
  proposition: () => ({
    p: "m1.food-at-123456",
    a: [{ c: [-0x8000_0000, -0x8000_0000] }],
    v: -Number.MAX_SAFE_INTEGER,
    neg: true,
  }),
};

/** Whether `subject` breaks no invariant of a mind. */
function isValid(subject: mind.Mind): boolean {
  let count = 0;
  mind.checkMind(subject, "", { report: () => (count += 1) });
  return count === 0;
}

describe("the largest mind", () => {
  test("with values typical of v0.1 takes 4,056 bytes, at most 4.5 KB", () => {
    expect(bytesOf(TYPICAL.proposition())).toBe(63);
    const typical = largestMind(TYPICAL);
    expect(isValid(typical)).toBe(true);
    expect(String(typical.next).length).toBe(3);
    expect(bytesOf(typical)).toBe(4056);
    expect(bytesOf(typical)).toBeLessThanOrEqual(4500);
  });

  test("with the largest values takes 5,711 bytes, at most 6 KB", () => {
    const proposition = LARGEST.proposition();
    expect(bytesOf(proposition)).toBe(mind.PROP_BOUNDS.bytes);
    let issues = 0;
    expect(mind.checkProposition(proposition, "", { report: () => (issues += 1) })).toBe(true);
    const largest = largestMind(LARGEST);
    expect(isValid(largest)).toBe(true);
    expect(largest.next).toBe(mind.INT31_MAX);
    expect(bytesOf(largest)).toBe(5711);
    expect(bytesOf(largest)).toBeLessThanOrEqual(6000);
  });
});
