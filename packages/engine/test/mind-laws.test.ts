/**
 * The laws of the mind and of relationships in life@2 (docs/architecture/mind.md, "Laws of
 * life@2"): their defaults, the bounds of the table at both edges, and the two rules across laws.
 */
import { describe, expect, test } from "bun:test";
import * as rates from "../src/beings/rates.ts";
import { beings, type Issue, mind } from "../src/index.ts";
import { Sfc32 } from "./support/sfc32.ts";

const { checkMindLaws, defaultMindLaws, familiaritySaturation, MIND_LAW_BOUNDS } = mind;

type Laws = mind.MindLaws;

function issuesOf(laws: Laws): Issue[] {
  const issues: Issue[] = [];
  checkMindLaws(laws, "/species/0", { report: (path, message) => issues.push({ path, message }) });
  return issues;
}

const pathsOf = (laws: Laws): string[] => issuesOf(laws).map((issue) => issue.path);

/** The default laws with `change` applied to the part `mind`. */
const withMind = (change: Partial<Laws["mind"]>): Laws => {
  const laws = defaultMindLaws();
  return { ...laws, mind: { ...laws.mind, ...change } };
};

/** The default laws with `change` applied to the part `relations`. */
const withRelations = (change: Partial<Laws["relations"]>): Laws => {
  const laws = defaultMindLaws();
  return { ...laws, relations: { ...laws.relations, ...change } };
};

describe("defaultMindLaws", () => {
  test("holds the defaults of the table", () => {
    expect(defaultMindLaws()).toEqual({
      mind: {
        episodes: 8,
        beliefs: 8,
        relations: 6,
        inbox: 2,
        ops: 4,
        depth: 6,
        halfLife: { episode: 75_600, belief: 302_400 },
        floor: 50,
        pinLevel: 900,
        pins: 2,
        recall: 200,
      },
      relations: { rate: { num: 5, den: 36 }, gap: 600, halfLife: 756_000, delta: 200 },
    });
    expect(issuesOf(defaultMindLaws())).toEqual([]);
  });

  test("returns a fresh value each time", () => {
    expect(defaultMindLaws()).not.toBe(defaultMindLaws());
  });
});

