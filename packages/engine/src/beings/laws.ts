/**
 * The laws of life (ADR 0023): the species of a world and the laws of their bodies, held in the
 * world's global value as `life`, with `lifeSeal = digest(["life", LIFE_VERSION, life])`, written
 * once like the genesis (ADR 0021). Laws are rates per simulated second, never per tick, so a world
 * with another `simSecondsPerTick` has the same physics. Every law has bounds that keep every
 * intermediate value of the beings layer a safe integer.
 */

import { copyCanonicalReported } from "../canonical/copy.ts";
import type { IssueSink } from "../canonical/value.ts";
import { type Digest, digest } from "../digest/digest.ts";
import { type Issue, IssueList } from "../errors.ts";
import { expectRecord, readMember, UNREAD, under } from "../world/members.ts";
import { NEED_MAX, type Ratio } from "./rates.ts";
import { type Fields, type IntRange, range, readFields, readId, readList } from "./schema.ts";

/** The version of the laws of life: their schema, bounds, and meaning. */
export const LIFE_VERSION = "life@1";

/** The stages of life T4 knows: one, since nothing is born or grows yet. */
export const STAGES: readonly string[] = Object.freeze(["adult"]);

/** Decay of nutrition per second, by activity. */
export type NutritionLaw = {
  readonly awake: Ratio;
  readonly walking: Ratio;
  readonly asleep: Ratio;
};
/** Decay of rest per second while awake, by activity; sleep restores it. */
export type RestLaw = { readonly awake: Ratio; readonly walking: Ratio };

export type Species = {
  readonly id: string;
  readonly stages: readonly string[];
  readonly needs: { readonly nutrition: NutritionLaw; readonly rest: RestLaw };
  /**
   * The deposit of the genesis the species eats, the nutrition one unit gives, the units and
   * milliseconds of one bite, and the food at which its senses cue "some" and "plenty".
   */
  readonly diet: {
    readonly deposit: number;
    readonly nutritionPerUnit: number;
    readonly biteUnits: number;
    readonly biteMs: number;
    readonly cue: { readonly some: number; readonly plenty: number };
  };
  /**
   * Milliseconds of a flat orthogonal step; the largest rise in elevation and the deepest liquid a
   * step may take; and the extra milliseconds per unit of rise and of depth.
   */
  readonly locomotion: {
    readonly stepMs: number;
    readonly maxRise: number;
    readonly rise: Ratio;
    readonly maxWade: number;
    readonly wade: Ratio;
  };
  readonly sleep: { readonly recover: Ratio };
  /** Loss while nutrition is 0; recovery while nutrition and rest are above `recoverAbove`. */
  readonly health: {
    readonly starve: Ratio;
    readonly recover: Ratio;
    readonly recoverAbove: number;
  };
  /** Food units per second an eaten cell recovers. */
  readonly regrowth: Ratio;
  readonly senses: { readonly radius: number };
  /** The bounds of every trait, in permille; the neutral trait, 1000, lies within them. */
  readonly traits: IntRange;
};

export type LifeConfig = {
  readonly version: string;
  readonly deathEnabled: boolean;
  readonly species: readonly Species[];
};

/**
 * The bounds of every law. A step or a bite of at most an hour keeps the sums of a walk and the
 * costs of a search far below 2^53; heights and depths cover twice worldgen's largest relief.
 */
export const LIFE_BOUNDS = Object.freeze({
  species: range(1, 16),
  deposit: range(0, 7),
  nutritionPerUnit: range(1, NEED_MAX),
  biteUnits: range(1, 0x10_0000),
  durationMs: range(1, 3_600_000),
  cue: range(1, 0x10_0000),
  height: range(0, 0x4000_0000),
  level: range(0, NEED_MAX),
  radius: range(1, 32),
  traitMin: range(1, 1000),
  traitMax: range(1000, 10_000),
});

/** Reports every problem of the record of ratios at `value`, whose members are `names`. */
function checkRatios(value: unknown, path: string, names: string[], sink: IssueSink): void {
  const fields = readFields(value, path, { required: names }, sink);
  for (const name of names) fields?.ratio(name);
}

/** Reports every problem of a species' needs. */
function checkNeeds(value: unknown, path: string, sink: IssueSink): void {
  const needs = readFields(value, path, { required: ["nutrition", "rest"] }, sink);
  if (needs === undefined) return;
  checkRatios(
    needs.value("nutrition"),
    needs.at("nutrition"),
    ["asleep", "awake", "walking"],
    sink,
  );
  checkRatios(needs.value("rest"), needs.at("rest"), ["awake", "walking"], sink);
}

