/**
 * The presentation plane (ADR 0025, "Planes and the boundary" and "Playout"; ADR 0026, "Interest
 * and transactions" and "Limits and backpressure"). It receives from the world plane three
 * functions only: a subscription that delivers the boot record and then each published tick,
 * deep-frozen C0 records; `readTerrain`; and the world's state. Nothing it holds reaches the world.
 * It has no network either: the transport of T6-7 drives it, with a sink per client, through
 * `connect`, `receive` (one raw text message of a client), `drained`, and `close`.
 *
 * Each period, in a task of its own and never inside a step's callback, the playout hands the
 * mirror at most one published tick; a change of the world's state is announced to every client;
 * the terrain queue serves the chunks transactions in flight missed, within their share, then its
 * head; the fan-out serves the clients in rotating order within its budget of time: each one's
 * pending messages, then the parts of its transaction, within its budget of bytes and while its
 * buffer has room, and its state when it got nothing else; what is left of the terrain budget goes
 * to the transactions and clients that wait for terrain; and the memory guard aborts the clients
 * that pin the oldest retained versions while they pass their limit.
 *
 * A client's transaction starts only after its previous one committed, and only once the playout
 * tick passed that commit's, so a client that is up to date gets one commit per period. Every
 * connection's first transaction is a reset. A throw while serving one client drops that client
 * alone; any other throw of a period, from the playout, the mirror, or a drop, is a fault of the
 * whole plane: the presentation stops and detaches, and the throw goes on.
 */
import {
  type ChunkCoord,
  CLIENT_LIMITS,
  type ClientMessage,
  chunkKey,
  type ErrorCode,
  MAX_PART_BYTES,
  parseClientMessage,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import type { PublishedListener } from "../world/published.ts";
import {
  ABORTS_TO_CLOSE,
  type Blocked,
  BUFFER_BYTES,
  Client,
  type ClientSink,
  type Ending,
  STRIKES_ENDING,
  TOO_SLOW_ENDING,
} from "./client.ts";
import {
  abortFrame,
  errorFrame,
  helloFrame,
  type Limits,
  noticeFrame,
  pongFrame,
  statusFrame,
  type WorldInfo,
  type WorldState,
} from "./frames.ts";
import { type ClientId, Interest } from "./interest.ts";
import { FEED, Mirror } from "./mirror.ts";
import type { EncodedText } from "./parts.ts";
import { Playout } from "./playout.ts";
import { guardRetention, RETAINED_BYTES } from "./retention.ts";
import { noCounts, type PresentationTelemetry } from "./telemetry.ts";
import { TERRAIN_ENTRIES, TERRAIN_PER_PERIOD, TerrainCache, TerrainQueue } from "./terrain.ts";
import { Transaction, ViewState } from "./txn.ts";
import { trimView, VIEW_BYTES } from "./view.ts";

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
  /** The most bytes of replaced versions pinned in all: RETAINED_BYTES unless given. */
  readonly retainedBytes?: number;
  /** Receives how long each period's fan-out took, in microseconds (C3). */
  readonly recordFanOut?: (micros: number) => void;
  /** The most bytes a client gets per period, every message counted: PERIOD_BYTES unless given. */
  readonly periodBytes?: number;
  /** The most bytes of a part: MAX_PART_BYTES unless given. */
  readonly partBytes?: number;
  /** The most bytes of a view: VIEW_BYTES unless given, which hello then announces. */
  readonly viewBytes?: number;
  /**
   * The most chunks of terrain generated per period, at least 2 (one for the lane, at least one for
   * the head of the terrain queue): TERRAIN_PER_PERIOD unless given.
   */
  readonly terrainPerPeriod?: number;
  /** The entries of the terrain's LRU: TERRAIN_ENTRIES unless given. */
  readonly terrainEntries?: number;
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
  /** Replaced versions still pinned. */
  readonly retained: number;
  /** Chunks of terrain the queue has yet to serve, and those held apart from its cache. */
  readonly terrain: { readonly queued: number; readonly held: number };
  /** Clients dropped because serving them threw (C3). */
  readonly faults: number;
  /** Whether a fault of the whole plane stopped the presentation (C3). */
  readonly failed: boolean;
};

