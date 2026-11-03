/**
 * The presentation plane (ADR 0025, "Planes and the boundary" and "Playout"; ADR 0026, "Interest
 * and transactions" and "Limits and backpressure"). It receives from the world plane three
 * functions only: a subscription that delivers the boot record and then each published tick,
 * deep-frozen C0 records; `readTerrain`; and the world's state. Nothing it holds reaches the world.
 * It has no network either: the transport of T6-7 drives it, with a sink per client, through
 * `connect`, `subscribe`, `follow`, `resync`, `drained`, and `close`.
 *
 * Each period, in a task of its own and never inside a step's callback, the playout hands the
 * mirror at most one published tick; a change of the world's state is announced to every client;
 * and the fan-out serves the clients in rotating order within its budget of time: each one's
 * pending messages, then the parts of its transaction, within its budget of bytes and while its
 * buffer has room.
 *
 * A client's transaction starts only after its previous one committed, and only once the playout
 * tick passed that commit's, so a client that is up to date gets one commit per period. Every
 * connection's first transaction is a reset. A throw while serving one client drops that client
 * alone; any other throw of a period, from the playout, the mirror, or a drop, is a fault of the
 * whole plane: the presentation stops and detaches, and the throw goes on.
 */
import { type ChunkCoord, MAX_PART_BYTES, type TerrainPublic } from "@open-origin/protocol/public";
import type { PublishedListener } from "../world/published.ts";
import { type Blocked, BUFFER_BYTES, Client, type ClientSink } from "./client.ts";
import { abortFrame, helloFrame, statusFrame, type WorldInfo, type WorldState } from "./frames.ts";
import { type ClientId, Interest } from "./interest.ts";
import { FEED, Mirror } from "./mirror.ts";
import { Playout } from "./playout.ts";
import { noCounts, type PresentationTelemetry } from "./telemetry.ts";
import { TerrainCache } from "./terrain.ts";
import { Transaction, ViewState } from "./txn.ts";

export type { ClientSink, Ending } from "./client.ts";

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

/** The fan-out's budget of time per period, across all clients: 40 ms. */
export const FAN_OUT_MICROS = 40_000;

export type PresentationOptions = {
  /** The world plane's subscription: the boot record first, then each published tick. */
  readonly subscribeToPublished: (listener: PublishedListener) => () => void;
  /** The public terrain of a chunk. */
  readonly readTerrain: (chunk: ChunkCoord) => TerrainPublic;
  /** The world's state now, which hello and `status` announce. */
  readonly worldState: () => WorldState;
  readonly clock: PeriodClock;
  readonly timer: PeriodTimer;
  /** The world's rate, whose period is the presentation's. */
  readonly tickRateHz: number;
  /** F: the ticks of a publication batch, which the playout releases one by one. */
  readonly batchTicks: number;
  /** What hello says of the world. */
  readonly world: WorldInfo;
  /** Receives how long each period's fan-out took, in microseconds (C3). */
  readonly recordFanOut?: (micros: number) => void;
  /** The most bytes a client gets per period, every message counted: PERIOD_BYTES unless given. */
  readonly periodBytes?: number;
  /** The most bytes of a part: MAX_PART_BYTES unless given. */
  readonly partBytes?: number;
};

/** What the presentation holds, for tests: each count is zero once every client is gone. */
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

/** The sizes the presentation works with, checked. */
type Sizes = { readonly part: number; readonly period: number };

const MICROS_PER_SECOND = 1_000_000;

/** Checks the sizes of `options`: a part holds the widest terrain, and a period holds a part. */
function sizesOf(options: PresentationOptions): Sizes {
  const part = options.partBytes ?? MAX_PART_BYTES;
  if (!Number.isSafeInteger(part) || part < MIN_PART_BYTES || part > MAX_PART_BYTES) {
    throw new RangeError(
      `a part holds from ${MIN_PART_BYTES} to ${MAX_PART_BYTES} bytes, not ${part}`,
    );
  }
  const period = options.periodBytes ?? PERIOD_BYTES;
  if (!Number.isSafeInteger(period) || period < part) {
    throw new RangeError(`a period's budget of ${period} bytes cannot hold a part of ${part}`);
  }
  return { part, period };
}

/** The index in `clients`, in the order they connected, of the first whose id is at least `id`. */
function startOf(clients: readonly Client[], id: ClientId | undefined): number {
  if (id === undefined) return 0;
  return Math.max(
    0,
    clients.findIndex((client) => client.id >= id),
  );
}

/** The presentation plane: playout, mirror, interest, and each client's transactions. */
export class Presentation {
  readonly #mirror = new Mirror();
  readonly #interest = new Interest();
  readonly #clients = new Map<ClientId, Client>();
  readonly #playout: Playout;
  readonly #terrain: TerrainCache;
  readonly #world: WorldInfo;
  readonly #sizes: Sizes;
  readonly #clock: PeriodClock;
  readonly #timer: PeriodTimer;
  readonly #hz: number;
  readonly #worldState: () => WorldState;
  readonly #recordFanOut: ((micros: number) => void) | undefined;
  readonly #counts = noCounts();
  #state: WorldState;
  #nextClient = 1;
  /** How many periods ran. */
  #period = 0;
  /** The client the next fan-out serves first: the first one the last could not serve. */
  #cursor: ClientId | undefined;
  /** The clients whose full buffer stopped the last fan-out, and those of the fan-out running. */
  #laggingClients = 0;
  #lagging = 0;
  #running = false;
  /** Whether `stop` ran: a stopped presentation is detached from the world plane for good. */
  #stopped = false;
  #cancel: (() => void) | undefined;
  readonly #unsubscribe: () => void;
  #failed = false;
  #anchor = 0;
  #periods = 0;

