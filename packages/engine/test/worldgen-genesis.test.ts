import { describe, expect, test } from "bun:test";
import { digest, worldgen } from "../src/index.ts";
import { sharedGenesis } from "../src/worldgen/genesis.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";

/**
 * The sealed genesis (ADR 0021, genesis): schema and bounds, every problem at once with its JSON
 * Pointer, a prepared genesis that copies and cannot be forged, and the seal.
 */

const {
  GENESIS_BOUNDS,
  PreparedGenesis,
  WORLDGEN_VERSION,
  defaultGenesis,
  genesisIssues,
  genesisOf,
  genesisSeal,
  prepareGenesis,
  sealOf,
  sealedGenesisIssues,
} = worldgen;

type Genesis = worldgen.Genesis;

const SEED = [0x0123_4567, 0x89ab_cdef, 0xdead_beef, 0, 1, 2, 3, 0xffff_ffff];

const MISSING = "the member is missing";
const SEED_WORD = "the word is not a u32: terrain seed words are integers from 0 to 4294967295";
const WITHHELD =
  "the terrain seed is not canonical here; the details are withheld, as no message prints the terrain seed";
const SEAL_MISMATCH =
  "the seal does not match the genesis: the genesis changed after it was sealed, or the seal was made for another genesis";
const NOT_PREPARED = "the value is not a prepared genesis: prepareGenesis makes them";
const outOfBounds = (value: number, min: number, max: number) =>
  `${value} is out of bounds: it must be from ${min} to ${max}`;
const notPowerOfTwo = (value: number, min: number, max: number) =>
  `${value} is not a power of two from ${min} to ${max}`;
const unknown = (members: string) => `unknown member: the members here are ${members}`;
const notRecord = (members: string, kind: string) =>
  `the value must be a record { ${members} }, not ${kind}`;
const entries = (count: number, bounds: string) =>
  `the array has ${count} entries: it must have ${bounds}`;

/** A marker that removes the member at a pointer instead of setting it. */
const REMOVE = Symbol("remove");

/**
 * A mutable deep copy of the default genesis with every edit applied: each key is a JSON Pointer
 * whose last segment is set to the value, or removed for REMOVE.
 */
function genesisWith(edits: Record<string, unknown>): Record<string, unknown> {
  const genesis = structuredClone(defaultGenesis(SEED)) as unknown as Record<string, unknown>;
  for (const [pointer, value] of Object.entries(edits)) {
    const keys = pointer.split("/").slice(1);
    const last = keys.pop() ?? "";
    let target = genesis;
    for (const key of keys) target = target[key] as Record<string, unknown>;
    if (value === REMOVE) delete target[last];
    else target[last] = value;
  }
  return genesis;
}

/** The issues of the default genesis with `edits` applied. */
const issuesWith = (edits: Record<string, unknown>) => genesisIssues(genesisWith(edits));

describe("defaultGenesis", () => {
  test("returns the non-terrestrial defaults of O-13 around the seed", () => {
    expect(defaultGenesis(SEED)).toEqual({
      terrainSeed: SEED,
      laws: {
        day: { length: 75600, daylight: 550 },
        liquid: { level: 450 },
        thermal: { base: 400, spread: 120, lapse: { num: 3, den: 1000 }, diurnal: 60 },
        radiance: { peak: 1000, night: 40 },
      },
      terrain: {
        relief: { wavelength: 2048, octaves: 7, amplitude: 60000 },
        substrate: { cell: 64, weights: [5, 3, 2, 1] },
        deposits: [
          { wavelength: 256, octaves: 3, threshold: 600, peak: 1000 },
          { wavelength: 512, octaves: 2, threshold: 700, peak: 1000 },
        ],
      },
    });
  });

  test("is valid, unlike Earth: a day other than 86,400 s, and warmer with elevation", () => {
    const genesis = defaultGenesis(SEED);
    expect(genesisIssues(genesis)).toEqual([]);
    expect(genesis.laws.day.length).not.toBe(86_400);
    expect(genesis.laws.thermal.lapse.num).toBeGreaterThan(0);
  });

  test("copies the seed, and returns a fresh genesis on every call", () => {
    const seed = [...SEED];
    const genesis = defaultGenesis(seed);
    seed[0] = 7;
    expect(genesis.terrainSeed).toEqual(SEED);
    expect(defaultGenesis(SEED)).not.toBe(defaultGenesis(SEED));
  });

  test("rejects a seed that is not 8 u32 words, without printing its words", () => {
    const error = engineErrorOf(() => defaultGenesis([1, 2, 3, 4, 5, 6, 7, 2 ** 32]));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "/terrainSeed/7", message: SEED_WORD }]);
    expect(error.message).not.toContain("4294967296");
  });
});