/** Reports every problem of a species' diet; its cue's "some" may not exceed its "plenty". */
function checkDiet(value: unknown, path: string, sink: IssueSink): void {
  const required = ["biteMs", "biteUnits", "cue", "deposit", "nutritionPerUnit"];
  const diet = readFields(value, path, { required }, sink);
  if (diet === undefined) return;
  diet.int("deposit", LIFE_BOUNDS.deposit);
  diet.int("nutritionPerUnit", LIFE_BOUNDS.nutritionPerUnit);
  diet.int("biteUnits", LIFE_BOUNDS.biteUnits);
  diet.int("biteMs", LIFE_BOUNDS.durationMs);
  const cue = readFields(diet.value("cue"), diet.at("cue"), { required: ["plenty", "some"] }, sink);
  const some = cue?.int("some", LIFE_BOUNDS.cue);
  const plenty = cue?.int("plenty", LIFE_BOUNDS.cue);
  if (some !== undefined && plenty !== undefined && some > plenty) {
    sink.report(
      `${path}/cue/plenty`,
      `${plenty} is below some (${some}): plenty must be at least some`,
    );
  }
}

/** Reports every problem of a species' locomotion. */
function checkLocomotion(value: unknown, path: string, sink: IssueSink): void {
  const required = ["maxRise", "maxWade", "rise", "stepMs", "wade"];
  const locomotion = readFields(value, path, { required }, sink);
  if (locomotion === undefined) return;
  locomotion.int("stepMs", LIFE_BOUNDS.durationMs);
  locomotion.int("maxRise", LIFE_BOUNDS.height);
  locomotion.int("maxWade", LIFE_BOUNDS.height);
  locomotion.ratio("rise");
  locomotion.ratio("wade");
}

/** Reports every problem of a species' health, sleep, regrowth, senses, and traits. */
function checkBody(species: Fields | undefined, sink: IssueSink): void {
  if (species === undefined) return;
  const health = readFields(
    species.value("health"),
    species.at("health"),
    {
      required: ["recover", "recoverAbove", "starve"],
    },
    sink,
  );
  health?.ratio("starve");
  health?.ratio("recover");
  health?.int("recoverAbove", LIFE_BOUNDS.level);
  checkRatios(species.value("sleep"), species.at("sleep"), ["recover"], sink);
  species.ratio("regrowth");
  readFields(species.value("senses"), species.at("senses"), { required: ["radius"] }, sink)?.int(
    "radius",
    LIFE_BOUNDS.radius,
  );
  const traits = readFields(
    species.value("traits"),
    species.at("traits"),
    {
      required: ["max", "min"],
    },
    sink,
  );
  traits?.int("min", LIFE_BOUNDS.traitMin);
  traits?.int("max", LIFE_BOUNDS.traitMax);
}

/** Reports every problem of the stages of a species: exactly the stages T4 knows. */
function checkStages(value: unknown, path: string, sink: IssueSink): void {
  const stages = readList(value, path, range(STAGES.length, STAGES.length), sink);
  stages?.forEach((stage, index) => {
    if (stage !== STAGES[index]) {
      sink.report(
        `${path}/${index}`,
        `the stages of ${LIFE_VERSION} are exactly ${STAGES.join(", ")}`,
      );
    }
  });
}

const SPECIES_MEMBERS: readonly string[] = Object.freeze([
  "diet",
  "health",
  "id",
  "locomotion",
  "needs",
  "regrowth",
  "senses",
  "sleep",
  "stages",
  "traits",
]);

/** Reports every problem of the species at `value`; its id, when it has a valid one. */
function checkSpecies(value: unknown, path: string, sink: IssueSink): string | undefined {
  const species = readFields(value, path, { required: SPECIES_MEMBERS }, sink);
  if (species === undefined) return undefined;
  const id = readId(species.value("id"), species.at("id"), sink);
  checkStages(species.value("stages"), species.at("stages"), sink);
  checkNeeds(species.value("needs"), species.at("needs"), sink);
  checkDiet(species.value("diet"), species.at("diet"), sink);
  checkLocomotion(species.value("locomotion"), species.at("locomotion"), sink);
  checkBody(species, sink);
  return id;
}

/** Reports every problem of the species list: ordered by id, without repeats. */
function checkSpeciesList(value: unknown, path: string, sink: IssueSink): void {
  const list = readList(value, path, LIFE_BOUNDS.species, sink);
  let previous: string | undefined;
  list?.forEach((entry, index) => {
    const id = checkSpecies(entry, `${path}/${index}`, sink);
    if (id !== undefined && previous !== undefined && id <= previous) {
      sink.report(
        `${path}/${index}/id`,
        `"${id}" must come after "${previous}": species are ordered by id, without repeats`,
      );
    }
    if (id !== undefined) previous = id;
  });
}

/** Reports every problem of `value` as the laws of life, at paths from `path`. */
export function checkLife(value: unknown, path: string, sink: IssueSink): void {
  const life = readFields(value, path, { required: ["deathEnabled", "species", "version"] }, sink);
  if (life === undefined) return;
  if (life.value("version") !== undefined && life.value("version") !== LIFE_VERSION) {
    sink.report(life.at("version"), `the version must be "${LIFE_VERSION}"`);
  }
  life.boolean("deathEnabled");
  checkSpeciesList(life.value("species"), life.at("species"), sink);
}

