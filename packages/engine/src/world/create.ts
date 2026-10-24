/**
 * Creating a world (ADR 0020, ownership and failures). createWorld validates the definition the
 * host gives and copies it once, so changing that definition afterwards never changes the world.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { type CanonicalValue, describeThrown, pointer } from "../canonical/value.ts";
import { EngineError, type Issue, IssueList } from "../errors.ts";
import { readSeed, type Seed } from "../rng/mix32.ts";
import { secondsPerTickProblem } from "../time/tick.ts";
import { ENGINE_VERSION } from "../version.ts";
import { chunkTerm, digestCache } from "./checksum.ts";
import { type ChunkKey, readChunkKey } from "./chunk.ts";
import { ChunkIndex } from "./chunk-index.ts";
import type { WorldInit, WorldOptions } from "./contracts.ts";
import { isRecord, readMember, readRecordKeys, UNREAD, under } from "./members.ts";
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

function readWorldSeed(init: object, issues: IssueList): Seed {
  const copy = copyMember(init, "seed", issues);
  if (copy === undefined) return [0, 0];
  const problems: Issue[] = [];
  const seed = readSeed(copy, problems);
  for (const { path, message } of problems) issues.report(`/init${path}`, message);
  return seed;
}

function readSecondsPerTick(init: object, issues: IssueList): number {
  const path = "/init/simSecondsPerTick";
  const value = readMember(init, "simSecondsPerTick", path, issues);
  const problem = value === UNREAD ? undefined : secondsPerTickProblem(value);
  if (problem !== undefined) issues.report(path, problem);
  return typeof value === "number" ? value : 0;
}

/** Whether `issue` is a record { path, message } whose path is a JSON Pointer. */
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

function readGlobal(init: object, ruleset: CapturedRuleset, issues: IssueList): CanonicalValue {
  const global = copyMember(init, "global", issues);
  if (global === undefined) return false;
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateGlobal } = ruleset;
  runValidator("validateGlobal", "/init/global", () => validateGlobal(global), issues);
  return global;
}

/**
 * The chunks, by key in canonical order: each key checked with readChunkKey, each value copied on
 * its own and then checked by validateChunk, so that every problem of every chunk is reported.
 */
function readChunks(
  init: object,
  ruleset: CapturedRuleset,
  issues: IssueList,
): [ChunkKey, CanonicalValue][] {
  const value = readMember(init, "chunks", "/init/chunks", issues);
  const notRecord = "the chunks must be a record of chunks by chunk key";
  const read = readRecordKeys(value, "/init/chunks", notRecord, issues);
  if (read === undefined) return [];
  const { record, keys } = read;
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { validateChunk } = ruleset;
  const chunks: [ChunkKey, CanonicalValue][] = [];
  for (const key of keys) {
    const path = `/init/chunks${pointer([key])}`;
    const { problems } = readChunkKey(key);
    for (const message of problems ?? []) issues.report(path, message);
    const chunk = copyAt(readMember(record, key, path, issues), path, issues);
    if (problems !== undefined || chunk === undefined) continue;
    runValidator("validateChunk", path, () => validateChunk(key, chunk), issues);
    chunks.push([key, chunk]);
  }
  return chunks;
}

function readAudit(options: unknown, issues: IssueList): boolean {
  if (options === undefined) return false;
  if (!isRecord(options)) {
    issues.report("/options", "the options must be a record");
    return false;
  }
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

/**
 * A new world at tick 0, epoch 0, with the next entity id 1, from the definition `init`.
 *
 * - The ruleset is captured first (captureRuleset), because its validators check the data: a
 *   broken ruleset throws EngineError("invalid_ruleset"), with paths into the ruleset.
 * - The seed must be two u32 words and simSecondsPerTick a positive safe integer. The global value
 *   and the chunks, a record keyed by chunk key (parseChunkKey), are validated and copied as
 *   copyCanonical does, then checked by the ruleset's validators. `options.audit` is a boolean.
 * - Every problem is reported in one EngineError("invalid_input"), with its path into
 *   `{ init, options }`; a definition that is not a record is the only issue reported alone.
 *
 * Each member of `init` and `options` is read once, through its own descriptor.
 */
export function createWorld<G extends CanonicalValue, C extends CanonicalValue>(
  init: WorldInit<G, C>,
  options?: WorldOptions,
): World<G, C> {
  if (!isRecord(init)) {
    throw new EngineError("invalid_input", [
      { path: "/init", message: "the world definition must be a record" },
    ]);
  }
  const ruleset = rulesetOf(init);
  const issues = new IssueList();
  const seed = readWorldSeed(init, issues);
  const simSecondsPerTick = readSecondsPerTick(init, issues);
  const global = readGlobal(init, ruleset, issues);
  const chunkList = readChunks(init, ruleset, issues);
  const audit = readAudit(options, issues);
  issues.throwIfAny("invalid_input");
  const kernel: Kernel = {
    epoch: 0,
    tick: 0,
    nextEntityId: 1,
    rng: { algorithm: "ctr-mix32@1", seed },
    config: { simSecondsPerTick },
  };
  const chunks = new ChunkIndex<ChunkEntry>();
  for (const [key, value] of chunkList) chunks.add(key, { value, term: chunkTerm(key, value) });
  const { versions } = ruleset;
  const state: WorldState = {
    header: {
      engineVersion: ENGINE_VERSION,
      rulesetVersion: versions.ruleset,
      generatorVersion: versions.generator,
      brainVersion: versions.brain,
    },
    kernel,
    global,
    chunks,
    ruleset,
    digests: digestCache(kernel, global, chunks),
    audit,
    status: { kind: "ok" },
  };
  // The ruleset's validators accepted the global value as a G and every chunk as a C.
  return newWorld(state as WorldState<G, C>);
}
