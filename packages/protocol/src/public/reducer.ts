/**
 * The reference client reducer (ADR 0026, docs/architecture/protocol.md): one client's model of the
 * public view, which applies the server's messages in the order they arrive. It is pure and
 * deterministic: it reads no clock, does no I/O, and never changes the state or the message it is
 * given. The server's tests, the terminal probe, and the web client all use it.
 *
 * - The parts of a transaction are kept aside and the whole transaction is applied at its
 *   `commit`, so the visible view is always at one tick; `abort` discards the parts.
 * - A commit applies, in order: the chunks that leave (`drop`), then every visible chunk's `gone`,
 *   then every visible chunk's `upsert`, then the full content of the chunks that enter, each put
 *   together from all its fragments, which may span several parts. Every being is then in one
 *   visible chunk: a being that crosses leaves one chunk and enters the other in one transaction.
 * - A `reset` transaction replaces the whole view at its commit; until then the old view stays,
 *   marked `stale`. Every connection starts stale, so its first transaction must be a reset, and a
 *   reset always has at least one `snapshot` part with `reset: true`.
 * - The visible clock comes only from `hello` (before any view) and from `commit`.
 * - A `seq` gap, a `commit` whose tick does not exceed the previous commit's, or a transaction that
 *   breaks the protocol is an anomaly: the result carries it, the view stays as it was, marked
 *   stale, and the client sends `resync`. While stale, only a reset transaction is applied; the
 *   transaction in flight at a gap is discarded, since parts of it may be lost.
 */
import {
  assemble,
  type ChunkContent,
  type ChunkDelta,
  liesIn,
  type Part,
  type Transaction,
  TransactionProblem,
} from "./assemble.ts";
import type { DURABILITIES } from "./constants.ts";
import type { BeingPublic, ChunkCoord, FeedItem, Speech } from "./dto.ts";
import type { Clock, CommitMessage, HelloMessage, ServerMessage } from "./server.ts";
import type { PlainText } from "./text.ts";

/** A visible chunk: its version, its terrain, and its beings by id. */
export type ChunkView = ChunkContent;

/** The visible view: its tick, the clock of that tick, its chunks, and the followed being. */
export type ClientView = {
  readonly tick: number;
  readonly clock: Clock;
  /** By chunkKey. */
  readonly chunks: ReadonlyMap<string, ChunkView>;
  /**
   * The followed being's record at this tick while a visible chunk holds it, else the one the last
   * commit's parts sent; null when nothing is followed, or the being is gone or outside the view.
   */
  readonly followed: BeingPublic | null;
};

/** What `hello` announced for the connection. */
export type Connection = {
  readonly worldId: string;
  readonly durability: (typeof DURABILITIES)[number];
  readonly limits: HelloMessage["limits"];
  readonly helloTick: number;
};

/** The parts of the transaction in flight. */
type Pending = { readonly txn: number; readonly tick: number; readonly parts: readonly Part[] };

/** One client's state. */
export type ClientState = {
  /** Undefined before the first `hello`. */
  readonly connection: Connection | undefined;
  /** The world's state and the reason of its last stop, as `hello` and `status` gave them. */
  readonly world: { readonly state: HelloMessage["state"]; readonly reason: PlainText | undefined };
  /** Undefined before the first `hello`; kept across reconnects until a reset replaces it. */
  readonly view: ClientView | undefined;
  /** Whether the view waits for a reset: after every `hello`, and after an anomaly. */
  readonly stale: boolean;
  /** The chunks the last `notice` said the view limit trimmed. */
  readonly trimmed: readonly ChunkCoord[];
  readonly expectedSeq: number;
  readonly lastCommitTick: number | undefined;
  readonly pending: Pending | undefined;
  /** A transaction whose parts are ignored until its commit or abort. */
  readonly discarded: number | undefined;
  /** Whether the next transaction message belongs to a transaction a gap may have cut. */
  readonly suspect: boolean;
};

/** Why the client must send `resync`. */
export type AnomalyKind = "before_hello" | "seq_gap" | "tick_not_increasing" | "bad_transaction";
export type Anomaly = { readonly kind: AnomalyKind; readonly detail: string };

