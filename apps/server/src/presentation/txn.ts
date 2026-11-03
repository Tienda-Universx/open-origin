/**
 * Transactions (ADR 0026, "Interest and transactions"): how a client's view moves from its visible
 * tick `L` to `L'`, the playout tick at which the transaction starts. A transaction pins the
 * versions of `L'` for the client's effective interest and fixes its whole content at its start;
 * its parts then read only those pinned versions, so its content stays that of `L'` however many
 * periods it takes while the world moves on. Its content, in order:
 *
 * 1. `drop` of the chunks that leave the view;
 * 2. for each chunk that stays, its differences by id between the versions pinned at `L` and at
 *    `L'` (`gone`, `upsert`), shared between clients, and its local speech of `(L, L']`;
 * 3. the full content, terrain included, of the chunks that enter, or of the whole view in a reset;
 *    and the followed being's record when the client must learn it;
 * 4. the feed of `(L, L']`;
 * 5. `commit`, with the clock of `L'`.
 *
 * The client applies it whole at the commit (the protocol's reducer); the server then takes the
 * pins of `L'` as the view's own and releases those of `L`.
 *
 * The terrain of the chunks that enter is fixed by the world's genesis, so a transaction keeps only
 * its bytes, which plan its parts, and reads its text through `terrain` as each part is written. A
 * part whose terrain cannot be had in this period waits: `peek` gives nothing, and tries again at
 * the next call.
 */
import { type ChunkCoord, type Clock, chunkKey } from "@open-origin/protocol/public";
import { commitFrame, type Frame } from "./frames.ts";
import { FEED, type Mirror } from "./mirror.ts";
import {
  type DeltaContent,
  deltaParts,
  type Entering,
  eventsParts,
  type PartHead,
  snapshotParts,
  TERRAIN_PENDING,
  type TerrainPending,
  type TerrainSource,
} from "./parts.ts";
import type { RingRead } from "./ring.ts";
import type { ChunkVersion, EncodedBeing } from "./version.ts";

/** A client's view as the server knows it: what the client shows once its last commit applied. */
export class ViewState {
  /** L: the visible tick, hello's until the first commit. */
  tick: number;
  /** The tick of the last commit sent, or undefined before the first. */
  committed: number | undefined = undefined;
  /** The versions the view shows, pinned, by chunk key. */
  pinned = new Map<string, ChunkVersion>();
  /** How many items of each visible chunk's speech the view has seen, at L. */
  speechSeen = new Map<string, number>();
  /** How many items of the feed the view has seen, at L. */
  feedSeen: number;
  /** The being the client shows as followed, or null. */
  followed: number | null = null;
  /** Whether the next transaction must be a reset: at first, and after a resync or a lost view. */
  needsReset = true;

  /** The view of a new connection: empty, at `tick`, having seen the feed up to `feedSeen`. */
  constructor(tick: number, feedSeen: number) {
    this.tick = tick;
    this.feedSeen = feedSeen;
  }
}

/** What a transaction needs at its start. */
export type TransactionStart = {
  readonly txn: number;
  readonly view: ViewState;
  readonly mirror: Mirror;
  /** The client's effective interest at the playout tick, in the order its content goes out. */
  readonly interest: readonly ChunkCoord[];
  /** The being the client follows, or null. */
  readonly target: number | null;
  /** The bytes of the encoded public terrain of a chunk that enters, at hand when it starts. */
  readonly terrainBytes: (at: ChunkCoord) => number;
  /** Where the transaction reads the terrain of a chunk as it writes the chunk's first part. */
  readonly terrain: TerrainSource;
  /** The most bytes of a part. */
  readonly partBytes: number;
};

/** What the view becomes once the transaction commits. */
type After = {
  readonly tick: number;
  readonly speechSeen: Map<string, number>;
  readonly feedSeen: number;
  readonly followed: number | null;
};

/** The followed record to send, `"null"` to say none, or undefined to say nothing. */
function followedToSend(
  shown: number | null,
  target: number | null,
  reset: boolean,
  record: EncodedBeing | undefined,
): string | undefined {
  // After a reset that says nothing, the client follows nothing.
  if (reset) return target === null ? undefined : (record?.json ?? "null");
  if (target === shown) return undefined;
  if (record !== undefined) return record.json;
  // The target is gone or unknown: only a client that shows another being must hear none.
  return shown === null ? undefined : "null";
}

/**
 * The followed record this transaction sends, and the being the client shows as followed after
 * it, as the reducer computes it: the being a part named, or the one shown before; its record in
 * the view, else the record sent, else none. A followed being whose chunk the view does not show,
 * trimmed or waiting for its terrain, has its record sent, so the client keeps it.
 */
function followPlan(
  start: TransactionStart,
  reset: boolean,
  visible: ReadonlySet<string>,
): { readonly send: string | undefined; readonly followed: number | null } {
  const { view, mirror, target } = start;
  const record = target === null ? undefined : mirror.record(target);
  const unseen = record !== undefined && !inView(mirror, record.id, visible);
  const send = unseen ? record.json : followedToSend(view.followed, target, reset, record);
  // The being the client follows after the commit: the one a part named, else the one it showed.
  const shownBefore = reset ? null : view.followed;
  const named = send === undefined ? shownBefore : target;
  const id = send === "null" ? null : named;
  if (id === null) return { send, followed: null };
  return { send, followed: inView(mirror, id, visible) || send !== undefined ? id : null };
}

/** Whether the chunk that holds the being `id` is one of `visible`. */
function inView(mirror: Mirror, id: number, visible: ReadonlySet<string>): boolean {
  const at = mirror.locate(id);
  return at !== undefined && visible.has(chunkKey(at));
}

