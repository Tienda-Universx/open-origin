/**
 * The tick context (ADR 0020, ownership and randomness; plan §2.2): one instance per step, and
 * one read-only view of it for `check`. Both are revoked when the step returns.
 *
 * - Reads return the live values; writeChunk and writeGlobal return them too and mark them
 *   changed, so that the commit hashes them. A chunk created during the tick can be read and
 *   written at once, and chunkKeys lists it from the next tick on.
 * - Draws for an entity, or for a contended resource, use the key tickKey(tick, id) on a stream
 *   the running owner declared, with a counter per (stream, id) that continues across calls and
 *   restarts every tick.
 * - Every misuse is a fault, recorded in the session (step/session.ts).
 *
 * This is the one module besides canonical/value.ts that may use the global `Map`
 * (global-map.grit): it keeps the tick's draw sequences by stream and id, and looks them up
 * without ever iterating them.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { type CanonicalValue, describeThrown } from "../canonical/value.ts";
import { describePath, describeValue, EngineError, type Issue, IssueList } from "../errors.ts";
import { tickKey } from "../rng/mix32.ts";
import { DrawSequence } from "../rng/random.ts";
import { type ChunkKey, readChunkKey } from "../world/chunk.ts";
import type { EntityId, ReadView, TickContext, TickRandom } from "../world/contracts.ts";
import { readText } from "../world/members.ts";
import type { TickSession } from "./session.ts";

type Value = CanonicalValue;

/** The context of one tick, and the view of it that `check` receives. */
export type TickHandles = {
  readonly ctx: TickContext<Value, Value>;
  readonly view: ReadView<Value, Value>;
};

/** The tick's draw sequences, by stream id and then by entity or resource id. */
type Sequences = Map<number, Map<number, DrawSequence>>;

/** The live chunk `key`, committed or created during the tick; undefined when there is none. */
function liveChunk(session: TickSession, key: unknown): Value | undefined {
  if (typeof key !== "string") return undefined;
  const entry = session.state.chunks.get(key);
  return entry === undefined ? session.created[key] : entry.value;
}

/** A fault for each problem of a chunk key passed to `what`. */
function keyFault(session: TickSession, what: string, problems: readonly string[]): EngineError {
  return session.failWith(
    "system_fault",
    problems.map((problem) => `${what}: ${problem}`),
  );
}

function readChunk(session: TickSession, key: ChunkKey): Value | undefined {
  session.ensureLive();
  const value = liveChunk(session, key);
  if (value !== undefined) return value;
  const { problems } = readChunkKey(key);
  if (problems === undefined) return undefined;
  throw keyFault(session, "readChunk", problems);
}

function writeChunk(session: TickSession, key: ChunkKey): Value {
  session.ensureLive();
  const entry = typeof key === "string" ? session.state.chunks.get(key) : undefined;
  if (entry !== undefined) {
    session.markDirty(key);
    return entry.value;
  }
  // A chunk created during the tick is hashed at the commit whether it is written or not.
  const created = liveChunk(session, key);
  if (created !== undefined) return created;
  const { problems } = readChunkKey(key);
  throw keyFault(session, "writeChunk", problems ?? [`there is no chunk "${key}"`]);
}

/** The messages for the issues of a canonical copy, each with its path into the value. */
function copyProblems(what: string, issues: readonly Issue[]): string[] {
  return issues.map(({ path, message }) => `${what}: at ${describePath(path)}: ${message}`);
}

/** A canonical copy of `value`, or a fault that names `what` and every issue of the value. */
function copyOrFault(session: TickSession, value: unknown, what: string): Value {
  const issues = new IssueList();
  const copy = copyCanonicalReported(value, issues);
  if (issues.count === 0) return copy;
  const cause = issues.toError("invalid_value");
  throw session.failWith("system_fault", copyProblems(what, cause.issues), cause);
}

function createChunk(session: TickSession, key: ChunkKey, initial: Value): void {
  session.ensureLive();
  const { problems } = readChunkKey(key);
  if (problems !== undefined) throw keyFault(session, "createChunk", problems);
  if (liveChunk(session, key) !== undefined) {
    throw session.fail(`createChunk: the chunk "${key}" already exists`);
  }
  const what = `createChunk("${key}"): the initial value is not canonical`;
  session.created[key] = copyOrFault(session, initial, what);
  session.createdKeys.push(key);
}

function newEntityId(session: TickSession): EntityId {
  session.ensureLive();
  const { kernel } = session.state;
  const id = kernel.nextEntityId;
  // Handing out the largest safe integer would leave nextEntityId beyond the safe integers.
  if (id >= Number.MAX_SAFE_INTEGER) {
    const message = `newEntityId: the entity ids are exhausted: nextEntityId is ${id}, the largest safe integer`;
    throw session.failWith("id_exhausted", [message]);
  }
  kernel.nextEntityId = id + 1;
  return id;
}

