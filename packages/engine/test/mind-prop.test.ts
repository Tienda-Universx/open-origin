/**
 * Propositions prop@1 (docs/architecture/mind.md, "Propositions"): the structure the engine checks
 * on a value the beings layer already copied canonically, at most 96 bytes of canonical text, and
 * canonical equality, which deduplicates beliefs.
 */
import { describe, expect, test } from "bun:test";
import { canonicalize, type Issue, mind } from "../src/index.ts";
import { MAX_CELL, MIN_CELL } from "../src/worldgen/index.ts";

const { checkProposition, isConceptId, MIND_BOUNDS, PROP_BOUNDS, sameProposition } = mind;

/** The issues `checkProposition` reports for `value` at `/p`, and whether it accepted it. */
function check(value: unknown): { valid: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const valid = checkProposition(value, "/p", {
    report: (path, message) => issues.push({ path, message }),
  });
  return { valid, issues };
}

/** The paths of the issues of `value`. */
const paths = (value: unknown): string[] => check(value).issues.map((issue) => issue.path);

const FOOD_AT: mind.Proposition = {
  p: "m1.food-at",
  a: [{ c: [-99_999, -99_999] }],
  v: 2,
  neg: true,
};

describe("concept ids", () => {
  test.each(["m1.food-at", "obs.food", "a.b", "m1.food.near-0", "obs.0", `a.${"b".repeat(46)}`])(
    "accepts %s",
    (id) => {
      expect(isConceptId(id)).toBe(true);
    },
  );

  test.each([
    ["no namespace", "food"],
    ["an empty id", ""],
    ["an upper-case letter", "M1.food"],
    ["a namespace that starts with a digit", "1m.food"],
    ["a segment that starts with a hyphen", "m1.-food"],
    ["an underscore", "m1.food_at"],
    ["an empty segment", "m1..food"],
    ["a trailing dot", "m1.food."],
    ["a hyphen in the namespace", "m-1.food"],
    ["a space", "m1.food at"],
    ["49 characters", `a.${"b".repeat(47)}`],
  ])("rejects %s", (_name, id) => {
    expect(isConceptId(id)).toBe(false);
  });

  test("the longest concept id has 48 characters", () => {
    expect(PROP_BOUNDS.concept).toBe(48);
  });
});

