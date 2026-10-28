/**
 * The laws of life@2 (ADR 0024, docs/architecture/mind.md "Laws of life@2"): every law of a life@1
 * species, unchanged and with the same defaults, plus the laws of perception, of the mind and of
 * relationships, of speech, and the capacity of a chunk, sealed as `digest(["life", "life@2",
 * life])`. Reading the untrusted laws stays here, as for life@1; the parts `mind` and `relations`
 * are then bounded by the mind layer (mind.checkMindLaws), which owns their meaning.
 */
import type { IssueSink } from "../canonical/value.ts";
import { type Digest, digest } from "../digest/digest.ts";
import { IssueList } from "../errors.ts";
import { checkMindLaws, defaultMindLaws, INT31_MAX, type MindLaws } from "../mind/index.ts";
import {
  checkLifeAs,
  defaultLife,
  LIFE_BOUNDS,
  type LifeConfig,
  type LifeRules,
  type LifeShape,
  SPECIES_MEMBERS,
  type Species,
} from "./laws.ts";
import { type Fields, type IntRange, range, readFields, SAFE_INTEGERS } from "./schema.ts";

/** The version of the laws of life@2: their schema, bounds, and meaning. */
export const LIFE2_VERSION = "life@2";

/** How far a species sees other beings, in cells, and how many it perceives at a decision. */
export type Perception = {
  readonly sight: { readonly day: number; readonly dim: number };
  /** The radiance below which its sight is `dim`. */
  readonly dimBelow: number;
  readonly attention: number;
};

/** The reach, duration, and quotas of speech (T5-6 applies them; life@2 holds them already). */
export type SpeechLaws = {
  readonly range: number;
  readonly actMs: number;
  readonly turns: number;
  readonly gap: number;
  readonly cooldown: number;
  readonly perDay: number;
  readonly wakesPerDay: number;
};

/** A species of life@2: the body laws of life@1, and the laws of its mind. */
export type Species2 = Species &
  MindLaws & { readonly perception: Perception; readonly speech: SpeechLaws };

export type LifeConfig2 = {
  readonly version: string;
  readonly deathEnabled: boolean;
  /** The most beings a chunk holds. */
  readonly capacity: number;
  readonly species: readonly Species2[];
};

/** The bounds of the laws life@2 adds; those of `mind` and `relations` are the mind layer's. */
const LIFE2_BOUNDS = Object.freeze({
  capacity: range(1, 1024),
  dimBelow: range(0, 0x10_0000),
  attention: range(0, 8),
  speechRange: range(1, 8),
  actMs: range(1, 60_000),
  turns: range(1, 8),
  seconds: range(1, INT31_MAX),
  daily: range(0, 64),
});

/** Any safe integer: the reader checks the type, and the mind layer the bounds. */
const SAFE = SAFE_INTEGERS;

/** A member of a part of the laws: an integer within `bounds`, or a part of its own. */
type LawEntry = {
  readonly name: string;
  readonly bounds?: IntRange;
  readonly part?: readonly LawEntry[];
};

/** An integer member within `bounds`. */
const int = (name: string, bounds: IntRange = SAFE): LawEntry => Object.freeze({ name, bounds });

/** The members of the part `mind`, by name; mind.checkMindLaws bounds them. */
const MIND_PART: readonly LawEntry[] = Object.freeze([
  int("beliefs"),
  int("depth"),
  int("episodes"),
  int("floor"),
  Object.freeze({ name: "halfLife", part: Object.freeze([int("belief"), int("episode")]) }),
  int("inbox"),
  int("ops"),
  int("pinLevel"),
  int("pins"),
  int("recall"),
  int("relations"),
]);

/** The members of the part `relations`, by name; mind.checkMindLaws bounds them. */
const RELATIONS_PART: readonly LawEntry[] = Object.freeze([
  int("delta"),
  int("gap"),
  int("halfLife"),
  Object.freeze({ name: "rate", part: Object.freeze([int("den"), int("num")]) }),
]);

/**
 * The integers of the part at `value`, each within its bounds, as a record; undefined when the
 * part is missing or anything in it was reported, so that its checks across laws read only values
 * that passed.
 */
function readPart(
  value: unknown,
  path: string,
  entries: readonly LawEntry[],
  sink: IssueSink,
): { readonly [name: string]: unknown } | undefined {
  const issues = new IssueList();
  const fields = readFields(value, path, { required: entries.map(({ name }) => name) }, issues);
  const part: { [name: string]: unknown } = {};
  if (fields !== undefined)
    for (const entry of entries) part[entry.name] = readEntry(fields, entry, issues);
  for (const issue of issues.issues) sink.report(issue.path, issue.message);
  return fields === undefined || issues.count > 0 ? undefined : part;
}

/** The member `entry` of the part `fields`: an integer within its bounds, or a part of its own. */
function readEntry(fields: Fields, entry: LawEntry, issues: IssueList): unknown {
  if (entry.part === undefined) return fields.int(entry.name, entry.bounds ?? SAFE);
  return readPart(fields.value(entry.name), fields.at(entry.name), entry.part, issues);
}

/** The radius of the species' window, or the largest a law allows when it is not valid. */
function radiusOf(species: Fields): number {
  const senses = readFields(species.value("senses"), "", { required: ["radius"] }, new IssueList());
  return senses?.int("radius", LIFE_BOUNDS.radius) ?? LIFE_BOUNDS.radius.max;
}

/**
 * Reports every problem of the species' perception: each sight from 0 to the radius of its
 * window, which holds every being it could see. Returns its dim sight, when the part is valid.
 */
