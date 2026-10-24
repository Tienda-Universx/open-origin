/**
 * The schema gate of snapshot version 1 (ADR 0020, snapshots; plan §4, §5.2 "Versiones"):
 *
 * { header: { snapshotSchemaVersion: 1, engineVersion, rulesetVersion, generatorVersion,
 *   brainVersion }, stateRoot, world: { epoch, tick, nextEntityId, rng: { algorithm:
 *   "ctr-mix32@1", seed }, config: { simSecondsPerTick }, global, chunks } }
 *
 * readSnapshot parses canonical text only, then checks the schema version first: a snapshot of
 * another version may have other members, so its version is reported alone, as
 * unsupported_schema. Every other problem is reported in one invalid_snapshot: every missing and
 * every extra member, at every level, and every member out of its bounds, each at its path.
 */
import { parseCanonical } from "../canonical/encode.ts";
import { sortedOwnKeys } from "../canonical/order.ts";
import { type CanonicalValue, pointer } from "../canonical/value.ts";
import type { Digest } from "../digest/digest.ts";
import { describeValue, EngineError, type Issue, IssueList } from "../errors.ts";
import { readSeed, type Seed } from "../rng/mix32.ts";
import { secondsPerTickProblem, tickProblem } from "../time/tick.ts";
import { type ChunkKey, readChunkKey } from "../world/chunk.ts";
import { isRecord, readText } from "../world/members.ts";
import type { Kernel, WorldHeader } from "../world/world.ts";

/** The one schema version this engine writes and reads. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** The only random algorithm this engine runs. */
const ALGORITHM = "ctr-mix32@1";

/** A version 1 snapshot that passed the schema gate, as the parts a world is made of. */
export type SnapshotV1 = {
  readonly header: WorldHeader;
  readonly stateRoot: Digest;
  readonly kernel: Kernel;
  readonly global: CanonicalValue;
  /** The chunks by key, in canonical key order. */
  readonly chunks: readonly (readonly [ChunkKey, CanonicalValue])[];
};

/** A record of a parsed snapshot: canonical, so a plain record of canonical values. */
type Data = { readonly [key: string]: CanonicalValue };

const MISSING = "the member is missing";
const EXTRA = "the member is not part of a version 1 snapshot";
const DIGEST = /^[0-9a-f]{32}$/;

/** A record of the schema: where it is, its members, and what to say when it is not a record. */
type Shape = {
  readonly path: string;
  readonly members: readonly string[];
  readonly notRecord: string;
};

const SHAPES = {
  top: {
    path: "",
    members: ["header", "stateRoot", "world"],
    notRecord: "the snapshot must be a record { header, stateRoot, world }",
  },
  header: {
    path: "/header",
    members: [
      "snapshotSchemaVersion",
      "engineVersion",
      "rulesetVersion",
      "generatorVersion",
      "brainVersion",
    ],
    notRecord: "the header must be a record",
  },
  world: {
    path: "/world",
    members: ["epoch", "tick", "nextEntityId", "rng", "config", "global", "chunks"],
    notRecord: "the world must be a record",
  },
  rng: {
    path: "/world/rng",
    members: ["algorithm", "seed"],
    notRecord: "the random state must be a record { algorithm, seed }",
  },
  config: {
    path: "/world/config",
    members: ["simSecondsPerTick"],
    notRecord: "the configuration must be a record { simSecondsPerTick }",
  },
} as const satisfies { readonly [name: string]: Shape };

/** A number member of the schema: its key, its path, and why a value is not one. */
type NumberField = {
  readonly key: string;
  readonly path: string;
  readonly problem: (value: unknown) => string | undefined;
};

/** The member `key` of `record`, or undefined when it has none. */
function member(record: Data | undefined, key: string): CanonicalValue | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `value` as a record, if it is one; a canonical record holds only canonical values. */
function asData(value: CanonicalValue | undefined): Data | undefined {
  return value !== undefined && isRecord(value) ? (value as Data) : undefined;
}

/**
 * `value` as a record with exactly the members of `shape`. Reports at its path a value that is not
 * a record, then each missing member, in the order of the shape, and each extra one, in canonical
 * order. A missing value was already reported by its parent.
 */
function exactMembers(
  value: CanonicalValue | undefined,
  { path, members, notRecord }: Shape,
  issues: IssueList,
): Data | undefined {
  if (value === undefined) return undefined;
  const record = asData(value);
  if (record === undefined) {
    issues.report(path, notRecord);
    return undefined;
  }
  for (const key of members) {
    if (!Object.hasOwn(record, key)) issues.report(`${path}${pointer([key])}`, MISSING);
  }
  for (const key of sortedOwnKeys(record)) {
    if (!members.includes(key)) issues.report(`${path}${pointer([key])}`, EXTRA);
  }
  return record;
}

/** Throws unsupported_schema when the snapshot names a schema version other than 1. */
function expectSupportedVersion(snapshot: CanonicalValue): void {
  const version = member(asData(member(asData(snapshot), "header")), "snapshotSchemaVersion");
  if (version === undefined || version === SNAPSHOT_SCHEMA_VERSION) return;
  const path = "/header/snapshotSchemaVersion";
  const message =
    `${describeValue(version)} is not a supported snapshot schema version: ` +
    `this engine reads version ${SNAPSHOT_SCHEMA_VERSION}`;
  throw new EngineError("unsupported_schema", [{ path, message }]);
}

/** The version `key` of `header`, a non-empty string; "" after an issue, or when missing. */
function readVersion(header: Data | undefined, key: string, issues: IssueList): string {
  const value = member(header, key);
  if (value === undefined) return "";
  return readText(value, `/header/${key}`, "the version", issues) ?? "";
}

