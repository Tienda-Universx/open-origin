/**
 * The rules of `mind@1` (docs/architecture/mind.md "Beliefs" and "The brain mind@1", plan §5.2):
 * each belief operation is the output of an exported pure function of the records it cites and
 * the being's traits, and of nothing else, so its confidence depends only on what it cites,
 * including the relationship with the speaker. These tests compute each rule by hand, show that
 * nothing but the cited content moves it, and pin the cases each rule names.
 */
import { describe, expect, test } from "bun:test";
import type { beings, mind } from "@open-origin/engine";
import {
  CONTRADICTED_CR,
  FOOD_AT,
  RULE_IDS,
  SEEN_CR,
  STRANGER_TRUST,
  TOLD_CR,
  TRUST_STEP,
} from "../src/brain/mind/parameters.ts";
import {
  BELIEF_RULES,
  type CitedRecord,
  foodAt,
  revisedConfidence,
  seenFood,
  toldFood,
  trustChange,
} from "../src/brain/mind/rules.ts";

const NEUTRAL: beings.Traits2 = Object.freeze({
  appetite: 1000,
  sleepiness: 1000,
  curiosity: 1000,
  sociability: 1000,
  credulity: 1000,
  retention: 1000,
});

const withTraits = (traits: Partial<beings.Traits2>): beings.Traits2 => ({ ...NEUTRAL, ...traits });

/** A cited episode of `kind` with `content`, its id, ages, and importance as a view shows them. */
function episode(kind: string, content: object, extra: object = {}): CitedRecord {
  const record = { id: 4, kind, t: 60, w: 500, r: 60, ...content, ...extra };
  return { store: "episodes", record };
}

/** A cited relationship with `who`, its trust `tr`. */
function relationship(who: number, tr: number): CitedRecord {
  const record = { id: 2, who, f: 300, seen: 12, aff: 0, tr, talk: 24, turns: 1 };
  return { store: "relations", record };
}

const CELL: mind.Cell = [5, -3];
const food = (v: number, cell: mind.Cell = CELL) => episode("food", { cell, v });
const told = (band: number | undefined, who = 7, p: mind.Proposition = foodAt(CELL, 2)) =>
  episode("heard", { who, cell: [4, -3], act: "tell", p, ...(band === undefined ? {} : { band }) });

describe("the proposition of mind@1", () => {
  test("is the band of food at a cell, in the namespace m1", () => {
    expect(foodAt([5, -3], 2)).toEqual({ p: FOOD_AT, a: [{ c: [5, -3] }], v: 2 });
    expect(FOOD_AT.startsWith("m1.")).toBe(true);
  });

  test("names its rules by identifiers the engine accepts", () => {
    expect(Object.keys(BELIEF_RULES).sort()).toEqual([RULE_IDS.seen, RULE_IDS.told].sort());
    for (const id of Object.keys(BELIEF_RULES)) expect(id).toMatch(/^[a-z][a-z0-9._-]{0,31}$/);
    expect(BELIEF_RULES[RULE_IDS.seen]).toBe(seenFood);
    expect(BELIEF_RULES[RULE_IDS.told]).toBe(toldFood);
  });
});

describe("seen-food: a belief from a food cue the being remembers", () => {
  test.each([0, 1, 2])(
    "believes band %i at the episode's cell with the confidence of sight",
    (v) => {
      expect(seenFood([food(v)], NEUTRAL)).toEqual({ p: foodAt(CELL, v), cr: SEEN_CR });
    },
  );

  test("reads only the cited content: not the episode's age, importance, or the traits", () => {
    const formed = seenFood([food(2)], NEUTRAL);
    expect(
      seenFood([episode("food", { cell: CELL, v: 2 }, { t: 9999, w: 3, r: 1 })], NEUTRAL),
    ).toEqual(formed);
    expect(seenFood([food(2)], withTraits({ credulity: 800, retention: 1200 }))).toEqual(formed);
  });

  test.each([
    { name: "nothing", cited: [] },
    { name: "two food cues", cited: [food(1), food(2, [6, -3])] },
    { name: "a being", cited: [episode("being", { who: 3, cell: CELL, v: 1 })] },
    { name: "a bite", cited: [episode("ate", { cell: CELL, v: 40 })] },
    { name: "a message", cited: [told(2)] },
    { name: "a relationship", cited: [relationship(7, 500)] },
  ])("forms nothing from $name", ({ cited }) => {
    expect(seenFood(cited, NEUTRAL)).toBeUndefined();
  });
});

