/**
 * The laws of life@2 (ADR 0024, docs/architecture/mind.md "Laws of life@2"): the defaults of the
 * table, body laws equal to life@1's, every bound and every law across parts reported at its path,
 * the parts `mind` and `relations` bounded by the mind layer, the seal, and the two versions
 * refusing each other's laws.
 */
import { describe, expect, test } from "bun:test";
import { beings, copyCanonical, digest, type Issue, mind, worldgen } from "../src/index.ts";

const { checkLife2, defaultLife2, LIFE2_VERSION, sealedLifeIssues, sealLife2 } = beings;

/** Every issue checkLife2 reports for `value`. */
function issues2(value: unknown): Issue[] {
  const found: Issue[] = [];
  checkLife2(value, "", { report: (path, message) => found.push({ path, message }) });
  return found;
}

/** The default laws of life@2 with the member at the JSON Pointer `path` set to `value`. */
function withMember(path: string, value: unknown): unknown {
  const root = copyCanonical(defaultLife2()) as { [key: string]: unknown };
  const parts = path.split("/").slice(1);
  const name = parts.pop() ?? "";
  let parent = root;
  for (const part of parts) parent = parent[part] as { [key: string]: unknown };
  if (value === undefined) delete parent[name];
  else parent[name] = value;
  return root;
}

/** The members life@2 adds to a species of life@1. */
const ADDED = ["mind", "perception", "relations", "speech"];