/** The seal of the laws of life `life`. */
export function lifeSeal(life: LifeConfig): Digest {
  return digest(["life", LIFE_VERSION, life]);
}

const MISSING = "the member is missing";

/** The number of deposits of the genesis `global` holds, or undefined when it cannot be read. */
function depositCount(global: object): number | undefined {
  const quiet = new IssueList();
  const genesis = readMember(global, "genesis", "", quiet);
  if (!expectRecord(genesis, "", "", quiet)) return undefined;
  const terrain = readMember(genesis, "terrain", "", quiet);
  if (!expectRecord(terrain, "", "", quiet)) return undefined;
  const deposits = readMember(terrain, "deposits", "", quiet);
  return Array.isArray(deposits) && quiet.count === 0 ? deposits.length : undefined;
}

/** Reports every species whose diet names a deposit the genesis does not have. */
function checkDeposits(life: LifeConfig, count: number, sink: IssueSink): void {
  life.species.forEach((species, index) => {
    if (species.diet.deposit < count) return;
    sink.report(
      `/species/${index}/diet/deposit`,
      `the genesis has ${count} deposits: a species eats one of 0 to ${count - 1}`,
    );
  });
}

/** The member `name` of `global`, copied canonically; undefined after an issue at `/name`. */
function readCopy(global: object, name: string, issues: IssueList): unknown {
  const value = readMember(global, name, `/${name}`, issues);
  if (value === UNREAD) return undefined;
  if (value === undefined) {
    issues.report(`/${name}`, MISSING);
    return undefined;
  }
  const before = issues.count;
  const copy = copyCanonicalReported(value, under(issues, `/${name}`));
  return issues.count === before ? copy : undefined;
}

/**
 * Why `global`, a world's global value, does not hold sealed laws of life that its genesis can
 * feed, for a ruleset's validateGlobal: every problem of `life` at its path under /life, a seal
 * that is not a string or does not match at /lifeSeal, and a diet whose deposit the genesis does
 * not have. The genesis itself is sealedGenesisIssues' to check. Each member is read once, through
 * its own descriptor (world/members.ts), and copied before it is read further.
 */
export function sealedLifeIssues(global: unknown): Issue[] {
  const issues = new IssueList();
  const notRecord = "the global value must be a record that holds life and lifeSeal";
  if (!expectRecord(global, "", notRecord, issues)) return issues.issues;
  const life = readCopy(global, "life", issues);
  const seal = readCopy(global, "lifeSeal", issues);
  const before = issues.count;
  if (life !== undefined) checkLife(life, "", under(issues, "/life"));
  if (seal !== undefined && typeof seal !== "string") {
    issues.report("/lifeSeal", `the seal must be a string, not ${typeof seal}`);
  }
  if (life === undefined || issues.count !== before) return issues.issues;
  // checkLife reported nothing, so the copy is a LifeConfig.
  const laws = life as LifeConfig;
  const count = depositCount(global);
  if (count !== undefined) checkDeposits(laws, count, under(issues, "/life"));
  if (typeof seal === "string" && lifeSeal(laws) !== seal) {
    issues.report(
      "/lifeSeal",
      "the seal does not match the laws of life: they changed after they were sealed, or the seal was made for other laws",
    );
  }
  return issues.issues;
}

/**
 * The default laws of life: one species, `s1`, that eats deposit 0. These values are provisional:
 * they meet the ecological targets registered in docs/architecture/beings.md, and T4-6 calibrates
 * them on the calibration seeds only, then freezes them with the brain.
 */
export function defaultLife(): LifeConfig {
  return {
    version: LIFE_VERSION,
    deathEnabled: false,
    species: [
      {
        id: "s1",
        stages: ["adult"],
        needs: {
          nutrition: {
            awake: { num: 1250, den: 189 },
            walking: { num: 625, den: 63 },
            asleep: { num: 625, den: 189 },
          },
          rest: { awake: { num: 3125, den: 378 }, walking: { num: 15_625, den: 1512 } },
        },
        diet: {
          deposit: 0,
          nutritionPerUnit: 2000,
          biteUnits: 25,
          biteMs: 60_000,
          cue: { some: 25, plenty: 200 },
        },
        locomotion: {
          stepMs: 45_000,
          maxRise: 900,
          rise: { num: 50, den: 1 },
          maxWade: 600,
          wade: { num: 100, den: 1 },
        },
        sleep: { recover: { num: 50_000, den: 1323 } },
        health: {
          starve: { num: 5000, den: 567 },
          recover: { num: 1250, den: 189 },
          recoverAbove: 300_000,
        },
        regrowth: { num: 1, den: 504 },
        senses: { radius: 24 },
        traits: { min: 800, max: 1200 },
      },
    ],
  };
}

/** The global value's members for `life`: the laws and their seal, ready for createWorld. */
export function sealLife(life: LifeConfig): {
  readonly life: LifeConfig;
  readonly lifeSeal: Digest;
} {
  return { life, lifeSeal: lifeSeal(life) };
}