/** The sizes the presentation works with, checked. */
type Sizes = {
  readonly part: number;
  readonly period: number;
  readonly view: number;
  readonly retained: number;
};

const MICROS_PER_SECOND = 1_000_000;

/** Rejections a correct client may still meet, by a race with the world or its own timing. */
const NO_STRIKE: ReadonlySet<ErrorCode> = new Set(["unknown_being", "resync_too_soon"]);

/** `value` when it is a safe integer of at least `min`, else a RangeError naming `what`. */
function atLeast(what: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${what} is an integer of at least ${min}, not ${value}`);
  }
  return value;
}

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
  return {
    part,
    period,
    view: atLeast("a view's limit", options.viewBytes ?? VIEW_BYTES, 1),
    retained: atLeast("the limit of retained bytes", options.retainedBytes ?? RETAINED_BYTES, 1),
  };
}

/** The index in `clients`, in the order they connected, of the first whose id is at least `id`. */
function startOf(clients: readonly Client[], id: ClientId | undefined): number {
  if (id === undefined) return 0;
  return Math.max(
    0,
    clients.findIndex((client) => client.id >= id),
  );
}

/**
 * How many of the `count` clients from index `from` on, in turn, have a full buffer: the fan-out
 * deferred them, and the gauge of lagging clients still counts them.
 */
function laggingAmong(clients: readonly Client[], from: number, count: number): number {
  let lagging = 0;
  for (let turn = 0; turn < count; turn += 1) {
    const client = clients[(from + turn) % clients.length];
    if (client !== undefined && client.sink.buffered() >= BUFFER_BYTES) lagging += 1;
  }
  return lagging;
}

/** The terrain `taken` holds for the chunk `at`. */
function terrainIn(taken: ReadonlyMap<string, EncodedText>, at: ChunkCoord): EncodedText {
  const terrain = taken.get(chunkKey(at));
  if (terrain === undefined) throw new Error(`no terrain was taken for chunk ${chunkKey(at)}`);
  return terrain;
}

/** The presentation plane: playout, mirror, interest, sessions, and each client's transactions. */
export class Presentation {
  readonly #mirror = new Mirror();
  readonly #interest = new Interest();
  readonly #clients = new Map<ClientId, Client>();
  readonly #playout: Playout;
  readonly #terrain: TerrainQueue;
  readonly #world: WorldInfo;
  readonly #limits: Limits;
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
    this.#terrain = new TerrainQueue(
      new TerrainCache(options.readTerrain, options.terrainEntries ?? TERRAIN_ENTRIES),
      options.terrainPerPeriod ?? TERRAIN_PER_PERIOD,
    );
    this.#world = options.world;
    this.#limits = Object.freeze({ ...CLIENT_LIMITS, maxViewBytes: this.#sizes.view });
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
    const client = new Client(id, sink, view, this.#clock.now());
    client.queue(helloFrame(this.#world, mirror.clock, this.#state, this.#limits));
    this.#clients.set(id, client);
    this.#interest.add(id);
    return id;
  }

  /**
   * One raw text message of `client`, which the transport already held to 4 KiB and to text: read
   * with the protocol's strict schema, then held to the bucket of messages, and, for a subscribe,
   * to the bucket of new chunks. A rejected message gets `error` with its code alone, and, unless
   * a correct client may meet it too (`unknown_being`, `resync_too_soon`), a strike: the third
   * within 10 s closes the client with 1008, with no `error` for it. An answer goes out at once,
   * within the client's budget and buffer; what does not fit waits.
   */
  receive(client: ClientId, text: string): void {
    const connected = this.#client(client);
    try {
      this.#read(connected, text);
    } catch (cause) {
      this.#fault(connected, cause);
    }
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
   * transaction is a reset: what the memory guard does to the clients it aborts.
   */
  abort(client: ClientId, options: { readonly releaseView?: boolean } = {}): void {
    this.#abort(this.#client(client), options.releaseView === true);
  }

  /** Disconnects `client`: its interest, index entries, pins, transaction, and terrain go. */
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
      retained: mirror.retained,
      terrain: { queued: this.#terrain.queued, held: this.#terrain.held },
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
      retainedBytes: this.#mirror.retainedBytes,
      terrainQueue: this.#terrain.queued,
    };
  }

  /**
   * One period: the playout's release, the world's state, the terrain queue's head, the fan-out,
   * the rest of the terrain budget for the clients that wait, and the memory guard. A throw that is not one client's is a fault of the whole plane, whose state may
   * be inconsistent: the presentation stops and detaches, `failed` turns true, and the throw goes
   * on.
   */
  period(): void {
    this.#period += 1;
    try {
      this.#playout.release((published) => this.#mirror.apply(published));
      this.#announce();
      this.#terrain.period(this.#terrainFault);
      this.#fanOut();
      this.#terrain.prefetch(this.#terrainFault);
      this.#guardRetention();
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

  /** A queued generation of terrain threw: its client is dropped. */
  readonly #terrainFault = (client: ClientId, cause: unknown): void => {
    this.#fault(this.#client(client), cause);
  };

  #client(id: ClientId): Client {
    const client = this.#clients.get(id);
    if (client === undefined) throw new Error(`client ${id} is not connected`);
    return client;
  }

  /** Removes `client` and all it holds: interest, index entries, pins, transaction, terrain. */
  #remove(client: Client): void {
    client.txn?.release(this.#mirror);
    client.txn = undefined;
    this.#releaseView(client.view);
    this.#interest.remove(client.id);
    this.#terrain.remove(client.id);
    this.#clients.delete(client.id);
  }

  /** Ends `client`: it is removed and counted, and its transport told to close it, once. */
  #end(client: Client, ending: Ending): void {
    this.#remove(client);
    if (ending.reason === "strikes") this.#counts.strikeCloses += 1;
    else if (ending.reason === "too_slow") this.#counts.slowCloses += 1;
    else this.#counts.faults += 1;
    client.sink.end(ending);
  }

  /** Serving `client` threw `cause`: it is dropped and counted, and its transport told to end it. */
  #fault(client: Client, cause: unknown): void {
    this.#end(client, { reason: "fault", cause });
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
      // What the transaction waited for goes; the client keeps its place in the terrain queue.
      this.#terrain.cancel(client.id);
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

  /** Reads one message of `client` and answers it. */
  #read(client: Client, text: string): void {
    const now = this.#clock.now();
    const parsed = parseClientMessage(text);
    let code: ErrorCode | undefined;
    if (!parsed.ok) code = parsed.code;
    else if (!client.session.admitMessage(now)) code = "rate_limited";
    else code = this.#apply(client, parsed.message, now);
    // A client that a strike closed gets nothing more.
    if (code !== undefined && !this.#reject(client, code, now)) return;
    this.#flush(client, false);
  }

  /** Applies `message`; returns why it is rejected, if it is. */
  #apply(client: Client, message: ClientMessage, now: number): ErrorCode | undefined {
    switch (message.type) {
      case "subscribe": {
        const added = this.#interest.added(client.id, message.chunks);
        if (!client.session.admitChunks(now, added)) return "rate_limited";
        this.#interest.subscribe(client.id, message.chunks);
        return undefined;
      }
      case "follow": {
        const { being } = message;
        if (being !== null && this.#mirror.locate(being) === undefined) return "unknown_being";
        this.#follow(client, being);
        return undefined;
      }
      case "ping":
        client.queue(pongFrame(client.view.tick, message.nonce), "pong");
        return undefined;
      case "resync":
        if (!client.session.mayResync(now)) return "resync_too_soon";
        client.view.needsReset = true;
        return undefined;
    }
  }

  /**
   * Rejects a message of `client` with `code`, and strikes it unless a correct client may meet the
   * code too. Returns whether the client stays: the third strike within 10 s ends it with 1008.
   */
  #reject(client: Client, code: ErrorCode, now: number): boolean {
    if (!NO_STRIKE.has(code)) {
      this.#counts.strikes += 1;
      if (client.session.strike(now)) {
        this.#end(client, STRIKES_ENDING);
        return false;
      }
    }
    client.queue(errorFrame(client.view.tick, code), `error:${code}`);
    return true;
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
        this.#lagging += laggingAmong(clients, first + turn, clients.length - turn);
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
   * Sends `client` what fits this period, unless its buffer is full. A client served that got
   * nothing else this period gets the world's state, whatever it is: the heartbeat no part or commit
   * gave, while the world is stopped or the client's next part waits for terrain.
   */
  #serve(client: Client): void {
    let blocked: Blocked | undefined = "lagging";
    if (client.sink.buffered() < BUFFER_BYTES) blocked = this.#flush(client, true);
    if (blocked === undefined && !client.sentIn(this.#period)) {
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

  /**
   * Starts the next transaction of `client`, at the playout tick, over its effective interest
   * trimmed to the view's limit. A chunk that would enter but whose terrain is not at hand is left
   * out of this transaction, neither trimmed nor dropped from the interest: the client waits for it
   * in the terrain queue, and it enters, whole, in a later transaction.
   */
  #begin(client: Client): void {
    const target = this.#interest.target(client.id);
    // The follow window moves with the followed being, to its chunk at the playout tick.
    const center = target === null ? undefined : this.#mirror.locate(target);
    this.#interest.moveWindow(client.id, center);
    const { kept, trimmed } = trimView(
      this.#mirror,
      this.#interest.effective(client.id),
      this.#sizes.view,
    );
    this.#notice(client, trimmed);
    const { view } = client;
    const entering = kept.filter((at) => view.needsReset || !view.pinned.has(chunkKey(at)));
    const taken = this.#terrain.take(client.id, entering);
    const later = new Set(entering.map(chunkKey).filter((key) => !taken.has(key)));
    client.txn = Transaction.start({
      txn: client.nextTxn,
      view,
      mirror: this.#mirror,
      interest: kept.filter((at) => !later.has(chunkKey(at))),
      target,
      terrainBytes: (at) => terrainIn(taken, at).bytes,
      terrain: this.#terrain.reader(client.id),
      partBytes: this.#sizes.part,
    });
    client.nextTxn += 1;
    // A trim counts once its transaction started.
    if (trimmed.length > 0) this.#counts.trims += 1;
  }

  /**
   * Tells `client` which chunks the view's limit left out, when they changed: an empty list says
   * that nothing is left out any more.
   */
  #notice(client: Client, trimmed: readonly ChunkCoord[]): void {
    const keys = trimmed.map(chunkKey).join(";");
    if (keys === client.trimmed) return;
    client.trimmed = keys;
    client.queue(noticeFrame(client.view.tick, trimmed), "notice");
  }

  /**
   * While the retained versions pass their limit, aborts every client that pins the oldest one,
   * with its view when it pins that version at L. Each client aborted counts one abort; the third
   * within 60 s closes it with 1013. A version still pinned once its clients were aborted is a
   * fault of the plane.
   */
  #guardRetention(): void {
    const aborted = guardRetention(
      this.#mirror,
      this.#sizes.retained,
      this.#clients.values(),
      (client, atL) => this.#abort(client, atL),
    );
    const now = this.#clock.now();
    for (const client of aborted) {
      this.#counts.aborts += 1;
      if (client.aborts.add(now) >= ABORTS_TO_CLOSE) this.#end(client, TOO_SLOW_ENDING);
    }
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
