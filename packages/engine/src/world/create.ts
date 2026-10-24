/**
 * Creating a world (ADR 0020, ownership and failures). createWorld validates the definition the
 * host gives and copies it once, so changing that definition afterwards never changes the world.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { type CanonicalValue, describeThrown, pointer } from "../canonical/value.ts";
import type { Digest } from "../digest/digest.ts";
import { type Issue, IssueList } from "../errors.ts";
import { readSeed, type Seed } from "../rng/mix32.ts";
import { secondsPerTickProblem } from "../time/tick.ts";
import { ENGINE_VERSION } from "../version.ts";
import { chunkTerm, digestCache, globalDigest } from "./checksum.ts";
import { type ChunkKey, readChunkKey } from "./chunk.ts";
import { ChunkIndex } from "./chunk-index.ts";
import type { WorldInit, WorldOptions } from "./contracts.ts";
import { expectRecord, isRecord, readMember, readRecordKeys, UNREAD, under } from "./members.ts";
import { type CapturedRuleset, captureRuleset } from "./ruleset.ts";
import { type ChunkEntry, type Kernel, newWorld, type World, type WorldState } from "./world.ts";

const MALFORMED = "must return a list of issues, each a record { path, message } of strings";

/** A copy of `value`, which readMember read, with its issues at `path`; undefined after any. */
function copyAt(value: unknown, path: string, issues: IssueList): CanonicalValue | undefined {
  if (value === UNREAD) return undefined;
  const before = issues.count;
  const copy = copyCanonicalReported(value, under(issues, path));
  return issues.count === before ? copy : undefined;
}

/** A copy of the canonical member `key` of `init`, with its issues at `/init/<key>`. */
function copyMember(init: object, key: string, issues: IssueList): CanonicalValue | undefined {
  const path = `/init/${key}`;
  return copyAt(readMember(init, key, path, issues), path, issues);
}

/** The seed, two u32 words; undefined after an issue. */
function readWorldSeed(init: object, issues: IssueList): Seed | undefined {
  const copy = copyMember(init, "seed", issues);
  if (copy === undefined) return undefined;
  const problems: Issue[] = [];
  const seed = readSeed(copy, problems);
  for (const { path, message } of problems) issues.report(`/init${path}`, message);
  return problems.length === 0 ? seed : undefined;
}

/** The seconds per tick, a positive safe integer; undefined after an issue. */
function readSecondsPerTick(init: object, issues: IssueList): number | undefined {
  const path = "/init/simSecondsPerTick";
  const value = readMember(init, "simSecondsPerTick", path, issues);
  if (value === UNREAD) return undefined;
  const problem = secondsPerTickProblem(value);
  if (problem !== undefined) {
    issues.report(path, problem);
    return undefined;
  }
  // secondsPerTickProblem found no problem, so the value is a positive safe integer.
  return value as number;
}

/** Whether `issue`, part of a canonical copy, is a record { path, message } with a JSON Pointer. */
function isIssue(issue: unknown): issue is Issue {
  if (!isRecord(issue) || !("path" in issue) || !("message" in issue)) return false;
  const { path, message } = issue;
  const pointerLike = typeof path === "string" && (path === "" || path.startsWith("/"));
  return pointerLike && typeof message === "string";
}

/**
 * Runs the validator `name` of the ruleset and reports what it returns at `path`: each issue under
 * that path, or one issue when it throws or returns anything but a list of issues.
 */
function runValidator(
  name: string,
  path: string,
  validate: () => unknown,
  issues: IssueList,
): void {
  let result: unknown;
  try {
    result = validate();
  } catch (error) {
    issues.report(path, `${name} threw: ${describeThrown(error)}`, error);
    return;
  }
  const problems = new IssueList();
  const found = copyCanonicalReported(result, problems);
  if (problems.count > 0 || !Array.isArray(found) || !found.every(isIssue)) {
    issues.report(path, `${name} ${MALFORMED}`);
    return;
  }
  for (const issue of found) issues.report(`${path}${issue.path}`, issue.message);
}

/** A global value as createWorld keeps it: the copy, and its digest. */
type HashedGlobal = { readonly value: CanonicalValue; readonly digest: Digest };

/**
 * The global value and its digest, or undefined after an issue. The digest is taken before
 * validateGlobal runs, so a validator that changes the value it is given, or keeps it and changes
 * it later, leaves a cache that fullChecksum disagrees with: detected, as every write that
 * bypasses the barrier is, not prevented (ADR 0020, ownership).
 */
function readGlobal(
  init: object,
  ruleset: CapturedRuleset,
  issues: IssueList,
): HashedGlobal | undefined {
  const value = copyMember(init, "global", issues);
  if (value === undefined) return undefined;
  const hashed = { value, digest: globalDigest(value) };
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateGlobal } = ruleset;
  runValidator("validateGlobal", "/init/global", () => validateGlobal(value), issues);
  return hashed;
}

/**
 * The chunks, by key in canonical order: each key checked with readChunkKey, each value copied on
 * its own and then checked by validateChunk, so that every problem of every chunk is reported.
 * Each chunk's term is taken before validateChunk runs, as readGlobal takes the global digest.
 */