describe("the default laws of life@2", () => {
  test("keep every body law of the default laws of life@1, exactly", () => {
    const life2 = defaultLife2();
    const life1 = beings.defaultLife();
    expect(life2.deathEnabled).toBe(life1.deathEnabled);
    const bodies = life2.species.map((species) => {
      const body: { [name: string]: unknown } = { ...species };
      for (const name of ADDED) delete body[name];
      return body;
    });
    expect(bodies).toEqual(life1.species as unknown as { [name: string]: unknown }[]);
  });

  test("hold the defaults of the table of mind.md, and pass their own check", () => {
    const life = defaultLife2();
    expect(life.version).toBe("life@2");
    expect(life.capacity).toBe(64);
    const [species] = life.species;
    expect(species?.perception).toEqual({
      sight: { day: 12, dim: 4 },
      dimBelow: 150,
      attention: 6,
    });
    expect({ mind: species?.mind, relations: species?.relations }).toEqual({
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
    expect(species?.speech).toEqual({
      range: 3,
      actMs: 4000,
      turns: 3,
      gap: 120,
      cooldown: 18_900,
      perDay: 10,
      wakesPerDay: 8,
    });
    expect(species?.traits).toEqual({ min: 800, max: 1200 });
    expect(issues2(life)).toEqual([]);
  });

  test("are a fresh tree at every call, with no part shared between species or calls", () => {
    const first = defaultLife2();
    const second = defaultLife2();
    expect(first).toEqual(second);
    expect(first.species[0]?.mind).not.toBe(second.species[0]?.mind);
    expect(() => copyCanonical(first)).not.toThrow();
  });
});

describe("checkLife2", () => {
  test.each([
    ["/capacity", 0, "0 is out of bounds: it must be from 1 to 1024"],
    ["/capacity", 1025, "1025 is out of bounds: it must be from 1 to 1024"],
    ["/species/0/perception/sight/day", 25, "25 is out of bounds: it must be from 0 to 24"],
    ["/species/0/perception/sight/dim", -1, "-1 is out of bounds: it must be from 0 to 24"],
    [
      "/species/0/perception/dimBelow",
      0x10_0001,
      "1048577 is out of bounds: it must be from 0 to 1048576",
    ],
    ["/species/0/perception/attention", 9, "9 is out of bounds: it must be from 0 to 8"],
    ["/species/0/speech/range", 0, "0 is out of bounds: it must be from 1 to 8"],
    ["/species/0/speech/actMs", 60_001, "60001 is out of bounds: it must be from 1 to 60000"],
    ["/species/0/speech/turns", 9, "9 is out of bounds: it must be from 1 to 8"],
    ["/species/0/speech/gap", 0, "0 is out of bounds: it must be from 1 to 2147483647"],
    [
      "/species/0/speech/cooldown",
      2 ** 31,
      "2147483648 is out of bounds: it must be from 1 to 2147483647",
    ],
    ["/species/0/speech/perDay", 65, "65 is out of bounds: it must be from 0 to 64"],
    ["/species/0/speech/wakesPerDay", -1, "-1 is out of bounds: it must be from 0 to 64"],
    ["/species/0/mind/episodes", 17, "must be an integer from 0 to 16"],
    ["/species/0/mind/halfLife/belief", 0, "must be an integer from 1 to 2147483647"],
    ["/species/0/mind/depth", 0, "must be an integer from 1 to 8"],
    ["/species/0/relations/delta", 1001, "must be an integer from 0 to 1000"],
    ["/species/0/relations/rate/den", 0, "must be an integer from 1 to 4294967296"],
  ])("reports %s = %p: %s", (path, value, message) => {
    expect(issues2(withMember(path, value))).toEqual([{ path, message }]);
  });

  test("accepts every law at its bounds", () => {
    const bounds: [string, number][] = [
      ["/capacity", 1],
      ["/capacity", 1024],
      ["/species/0/perception/sight/day", 24],
      ["/species/0/perception/sight/day", 0],
      ["/species/0/perception/attention", 0],
      ["/species/0/perception/attention", 8],
      ["/species/0/perception/dimBelow", 0x10_0000],
      ["/species/0/speech/range", 1],
      ["/species/0/speech/perDay", 64],
      ["/species/0/speech/actMs", 60_000],
    ];
    for (const [path, value] of bounds) expect(issues2(withMember(path, value))).toEqual([]);
  });

  test("bounds sight by the radius of the window, which holds every being in sight", () => {
    const narrow = withMember("/species/0/senses/radius", 8) as {
      species: { perception: { sight: { day: number } } }[];
    };
    expect(issues2(narrow)).toEqual([
      {
        path: "/species/0/perception/sight/day",
        message: "12 is out of bounds: it must be from 0 to 8",
      },
    ]);
  });

  test("keeps speech within dim sight, and silent without relationships", () => {
    expect(issues2(withMember("/species/0/speech/range", 5))).toEqual([
      {
        path: "/species/0/speech/range",
        message:
          "speech reaches 5 cells, farther than the dim sight of 4: a hearer must be perceived",
      },
    ]);
    expect(issues2(withMember("/species/0/mind/relations", 0))).toEqual([
      {
        path: "/species/0/speech/perDay",
        message:
          "10 acts a day with mind.relations 0: a species without relationships says nothing, since the quotas per pair live in relationships",
      },
    ]);
    const silent = withMember("/species/0/mind/relations", 0) as {
      species: { speech: { perDay: number } }[];
    };
    (silent.species[0] as { speech: { perDay: number } }).speech.perDay = 0;
    expect(issues2(silent)).toEqual([]);
  });

  test("bounds mind and relations with the mind layer, across laws too", () => {
    const pinned = withMember("/species/0/mind/pinLevel", 50);
    const expected: Issue[] = [];
    const laws = mind.defaultMindLaws();
    mind.checkMindLaws({ ...laws, mind: { ...laws.mind, pinLevel: 50 } }, "/species/0", {
      report: (path, message) => expected.push({ path, message }),
    });
    expect(expected).toHaveLength(1);
    expect(issues2(pinned)).toEqual(expected);
    const slow = withMember("/species/0/relations/rate", { num: 1, den: 0x1_0000_0000 });
    expect(issues2(slow).map(({ path }) => path)).toEqual(["/species/0/relations/rate"]);
  });

  test("reads the shape of mind and relations first, and bounds only a shape it could read", () => {
    const life = withMember("/species/0/mind/episodes", "8");
    // One issue, from the reader: the mind layer is not asked about a part it cannot read.
    expect(issues2(life)).toEqual([
      { path: "/species/0/mind/episodes", message: "the value must be an integer, not a string" },
    ]);
    expect(issues2(withMember("/species/0/relations/rate", undefined))).toEqual([
      { path: "/species/0/relations/rate", message: "the member is missing" },
    ]);
    expect(
      issues2(withMember("/species/0/mind/halfLife", { episode: 1, belief: 1, x: 1 })),
    ).toEqual([
      {
        path: "/species/0/mind/halfLife/x",
        message: "unknown member: the members here are belief, episode",
      },
    ]);
  });

  test("reports every missing part and the version of life@1", () => {
    const life = copyCanonical(defaultLife2()) as {
      version: string;
      species: { [name: string]: unknown }[];
    };
    life.version = "life@1";
    for (const name of ADDED) delete (life.species[0] as { [name: string]: unknown })[name];
    expect(issues2(life)).toEqual([
      { path: "/version", message: `the version must be "${LIFE2_VERSION}"` },
      ...ADDED.map((name) => ({ path: `/species/0/${name}`, message: "the member is missing" })),
    ]);
  });
});

describe("the two versions of the laws", () => {
  test("refuse each other's laws", () => {
    const one: Issue[] = [];
    beings.checkLife(defaultLife2(), "", {
      report: (path, message) => one.push({ path, message }),
    });
    expect(one.map(({ path }) => path)).toEqual([
      "/capacity",
      "/version",
      ...ADDED.map((name) => `/species/0/${name}`),
    ]);
    expect(issues2(beings.defaultLife()).map(({ path }) => path)).toEqual([
      "/capacity",
      "/version",
      ...ADDED.map((name) => `/species/0/${name}`),
    ]);
  });

  test("seal with their own version: digest(['life', 'life@2', life])", () => {
    const life = defaultLife2();
    expect(beings.lifeSeal2(life)).toBe(digest(["life", "life@2", life]));
    expect(sealLife2(life)).toEqual({ life, lifeSeal: digest(["life", "life@2", life]) });
    expect(beings.lifeSeal2(life)).not.toBe(digest(["life", "life@1", life]));
  });

  test("validate a sealed global value of life@2 with its own rules", () => {
    const genesis = worldgen.defaultGenesis([1, 2, 3, 4, 5, 6, 7, 8]);
    const life = defaultLife2();
    const global = { genesis, genesisSeal: worldgen.genesisSeal(genesis), ...sealLife2(life) };
    expect(sealedLifeIssues(global, beings.LIFE2_RULES)).toEqual([]);
    const stale = { ...global, lifeSeal: beings.lifeSeal(beings.defaultLife()) };
    expect(sealedLifeIssues(stale, beings.LIFE2_RULES).map(({ path }) => path)).toEqual([
      "/lifeSeal",
    ]);
    // Under the rules of life@1, the same value is refused for its version and members.
    expect(sealedLifeIssues(global).map(({ path }) => path)).toContain("/life/version");
  });
});