describe("checkMindLaws", () => {
  const INT31 = 0x7fff_ffff;
  test.each([
    ["episodes", 0, 16],
    ["beliefs", 0, 16],
    ["relations", 0, 12],
    ["inbox", 0, 4],
    ["ops", 0, 8],
    ["depth", 1, 8],
    ["pins", 0, 4],
    ["recall", 0, 1000],
  ] as const)("bounds mind.%s from %d to %d", (name, min, max) => {
    expect(MIND_LAW_BOUNDS[name]).toEqual({ min, max });
    expect(pathsOf(withMind({ [name]: min }))).toEqual([]);
    expect(pathsOf(withMind({ [name]: max }))).toEqual([]);
    expect(pathsOf(withMind({ [name]: min - 1 }))).toEqual([`/species/0/mind/${name}`]);
    expect(pathsOf(withMind({ [name]: max + 1 }))).toEqual([`/species/0/mind/${name}`]);
  });

  test("bounds each half-life of salience from 1 to 2^31 − 1", () => {
    for (const name of ["episode", "belief"] as const) {
      const at = (value: number) =>
        pathsOf(withMind({ halfLife: { ...defaultMindLaws().mind.halfLife, [name]: value } }));
      expect(at(1)).toEqual([]);
      expect(at(INT31)).toEqual([]);
      expect(at(0)).toEqual([`/species/0/mind/halfLife/${name}`]);
      expect(at(INT31 + 1)).toEqual([`/species/0/mind/halfLife/${name}`]);
    }
  });

  test("bounds the floor from 0 to 999 and the pin level from 1 to 1000, above the floor", () => {
    expect(pathsOf(withMind({ floor: 0, pinLevel: 1 }))).toEqual([]);
    expect(pathsOf(withMind({ floor: 999, pinLevel: 1000 }))).toEqual([]);
    expect(pathsOf(withMind({ floor: -1 }))).toEqual(["/species/0/mind/floor"]);
    expect(pathsOf(withMind({ floor: 1000, pinLevel: 1000 }))).toEqual(["/species/0/mind/floor"]);
    expect(pathsOf(withMind({ pinLevel: 1001 }))).toEqual(["/species/0/mind/pinLevel"]);
    expect(issuesOf(withMind({ floor: 900, pinLevel: 900 }))).toEqual([
      {
        path: "/species/0/mind/pinLevel",
        message:
          "900 is not above the floor (900): an episode is pinned only from an importance above the salience it is forgotten below",
      },
    ]);
  });

  test.each([
    ["gap", 1, INT31],
    ["halfLife", 1, INT31],
    ["delta", 0, 1000],
  ] as const)("bounds relations.%s from %d to %d", (name, min, max) => {
    expect(pathsOf(withRelations({ [name]: min }))).toEqual([]);
    expect(pathsOf(withRelations({ [name]: max }))).toEqual([]);
    expect(pathsOf(withRelations({ [name]: min - 1 }))).toEqual([`/species/0/relations/${name}`]);
    expect(pathsOf(withRelations({ [name]: max + 1 }))).toEqual([`/species/0/relations/${name}`]);
  });

  test("bounds the rate's terms as the rates of T4", () => {
    expect(MIND_LAW_BOUNDS.rate).toEqual(beings.RATIO_BOUNDS);
    const rate = (num: number, den: number) => pathsOf(withRelations({ rate: { num, den } }));
    expect(rate(0x10_0000, 1)).toEqual([]);
    expect(rate(0x10_0001, 1)).toEqual(["/species/0/relations/rate/num"]);
    expect(rate(1, 0)).toEqual(["/species/0/relations/rate/den"]);
    expect(rate(0x10_0000, 0x1_0000_0001)).toEqual(["/species/0/relations/rate/den"]);
  });

  test("keeps the saturation of familiarity, ⌈1000 / rate⌉ seconds, at most 2^22", () => {
    const rate = (num: number, den: number) => issuesOf(withRelations({ rate: { num, den } }));
    // ⌈1000·4194304/1000⌉ = 2^22 exactly, and one more second of den crosses it.
    expect(rate(1000, 4_194_304)).toEqual([]);
    expect(rate(1000, 4_194_305)).toEqual([
      {
        path: "/species/0/relations/rate",
        message:
          "familiarity saturates at ⌈1000 / rate⌉ = 4194305 seconds: at most 4194304 (2^22), so every product of salience and familiarity stays a safe integer",
      },
    ]);
    expect(rate(0, 1)).toEqual([
      {
        path: "/species/0/relations/rate",
        message:
          "a rate of 0 never gives familiarity: the rate must be positive, so that familiarity saturates",
      },
    ]);
  });

  test("reports every problem of both parts", () => {
    const laws = defaultMindLaws();
    const broken: Laws = {
      mind: { ...laws.mind, episodes: 17, depth: 0, recall: -1 },
      relations: { ...laws.relations, gap: 0, delta: 1001 },
    };
    expect(pathsOf(broken)).toEqual([
      "/species/0/mind/episodes",
      "/species/0/mind/depth",
      "/species/0/mind/recall",
      "/species/0/relations/gap",
      "/species/0/relations/delta",
    ]);
  });
});

describe("what the mind layer shares with the beings layer", () => {
  test("ceilDiv, least, and greatest agree with the beings layer's, which it may not import", () => {
    const random = new Sfc32(5306);
    for (let round = 0; round < 2000; round += 1) {
      const a = random.between(0, 0xffff_ffff) * random.between(1, 0x1f_ffff);
      const b = random.between(1, 0xffff_ffff);
      expect(mind.ceilDiv(a, b)).toBe(rates.ceilDiv(a, b));
      expect(mind.least(a, b)).toBe(rates.least(a, b));
      expect(mind.greatest(a, b)).toBe(rates.greatest(a, b));
    }
  });

  test("familiarity saturates within the 2^22 seconds its bound allows", () => {
    expect(mind.MIND_BOUNDS.familiarity.max).toBe(2 ** 22);
    expect(familiaritySaturation({ num: 5, den: 36 })).toBe(7200);
    expect(familiaritySaturation({ num: 3, den: 7 })).toBe(2334);
  });
});