/** An item of local speech, with the chunk where it was heard. */
export type LocalSpeech = { readonly at: ChunkCoord; readonly speech: Speech };

/** What a commit applied, besides the view: the speech and the feed of its ticks. */
export type Committed = {
  readonly txn: number;
  readonly tick: number;
  readonly reset: boolean;
  readonly speech: readonly LocalSpeech[];
  /** The chunks whose speech the server could not send in full, with how many items it left out. */
  readonly speechMissed: readonly { readonly at: ChunkCoord; readonly count: number }[];
  readonly feed: readonly FeedItem[];
  /** How many feed items the server left out; 0 when none. */
  readonly missed: number;
};

/** The result of applying one message. */
export type Applied = {
  readonly state: ClientState;
  readonly committed?: Committed;
  readonly anomaly?: Anomaly;
};

/** A state after a `hello`, with its view. */
type Connected = ClientState & { readonly connection: Connection; readonly view: ClientView };

/** The result of an anomaly: the state stays connected. */
type Flagged = { readonly state: Connected; readonly anomaly: Anomaly };

/** The state of a client that has received nothing. */
export function initialClientState(): ClientState {
  return {
    connection: undefined,
    world: { state: "running", reason: undefined },
    view: undefined,
    stale: true,
    trimmed: [],
    expectedSeq: 0,
    lastCommitTick: undefined,
    pending: undefined,
    discarded: undefined,
    suspect: false,
  };
}

/** The record of the being `id` in `view`, or undefined when no visible chunk holds it. */
export function findBeing(view: ClientView, id: number): BeingPublic | undefined {
  for (const chunk of view.chunks.values()) {
    const being = chunk.beings.get(id);
    if (being !== undefined) return being;
  }
  return undefined;
}

/**
 * A new connection: the old view, if any, stays, marked stale, with its clock; a first view is
 * empty, at hello's tick and clock. Sequence, transaction, and commit tracking start over.
 */
function greet(state: ClientState, hello: HelloMessage): ClientState {
  const empty = { tick: hello.tick, clock: hello.clock, chunks: new Map(), followed: null };
  return {
    ...initialClientState(),
    connection: {
      worldId: hello.world.id,
      durability: hello.durability,
      limits: hello.limits,
      helloTick: hello.tick,
    },
    world: { state: hello.state, reason: undefined },
    view: state.view ?? empty,
    expectedSeq: 1,
  };
}

/**
 * `state`, marked stale, with `anomaly`: the parts kept aside are dropped, and the parts and the
 * close of `discarded`, the transaction left open, if any, will be ignored.
 */
function flag(state: Connected, anomaly: Anomaly, discarded: number | undefined): Flagged {
  return { state: { ...state, stale: true, pending: undefined, discarded }, anomaly };
}

/** A transaction that breaks the protocol. */
function broken(detail: string): Anomaly {
  return { kind: "bad_transaction", detail };
}

/** The transaction still open once `txn` closes: the one in flight or discarded, if not `txn`. */
function openAfter(state: Connected, txn: number): number | undefined {
  const open = state.pending?.txn ?? state.discarded;
  return open === txn ? undefined : open;
}

/** `state` before a transaction message of `txn`: after a gap, that transaction is discarded. */
function settle(state: Connected, txn: number): Connected {
  if (!state.suspect) return state;
  return { ...state, suspect: false, pending: undefined, discarded: txn };
}

/** Keeps a part aside until its transaction's commit. */
function addPart(state: Connected, part: Part): Applied {
  const settled = settle(state, part.txn);
  if (part.txn === settled.discarded) return { state: settled };
  const { pending } = settled;
  if (pending === undefined) {
    return { state: { ...settled, pending: { txn: part.txn, tick: part.tick, parts: [part] } } };
  }
  if (pending.txn !== part.txn) {
    const detail = `transaction ${part.txn} began before transaction ${pending.txn} closed`;
    return flag(settled, broken(detail), part.txn);
  }
  if (pending.tick !== part.tick) {
    return flag(
      settled,
      broken(`the parts of transaction ${part.txn} disagree on its tick`),
      part.txn,
    );
  }
  return { state: { ...settled, pending: { ...pending, parts: [...pending.parts, part] } } };
}