describe("checkProposition", () => {
  test("accepts the propositions of mind@1 and every kind of term", () => {
    expect(check(FOOD_AT)).toEqual({ valid: true, issues: [] });
    expect(check({ p: "m1.food-near", a: [{ c: [0, 0] }] })).toEqual({ valid: true, issues: [] });
    const terms = { p: "obs.met", a: [{ e: 1 }, { n: -3 }], v: Number.MIN_SAFE_INTEGER };
    expect(check(terms)).toEqual({ valid: true, issues: [] });
    const extremes = { p: "a.b", a: [{ c: [MIN_CELL, MAX_CELL] }, { e: Number.MAX_SAFE_INTEGER }] };
    expect(check(extremes)).toEqual({ valid: true, issues: [] });
  });

  test("bounds a cell's coordinates as worldgen does", () => {
    expect(MIND_BOUNDS.cell).toEqual({ min: MIN_CELL, max: MAX_CELL });
    expect(paths({ p: "a.b", a: [{ c: [MIN_CELL - 1, 0] }] })).toEqual(["/p/a/0/c/0"]);
    expect(paths({ p: "a.b", a: [{ c: [0, MAX_CELL + 1] }] })).toEqual(["/p/a/0/c/1"]);
  });

  test.each([
    ["not a record", [1, 2], ["/p"]],
    ["null", null, ["/p"]],
    ["a string", "m1.food-at", ["/p"]],
    ["no concept and no terms", {}, ["/p/a", "/p/p"]],
    ["an unknown member", { ...FOOD_AT, x: 1 }, ["/p/x"]],
    ["a concept that breaks the grammar", { ...FOOD_AT, p: "Food" }, ["/p/p"]],
    ["a concept that is not a string", { ...FOOD_AT, p: 7 }, ["/p/p"]],
    ["no terms", { ...FOOD_AT, a: [] }, ["/p/a"]],
    ["three terms", { ...FOOD_AT, a: [{ n: 1 }, { n: 2 }, { n: 3 }] }, ["/p/a"]],
    ["terms that are not a list", { ...FOOD_AT, a: { n: 1 } }, ["/p/a"]],
    ["a term with two members", { ...FOOD_AT, a: [{ e: 1, n: 2 }] }, ["/p/a/0"]],
    ["a term of an unknown kind", { ...FOOD_AT, a: [{ x: 1 }] }, ["/p/a/0"]],
    ["a term that is not a record", { ...FOOD_AT, a: [1] }, ["/p/a/0"]],
    ["an entity id of 0", { ...FOOD_AT, a: [{ e: 0 }] }, ["/p/a/0/e"]],
    ["a cell with one coordinate", { ...FOOD_AT, a: [{ c: [1] }] }, ["/p/a/0/c"]],
    ["a cell that is not a list", { ...FOOD_AT, a: [{ c: 1 }] }, ["/p/a/0/c"]],
    ["a number term that is a string", { ...FOOD_AT, a: [{ n: "1" }] }, ["/p/a/0/n"]],
    ["a value that is not an integer", { ...FOOD_AT, v: "2" }, ["/p/v"]],
    ["neg false", { ...FOOD_AT, neg: false }, ["/p/neg"]],
    ["neg as a string", { ...FOOD_AT, neg: "true" }, ["/p/neg"]],
  ])("rejects %s", (_name, value, expected) => {
    const { valid, issues } = check(value);
    expect(valid).toBe(false);
    expect(issues.map((issue) => issue.path)).toEqual(expected);
  });

  test("reports every problem, not only the first", () => {
    const value = { p: "x", a: [{ e: -1 }, { c: [1] }], v: true, neg: 1, y: 0 };
    expect(paths(value)).toEqual(["/p/y", "/p/p", "/p/a/0/e", "/p/a/1/c", "/p/v", "/p/neg"]);
  });

  test("accepts exactly 96 bytes of canonical text and rejects 97", () => {
    // {"a":[{"n":1000000000000},{"n":-1000000000}],"p":"a.…"} is 54 bytes and the concept.
    const of = (length: number) => ({
      p: `a.${"b".repeat(length)}`,
      a: [{ n: 1_000_000_000_000 }, { n: -1_000_000_000 }],
    });
    const exact = of(42);
    expect(canonicalize(exact).length).toBe(PROP_BOUNDS.bytes);
    expect(check(exact)).toEqual({ valid: true, issues: [] });
    const over = of(43);
    expect(canonicalize(over).length).toBe(97);
    expect(check(over)).toEqual({
      valid: false,
      issues: [
        { path: "/p", message: "the proposition takes 97 bytes of canonical text: at most 96" },
      ],
    });
  });
});

describe("sameProposition", () => {
  test("compares canonical text, whatever the order of members", () => {
    const reordered: mind.Proposition = {
      neg: true,
      v: 2,
      a: [{ c: [-99_999, -99_999] }],
      p: "m1.food-at",
    };
    expect(sameProposition(FOOD_AT, reordered)).toBe(true);
  });

  test.each<[string, mind.Proposition]>([
    ["the negation", { p: "m1.food-at", a: [{ c: [-99_999, -99_999] }], v: 2 }],
    ["the value", { ...FOOD_AT, v: 1 }],
    ["a term", { ...FOOD_AT, a: [{ c: [-99_999, -99_998] }] }],
    ["the concept", { ...FOOD_AT, p: "m1.food-near" }],
  ])("tells propositions apart by %s", (_name, other) => {
    expect(sameProposition(FOOD_AT, other)).toBe(false);
  });
});
