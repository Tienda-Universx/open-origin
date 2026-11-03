/**
 * The presentation plane (ADR 0025, "Planes and the boundary" and "Playout"; ADR 0026, "Interest
 * and transactions"). It receives from the world plane two functions only: a subscription that
 * delivers the boot record and then each published tick, deep-frozen C0 records, and `readTerrain`.
 * Nothing it holds reaches the world. It has no network either: the transport of T6-7 drives it,
 * with a sink per client, through `connect`, `subscribe`, `follow`, `resync`, and `close`.
 *
 * Each period, in a task of its own and never inside a step's callback, the playout hands the
 * mirror at most one published tick, and the fan-out serves every client that is not lagging: its
 * pending messages, then the parts of its transaction, up to a byte budget per client and period.
 * A client's transaction starts only after its previous one committed, and only once the playout
 * tick passed that commit's, so a client that is up to date gets one commit per period. Every
 * connection's first transaction is a reset. A throw while serving one client drops that client
 * alone, and the period goes on with the others; any other throw of a period, from the playout,
 * the mirror, or a drop, is a fault of the whole plane: the presentation stops and detaches, and
 * the throw goes on.
 */
import { type ChunkCoord, MAX_PART_BYTES, type TerrainPublic } from "@open-origin/protocol/public";
import type { PublishedListener } from "../world/published.ts";
import {
  abortFrame,
  type Frame,
  frameBytes,
  frameText,
  helloFrame,
  type WorldInfo,
} from "./frames.ts";
import { type ClientId, Interest } from "./interest.ts";
import { FEED, Mirror } from "./mirror.ts";
import { Playout } from "./playout.ts";
import { TerrainCache } from "./terrain.ts";
import { Transaction, ViewState } from "./txn.ts";

/** Where a client's messages go: the transport's socket, or a test's recorder. */
export interface ClientSink {
  /** Sends one text frame. */
  send(frame: string): void;
  /** Whether the client's buffer is full: it gets nothing this period (T6-6b measures it). */
  lagging(): boolean;
  /**
   * Ends the connection: serving the client threw `cause`, and the presentation already dropped
   * it, so it must not be closed again. Called once; it must not throw.
   */
  end(cause: unknown): void;
}

/** A monotonic clock, in whole microseconds. */
export interface PeriodClock {
  now(): number;
}

/** One-shot timers, whose callbacks run in a task of their own; returns the function that cancels. */
export interface PeriodTimer {
  schedule(delayMicros: number, callback: () => void): () => void;
}

/** The per-period budget of one client, 256 KiB (ADR 0026, "Limits and backpressure"). */
export const PERIOD_BYTES = 256 * 1024;

/** The smallest part the presentation makes: the widest terrain, 12,401 bytes, fits in one. */
export const MIN_PART_BYTES = 16 * 1024;

export type PresentationOptions = {
  /** The world plane's subscription: the boot record first, then each published tick. */
  readonly subscribeToPublished: (listener: PublishedListener) => () => void;
  /** The public terrain of a chunk. */
  readonly readTerrain: (chunk: ChunkCoord) => TerrainPublic;
  readonly clock: PeriodClock;
  readonly timer: PeriodTimer;
  /** The world's rate, whose period is the presentation's. */
  readonly tickRateHz: number;
  /** F: the ticks of a publication batch, which the playout releases one by one. */
  readonly batchTicks: number;
  /** What hello says of the world. */
  readonly world: WorldInfo;
  /** The most bytes a client gets per period, every message counted: PERIOD_BYTES unless given. */
  readonly periodBytes?: number;
  /** The most bytes of a part: MAX_PART_BYTES unless given. */
  readonly partBytes?: number;
};

/** A connected client: its sink, its view, its order, and its transaction in flight. */
type Client = {
  readonly id: ClientId;
  readonly sink: ClientSink;
  readonly view: ViewState;
  /** The `seq` of its next message. */
  seq: number;
  /** The id of its next transaction. */
  nextTxn: number;
  /** The period of its last commit: no transaction starts in it, so none commits twice in one. */
  committedIn: number;
  /** Messages that go before any part: hello, and aborts. */
  readonly outbox: Frame[];
  txn: Transaction | undefined;
};