/** Discards the parts of the transaction an `abort` cancels. */
function abort(state: Connected, txn: number): Applied {
  const settled = settle(state, txn);
  if (txn === settled.discarded) return { state: { ...settled, discarded: undefined } };
  const { pending } = settled;
  if (pending !== undefined && pending.txn !== txn) {
    const detail = `abort of transaction ${txn} while transaction ${pending.txn} is in flight`;
    return flag(settled, broken(detail), openAfter(settled, txn));
  }
  return { state: { ...settled, pending: undefined } };
}

/** Why `commit`'s tick is out of order: not above the previous commit's, or below hello's. */
function tickProblem(state: Connected, commit: CommitMessage): Anomaly | undefined {
  const last = state.lastCommitTick;
  const helloTick = state.connection.helloTick;
  if (last === undefined ? commit.tick >= helloTick : commit.tick > last) return undefined;
  const previous = last === undefined ? `hello's tick ${helloTick}` : `tick ${last}`;
  return { kind: "tick_not_increasing", detail: `commit at tick ${commit.tick} after ${previous}` };
}

/** Why the differences of the visible `chunk` at `key` cannot apply; undefined when they can. */
function deltaProblem(key: string, chunk: ChunkView | undefined, delta: ChunkDelta) {
  if (chunk === undefined) return new TransactionProblem(`chunk ${key} is not visible`);
  if (delta.v < chunk.v) return new TransactionProblem(`chunk ${key} cannot go back a version`);
  const absent = delta.gone.find((id) => !chunk.beings.has(id));
  if (absent !== undefined) return new TransactionProblem(`being ${absent} is not in ${key}`);
  const outside = delta.upsert.find((being) => !liesIn(being, delta.at));
  if (outside !== undefined) {
    return new TransactionProblem(`being ${outside.id} does not lie in chunk ${key}`);
  }
  return undefined;
}

/**
 * Applies the differences of `deltas` to `chunks`: every chunk's `gone` first, then every chunk's
 * `upsert`, so that a being that crosses from one visible chunk to another is never in both.
 */
function applyDeltas(
  chunks: Map<string, ChunkView>,
  deltas: Transaction["deltas"],
): TransactionProblem | undefined {
  const edited: {
    key: string;
    chunk: ChunkView;
    delta: ChunkDelta;
    beings: Map<number, BeingPublic>;
  }[] = [];
  for (const [key, delta] of deltas) {
    const chunk = chunks.get(key);
    const problem = deltaProblem(key, chunk, delta);
    if (problem !== undefined || chunk === undefined) return problem;
    const beings = new Map(chunk.beings);
    for (const id of delta.gone) beings.delete(id);
    edited.push({ key, chunk, delta, beings });
  }
  for (const { key, chunk, delta, beings } of edited) {
    for (const being of delta.upsert) beings.set(being.id, being);
    chunks.set(key, { ...chunk, v: delta.v, beings });
  }
  return undefined;
}

/** The chunks `txn` leaves, applied to the chunks of `view`, before any check across chunks. */
function appliedChunks(
  view: ClientView,
  txn: Transaction,
): Map<string, ChunkView> | TransactionProblem {
  if (txn.reset) return new Map(txn.entering);
  const chunks = new Map(view.chunks);
  for (const key of txn.drop.keys()) {
    if (!chunks.delete(key)) return new TransactionProblem(`chunk ${key} is not visible to drop`);
  }
  const problem = applyDeltas(chunks, txn.deltas);
  if (problem !== undefined) return problem;
  for (const [key, content] of txn.entering) {
    if (chunks.has(key)) return new TransactionProblem(`chunk ${key} is visible: it cannot enter`);
    chunks.set(key, content);
  }
  return chunks;
}