function readHeader(value: CanonicalValue | undefined, issues: IssueList): WorldHeader {
  const header = exactMembers(value, SHAPES.header, issues);
  return {
    engineVersion: readVersion(header, "engineVersion", issues),
    rulesetVersion: readVersion(header, "rulesetVersion", issues),
    generatorVersion: readVersion(header, "generatorVersion", issues),
    brainVersion: readVersion(header, "brainVersion", issues),
  };
}

function readStateRoot(value: CanonicalValue | undefined, issues: IssueList): Digest {
  if (value === undefined) return "";
  if (typeof value === "string" && DIGEST.test(value)) return value;
  issues.report("/stateRoot", "the state root must be a digest: 32 lowercase hexadecimal digits");
  return "";
}

const EPOCH: NumberField = {
  key: "epoch",
  path: "/world/epoch",
  problem: (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? undefined
      : `${describeValue(value)} is not an epoch: epochs are safe integers from 0`,
};

const TICK: NumberField = { key: "tick", path: "/world/tick", problem: tickProblem };

const NEXT_ENTITY_ID: NumberField = {
  key: "nextEntityId",
  path: "/world/nextEntityId",
  problem: (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1
      ? undefined
      : `${describeValue(value)} is not an entity id: the next entity id is a safe integer from 1`,
};

const SECONDS_PER_TICK: NumberField = {
  key: "simSecondsPerTick",
  path: "/world/config/simSecondsPerTick",
  problem: secondsPerTickProblem,
};

/** The member `field` of `record`, a number its problem accepts; 0 after an issue, or missing. */
function readNumber(record: Data | undefined, field: NumberField, issues: IssueList): number {
  const value = member(record, field.key);
  if (value === undefined) return 0;
  const problem = field.problem(value);
  if (problem !== undefined) issues.report(field.path, problem);
  return typeof value === "number" && problem === undefined ? value : 0;
}

function readRng(world: Data | undefined, issues: IssueList): Kernel["rng"] {
  const rng = exactMembers(member(world, "rng"), SHAPES.rng, issues);
  const algorithm = member(rng, "algorithm");
  if (algorithm !== undefined && algorithm !== ALGORITHM) {
    const message = `the random algorithm must be "${ALGORITHM}", the only one this engine runs`;
    issues.report("/world/rng/algorithm", message);
  }
  const seed = member(rng, "seed");
  if (seed === undefined) return { algorithm: ALGORITHM, seed: [0, 0] };
  const problems: Issue[] = [];
  const words: Seed = readSeed(seed, problems);
  for (const { path, message } of problems) issues.report(`/world/rng${path}`, message);
  return { algorithm: ALGORITHM, seed: words };
}

function readConfig(world: Data | undefined, issues: IssueList): Kernel["config"] {
  const config = exactMembers(member(world, "config"), SHAPES.config, issues);
  return { simSecondsPerTick: readNumber(config, SECONDS_PER_TICK, issues) };
}

function readKernel(world: Data | undefined, issues: IssueList): Kernel {
  return {
    epoch: readNumber(world, EPOCH, issues),
    tick: readNumber(world, TICK, issues),
    nextEntityId: readNumber(world, NEXT_ENTITY_ID, issues),
    rng: readRng(world, issues),
    config: readConfig(world, issues),
  };
}

/** The chunks of `world` by key, in canonical order, each key read as a chunk key. */
function readChunks(world: Data | undefined, issues: IssueList): [ChunkKey, CanonicalValue][] {
  const value = member(world, "chunks");
  if (value === undefined) return [];
  const chunks = asData(value);
  if (chunks === undefined) {
    issues.report("/world/chunks", "the chunks must be a record of chunks by chunk key");
    return [];
  }
  return sortedOwnKeys(chunks).flatMap((key): [ChunkKey, CanonicalValue][] => {
    const { problems } = readChunkKey(key);
    for (const message of problems ?? []) issues.report(`/world/chunks${pointer([key])}`, message);
    const chunk = chunks[key];
    return problems === undefined && chunk !== undefined ? [[key, chunk]] : [];
  });
}

/** The world of a version 1 snapshot: its kernel, its global value, and its chunks. */
function readWorld(value: CanonicalValue | undefined, issues: IssueList) {
  const world = exactMembers(value, SHAPES.world, issues);
  return {
    kernel: readKernel(world, issues),
    // A missing global value was reported, and the snapshot is rejected with it.
    global: member(world, "global") ?? false,
    chunks: readChunks(world, issues),
  };
}

/** The canonical value of `text`; anything else is an invalid snapshot with the parser's issues. */
function parseSnapshot(text: string): CanonicalValue {
  try {
    return parseCanonical(text);
  } catch (error) {
    if (!EngineError.isEngineError(error)) throw error;
    throw new EngineError("invalid_snapshot", error.issues, { cause: error });
  }
}

/**
 * The version 1 snapshot that `text` writes. Throws EngineError("invalid_snapshot") for text that
 * is not canonical, with the parser's issues, and for every problem of the schema at once, in the
 * order of their paths; EngineError("unsupported_schema") when the snapshot names another schema
 * version.
 */
export function readSnapshot(text: string): SnapshotV1 {
  const snapshot = parseSnapshot(text);
  expectSupportedVersion(snapshot);
  const issues = new IssueList();
  const top = exactMembers(snapshot, SHAPES.top, issues);
  // Members are read in the order of their paths, so the issues come in that order too.
  const result: SnapshotV1 = {
    header: readHeader(member(top, "header"), issues),
    stateRoot: readStateRoot(member(top, "stateRoot"), issues),
    ...readWorld(member(top, "world"), issues),
  };
  issues.throwIfAny("invalid_snapshot");
  return result;
}