describe("GENESIS_BOUNDS", () => {
  test("pins the bounds table of the worldgen specification", () => {
    const p20 = 2 ** 20;
    expect(GENESIS_BOUNDS).toEqual({
      terrainSeedWords: { min: 8, max: 8 },
      laws: {
        day: { length: { min: 1, max: 2 ** 40 }, daylight: { min: 1, max: 999 } },
        liquid: { level: { min: 100, max: 900 } },
        thermal: {
          base: { min: -p20, max: p20 },
          spread: { min: 0, max: p20 },
          lapse: { num: { min: -p20, max: p20 }, den: { min: 1, max: p20 } },
          diurnal: { min: 0, max: p20 },
        },
        radiance: { peak: { min: 1, max: p20 }, night: { min: 0, max: p20 } },
      },
      terrain: {
        relief: {
          wavelength: { min: 8, max: 2 ** 16 },
          octaves: { min: 1, max: 12 },
          amplitude: { min: 1, max: 2 ** 30 },
        },
        substrate: {
          cell: { min: 8, max: 2 ** 12 },
          classes: { min: 1, max: 16 },
          weight: { min: 1, max: 1000 },
        },
        deposits: {
          count: { min: 0, max: 8 },
          wavelength: { min: 8, max: 2 ** 16 },
          octaves: { min: 1, max: 6 },
          threshold: { min: 0, max: 999 },
          peak: { min: 1, max: p20 },
        },
      },
    });
  });

  test("is frozen at every level, so no caller can loosen a bound", () => {
    const { laws, terrain } = GENESIS_BOUNDS;
    for (const value of [
      GENESIS_BOUNDS,
      GENESIS_BOUNDS.terrainSeedWords,
      laws,
      laws.day,
      laws.day.length,
      laws.thermal.lapse,
      laws.thermal.lapse.den,
      terrain,
      terrain.relief.wavelength,
      terrain.substrate,
      terrain.deposits,
      terrain.deposits.peak,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});

describe("genesisIssues: integer bounds", () => {
  /**
   * Each bounded integer, its bounds, and the edits that keep every other check passing at the
   * bounds: night may not exceed peak, and the wavelength must cover the octaves.
   */
  const rows: [string, number, number, Record<string, unknown>][] = [
    ["/laws/day/length", 1, 2 ** 40, {}],
    ["/laws/day/daylight", 1, 999, {}],
    ["/laws/liquid/level", 100, 900, {}],
    ["/laws/thermal/base", -(2 ** 20), 2 ** 20, {}],
    ["/laws/thermal/spread", 0, 2 ** 20, {}],
    ["/laws/thermal/lapse/num", -(2 ** 20), 2 ** 20, {}],
    ["/laws/thermal/lapse/den", 1, 2 ** 20, {}],
    ["/laws/thermal/diurnal", 0, 2 ** 20, {}],
    ["/laws/radiance/peak", 1, 2 ** 20, { "/laws/radiance/night": 0 }],
    ["/laws/radiance/night", 0, 1000, {}],
    ["/terrain/relief/octaves", 1, 12, { "/terrain/relief/wavelength": 2 ** 16 }],
    ["/terrain/relief/amplitude", 1, 2 ** 30, {}],
    ["/terrain/substrate/weights/0", 1, 1000, {}],
    ["/terrain/substrate/weights/3", 1, 1000, {}],
    ["/terrain/deposits/0/octaves", 1, 6, {}],
    ["/terrain/deposits/1/threshold", 0, 999, {}],
    ["/terrain/deposits/1/peak", 1, 2 ** 20, {}],
  ];

  test.each(rows)("%s accepts %d and %d, its bounds", (pointer, min, max, context) => {
    expect(issuesWith({ ...context, [pointer]: min })).toEqual([]);
    expect(issuesWith({ ...context, [pointer]: max })).toEqual([]);
  });

  test.each(rows)("%s rejects one past either bound", (pointer, min, max, context) => {
    for (const value of [min - 1, max + 1]) {
      expect(issuesWith({ ...context, [pointer]: value })).toEqual([
        { path: pointer, message: outOfBounds(value, min, max) },
      ]);
    }
  });

  test("night may not exceed peak, whatever peak is", () => {
    const edits = { "/laws/radiance/peak": 500, "/laws/radiance/night": 501 };
    expect(issuesWith(edits)).toEqual([
      { path: "/laws/radiance/night", message: outOfBounds(501, 0, 500) },
    ]);
  });

  test("night is checked against the widest peak when peak itself is invalid", () => {
    const edits = { "/laws/radiance/peak": 0, "/laws/radiance/night": 2 ** 20 + 1 };
    expect(issuesWith(edits)).toEqual([
      { path: "/laws/radiance/peak", message: outOfBounds(0, 1, 2 ** 20) },
      { path: "/laws/radiance/night", message: outOfBounds(2 ** 20 + 1, 0, 2 ** 20) },
    ]);
    expect(issuesWith({ "/laws/radiance/peak": 0, "/laws/radiance/night": 999 })).toEqual([
      { path: "/laws/radiance/peak", message: outOfBounds(0, 1, 2 ** 20) },
    ]);
  });
});

describe("genesisIssues: powers of two", () => {
  /** Each power-of-two field, its bounds for the default octaves, and a value in range that is not one. */
  const rows: [string, number, number, number][] = [
    ["/terrain/relief/wavelength", 8 * 2 ** 6, 2 ** 16, 3000],
    ["/terrain/substrate/cell", 8, 2 ** 12, 63],
    ["/terrain/deposits/0/wavelength", 8 * 2 ** 2, 2 ** 16, 100],
    ["/terrain/deposits/1/wavelength", 8 * 2 ** 1, 2 ** 16, 24],
  ];

  test.each(rows)("%s accepts %d and %d, its bounds", (pointer, min, max) => {
    expect(issuesWith({ [pointer]: min })).toEqual([]);
    expect(issuesWith({ [pointer]: max })).toEqual([]);
  });

  test.each(rows)(
    "%s rejects half its lowest, twice its highest, and a value that is not a power of two",
    (pointer, min, max, odd) => {
      for (const value of [min / 2, max * 2, odd]) {
        expect(issuesWith({ [pointer]: value })).toEqual([
          { path: pointer, message: notPowerOfTwo(value, min, max) },
        ]);
      }
    },
  );

  test("the lowest wavelength follows the octaves: 8·2^(octaves − 1)", () => {
    expect(issuesWith({ "/terrain/relief/octaves": 1, "/terrain/relief/wavelength": 8 })).toEqual(
      [],
    );
    expect(
      issuesWith({ "/terrain/relief/octaves": 12, "/terrain/relief/wavelength": 8192 }),
    ).toEqual([
      {
        path: "/terrain/relief/wavelength",
        message: notPowerOfTwo(8192, 16384, 65536),
      },
    ]);
    const deposit = { "/terrain/deposits/0/octaves": 6, "/terrain/deposits/0/wavelength": 128 };
    expect(issuesWith(deposit)).toEqual([
      { path: "/terrain/deposits/0/wavelength", message: notPowerOfTwo(128, 256, 65536) },
    ]);
  });

  test("a wavelength is checked for one octave when its octaves are invalid", () => {
    const edits = { "/terrain/relief/octaves": 13, "/terrain/relief/wavelength": 8 };
    expect(issuesWith(edits)).toEqual([
      { path: "/terrain/relief/octaves", message: outOfBounds(13, 1, 12) },
    ]);
    expect(issuesWith({ "/terrain/relief/octaves": 0, "/terrain/relief/wavelength": 4 })).toEqual([
      { path: "/terrain/relief/octaves", message: outOfBounds(0, 1, 12) },
      { path: "/terrain/relief/wavelength", message: notPowerOfTwo(4, 8, 65536) },
    ]);
  });
});

describe("genesisIssues: lists", () => {
  test("weights hold 1 to 16 entries", () => {
    const weights = "/terrain/substrate/weights";
    expect(issuesWith({ [weights]: [1] })).toEqual([]);
    expect(issuesWith({ [weights]: Array.from({ length: 16 }, () => 1000) })).toEqual([]);
    expect(issuesWith({ [weights]: [] })).toEqual([
      { path: weights, message: entries(0, "from 1 to 16") },
    ]);
    expect(issuesWith({ [weights]: Array.from({ length: 17 }, () => 1) })).toEqual([
      { path: weights, message: entries(17, "from 1 to 16") },
    ]);
  });

  test("deposits hold 0 to 8 entries", () => {
    const deposit = { wavelength: 64, octaves: 1, threshold: 0, peak: 1 };
    const deposits = "/terrain/deposits";
    expect(issuesWith({ [deposits]: [] })).toEqual([]);
    expect(issuesWith({ [deposits]: Array.from({ length: 8 }, () => ({ ...deposit })) })).toEqual(
      [],
    );
    expect(issuesWith({ [deposits]: Array.from({ length: 9 }, () => ({ ...deposit })) })).toEqual([
      { path: deposits, message: entries(9, "from 0 to 8") },
    ]);
  });

  test("a list that is too long still reports the problems of its entries", () => {
    const weights = [...Array.from({ length: 16 }, () => 1), 0];
    expect(issuesWith({ "/terrain/substrate/weights": weights })).toEqual([
      { path: "/terrain/substrate/weights", message: entries(17, "from 1 to 16") },
      { path: "/terrain/substrate/weights/16", message: outOfBounds(0, 1, 1000) },
    ]);
  });
});

describe("genesisIssues: the terrain seed", () => {
  test.each<[string, unknown[], string]>([
    ["7 words", SEED.slice(1), entries(7, "exactly 8")],
    ["9 words", [...SEED, 0], entries(9, "exactly 8")],
    ["no words", [], entries(0, "exactly 8")],
  ])("rejects %s", (_, terrainSeed, message) => {
    expect(issuesWith({ "/terrainSeed": terrainSeed })).toEqual([
      { path: "/terrainSeed", message },
    ]);
  });

  test.each<[string, unknown]>([
    ["2^32", 2 ** 32],
    ["-1", -1],
    ["a string", "12345"],
    ["a boolean", true],
    ["an array", [12345]],
  ])("rejects a word that is %s, without printing it", (_, word) => {
    const issues = issuesWith({ "/terrainSeed/3": word });
    expect(issues).toEqual([{ path: "/terrainSeed/3", message: SEED_WORD }]);
  });

  test.each<[string, unknown]>([
    ["a fraction", 1234.5],
    ["2^53", 2 ** 53],
    ["-0", -0],
    ["null", null],
  ])("withholds the canonical problem of a word that is %s", (_, word) => {
    const issues = issuesWith({ "/terrainSeed/3": word });
    expect(issues).toEqual([{ path: "/terrainSeed/3", message: WITHHELD }]);
    for (const { message } of issues) {
      expect(message).not.toContain("1234");
      expect(message).not.toContain("9007199254740992");
    }
  });

  test("withholds the canonical problem of a seed with a hole", () => {
    const terrainSeed = [...SEED];
    delete terrainSeed[2];
    expect(issuesWith({ "/terrainSeed": terrainSeed })).toEqual([
      { path: "/terrainSeed", message: WITHHELD },
    ]);
  });

  test("rejects a seed that is not an array, without printing it", () => {
    expect(issuesWith({ "/terrainSeed": 123456789 })).toEqual([
      { path: "/terrainSeed", message: "the value must be an array, not a number" },
    ]);
    expect(issuesWith({ "/terrainSeed": 1.5 })).toEqual([
      { path: "/terrainSeed", message: WITHHELD },
    ]);
  });

  test("never prints a word in any message, even among other problems", () => {
    const terrainSeed = [4_000_000_001, 2 ** 32 + 7, 1234.5, -987654, "31337"];
    const issues = issuesWith({ "/terrainSeed": terrainSeed });
    expect(issues.map(({ path }) => path)).toEqual([
      "/terrainSeed/2",
      "/terrainSeed",
      "/terrainSeed/1",
      "/terrainSeed/3",
      "/terrainSeed/4",
    ]);
    const text = issues.map(({ message }) => message).join("\n");
    for (const word of ["4000000001", "4294967303", "1234", "987654", "31337"]) {
      expect(text).not.toContain(word);
    }
  });
});

describe("genesisIssues: schema", () => {
  test.each<[string, string]>([
    ["", "terrainSeed, laws, terrain"],
    ["/laws", "day, liquid, thermal, radiance"],
    ["/laws/day", "length, daylight"],
    ["/laws/liquid", "level"],
    ["/laws/thermal", "base, spread, lapse, diurnal"],
    ["/laws/thermal/lapse", "num, den"],
    ["/laws/radiance", "peak, night"],
    ["/terrain", "relief, substrate, deposits"],
    ["/terrain/relief", "wavelength, octaves, amplitude"],
    ["/terrain/substrate", "cell, weights"],
    ["/terrain/deposits/1", "wavelength, octaves, threshold, peak"],
  ])("rejects an unknown member of %j, and reports each missing one", (pointer, members) => {
    expect(issuesWith({ [`${pointer}/extra`]: 1 })).toEqual([
      { path: `${pointer}/extra`, message: unknown(members) },
    ]);
    for (const member of members.split(", ")) {
      expect(issuesWith({ [`${pointer}/${member}`]: REMOVE })).toEqual([
        { path: `${pointer}/${member}`, message: MISSING },
      ]);
    }
  });

  test("escapes the keys of unknown members as JSON Pointers", () => {
    const genesis = genesisWith({});
    (genesis.laws as Record<string, unknown>)["a~b/c"] = 1;
    expect(genesisIssues(genesis)).toEqual([
      { path: "/laws/a~0b~1c", message: unknown("day, liquid, thermal, radiance") },
    ]);
  });

  test.each<[string, unknown, string]>([
    ["", 5, notRecord("terrainSeed, laws, terrain", "a number")],
    ["/laws", [], notRecord("day, liquid, thermal, radiance", "an array")],
    ["/laws/day", "day", notRecord("length, daylight", "a string")],
    ["/laws/thermal/lapse", 3, notRecord("num, den", "a number")],
    ["/terrain/deposits/0", true, notRecord("wavelength, octaves, threshold, peak", "a boolean")],
    ["/laws/day/length", "75600", "the value must be an integer, not a string"],
    ["/laws/liquid/level", { level: 1 }, "the value must be an integer, not a record"],
    ["/terrain/substrate/weights/1", [3], "the value must be an integer, not an array"],
    ["/terrain/substrate/weights", 5, "the value must be an array, not a number"],
    ["/terrain/deposits", {}, "the value must be an array, not a record"],
  ])("rejects a value of the wrong type at %j", (pointer, value, message) => {
    const genesis = pointer === "" ? value : genesisWith({ [pointer]: value });
    expect(genesisIssues(genesis)).toEqual([{ path: pointer, message }]);
  });

  test("reports every problem at once, canonical ones first, then the schema in its order", () => {
    const issues = issuesWith({
      "/terrainSeed/0": -1,
      "/laws/day/length": 0,
      "/laws/liquid": REMOVE,
      "/laws/thermal/lapse/den": 1.5,
      "/laws/radiance/night": 2000,
      "/terrain/relief/wavelength": 1000,
      "/terrain/substrate/weights": [],
      "/terrain/deposits/1/peak": "high",
      "/terrain/extra": null,
    });
    expect(issues).toEqual([
      { path: "/laws/thermal/lapse/den", message: "1.5 is not a safe integer" },
      { path: "/terrain/extra", message: "null is not a canonical value" },
      { path: "/terrainSeed/0", message: SEED_WORD },
      { path: "/laws/liquid", message: MISSING },
      { path: "/laws/day/length", message: outOfBounds(0, 1, 2 ** 40) },
      { path: "/laws/radiance/night", message: outOfBounds(2000, 0, 1000) },
      { path: "/terrain/extra", message: unknown("relief, substrate, deposits") },
      { path: "/terrain/relief/wavelength", message: notPowerOfTwo(1000, 512, 65536) },
      { path: "/terrain/substrate/weights", message: entries(0, "from 1 to 16") },
      { path: "/terrain/deposits/1/peak", message: "the value must be an integer, not a string" },
    ]);
  });

  test.each<[string, unknown, string]>([
    ["-0", -0, "-0 is not canonical: use 0"],
    ["NaN", Number.NaN, "NaN is not a safe integer"],
    ["undefined", undefined, "undefined is not a canonical type"],
    [
      "a string not in NFC",
      `e${String.fromCodePoint(0x301)}`,
      "the string is not in Unicode Normalization Form C (NFC)",
    ],
  ])("requires a canonical value: rejects %s", (_, value, message) => {
    expect(issuesWith({ "/laws/day/daylight": value })).toEqual([
      { path: "/laws/day/daylight", message },
    ]);
  });

  test("rejects an accessor without running it, and a record that is not plain", () => {
    let calls = 0;
    const genesis = genesisWith({});
    const day = (genesis.laws as Record<string, unknown>).day as object;
    Object.defineProperty(day, "length", {
      get: () => {
        calls += 1;
        return 75_600;
      },
      enumerable: true,
    });
    class Liquid {
      readonly level = 450;
    }
    (genesis.laws as Record<string, unknown>).liquid = new Liquid();
    expect(genesisIssues(genesis)).toEqual([
      {
        path: "/laws/day/length",
        message: "the property is an accessor: only data properties are canonical",
      },
      {
        path: "/laws/liquid",
        message:
          "the object is not a plain array or record: a record's prototype must be Object.prototype or null",
      },
    ]);
    expect(calls).toBe(0);
  });

  test("reports a genesis that throws while read as one issue at the root", () => {
    const issues = genesisIssues(revokedProxy());
    expect(issues.map(({ path }) => path)).toEqual([""]);
    expect(issues[0]?.message).toStartWith("the object threw while being read: TypeError");
  });
});

describe("prepareGenesis", () => {
  test("prepares a valid genesis, whose copy and seal it returns", () => {
    const genesis = defaultGenesis(SEED);
    const prepared = prepareGenesis(genesis);
    expect(PreparedGenesis.isPreparedGenesis(prepared)).toBe(true);
    expect(genesisOf(prepared)).toEqual(genesis);
    expect(sealOf(prepared)).toBe(genesisSeal(genesis));
  });

  test("copies its input, so changing the input afterwards changes nothing", () => {
    const genesis = genesisWith({});
    const prepared = prepareGenesis(genesis);
    const seal = sealOf(prepared);
    ((genesis.laws as Record<string, unknown>).day as Record<string, unknown>).length = 1;
    (genesis.terrainSeed as number[])[0] = 0;
    expect(genesisOf(prepared)).toEqual(defaultGenesis(SEED));
    expect(sealOf(prepared)).toBe(seal);
  });

  test("returns a fresh copy each time, so changing one changes nothing", () => {
    const prepared = prepareGenesis(defaultGenesis(SEED));
    const copy = genesisOf(prepared) as { laws: { day: { length: number } } };
    expect(genesisOf(prepared)).not.toBe(copy);
    copy.laws.day.length = 1;
    expect(genesisOf(prepared)).toEqual(defaultGenesis(SEED));
  });

  test("reads every member once, so an accessor is rejected and never runs", () => {
    let calls = 0;
    const genesis = Object.defineProperty(genesisWith({}), "laws", {
      get: () => {
        calls += 1;
        return defaultGenesis(SEED).laws;
      },
      enumerable: true,
    });
    const error = engineErrorOf(() => prepareGenesis(genesis));
    expect(error.issues).toEqual([
      { path: "/laws", message: "the property is an accessor: only data properties are canonical" },
    ]);
    expect(calls).toBe(0);
  });

  test("throws invalid_value with every issue genesisIssues finds", () => {
    const genesis = genesisWith({ "/laws/day/daylight": 0, "/terrain/relief/octaves": 99 });
    const error = engineErrorOf(() => prepareGenesis(genesis));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual(genesisIssues(genesis));
    expect(error.issueCount).toBe(2);
  });

  test("gives worldgen modules the prepared genesis itself, frozen at every level", () => {
    const prepared = prepareGenesis(defaultGenesis(SEED));
    const shared = sharedGenesis(prepared);
    expect(sharedGenesis(prepared)).toBe(shared);
    expect(shared).toEqual(defaultGenesis(SEED));
    const { laws, terrain } = shared;
    for (const value of [
      shared,
      shared.terrainSeed,
      laws,
      laws.day,
      laws.thermal.lapse,
      terrain.substrate.weights,
      terrain.deposits,
      terrain.deposits[1],
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect("sharedGenesis" in worldgen).toBe(false);
  });
});

describe("a forged prepared genesis", () => {
  const prepared = prepareGenesis(defaultGenesis(SEED));

  test.each<[string, unknown]>([
    ["a record", { genesis: defaultGenesis(SEED) }],
    ["an object whose prototype is a prepared genesis", Object.create(prepared)],
    ["a revoked Proxy", revokedProxy()],
    ["null", null],
  ])("is rejected by every function: %s", (_, forged) => {
    for (const read of [genesisOf, sealOf, sharedGenesis]) {
      const error = engineErrorOf(() => read(forged as worldgen.PreparedGenesis));
      expect(error.code).toBe("invalid_value");
      expect(error.issues).toEqual([{ path: "", message: NOT_PREPARED }]);
    }
    expect(PreparedGenesis.isPreparedGenesis(forged)).toBe(false);
  });

  test("is rejected without running a Proxy trap", () => {
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get: () => {
        traps += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        traps += 1;
        return null;
      },
      has: () => {
        traps += 1;
        return true;
      },
    };
    const proxy = new Proxy(prepared, handler) as worldgen.PreparedGenesis;
    expect(engineErrorOf(() => genesisOf(proxy)).issues).toEqual([
      { path: "", message: NOT_PREPARED },
    ]);
    expect(traps).toBe(0);
  });

  test("cannot be made through the constructor", () => {
    const Constructor = Object.getPrototypeOf(prepared).constructor as new (
      key: symbol,
      genesis: Genesis,
    ) => unknown;
    const error = engineErrorOf(
      () => new Constructor(Symbol("PreparedGenesis"), defaultGenesis(SEED)),
    );
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      {
        path: "",
        message:
          "prepared geneses are made by prepareGenesis, not by the PreparedGenesis constructor",
      },
    ]);
  });

  test("cannot be read through the internal accessor without its key", () => {
    const forgedKey = Symbol("PreparedGenesis");
    const error = engineErrorOf(() => PreparedGenesis.internals(forgedKey, prepared));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "", message: "only the worldgen module reads the internals of a prepared genesis" },
    ]);
  });
});