  /**
   * Subscribes to the world plane, whose boot record builds the mirror at once. Without a boot
   * record applied, it unsubscribes and throws: a presentation that was not built leaves no listener.
   */
  constructor(options: PresentationOptions) {
    this.#sizes = sizesOf(options);
    const hz = options.tickRateHz;
    if (!Number.isSafeInteger(hz) || hz < 1 || hz > 1000) {
      throw new RangeError(`the tick rate is an integer from 1 to 1000 Hz, not ${hz}`);
    }
    this.#playout = new Playout(options.batchTicks);
    this.#terrain = new TerrainCache(options.readTerrain);
    this.#world = options.world;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#hz = hz;
    this.#worldState = options.worldState;
    this.#recordFanOut = options.recordFanOut;
    this.#state = options.worldState();
    this.#unsubscribe = this.#attach(options.subscribeToPublished);
  }

  /** The playout tick: the tick of the world the mirror holds. */
  get tick(): number {
    return this.#mirror.tick;
  }

  /** Connects a client whose messages go to `sink`: its first message, hello, goes first. */
  connect(sink: ClientSink): ClientId {
    const id = this.#nextClient;
    this.#nextClient += 1;
    const mirror = this.#mirror;
    const view = new ViewState(mirror.tick, mirror.feed.count(FEED));
    const client = new Client(id, sink, view);
    client.queue(helloFrame(this.#world, mirror.clock, this.#state));
    this.#clients.set(id, client);
    this.#interest.add(id);
    return id;
  }

  /** The client's buffer drained: what waits of its messages and its transaction goes on. */
  drained(client: ClientId): void {
    const connected = this.#client(client);
    try {
      this.#flush(connected, false);
    } catch (cause) {
      this.#fault(connected, cause);
    }
  }

  /** Replaces the camera of `client`, already checked; its next transaction shows it. */
  subscribe(client: ClientId, chunks: readonly ChunkCoord[]): void {
    this.#client(client);
    this.#interest.subscribe(client, chunks);
  }

  /** Makes `client` follow `being`, or nothing for null; its next transaction shows it. */
  follow(client: ClientId, being: number | null): void {
    this.#follow(this.#client(client), being);
  }

  /** The client asked for a resync: its next transaction is a reset. */
  resync(client: ClientId): void {
    this.#client(client).view.needsReset = true;
  }

  /**
   * Cancels the transaction in flight of `client`, if any, which gets `abort` before anything else
   * and whose pins are released. With `releaseView`, the view's own pins go too, and its next
   * transaction is a reset.
   */
  abort(client: ClientId, options: { readonly releaseView?: boolean } = {}): void {
    this.#abort(this.#client(client), options.releaseView === true);
  }

  /** Disconnects `client`: its interest, index entries, pins, and transaction go. */
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
      faults: this.#counts.faults,
      failed: this.#failed,
    };
  }

  /** The presentation's telemetry (C3), for the admin status. */
  telemetry(): PresentationTelemetry {
    return {
      ...this.#counts,
      connections: this.#clients.size,
      laggingClients: this.#laggingClients,
    };
  }

  /**
   * One period: the playout's release, the world's state, and the fan-out. A throw that is not
   * one client's is a fault of the whole plane, whose state may be inconsistent: the presentation
   * stops and detaches, `failed` turns true, and the throw goes on.
   */
  period(): void {
    this.#period += 1;
    try {
      this.#playout.release((published) => this.#mirror.apply(published));
      this.#announce();
      this.#fanOut();
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

  /** Subscribes the mirror and the playout; throws, unsubscribed, without a boot record. */
  #attach(subscribe: PresentationOptions["subscribeToPublished"]): () => void {
    let booted = false;
    const unsubscribe = subscribe((published) => {
      if (booted) this.#playout.push(published);
      else this.#mirror.apply(published);
      booted = true;
    });
    if (!booted) {
      // The world plane counts a listener's throw and may keep the listener: remove it here.
      unsubscribe();
      throw new Error("the world plane gave the presentation no boot record");
    }
    return unsubscribe;
  }

  #client(id: ClientId): Client {
    const client = this.#clients.get(id);
    if (client === undefined) throw new Error(`client ${id} is not connected`);
    return client;
  }

  /** Removes `client` and all it holds: interest, index entries, pins, and transaction. */
  #remove(client: Client): void {
    client.txn?.release(this.#mirror);
    client.txn = undefined;
    this.#releaseView(client.view);
    this.#interest.remove(client.id);
    this.#clients.delete(client.id);
  }

