/**
 * The laws of life (ADR 0023): their schema and bounds, every problem reported at once with its
 * path, the seal, the diet's deposit against the genesis, and the default laws against the
 * ecological targets of docs/architecture/beings.md that depend on the laws alone.
 */
import { describe, expect, test } from "bun:test";
import { beings, copyCanonical, digest, type Issue, worldgen } from "../src/index.ts";

const { LIFE_VERSION, checkLife, defaultLife, sealedLifeIssues, sealLife } = beings;
type LifeConfig = beings.LifeConfig;

/** Every issue checkLife reports for `value`. */
function lifeIssues(value: unknown): Issue[] {
  const issues: Issue[] = [];
  checkLife(value, "", { report: (path, message) => issues.push({ path, message }) });
  return issues;
}

/** A deep, mutable copy of the default laws, for a test to break. */
function editable(): { [key: string]: unknown } {
  return copyCanonical(defaultLife()) as { [key: string]: unknown };
}

/** The member at the JSON Pointer `path` of `root`'s parent, and its own name. */
function parentOf(
  root: unknown,
  path: string,
): { parent: { [key: string]: unknown }; name: string } {
  const parts = path.split("/").slice(1);
  const name = parts.pop() ?? "";
  let parent = root as { [key: string]: unknown };
  for (const part of parts) parent = parent[part] as { [key: string]: unknown };
  return { parent, name };
}

/** The default laws with the member at `path` set to `value`. */
function withMember(path: string, value: unknown): unknown {
  const root = editable();
  const { parent, name } = parentOf(root, path);
  parent[name] = value;
  return root;
}

const SEED = [1, 2, 3, 4, 5, 6, 7, 8];

/** A global value with the default genesis and `life`, sealed unless `seal` is given. */
function globalWith(life: unknown, seal?: unknown): { [key: string]: unknown } {
  const genesis = worldgen.defaultGenesis(SEED);
  const lifeSeal = seal ?? digest(["life", LIFE_VERSION, life as LifeConfig]);
  return { genesis, genesisSeal: worldgen.genesisSeal(genesis), life, lifeSeal };
}

describe("checkLife", () => {
  test("accepts the default laws", () => {
    expect(lifeIssues(defaultLife())).toEqual([]);
  });

  test("reports every missing, unknown, and mistyped member at once, each at its path", () => {
    const life = editable();
    delete life.deathEnabled;
    life.extra = 1;
    const species = (life.species as { [key: string]: unknown }[])[0] ?? {};
    species.id = "S1";
    delete species.regrowth;
    (species.senses as { [key: string]: unknown }).radius = "far";
    expect(lifeIssues(life)).toEqual([
      {
        path: "/extra",
        message: "unknown member: the members here are deathEnabled, species, version",
      },
      { path: "/deathEnabled", message: "the member is missing" },
      { path: "/species/0/regrowth", message: "the member is missing" },
      {
        path: "/species/0/id",
        message:
          'a value of type string is not an identifier: 1 to 32 characters, a lowercase letter first, then lowercase letters, digits, ".", "_", or "-"',
      },
      { path: "/species/0/senses/radius", message: "the value must be an integer, not a string" },
    ]);
  });

  test.each([
    { path: "/species/0/senses/radius", min: 1, max: 32 },
    { path: "/species/0/traits/min", min: 1, max: 1000 },
    { path: "/species/0/traits/max", min: 1000, max: 10_000 },
    { path: "/species/0/diet/deposit", min: 0, max: 7 },
    { path: "/species/0/diet/biteMs", min: 1, max: 3_600_000 },
    { path: "/species/0/health/recoverAbove", min: 0, max: 1_000_000 },
    { path: "/species/0/regrowth/num", min: 0, max: 0x10_0000 },
    { path: "/species/0/regrowth/den", min: 1, max: 0x1_0000_0000 },
  ])("bounds $path from both sides", ({ path, min, max }) => {
    for (const ok of [max, min]) expect(lifeIssues(withMember(path, ok))).toEqual([]);
    for (const bad of [max + 1, min - 1]) {
      expect(lifeIssues(withMember(path, bad))).toEqual([
        { path, message: `${bad} is out of bounds: it must be from ${min} to ${max}` },
      ]);
    }
  });

  test("bounds the largest rise from both sides, with a rise that costs nothing", () => {
    const free = (maxRise: number) =>
      withMember("/species/0/locomotion", {
        ...defaultLife().species[0]?.locomotion,
        maxRise,
        rise: { num: 0, den: 1 },
      });
    expect(lifeIssues(free(0x4000_0000))).toEqual([]);
    expect(lifeIssues(free(0))).toEqual([]);
    expect(lifeIssues(free(0x4000_0001))).toEqual([
      {
        path: "/species/0/locomotion/maxRise",
        message: "1073741825 is out of bounds: it must be from 0 to 1073741824",
      },
    ]);
  });

  test("requires the version of the laws, exactly the stages T4 knows, and some ≤ plenty", () => {
    expect(lifeIssues(withMember("/version", "life@2"))).toEqual([
      { path: "/version", message: `the version must be "${LIFE_VERSION}"` },
    ]);
    expect(lifeIssues(withMember("/species/0/stages", ["child"]))).toEqual([
      { path: "/species/0/stages/0", message: "the stages of life@1 are exactly adult" },
    ]);
    expect(lifeIssues(withMember("/species/0/diet/cue", { some: 201, plenty: 200 }))).toEqual([
      {
        path: "/species/0/diet/cue/plenty",
        message: "200 is below some (201): plenty must be at least some",
      },
    ]);
    expect(lifeIssues(withMember("/species/0/diet/cue", { some: 200, plenty: 200 }))).toEqual([]);
  });

  test("requires species ordered by id, without repeats, and from 1 to 16 of them", () => {
    const [first] = defaultLife().species;
    const second = { ...first, id: "s0" };
    expect(lifeIssues(withMember("/species", [first, second]))).toEqual([
      {
        path: "/species/1/id",
        message: '"s0" must come after "s1": species are ordered by id, without repeats',
      },
    ]);
    expect(lifeIssues(withMember("/species", [first, first]))[0]?.path).toBe("/species/1/id");
    expect(lifeIssues(withMember("/species", []))).toEqual([
      { path: "/species", message: "the array has 0 entries: it must have from 1 to 16" },
    ]);
  });
});