describe("genesisSeal", () => {
  test("is the digest of the tag, the generator version, and the genesis", () => {
    const genesis = defaultGenesis(SEED);
    expect(genesisSeal(genesis)).toBe(digest(["genesis", "worldgen@1", genesis]));
    expect(genesisSeal(genesis)).toBe(digest(["genesis", WORLDGEN_VERSION, genesis]));
    expect(genesisSeal(genesis)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("is equal for equal geneses, whatever their key order", () => {
    const genesis = defaultGenesis(SEED);
    const { terrain, laws, terrainSeed } = genesisWith({});
    expect(genesisSeal({ terrain, laws, terrainSeed } as Genesis)).toBe(genesisSeal(genesis));
  });

  test("differs when any law, terrain parameter, or seed word changes", () => {
    const edits: Record<string, unknown>[] = [
      { "/terrainSeed/0": 1 },
      { "/terrainSeed/7": 0 },
      { "/laws/day/length": 75601 },
      { "/laws/day/daylight": 551 },
      { "/laws/liquid/level": 451 },
      { "/laws/thermal/base": 401 },
      { "/laws/thermal/spread": 121 },
      { "/laws/thermal/lapse/num": 4 },
      { "/laws/thermal/lapse/den": 1001 },
      { "/laws/thermal/diurnal": 61 },
      { "/laws/radiance/peak": 1001 },
      { "/laws/radiance/night": 41 },
      { "/terrain/relief/wavelength": 4096 },
      { "/terrain/relief/octaves": 6 },
      { "/terrain/relief/amplitude": 60001 },
      { "/terrain/substrate/cell": 128 },
      { "/terrain/substrate/weights/0": 6 },
      { "/terrain/deposits/0/threshold": 601 },
      { "/terrain/deposits": [] },
    ];
    const seals = new Set([genesisSeal(defaultGenesis(SEED))]);
    for (const edit of edits) {
      const genesis = genesisWith(edit);
      expect(genesisIssues(genesis)).toEqual([]);
      seals.add(genesisSeal(genesis as Genesis));
    }
    expect(seals.size).toBe(edits.length + 1);
  });
});

describe("sealedGenesisIssues", () => {
  const genesis = defaultGenesis(SEED);
  const sealed = (extra: Record<string, unknown> = {}) => ({
    genesis: genesisWith({}),
    genesisSeal: genesisSeal(genesis),
    ...extra,
  });

  test("accepts a sealed global value, whatever other members it holds", () => {
    expect(sealedGenesisIssues(sealed())).toEqual([]);
    expect(sealedGenesisIssues(sealed({ counter: 3, notes: ["ruleset data"] }))).toEqual([]);
  });

  test("rejects a tampered genesis with its stale seal, without printing either seal", () => {
    const tampered = sealed({ genesis: genesisWith({ "/laws/day/length": 86_400 }) });
    const issues = sealedGenesisIssues(tampered);
    expect(issues).toEqual([{ path: "/genesisSeal", message: SEAL_MISMATCH }]);
    expect(issues[0]?.message).not.toContain(genesisSeal(genesis));
    expect(issues[0]?.message).not.toContain(genesisSeal(tampered.genesis as Genesis));
  });

  test("rejects a seal made for another generator version", () => {
    const stale = digest(["genesis", "worldgen@0", genesis]);
    expect(sealedGenesisIssues(sealed({ genesisSeal: stale }))).toEqual([
      { path: "/genesisSeal", message: SEAL_MISMATCH },
    ]);
  });

  test("reports a missing genesis or seal, and a seal that is not a string", () => {
    expect(sealedGenesisIssues({ genesisSeal: genesisSeal(genesis) })).toEqual([
      { path: "/genesis", message: MISSING },
    ]);
    expect(sealedGenesisIssues({ genesis })).toEqual([{ path: "/genesisSeal", message: MISSING }]);
    expect(sealedGenesisIssues(sealed({ genesisSeal: 7 }))).toEqual([
      { path: "/genesisSeal", message: "the seal must be a string, not number" },
    ]);
    expect(sealedGenesisIssues({})).toEqual([
      { path: "/genesis", message: MISSING },
      { path: "/genesisSeal", message: MISSING },
    ]);
  });

  test("reports genesis problems under /genesis, and checks no seal against them", () => {
    const broken = sealed({
      genesis: genesisWith({ "/laws/day/length": 0, "/terrainSeed/1": -1 }),
    });
    expect(sealedGenesisIssues(broken)).toEqual([
      { path: "/genesis/terrainSeed/1", message: SEED_WORD },
      { path: "/genesis/laws/day/length", message: outOfBounds(0, 1, 2 ** 40) },
    ]);
  });

  test.each<[string, unknown]>([
    ["an array", [genesis]],
    ["a string", "genesis"],
    ["null", null],
  ])("rejects a global value that is %s", (_, global) => {
    expect(sealedGenesisIssues(global)).toEqual([
      { path: "", message: "the global value must be a record that holds genesis and genesisSeal" },
    ]);
  });

  test("rejects accessor members without running them", () => {
    let calls = 0;
    const global = Object.defineProperty({ genesisSeal: genesisSeal(genesis) }, "genesis", {
      get: () => {
        calls += 1;
        return genesis;
      },
      enumerable: true,
    });
    expect(sealedGenesisIssues(global)).toEqual([
      { path: "/genesis", message: "the property is an accessor: only data properties are read" },
    ]);
    expect(calls).toBe(0);
  });

  test("reads the seal as it reads the genesis: an accessor never runs, an inherited one is missing", () => {
    let calls = 0;
    const accessor = Object.defineProperty({ genesis }, "genesisSeal", {
      get: () => {
        calls += 1;
        return genesisSeal(genesis);
      },
      enumerable: true,
    });
    expect(sealedGenesisIssues(accessor)).toEqual([
      {
        path: "/genesisSeal",
        message: "the property is an accessor: only data properties are read",
      },
    ]);
    expect(calls).toBe(0);
    const inherited = Object.assign(Object.create({ genesisSeal: genesisSeal(genesis) }), {
      genesis,
    });
    expect(sealedGenesisIssues(inherited)).toEqual([{ path: "/genesisSeal", message: MISSING }]);
  });

  test("reports a global value that throws while read as one issue", () => {
    const issues = sealedGenesisIssues(revokedProxy());
    expect(issues.map(({ path }) => path)).toEqual([""]);
    expect(issues[0]?.message).toStartWith("the object threw while being read: TypeError");
  });

  test("is what a prepared genesis seals: sealOf agrees", () => {
    const prepared = prepareGenesis(genesis);
    expect(sealedGenesisIssues({ genesis, genesisSeal: sealOf(prepared) })).toEqual([]);
  });
});