/** What the presentation holds, for tests and for the limits of T6-6b. */
export type PresentationUsage = {
  readonly clients: number;
  /** Clients whose interest is tracked, chunk entries in the inverted index, and followings. */
  readonly interest: {
    readonly clients: number;
    readonly indexEntries: number;
    readonly following: number;
  };
  readonly pins: number;
  readonly retainedBytes: number;
  /** Clients dropped because serving them threw (C3). */
  readonly faults: number;
  /** Whether a fault of the whole plane stopped the presentation (C3). */
  readonly failed: boolean;
};

const MICROS_PER_SECOND = 1_000_000;

/** Checks the sizes of `options`: a part holds the widest terrain, and a period holds a part. */
function sizesOf(options: PresentationOptions): { readonly part: number; readonly period: number } {
  const part = options.partBytes ?? MAX_PART_BYTES;
  const period = options.periodBytes ?? PERIOD_BYTES;
  if (!Number.isSafeInteger(part) || part < MIN_PART_BYTES || part > MAX_PART_BYTES) {
    throw new RangeError(
      `a part holds from ${MIN_PART_BYTES} to ${MAX_PART_BYTES} bytes, not ${part}`,
    );
  }
  if (!Number.isSafeInteger(period) || period < part) {
    throw new RangeError(`a period's budget of ${period} bytes cannot hold a part of ${part}`);
  }
  return { part, period };
}

/** The presentation plane: playout, mirror, interest, and each client's transactions. */
export class Presentation {
  readonly #mirror = new Mirror();
  readonly #interest = new Interest();
  readonly #clients = new Map<ClientId, Client>();
  readonly #playout: Playout;
  readonly #terrain: TerrainCache;
  readonly #world: WorldInfo;
  readonly #partBytes: number;
  readonly #periodBytes: number;
  readonly #clock: PeriodClock;
  readonly #timer: PeriodTimer;
  readonly #hz: number;
  #nextClient = 1;
  /** How many periods ran. */
  #period = 0;
  #running = false;
  /** Whether `stop` ran: a stopped presentation is detached from the world plane for good. */
  #stopped = false;
  #cancel: (() => void) | undefined;
  readonly #unsubscribe: () => void;
  #faults = 0;
  #failed = false;
  #anchor = 0;
  #periods = 0;