describe("sealedLifeIssues", () => {
  test("accepts sealed default laws in a global value with a default genesis", () => {
    const life = defaultLife();
    expect(sealedLifeIssues(globalWith(life))).toEqual([]);
    expect(sealLife(life).lifeSeal).toBe(digest(["life", LIFE_VERSION, life]));
  });

  test("reports a seal that does not match, is not a string, or is missing", () => {
    const life = defaultLife();
    const changed = copyCanonical(life) as { deathEnabled: boolean };
    changed.deathEnabled = true;
    const stale = sealLife(life).lifeSeal;
    expect(sealedLifeIssues(globalWith(changed, stale))).toEqual([
      {
        path: "/lifeSeal",
        message:
          "the seal does not match the laws of life: they changed after they were sealed, or the seal was made for other laws",
      },
    ]);
    expect(sealedLifeIssues(globalWith(life, 7))).toEqual([
      { path: "/lifeSeal", message: "the seal must be a string, not number" },
    ]);
    const { lifeSeal: _dropped, ...unsealed } = globalWith(life);
    expect(sealedLifeIssues(unsealed)).toEqual([
      { path: "/lifeSeal", message: "the member is missing" },
    ]);
    expect(sealedLifeIssues(7)).toEqual([
      { path: "", message: "the global value must be a record that holds life and lifeSeal" },
    ]);
  });

  test("reports the laws' problems under /life, and a diet the genesis cannot feed", () => {
    expect(sealedLifeIssues(globalWith(withMember("/species/0/senses/radius", 0), "x"))).toEqual([
      {
        path: "/life/species/0/senses/radius",
        message: "0 is out of bounds: it must be from 1 to 32",
      },
    ]);
    const life = withMember("/species/0/diet/deposit", 2);
    expect(sealedLifeIssues(globalWith(life))).toEqual([
      {
        path: "/life/species/0/diet/deposit",
        message: "the genesis has 2 deposits: a species eats one of 0 to 1",
      },
    ]);
  });

  test("reads a hostile global value without throwing", () => {
    const hostile = globalWith(defaultLife());
    Object.defineProperty(hostile, "life", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const issues = sealedLifeIssues(hostile);
    expect(issues.map((issue) => issue.path)).toEqual(["/life"]);
  });
});

describe("the default laws against the registered targets", () => {
  const L = worldgen.defaultGenesis(SEED).laws.day.length;
  const [species] = defaultLife().species;
  if (species === undefined) throw new Error("the default laws have a species");
  /** Seconds a ratio takes to move a quantity across `amount` units. */
  const span = ({ num, den }: { num: number; den: number }, amount = 1_000_000) =>
    (amount * den) / num;
  /** Units per second of a ratio. */
  const perSecond = ({ num, den }: { num: number; den: number }) => num / den;
  const { nutrition, rest } = species.needs;

  test("nutrition, health, rest, and sleep take as long as registered", () => {
    expect(span(nutrition.awake) / L).toBeWithin(1.5, 3);
    expect(perSecond(nutrition.walking) / perSecond(nutrition.awake)).toBeWithin(1.25, 2.0001);
    expect(perSecond(nutrition.asleep) / perSecond(nutrition.awake)).toBeWithin(0.25, 0.7501);
    expect(span(species.health.starve) / L).toBeWithin(1, 2);
    expect(span(rest.awake) / L).toBeWithin(1.2, 2);
    expect(perSecond(rest.walking) / perSecond(rest.awake)).toBeWithin(1, 1.5001);
    expect(span(species.sleep.recover) / L).toBeWithin(0.25, 0.45);
    expect((32 * species.locomotion.stepMs) / 1000 / L).toBeWithin(0.01, 0.03);
  });

  test("one cell alone cannot sustain a being, and the stationary horizon stays within 60 days", () => {
    // The shortest sleep that restores what a day awake costs: s/span(sleep) = (1 − s)/span(rest).
    const s = span(species.sleep.recover) / (span(species.sleep.recover) + span(rest.awake));
    const c = L * ((1 - s) * perSecond(nutrition.awake) + s * perSecond(nutrition.asleep));
    const g = L * perSecond(species.regrowth) * species.diet.nutritionPerUnit;
    expect(g).toBeLessThanOrEqual(0.75 * c);
    const peak = worldgen.defaultGenesis(SEED).terrain.deposits[0]?.peak ?? 0;
    // Health falls only while nutrition is 0, a fraction (c − g)/c of the time once it first is.
    const health = span(species.health.starve) / L;
    const horizon =
      (1_000_000 + peak * species.diet.nutritionPerUnit) / (c - g) + (health * c) / (c - g);
    expect(horizon).toBeLessThanOrEqual(60);
  });
});

describe("every law, one bad value at a time", () => {
  test.each([
    "/species/0/needs/nutrition/awake/den",
    "/species/0/needs/nutrition/walking/num",
    "/species/0/needs/nutrition/asleep/den",
    "/species/0/needs/rest/awake/num",
    "/species/0/needs/rest/walking/den",
    "/species/0/diet/nutritionPerUnit",
    "/species/0/diet/biteUnits",
    "/species/0/diet/cue/some",
    "/species/0/locomotion/stepMs",
    "/species/0/locomotion/maxWade",
    "/species/0/locomotion/rise/num",
    "/species/0/locomotion/wade/den",
    "/species/0/sleep/recover/den",
    "/species/0/health/starve/den",
    "/species/0/health/recover/num",
    "/species/0/regrowth/den",
  ])("%s", (path) => {
    // -2 is out of every bound of the laws, and below every ratio's terms.
    expect(lifeIssues(withMember(path, -2)).map((issue) => issue.path)).toEqual([path]);
  });

  test("bounds the slowest step a locomotion law allows, so every step fits an Int32", () => {
    const steep = (maxRise: number) =>
      withMember("/species/0/locomotion", {
        stepMs: 45_000,
        maxRise,
        rise: { num: 1000, den: 1 },
        maxWade: 0,
        wade: { num: 0, den: 1 },
      });
    // 45,000 + 1,000·1,518,684 = SLOWEST_STEP_INNER exactly; one more unit of rise is too slow.
    expect(lifeIssues(steep(1_518_684))).toEqual([]);
    expect(lifeIssues(steep(1_518_685))).toEqual([
      {
        path: "/species/0/locomotion",
        message:
          "the slowest step this law allows costs stepMs + ⌊rise·maxRise⌋ + ⌊wade·maxWade⌋ = 1518730000 ms before its diagonal factor: it must be at most 1518729594, so that every step lasts at most 2^31 − 1 ms",
      },
    ]);
    expect(beings.SLOWEST_STEP_INNER * 1414).toBeLessThanOrEqual((2 ** 31 - 1) * 1000);
    expect((beings.SLOWEST_STEP_INNER + 1) * 1414).toBeGreaterThan((2 ** 31 - 1) * 1000);
  });

  test("accepts the last deposit the genesis has, and a bad seal never hides the deposit check", () => {
    expect(sealedLifeIssues(globalWith(withMember("/species/0/diet/deposit", 1)))).toEqual([]);
    const fifth = withMember("/species/0/diet/deposit", 5);
    expect(sealedLifeIssues(globalWith(fifth, 7)).map((issue) => issue.path)).toEqual([
      "/lifeSeal",
      "/life/species/0/diet/deposit",
    ]);
  });

  test("reads a hostile genesis without throwing", () => {
    const life = defaultLife();
    // A mutable copy of the frozen default genesis, to install a getter on.
    const global = { ...globalWith(life), genesis: copyCanonical(globalWith(life).genesis) };
    const genesis = global.genesis as { terrain: { [key: string]: unknown } };
    Object.defineProperty(genesis.terrain, "deposits", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    expect(() => sealedLifeIssues(global)).not.toThrow();
  });
});