/** The problem of a being found in two chunks. */
function twice(id: number, first: string, second: string): TransactionProblem {
  return new TransactionProblem(`being ${id} is in two chunks: ${first} and ${second}`);
}

/** Records that the beings `ids` are in the chunk `key`; one already in another chunk is a problem. */
function place(
  placed: Map<number, string>,
  key: string,
  ids: Iterable<number>,
): TransactionProblem | undefined {
  for (const id of ids) {
    const other = placed.get(id);
    if (other !== undefined && other !== key) return twice(id, other, key);
    placed.set(id, key);
  }
  return undefined;
}

/** The chunk of every being `txn` places, by an upsert or in a chunk that enters, by id. */
function placedBy(txn: Transaction): Map<number, string> | TransactionProblem {
  const placed = new Map<number, string>();
  for (const [key, delta] of txn.deltas) {
    const ids = delta.upsert.map((being) => being.id);
    const problem = place(placed, key, ids);
    if (problem !== undefined) return problem;
  }
  for (const [key, content] of txn.entering) {
    const problem = place(placed, key, content.beings.keys());
    if (problem !== undefined) return problem;
  }
  return placed;
}

/**
 * A being of the visible `chunk` at `key` that `placed` puts in another chunk, as a problem. It walks
 * the smaller of the two, so a commit that places few beings costs little in a dense view.
 */
function heldElsewhere(
  key: string,
  chunk: ChunkView,
  placed: ReadonlyMap<number, string>,
): TransactionProblem | undefined {
  if (placed.size <= chunk.beings.size) {
    for (const [id, at] of placed) {
      if (at !== key && chunk.beings.has(id)) return twice(id, key, at);
    }
    return undefined;
  }
  for (const id of chunk.beings.keys()) {
    const at = placed.get(id);
    if (at !== undefined && at !== key) return twice(id, key, at);
  }
  return undefined;
}

/**
 * Why `chunks`, the view after `txn`, holds a being in two chunks; undefined when every being is
 * in one. The view before held each being once, so a being twice is one `txn` placed: placed in
 * two chunks, or placed in one and still held by another that did not enter. The beings of a chunk
 * that entered are all placed, so only the chunks that did not enter are searched.
 */