  /** Serving `client` threw `cause`: it is dropped and counted, and its transport told to end it. */
  #fault(client: Client, cause: unknown): void {
    this.#remove(client);
    this.#counts.faults += 1;
    client.sink.end({ reason: "fault", cause });
  }

  #releaseView(view: ViewState): void {
    for (const version of view.pinned.values()) this.#mirror.unpin(version);
    view.pinned = new Map();
    view.speechSeen = new Map();
    view.needsReset = true;
  }

  /** Cancels the transaction of `client`, which hears it first; `releaseView` drops its view too. */
  #abort(client: Client, releaseView: boolean): void {
    const { txn } = client;
    if (txn !== undefined) {
      txn.release(this.#mirror);
      client.txn = undefined;
      client.queue(abortFrame(txn.txn, txn.tick));
      if (txn.reset) client.view.needsReset = true;
    }
    if (releaseView) this.#releaseView(client.view);
  }

  #follow(client: Client, being: number | null): void {
    this.#interest.follow(client.id, being);
    const center = being === null ? undefined : this.#mirror.locate(being);
    this.#interest.moveWindow(client.id, center);
  }

  /** The world's state changed: every client is told, at its visible tick. */
  #announce(): void {
    const state = this.#worldState();
    if (state === this.#state) return;
    this.#state = state;
    for (const client of this.#clients.values()) {
      client.queue(statusFrame(client.view.tick, state), "status");
    }
  }

  /**
   * Serves the clients in turn, from the first the last fan-out could not serve, while the period's
   * budget of time lasts: the client whose turn comes once it is spent waits for the next period,
   * and goes first then. The first client is always served.
   */
  #fanOut(): void {
    const clients = [...this.#clients.values()];
    const first = startOf(clients, this.#cursor);
    const started = this.#clock.now();
    this.#cursor = undefined;
    this.#lagging = 0;
    for (let turn = 0; turn < clients.length; turn += 1) {
      const client = clients[(first + turn) % clients.length];
      if (client === undefined) continue;
      if (turn > 0 && this.#clock.now() - started >= FAN_OUT_MICROS) {
        this.#cursor = client.id;
        break;
      }
      // A client the period already dropped is not served.
      if (this.#clients.get(client.id) === client) this.#serveIsolated(client);
    }
    this.#laggingClients = this.#lagging;
    this.#recordFanOut?.(this.#clock.now() - started);
  }

  /** Serves `client`: a throw drops it alone, and a throw of the drop itself reaches the plane. */
  #serveIsolated(client: Client): void {
    try {
      this.#serve(client);
    } catch (cause) {
      this.#fault(client, cause);
    }
  }

  /**
   * Sends `client` what fits this period, unless its buffer is full. While the world is stopped,
   * a client that got nothing else this period gets its state: the heartbeat no commit gives.
   */
  #serve(client: Client): void {
    let blocked: Blocked | undefined = "lagging";
    if (client.sink.buffered() < BUFFER_BYTES) blocked = this.#flush(client, true);
    if (blocked === undefined && this.#state !== "running" && !client.sentIn(this.#period)) {
      client.queue(statusFrame(client.view.tick, this.#state), "status");
      blocked = this.#flush(client, false);
    }
    if (blocked === "lagging") this.#lagging += 1;
  }

  /**
   * Sends `client` its next messages while its budget and buffer hold them, and, when `mayStart`,
   * starts its next transaction once nothing else waits; returns what stopped it, if anything did.
   */
  #flush(client: Client, mayStart: boolean): Blocked | undefined {
    for (;;) {
      if (mayStart && this.#mayStart(client)) this.#begin(client);
      const frame = client.next();
      if (frame === undefined) return undefined;
      const blocked = client.send(frame, this.#period, this.#sizes.period);
      if (blocked !== undefined) return blocked;
      client.sent(frame, this.#mirror, this.#period);
    }
  }

  /**
   * Whether a transaction of `client` may start: none is in flight and no message waits; it did
   * not commit in this period; its buffer has room; and the playout tick passed its last commit's,
   * or, for its first, reached hello's.
   */
  #mayStart(client: Client): boolean {
    if (client.txn !== undefined || client.waiting > 0) return false;
    if (client.committedIn === this.#period) return false;
    if (client.sink.buffered() >= BUFFER_BYTES) return false;
    const { view } = client;
    const tick = this.#mirror.tick;
    return view.committed === undefined ? tick >= view.tick : tick > view.committed;
  }

  /** Starts the next transaction of `client`, at the playout tick, over its effective interest. */
  #begin(client: Client): void {
    const target = this.#interest.target(client.id);
    // The follow window moves with the followed being, to its chunk at the playout tick.
    const center = target === null ? undefined : this.#mirror.locate(target);
    this.#interest.moveWindow(client.id, center);
    client.txn = Transaction.start({
      txn: client.nextTxn,
      view: client.view,
      mirror: this.#mirror,
      interest: this.#interest.effective(client.id),
      target,
      terrain: (at) => this.#terrain.of(at),
      partBytes: this.#sizes.part,
    });
    client.nextTxn += 1;
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