/** Every problem of `type` as an event type: a non-empty canonical string, not `engine.`. */
function eventTypeProblems(type: unknown): string[] {
  const problems: string[] = [];
  const text = readText(type, "", "the event type", {
    report: (_path, message) => problems.push(message),
  });
  if (text?.startsWith("engine.")) {
    problems.push(
      `the event type "${text}" starts with "engine.", which is reserved for the kernel`,
    );
  }
  return problems;
}

function emit(session: TickSession, type: string, payload: Value): void {
  const { cause } = session.ensureLive();
  const problems = eventTypeProblems(type).map((problem) => `emit: ${problem}`);
  if (problems.length > 0) throw session.failWith("system_fault", problems);
  const copy = copyOrFault(session, payload, "emit: the payload is not canonical");
  const { events } = session;
  events.push({ tick: session.tick, seq: events.length, type, payload: copy, cause: { ...cause } });
}

/** The id of `stream`, if the running owner declared it; a fault otherwise. */
function declaredStream(session: TickSession, what: string, stream: unknown): number {
  const { streams } = session.ensureLive();
  const id = typeof stream === "string" ? streams[stream] : undefined;
  if (id !== undefined) return id;
  const name = typeof stream === "string" ? `"${stream}"` : describeValue(stream);
  throw session.fail(`${what} drew from ${name}, a stream it did not declare`);
}

/** The tick's draw sequence of the stream `streamId` for `id`, made on its first draw. */
function sequenceOf(
  sequences: Sequences,
  session: TickSession,
  streamId: number,
  id: EntityId,
): DrawSequence {
  let byId = sequences.get(streamId);
  if (byId === undefined) {
    byId = new Map();
    sequences.set(streamId, byId);
  }
  let sequence = byId.get(id);
  if (sequence === undefined) {
    // tickKey rejects an id that is not a safe integer before the sequence is kept.
    sequence = new DrawSequence(session.state.kernel.rng.seed, streamId, tickKey(session.tick, id));
    byId.set(id, sequence);
  }
  return sequence;
}

/** Runs the draw `what`, turning what it throws into a fault. */
function attempt<T>(session: TickSession, what: string, draw: () => T): T {
  session.ensureLive();
  try {
    return draw();
  } catch (error) {
    if (error === session.fault) throw error;
    const reason = EngineError.isEngineError(error) ? error.message : describeThrown(error);
    throw session.fail(`${what}: ${reason}`, error);
  }
}

/** The draws of one tick. Its sequences live as long as the context, so they restart every tick. */
function tickRandom(session: TickSession): TickRandom {
  const sequences: Sequences = new Map();
  const sequence = (what: string, stream: string, id: EntityId) =>
    sequenceOf(sequences, session, declaredStream(session, what, stream), id);
  return {
    u32: (stream, entity) =>
      attempt(session, "random.u32", () => sequence("random.u32", stream, entity).u32()),
    int: (stream, entity, bound) =>
      attempt(session, "random.int", () => sequence("random.int", stream, entity).int(bound)),
    permutation: (stream, resourceId, count) =>
      attempt(session, "random.permutation", () =>
        sequence("random.permutation", stream, resourceId).permutation(count),
      ),
  };
}

/** The reads of the tick, live and revoked with it. */
function tickView(session: TickSession): ReadView<Value, Value> {
  return {
    get tick() {
      session.ensureLive();
      return session.tick;
    },
    chunkKeys: () => {
      session.ensureLive();
      return session.state.chunks.sortedKeys();
    },
    readChunk: (key) => readChunk(session, key),
    readGlobal: () => {
      session.ensureLive();
      return session.state.global;
    },
  };
}

/** The context of the tick `session` runs, and its read-only view for `check`. */
export function openTick(session: TickSession): TickHandles {
  const view = tickView(session);
  const ctx: TickContext<Value, Value> = {
    get tick() {
      return view.tick;
    },
    chunkKeys: view.chunkKeys,
    readChunk: view.readChunk,
    readGlobal: view.readGlobal,
    writeChunk: (key) => writeChunk(session, key),
    writeGlobal: () => {
      session.ensureLive();
      session.globalDirty = true;
      return session.state.global;
    },
    createChunk: (key, initial) => createChunk(session, key, initial),
    newEntityId: () => newEntityId(session),
    random: tickRandom(session),
    rejectedCommands: () => {
      session.ensureLive();
      return session.rejected.slice();
    },
    emit: (type, payload) => emit(session, type, payload),
  };
  return { ctx, view };
}