function checkPerception(species: Fields, sink: IssueSink): number | undefined {
  const sight = range(0, radiusOf(species));
  const perception = readPart(
    species.value("perception"),
    species.at("perception"),
    [
      int("attention", LIFE2_BOUNDS.attention),
      int("dimBelow", LIFE2_BOUNDS.dimBelow),
      { name: "sight", part: [int("day", sight), int("dim", sight)] },
    ],
    sink,
  );
  // readPart reported nothing, so the part has the shape of Perception.
  return (perception as Perception | undefined)?.sight.dim;
}

/**
 * Reports every problem of the parts `mind` and `relations`: their shape here, then their bounds
 * in the mind layer, which runs only on a shape it can read. Returns the capacity of
 * relationships, when both parts are valid.
 */
function checkMindParts(species: Fields, sink: IssueSink): number | undefined {
  const mind = readPart(species.value("mind"), species.at("mind"), MIND_PART, sink);
  const relations = readPart(
    species.value("relations"),
    species.at("relations"),
    RELATIONS_PART,
    sink,
  );
  if (mind === undefined || relations === undefined) return undefined;
  // readPart reported nothing, so both parts have the shape of MindLaws.
  const laws = { mind, relations } as unknown as MindLaws;
  const bounded = new IssueList();
  checkMindLaws(laws, species.path, bounded);
  for (const issue of bounded.issues) sink.report(issue.path, issue.message);
  return bounded.count === 0 ? laws.mind.relations : undefined;
}

/**
 * Reports every problem of the species' speech, and its laws across parts: speech reaches no
 * farther than dim sight, so a hearer is always perceived; and a species that holds no
 * relationships says nothing, because the quotas per pair live in relationships.
 */
function checkSpeech(
  species: Fields,
  limits: { readonly dim: number | undefined; readonly relations: number | undefined },
  sink: IssueSink,
): void {
  const B = LIFE2_BOUNDS;
  const speech = readPart(
    species.value("speech"),
    species.at("speech"),
    [
      int("actMs", B.actMs),
      int("cooldown", B.seconds),
      int("gap", B.seconds),
      int("perDay", B.daily),
      int("range", B.speechRange),
      int("turns", B.turns),
      int("wakesPerDay", B.daily),
    ],
    sink,
  ) as SpeechLaws | undefined;
  if (speech === undefined) return;
  const at = (name: string) => `${species.at("speech")}/${name}`;
  if (limits.dim !== undefined && speech.range > limits.dim)
    sink.report(
      at("range"),
      `speech reaches ${speech.range} cells, farther than the dim sight of ${limits.dim}: a hearer must be perceived`,
    );
  if (limits.relations === 0 && speech.perDay > 0)
    sink.report(
      at("perDay"),
      `${speech.perDay} acts a day with mind.relations 0: a species without relationships says nothing, since the quotas per pair live in relationships`,
    );
}

/** Reports every problem of the laws a species of life@2 adds to those of its body. */
function checkSpeciesLaws(species: Fields, sink: IssueSink): void {
  const dim = checkPerception(species, sink);
  const relations = checkMindParts(species, sink);
  checkSpeech(species, { dim, relations }, sink);
}

/** What life@2 checks: the members of life@1 and `capacity`, and each species' added laws. */
const LIFE2_SHAPE: LifeShape = Object.freeze({
  version: LIFE2_VERSION,
  members: Object.freeze(["capacity", "deathEnabled", "species", "version"]),
  species: Object.freeze([...SPECIES_MEMBERS, "mind", "perception", "relations", "speech"]),
  addedLaws: (life: Fields) => {
    life.int("capacity", LIFE2_BOUNDS.capacity);
  },
  addedSpeciesLaws: checkSpeciesLaws,
});

/**
 * Reports every problem of `value` as the laws of life@2, at paths from `path`. `value` is
 * canonical, as a copy or a validator's value is; it never throws for a canonical value.
 */
export function checkLife2(value: unknown, path: string, sink: IssueSink): void {
  checkLifeAs(LIFE2_SHAPE, value, path, sink);
}

/** The seal of the laws of life@2 `life`. */
export function lifeSeal2(life: LifeConfig2): Digest {
  return digest(["life", LIFE2_VERSION, life]);
}

/** The laws of life@2, for the rules of beings@2. */
export const LIFE2_RULES: LifeRules = Object.freeze({
  version: LIFE2_VERSION,
  check: checkLife2,
  // The ruleset applies the seal only to laws that checkLife2 accepted, which are LifeConfig2.
  seal: (life: LifeConfig) => lifeSeal2(life as LifeConfig2),
});

/**
 * The default laws of life@2: the default laws of life@1, every body law unchanged, with the
 * values of the table of mind.md for each law life@2 adds, as the calibration of T5-7 froze them
 * (mind-freeze.test.ts pins their seal): it raised the day's sight from 12 to 24.
 */
export function defaultLife2(): LifeConfig2 {
  const life = defaultLife();
  return {
    version: LIFE2_VERSION,
    deathEnabled: life.deathEnabled,
    capacity: 64,
    species: life.species.map((species) => ({
      ...species,
      perception: { sight: { day: 24, dim: 4 }, dimBelow: 150, attention: 6 },
      ...defaultMindLaws(),
      speech: {
        range: 3,
        actMs: 4000,
        turns: 3,
        gap: 120,
        cooldown: 18_900,
        perDay: 10,
        wakesPerDay: 8,
      },
    })),
  };
}

/** The global value's members for `life`: the laws and their seal, ready for createWorld. */
export function sealLife2(life: LifeConfig2): {
  readonly life: LifeConfig2;
  readonly lifeSeal: Digest;
} {
  return { life, lifeSeal: lifeSeal2(life) };
}