/** The differences and speech of every chunk that stays visible and has any. */
function deltasOf(
  start: TransactionStart,
  pins: ReadonlyMap<string, ChunkVersion>,
): DeltaContent[] {
  const { view, mirror } = start;
  const deltas: DeltaContent[] = [];
  for (const [key, now] of pins) {
    const old = view.pinned.get(key);
    if (old === undefined) continue;
    const { gone, upsert } = now.diffFrom(old);
    const seen = view.speechSeen.get(key) ?? mirror.speech.count(key);
    const { items, missed }: RingRead = mirror.speech.since(key, seen);
    const changed = now.v !== old.v || gone.length > 0 || upsert.length > 0;
    if (!changed && items.length === 0 && missed === 0) continue;
    deltas.push({ at: now.at, v: now.v, gone, upsert, speech: items, speechMissed: missed });
  }
  return deltas;
}

/** The content of a transaction, fixed at its start. */
type Content = {
  readonly head: PartHead;
  readonly reset: boolean;
  readonly drop: readonly ChunkCoord[];
  readonly deltas: readonly DeltaContent[];
  readonly entering: readonly Entering[];
  readonly terrain: TerrainSource;
  readonly followed: string | undefined;
  readonly feed: RingRead;
  readonly clock: Clock;
  readonly partBytes: number;
};

/** The frames of `content`, in the protocol's order, ending with its commit. */
function* framesOf(content: Content): Generator<Frame | TerrainPending> {
  const { head, reset, drop, deltas, entering, terrain, followed, feed, partBytes } = content;
  if (drop.length > 0 || deltas.length > 0) yield* deltaParts(head, drop, deltas, partBytes);
  if (reset || entering.length > 0 || followed !== undefined) {
    yield* snapshotParts(head, { reset, chunks: entering, followed, terrain }, partBytes);
  }
  if (feed.items.length > 0 || feed.missed > 0) {
    yield* eventsParts(head, feed.items, feed.missed, partBytes);
  }
  yield commitFrame(head.txn, content.clock);
}

/** One transaction of one client, from its start to its commit or abort. */
export class Transaction {
  readonly txn: number;
  /** L': the playout tick at its start. */
  readonly tick: number;
  readonly reset: boolean;
  /** The versions of L' it reads, pinned, by chunk key: the client's view once it commits. */
  readonly pins: ReadonlyMap<string, ChunkVersion>;
  readonly #after: After;
  readonly #frames: Iterator<Frame | TerrainPending>;
  #next: IteratorResult<Frame | TerrainPending>;

  private constructor(start: TransactionStart, pins: ReadonlyMap<string, ChunkVersion>) {
    const { view, mirror } = start;
    const visible = new Set(pins.keys());
    this.txn = start.txn;
    this.tick = mirror.tick;
    this.reset = view.needsReset;
    this.pins = pins;
    const follow = followPlan(start, this.reset, visible);
    const shown = this.reset ? [] : [...view.pinned.values()];
    this.#frames = framesOf({
      head: { tick: this.tick, txn: this.txn },
      reset: this.reset,
      drop: shown.filter(({ key }) => !visible.has(key)).map(({ at }) => at),
      deltas: this.reset ? [] : deltasOf(start, pins),
      entering: [...pins.values()]
        .filter(({ key }) => this.reset || !view.pinned.has(key))
        .map((version) => ({ version, terrainBytes: start.terrainBytes(version.at) })),
      terrain: start.terrain,
      followed: follow.send,
      feed: mirror.feed.since(FEED, view.feedSeen),
      clock: mirror.clock,
      partBytes: start.partBytes,
    });
    const speechSeen = new Map([...visible].map((key) => [key, mirror.speech.count(key)]));
    const feedSeen = mirror.feed.count(FEED);
    this.#after = { tick: this.tick, speechSeen, feedSeen, followed: follow.followed };
    this.#next = this.#frames.next();
  }

  /**
   * Starts a transaction: pins the versions of the playout tick for the client's interest, and
   * fixes its whole content. A reset consumes the view's need for one.
   */
  static start(start: TransactionStart): Transaction {
    const pins = new Map<string, ChunkVersion>();
    try {
      for (const at of start.interest) {
        const version = start.mirror.current(at);
        start.mirror.pin(version);
        pins.set(version.key, version);
      }
      const transaction = new Transaction(start, pins);
      start.view.needsReset = false;
      return transaction;
    } catch (cause) {
      // Its versions or its content could not be fixed: nothing it pinned stays pinned.
      for (const version of pins.values()) start.mirror.unpin(version);
      throw cause;
    }
  }

  /**
   * The next frame to send; undefined once the commit went out, or while the terrain of the next
   * part cannot be had in this period. A part that waited for terrain tries again first.
   */
  peek(): Frame | undefined {
    if (this.#next.done !== true && this.#next.value === TERRAIN_PENDING) {
      this.#next = this.#frames.next();
    }
    const next = this.#next;
    return next.done === true || next.value === TERRAIN_PENDING ? undefined : next.value;
  }

  /** Moves past the frame `peek` gave, which was sent. */
  advance(): void {
    this.#next = this.#frames.next();
  }

  /** The commit was sent: `view` becomes this transaction's, and the pins of L are released. */
  commit(view: ViewState, mirror: Mirror): void {
    for (const version of view.pinned.values()) mirror.unpin(version);
    view.pinned = new Map(this.pins);
    view.tick = this.tick;
    view.committed = this.tick;
    view.speechSeen = this.#after.speechSeen;
    view.feedSeen = this.#after.feedSeen;
    view.followed = this.#after.followed;
  }

  /** Releases the pins of a transaction that will not commit. */
  release(mirror: Mirror): void {
    for (const version of this.pins.values()) mirror.unpin(version);
  }
}