function beingTwice(
  chunks: ReadonlyMap<string, ChunkView>,
  txn: Transaction,
): TransactionProblem | undefined {
  const placed = placedBy(txn);
  if (placed instanceof TransactionProblem) return placed;
  for (const [key, chunk] of chunks) {
    const problem = txn.entering.has(key) ? undefined : heldElsewhere(key, chunk, placed);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The chunks after `txn`, applied to the chunks of `view`, with each being in one chunk. */
function chunksAfter(
  view: ClientView,
  txn: Transaction,
): Map<string, ChunkView> | TransactionProblem {
  const chunks = appliedChunks(view, txn);
  if (chunks instanceof TransactionProblem) return chunks;
  return beingTwice(chunks, txn) ?? chunks;
}

/**
 * The followed being after `txn`, whose view is `next`. The being is the one a part of `txn` named,
 * none when a part said none; when no part said, the one `view` followed, or none after a reset.
 * Its record is the one in `next`, which moves with the view so that it is always at the view's
 * tick; when `next` does not hold it, the record a part sent, or null: the being is gone or outside
 * the view (ADR 0026).
 */
function followedAfter(view: ClientView, txn: Transaction, next: ClientView): BeingPublic | null {
  const sent = txn.followed;
  const previous = txn.reset ? null : view.followed;
  const id = sent === undefined ? previous?.id : sent?.id;
  if (id === undefined) return null;
  return findBeing(next, id) ?? sent ?? null;
}

/** The view `txn` leaves, committed by `commit`; or the problem that keeps it from applying. */
function viewAfter(
  view: ClientView,
  txn: Transaction,
  commit: CommitMessage,
): ClientView | TransactionProblem {
  const chunks = chunksAfter(view, txn);
  if (chunks instanceof TransactionProblem) return chunks;
  const next: ClientView = { tick: commit.tick, clock: commit.clock, chunks, followed: null };
  return { ...next, followed: followedAfter(view, txn, next) };
}

/** What a commit of `txn` brought besides the view. */
function committedOf(txn: Transaction, commit: CommitMessage): Committed {
  const deltas = [...txn.deltas.values()];
  return {
    txn: commit.txn,
    tick: commit.tick,
    reset: txn.reset,
    speech: deltas.flatMap(({ at, speech }) => speech.map((item) => ({ at, speech: item }))),
    speechMissed: deltas
      .filter(({ speechMissed }) => speechMissed > 0)
      .map(({ at, speechMissed }) => ({ at, count: speechMissed })),
    feed: txn.feed,
    missed: txn.missed,
  };
}

/** Applies the transaction `commit` closes, whose parts are `parts`, to `state`, which is closed. */
function applyCommit(state: Connected, parts: readonly Part[], commit: CommitMessage): Applied {
  const txn = assemble(parts);
  if (txn instanceof TransactionProblem) return flag(state, broken(txn.detail), undefined);
  // While stale, only a reset can make the view current again.
  if (state.stale && !txn.reset) return { state };
  const view = viewAfter(state.view, txn, commit);
  if (view instanceof TransactionProblem) return flag(state, broken(view.detail), undefined);
  return { state: { ...state, view, stale: false }, committed: committedOf(txn, commit) };
}

/** Closes the transaction of `message`, and applies it unless it is discarded or out of order. */
function commit(state: Connected, message: CommitMessage): Applied {
  const settled = settle(state, message.txn);
  const order = tickProblem(settled, message);
  if (order !== undefined) return flag(settled, order, openAfter(settled, message.txn));
  const closed: Connected = { ...settled, lastCommitTick: message.tick, pending: undefined };
  if (message.txn === settled.discarded) return { state: { ...closed, discarded: undefined } };
  const { pending } = settled;
  if (pending !== undefined && (pending.txn !== message.txn || pending.tick !== message.tick)) {
    const detail = `the commit of transaction ${message.txn} at tick ${message.tick} does not close the one in flight`;
    return flag(closed, broken(detail), openAfter(settled, message.txn));
  }
  return applyCommit(closed, pending?.parts ?? [], message);
}

/** Applies a message of a connection whose `seq` was already checked. */
function dispatch(state: Connected, message: Exclude<ServerMessage, HelloMessage>): Applied {
  switch (message.type) {
    case "delta":
    case "snapshot":
    case "events":
      return addPart(state, message);
    case "commit":
      return commit(state, message);
    case "abort":
      return abort(state, message.txn);
    case "notice":
      return { state: { ...state, trimmed: message.chunks } };
    case "status":
      return { state: { ...state, world: { state: message.state, reason: message.reason } } };
    default:
      // pong and error change no state: the client reads them from the message.
      return { state };
  }
}

/** Whether `state` has a connection, and so a view. */
function isConnected(state: ClientState): state is Connected {
  return state.connection !== undefined && state.view !== undefined;
}

/**
 * The state after `message`, a message the ServerMessage schema accepted, with what a commit
 * brought and the anomaly that asks for a resync, if any. A message before the first `hello` is
 * an anomaly and changes nothing. After a `seq` gap the message is still applied, the transaction
 * it cut is discarded, and the gap is the anomaly reported.
 */
export function applyMessage(state: ClientState, message: ServerMessage): Applied {
  if (message.type === "hello") return { state: greet(state, message) };
  if (!isConnected(state)) {
    return {
      state,
      anomaly: { kind: "before_hello", detail: `a ${message.type} came before hello` },
    };
  }
  const next: Connected = { ...state, expectedSeq: message.seq + 1 };
  if (message.seq === state.expectedSeq) return dispatch(next, message);
  const gap: Anomaly = {
    kind: "seq_gap",
    detail: `expected seq ${state.expectedSeq}, received ${message.seq}`,
  };
  const cut = flag(next, gap, state.pending?.txn ?? state.discarded);
  const applied = dispatch({ ...cut.state, suspect: true }, message);
  return { ...applied, anomaly: gap };
}