function readChunks(
  init: object,
  ruleset: CapturedRuleset,
  issues: IssueList,
): [ChunkKey, ChunkEntry][] {
  const value = readMember(init, "chunks", "/init/chunks", issues);
  const notRecord = "the chunks must be a record of chunks by chunk key";
  const read = readRecordKeys(value, "/init/chunks", notRecord, issues);
  if (read === undefined) return [];
  const { record, keys } = read;
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateChunk } = ruleset;
  const chunks: [ChunkKey, ChunkEntry][] = [];
  for (const key of keys) {
    const path = `/init/chunks${pointer([key])}`;
    const { problems } = readChunkKey(key);
    for (const message of problems ?? []) issues.report(path, message);
    const chunk = copyAt(readMember(record, key, path, issues), path, issues);
    if (problems !== undefined || chunk === undefined) continue;
    const entry: ChunkEntry = { value: chunk, term: chunkTerm(key, chunk) };
    runValidator("validateChunk", path, () => validateChunk(key, chunk), issues);
    chunks.push([key, entry]);
  }
  return chunks;
}

function readAudit(options: unknown, issues: IssueList): boolean {
  if (options === undefined) return false;
  if (!expectRecord(options, "/options", "the options must be a record", issues)) return false;
  const audit = readMember(options, "audit", "/options/audit", issues);
  if (audit === undefined || typeof audit === "boolean") return audit === true;
  if (audit !== UNREAD)
    issues.report("/options/audit", `audit must be a boolean, not ${typeof audit}`);
  return false;
}

/** The captured ruleset of `init`. Throws invalid_input when the member cannot be read. */
function rulesetOf(init: object): CapturedRuleset {
  const issues = new IssueList();
  const ruleset = readMember(init, "ruleset", "/init/ruleset", issues);
  issues.throwIfAny("invalid_input");
  return captureRuleset(ruleset);
}

/** Everything createWorld reads from `{ init, options }`, validated and copied. */
type Definition = {
  readonly ruleset: CapturedRuleset;
  readonly seed: Seed;
  readonly simSecondsPerTick: number;
  readonly global: HashedGlobal;
  readonly chunks: readonly [ChunkKey, ChunkEntry][];
  readonly audit: boolean;
};

/** Reads `init` and `options` in the order createWorld documents, and throws on any issue. */
function readDefinition(init: unknown, options: unknown): Definition {
  const issues = new IssueList();
  if (!expectRecord(init, "/init", "the world definition must be a record", issues)) {
    throw issues.toError("invalid_input");
  }
  const ruleset = rulesetOf(init);
  const seed = readWorldSeed(init, issues);
  const simSecondsPerTick = readSecondsPerTick(init, issues);
  const global = readGlobal(init, ruleset, issues);
  const chunks = readChunks(init, ruleset, issues);
  const audit = readAudit(options, issues);
  // Each reader returns undefined only after an issue; the checks also narrow the types.
  if (issues.count > 0 || seed === undefined || simSecondsPerTick === undefined || !global) {
    throw issues.toError("invalid_input");
  }
  return { ruleset, seed, simSecondsPerTick, global, chunks, audit };
}

/**
 * A new world at tick 0, epoch 0, with the next entity id 1, from the definition `init`. Issue
 * paths point into `{ init, options }`, except those of invalid_ruleset, which point into the
 * ruleset. The checks run in this order, and each of the first three stops the others:
 *
 * 1. `init` must be a record that can be read: otherwise one invalid_input issue at `/init`.
 * 2. Its `ruleset` member must be an own, enumerable data property that can be read: otherwise
 *    one invalid_input issue at `/init/ruleset`.
 * 3. The ruleset is captured (captureRuleset), because its validators check the data: a broken
 *    ruleset throws invalid_ruleset with all its problems, and a missing ruleset, or one that is
 *    not a record, is one issue at the path "".
 * 4. Every other problem is reported in one invalid_input: the seed must be two u32 words and
 *    simSecondsPerTick a positive safe integer; the global value and each chunk, in a plain record
 *    keyed by chunk key (parseChunkKey), are validated and copied as copyCanonical does, then
 *    checked by the ruleset's validators; `options` is a record whose `audit` is a boolean.
 *
 * Each member of `init` and `options` is read once, through its own descriptor. The validators
 * receive the values the world keeps, not copies of them, as ruleset code does during a tick: a
 * validator must not change or keep what it is given. The digests are taken before the
 * validators run, so a validator that does is detected by fullChecksum, as any write that
 * bypasses the barrier is, but not prevented (ADR 0020, ownership).
 */
export function createWorld<G extends CanonicalValue, C extends CanonicalValue>(
  init: WorldInit<G, C>,
  options?: WorldOptions,
): World<G, C> {
  const {
    ruleset,
    seed,
    simSecondsPerTick,
    global,
    chunks: entries,
    audit,
  } = readDefinition(init, options);
  const kernel: Kernel = {
    epoch: 0,
    tick: 0,
    nextEntityId: 1,
    rng: { algorithm: "ctr-mix32@1", seed },
    config: { simSecondsPerTick },
  };
  const chunks = new ChunkIndex<ChunkEntry>();
  for (const [key, entry] of entries) chunks.add(key, entry);
  const { versions } = ruleset;
  const state: WorldState = {
    header: {
      engineVersion: ENGINE_VERSION,
      rulesetVersion: versions.ruleset,
      generatorVersion: versions.generator,
      brainVersion: versions.brain,
    },
    kernel,
    global: global.value,
    chunks,
    ruleset,
    digests: digestCache(kernel, global.digest, chunks),
    audit,
    status: { kind: "ok" },
  };
  // The ruleset's validators accepted the global value as a G and every chunk as a C.
  return newWorld(state as WorldState<G, C>);
}
