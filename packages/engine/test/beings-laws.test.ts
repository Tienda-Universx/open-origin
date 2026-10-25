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
    { path: "/species/0/locomotion/maxRise", min: 0, max: 0x4000_0000 },
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