describe("told-food: a belief from a testimony, weighed by trust and credulity", () => {
  test("weighs the speaker's band by its trust and the hearer's credulity, exactly", () => {
    // ⌊TOLD_CR[band] · (500 + trust) · credulity / 10^6⌋
    expect(toldFood([told(2), relationship(7, 700)], NEUTRAL)).toEqual({
      p: foodAt(CELL, 2),
      cr: Math.floor(((TOLD_CR[2] as number) * 1200) / 1000),
    });
    expect(toldFood([told(1), relationship(7, 300)], withTraits({ credulity: 900 }))?.cr).toBe(
      Math.floor(((TOLD_CR[1] as number) * 800 * 900) / 1_000_000),
    );
    expect(toldFood([told(0), relationship(7, 1000)], withTraits({ credulity: 1200 }))?.cr).toBe(
      Math.floor(((TOLD_CR[0] as number) * 1500 * 1200) / 1_000_000),
    );
  });

  test("trusts more, believes more: the band, the trust, and credulity each raise it", () => {
    const cr = (band: number, tr: number, credulity: number) =>
      toldFood([told(band), relationship(7, tr)], withTraits({ credulity }))?.cr ?? -1;
    expect(cr(1, 500, 1000)).toBeLessThan(cr(2, 500, 1000));
    expect(cr(2, 400, 1000)).toBeLessThan(cr(2, 600, 1000));
    expect(cr(2, 500, 800)).toBeLessThan(cr(2, 500, 1200));
  });

  test("never passes 1000", () => {
    const cr = toldFood([told(2), relationship(7, 1000)], withTraits({ credulity: 1200 }))?.cr;
    expect(cr).toBe(1000);
  });

  test("weighs a speaker the mind holds no relationship with as a stranger, with the trust of a new one", () => {
    const stranger = toldFood([told(2)], NEUTRAL);
    expect(stranger).toEqual(toldFood([told(2), relationship(7, STRANGER_TRUST)], NEUTRAL));
    expect(stranger?.cr).toBe(TOLD_CR[2]);
  });

  test("weighs a message whose speaker is not visible as one from a being it does not know", () => {
    // A research injection shows as a tell heard with no speaker, no cell, and no band.
    const unseen = episode("heard", { act: "tell", p: foodAt(CELL, 2) });
    const external = episode("external", { p: foodAt(CELL, 2) });
    const fromStranger = toldFood([told(1)], NEUTRAL);
    expect(toldFood([unseen], NEUTRAL)).toEqual(fromStranger);
    expect(toldFood([external], NEUTRAL)).toEqual(fromStranger);
    expect(toldFood([unseen], withTraits({ credulity: 800 }))?.cr).toBe(
      Math.floor(((TOLD_CR[1] as number) * 800) / 1000),
    );
  });

  test("reads only the cited content: not ages, importance, familiarity, or affinity", () => {
    const formed = toldFood([told(2), relationship(7, 700)], NEUTRAL);
    const record = { id: 9, who: 7, f: 1000, aff: -900, tr: 700, turns: 3 };
    const other: CitedRecord = { store: "relations", record };
    expect(
      toldFood(
        [
          episode(
            "heard",
            { who: 7, cell: [0, 0], act: "tell", p: foodAt(CELL, 2), band: 2 },
            { t: 5, w: 1, r: 5 },
          ),
          other,
        ],
        NEUTRAL,
      ),
    ).toEqual(formed);
  });

  test.each([
    { name: "a greet", cited: [episode("heard", { who: 7, cell: [4, -3], act: "greet" })] },
    { name: "an ask", cited: [episode("heard", { who: 7, cell: [4, -3], act: "ask" })] },
    {
      name: "a tell of another concept",
      cited: [told(2, 7, { p: "obs.light", a: [{ c: CELL }], v: 2 })],
    },
    { name: "a tell of a negation", cited: [told(2, 7, { ...foodAt(CELL, 2), neg: true })] },
    { name: "a tell of a band out of range", cited: [told(2, 7, foodAt(CELL, 3))] },
    {
      name: "a tell of two terms",
      cited: [told(2, 7, { p: FOOD_AT, a: [{ c: CELL }, { n: 1 }], v: 1 })],
    },
    { name: "a relationship with another being", cited: [told(2, 7), relationship(8, 900)] },
    { name: "a relationship first", cited: [relationship(7, 900), told(2, 7)] },
    { name: "a food cue", cited: [food(2)] },
    { name: "nothing", cited: [] },
  ])("forms nothing from $name", ({ cited }) => {
    expect(toldFood(cited, NEUTRAL)).toBeUndefined();
  });
});

describe("a revision of a food belief by what the being sees at its cell", () => {
  const held = { p: foodAt(CELL, 2), cr: 640 };
  const withConfidence = (cr: number) => ({ ...held, cr });

  test("confirms a belief seen again with its band, at the confidence of sight", () => {
    expect(revisedConfidence(held, [food(2)])).toBe(SEEN_CR);
  });

  test.each([0, 1])("contradicts a belief whose cell shows band %i", (v) => {
    expect(revisedConfidence(held, [food(v)])).toBe(CONTRADICTED_CR);
  });

  test("ignores the confidence the belief held", () => {
    expect(revisedConfidence(withConfidence(100), [food(1)])).toBe(CONTRADICTED_CR);
    expect(revisedConfidence(withConfidence(999), [food(2)])).toBe(SEEN_CR);
  });

  test.each([
    { name: "another cell", cited: [food(2, [5, -2])] },
    { name: "two cues", cited: [food(2), food(2)] },
    { name: "a message", cited: [told(2)] },
    { name: "nothing", cited: [] },
  ])("revises nothing from $name", ({ cited }) => {
    expect(revisedConfidence(held, cited)).toBeUndefined();
  });

  test("revises no belief of another shape", () => {
    const other = { p: { p: "m1.other", a: [{ c: CELL }] as const, v: 2 }, cr: 900 };
    expect(revisedConfidence(other, [food(2)])).toBeUndefined();
  });
});

describe("a change of trust by a testimony checked", () => {
  const laws = { relations: { delta: 200 } };

  test("raises trust when the speaker's claim is seen to hold, and lowers it when it does not", () => {
    expect(trustChange({ p: foodAt(CELL, 2) }, [food(2)], laws)).toBe(TRUST_STEP);
    expect(trustChange({ p: foodAt(CELL, 2) }, [food(0)], laws)).toBe(-TRUST_STEP);
  });

  test("never changes it by more than the law allows", () => {
    expect(trustChange({ p: foodAt(CELL, 2) }, [food(2)], { relations: { delta: 30 } })).toBe(30);
    expect(trustChange({ p: foodAt(CELL, 2) }, [food(1)], { relations: { delta: 0 } })).toBe(0);
  });

  test("changes nothing for what is not a cue of the belief's cell", () => {
    expect(trustChange({ p: foodAt(CELL, 2) }, [food(2, [0, 0])], laws)).toBeUndefined();
  });
});