  /**
   * Subscribes to the world plane, whose boot record builds the mirror at once. Without a boot
   * record applied, it unsubscribes and throws: a presentation that was not built leaves no listener.
   */
  constructor(options: PresentationOptions) {
    const sizes = sizesOf(options);
    const hz = options.tickRateHz;
    if (!Number.isSafeInteger(hz) || hz < 1 || hz > 1000) {
      throw new RangeError(`the tick rate is an integer from 1 to 1000 Hz, not ${hz}`);
    }
    this.#partBytes = sizes.part;
    this.#periodBytes = sizes.period;
    this.#playout = new Playout(options.batchTicks);
    this.#terrain = new TerrainCache(options.readTerrain);
    this.#world = options.world;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#hz = hz;
    let booted = false;
    this.#unsubscribe = options.subscribeToPublished((published) => {
      if (booted) this.#playout.push(published);
      else this.#mirror.apply(published);
      booted = true;
    });
    if (!booted) {
      // The world plane counts a listener's throw and may keep the listener: remove it here.
      this.#unsubscribe();
      throw new Error("the world plane gave the presentation no boot record");
    }
  }

  /** The playout tick: the tick of the world the mirror holds. */
  get tick(): number {
    return this.#mirror.tick;
  }

  /** Connects a client whose messages go to `sink`: its first message, hello, goes next period. */
  connect(sink: ClientSink): ClientId {
    const id = this.#nextClient;
    this.#nextClient += 1;
    const mirror = this.#mirror;
    const hello = helloFrame(this.#world, mirror.clock, "running");
    const view = new ViewState(mirror.tick, mirror.feed.count(FEED));
    const outbox = [hello];
    this.#clients.set(id, {
      id,
      sink,
      view,
      seq: 0,
      nextTxn: 0,
      committedIn: -1,
      outbox,
      txn: undefined,
    });
    this.#interest.add(id);
    return id;
  }

  /** Replaces the camera of `client`; its next transaction shows it. */
  subscribe(client: ClientId, chunks: readonly ChunkCoord[]): void {
    this.#client(client);
    this.#interest.subscribe(client, chunks);
  }

  /** Makes `client` follow `being`, or nothing for null; its next transaction shows it. */
  follow(client: ClientId, being: number | null): void {
    this.#client(client);
    this.#interest.follow(client, being);
    this.#interest.moveWindow(client, being === null ? undefined : this.#mirror.locate(being));
  }

  /** The client asked for a resync: its next transaction is a reset. */
  resync(client: ClientId): void {
    this.#client(client).view.needsReset = true;
  }

  /**
   * Cancels the transaction in flight of `client`, if any, which gets `abort` before anything else
   * and whose pins are released. With `releaseView`, the view's own pins go too, and its next
   * transaction is a reset (the memory guard of T6-6b).
   */
  abort(client: ClientId, options: { readonly releaseView?: boolean } = {}): void {
    const connected = this.#client(client);
    const { txn } = connected;
    if (txn !== undefined) {
      txn.release(this.#mirror);
      connected.txn = undefined;
      connected.outbox.push(abortFrame(txn.txn, txn.tick));
      if (txn.reset) connected.view.needsReset = true;
    }
    if (options.releaseView === true) this.#releaseView(connected.view);
  }

  /** Disconnects `client`: its interest, its index entries, its pins, and its transaction go. */
  close(client: ClientId): void {
    this.#remove(this.#client(client));
  }

  /** How many clients follow `being`: observation telemetry (C3), which the world cannot read. */
  followers(being: number): number {
    return this.#interest.followers(being);
  }

  usage(): PresentationUsage {
    const mirror = this.#mirror;
    return {
      clients: this.#clients.size,
      interest: this.#interest.usage(),
      pins: mirror.pins,
      retainedBytes: mirror.retainedBytes,
      faults: this.#faults,
      failed: this.#failed,
    };
  }

  /**
   * One period: the playout's release, then the fan-out to every client. A throw that is not one
   * client's is a fault of the whole plane, whose state may be inconsistent: the presentation stops
   * and detaches, `failed` turns true, and the throw goes on.
   */
  period(): void {
    this.#period += 1;
    try {
      this.#playout.release((published) => this.#mirror.apply(published));
      // Deleting the entry being visited, as a fault does, leaves a Map's iteration well defined.
      for (const client of this.#clients.values()) this.#serveIsolated(client);
    } catch (cause) {
      this.#failed = true;
      this.stop();
      throw cause;
    }
  }

  /** Runs a period every 1/tickRateHz seconds, each in a timer task of its own, from a period now. */
  start(): void {
    if (this.#stopped) throw new Error("a stopped presentation cannot start again");
    if (this.#running) return;
    this.#running = true;
    this.#anchor = this.#clock.now();
    this.#periods = 0;
    this.#arm();
  }

  /**
   * Stops the periods and detaches from the world plane for good: a stopped presentation receives
   * no published tick, so nothing grows its playout, and it cannot start again.
   */
  stop(): void {
    this.#running = false;
    this.#cancel?.();
    this.#cancel = undefined;
    if (!this.#stopped) this.#unsubscribe();
    this.#stopped = true;
  }

  #client(id: ClientId): Client {
    const client = this.#clients.get(id);
    if (client === undefined) throw new Error(`client ${id} is not connected`);
    return client;
  }

  /** Removes `client` with everything it holds: interest, index entries, pins, and transaction. */
  #remove(client: Client): void {
    client.txn?.release(this.#mirror);
    this.#releaseView(client.view);
    this.#interest.remove(client.id);
    this.#clients.delete(client.id);
  }

  /** Serves `client`: a throw drops it alone, and a throw of the drop itself reaches the plane. */
  #serveIsolated(client: Client): void {
    try {
      this.#serve(client);
    } catch (cause) {
      this.#fault(client, cause);
    }
  }

  /** Serving `client` threw `cause`: it is dropped and counted, and its transport told to end it. */
  #fault(client: Client, cause: unknown): void {
    this.#faults += 1;
    this.#remove(client);
    client.sink.end(cause);
  }

  #releaseView(view: ViewState): void {
    for (const version of view.pinned.values()) this.#mirror.unpin(version);
    view.pinned = new Map();
    view.speechSeen = new Map();
    view.needsReset = true;
  }

  /** Sends `client` what fits in its budget this period, unless it is lagging. */
  #serve(client: Client): void {
    if (client.sink.lagging()) return;
    let left = this.#periodBytes;
    for (let frame = this.#next(client); frame !== undefined; frame = this.#next(client)) {
      const bytes = frameBytes(frame, client.seq);
      if (bytes > left) return;
      client.sink.send(frameText(frame, client.seq));
      client.seq += 1;
      left -= bytes;
      this.#sent(client, frame);
    }
  }

  /** The next message of `client`: a pending one, a part, or the first of a new transaction. */
  #next(client: Client): Frame | undefined {
    const pending = client.outbox[0];
    if (pending !== undefined) return pending;
    if (client.txn === undefined && this.#mayStart(client)) client.txn = this.#start(client);
    return client.txn?.peek();
  }

  /**
   * Whether a transaction of `client` may start: not in the period its last one committed, and
   * once the playout tick passed that commit's, or, for its first, reached hello's. A transaction
   * then starts only before anything but hello or an abort went out in its period: its first part
   * goes out in that period whenever the budget holds a part and those.
   */
  #mayStart(client: Client): boolean {
    if (client.committedIn === this.#period) return false;
    const { view } = client;
    const tick = this.#mirror.tick;
    return view.committed === undefined ? tick >= view.tick : tick > view.committed;
  }

  #start(client: Client): Transaction {
    const target = this.#interest.target(client.id);
    // The follow window moves with the followed being, to its chunk at the playout tick.
    this.#interest.moveWindow(client.id, target === null ? undefined : this.#mirror.locate(target));
    const txn = client.nextTxn;
    client.nextTxn += 1;
    return Transaction.start({
      txn,
      view: client.view,
      mirror: this.#mirror,
      interest: this.#interest.effective(client.id),
      target,
      terrain: (at) => this.#terrain.of(at),
      partBytes: this.#partBytes,
    });
  }

  /** `frame` went out: the outbox or the transaction moves on, and a commit applies. */
  #sent(client: Client, frame: Frame): void {
    if (client.outbox[0] === frame) {
      client.outbox.shift();
      return;
    }
    const { txn } = client;
    txn?.advance();
    if (txn === undefined || frame.type !== "commit") return;
    txn.commit(client.view, this.#mirror);
    client.txn = undefined;
    client.committedIn = this.#period;
  }

  /** The deadline of the period `n` after the anchor. */
  #deadline(n: number): number {
    return this.#anchor + Math.floor((n * MICROS_PER_SECOND) / this.#hz);
  }

  /** Sets the timer of the next period; a period that ran late resets the schedule: no burst. */
  #arm(): void {
    if (!this.#running) return;
    const now = this.#clock.now();
    if (this.#deadline(this.#periods + 1) < now) {
      this.#anchor = now;
      this.#periods = 0;
    }
    this.#cancel = this.#timer.schedule(this.#deadline(this.#periods + 1) - now, () => {
      this.#cancel = undefined;
      this.#periods += 1;
      this.period();
      this.#arm();
    });
  }
}
