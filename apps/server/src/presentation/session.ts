/**
 * The limits on one client's input (ADR 0026, "Limits and backpressure"), on the presentation's
 * clock in whole microseconds: a token bucket of messages, 10 a second with a burst of 20; a token
 * bucket of chunks new to its camera, 64 every 2 s; strikes, 3 in 10 s closing the connection with
 * 1008; and resyncs, at most one every 2 s. Every rule reads only the times it is given, never real
 * time, so its outcome follows from the clock the presentation injects.
 */
import { CLIENT_LIMITS, RESYNC_INTERVAL_MS } from "@open-origin/protocol/public";

const MICROS_PER_SECOND = 1_000_000;
const MICROS_PER_MS = 1000;

/** How long a strike counts, and how many close the connection. */
const STRIKE_WINDOW_MICROS = 10 * MICROS_PER_SECOND;
const STRIKES_TO_CLOSE = 3;

/** The window of the new-chunk bucket: CLIENT_LIMITS.newChunksPer2s every 2 s. */
const NEW_CHUNKS_WINDOW_MICROS = 2 * MICROS_PER_SECOND;

/**
 * A token bucket counted in microseconds of refill, so every step is an integer: each token costs
 * `cost` microseconds, and the bucket holds at most `tokens` of them. It starts full.
 */
class TokenBucket {
  readonly #cost: number;
  readonly #capacity: number;
  #credit: number;
  #at: number;

  constructor(tokens: number, cost: number, now: number) {
    this.#cost = cost;
    this.#capacity = tokens * cost;
    this.#credit = this.#capacity;
    this.#at = now;
  }

  /** Takes `count` tokens at `now` when the bucket holds them; otherwise takes none. */
  take(now: number, count = 1): boolean {
    if (now < this.#at) throw new RangeError(`the clock went back from ${this.#at} to ${now}`);
    this.#credit = Math.min(this.#capacity, this.#credit + (now - this.#at));
    this.#at = now;
    const cost = count * this.#cost;
    if (cost > this.#credit) return false;
    this.#credit -= cost;
    return true;
  }
}

/** The times of recent events, each counted while it is younger than `window` microseconds. */
export class RecentEvents {
  readonly #window: number;
  readonly #times: number[] = [];

  constructor(window: number) {
    this.#window = window;
  }

  /** Records an event at `now`; returns how many are younger than the window, it included. */
  add(now: number): number {
    this.#times.push(now);
    while ((this.#times[0] ?? now) <= now - this.#window) this.#times.shift();
    return this.#times.length;
  }
}

/** One client's input limits. */
export class Session {
  readonly #messages: TokenBucket;
  readonly #chunks: TokenBucket;
  readonly #strikes = new RecentEvents(STRIKE_WINDOW_MICROS);
  #resyncAt: number | undefined;

  /** The limits of a client that connected at `now`, its buckets full. */
  constructor(now: number) {
    const { burst, messagesPerSecond, newChunksPer2s } = CLIENT_LIMITS;
    this.#messages = new TokenBucket(burst, MICROS_PER_SECOND / messagesPerSecond, now);
    this.#chunks = new TokenBucket(newChunksPer2s, NEW_CHUNKS_WINDOW_MICROS / newChunksPer2s, now);
  }

  /** Whether a message at `now` fits the bucket of messages, which it then takes from. */
  admitMessage(now: number): boolean {
    return this.#messages.take(now);
  }

  /** Whether `count` chunks new to the camera fit their bucket at `now`, then taken from it. */
  admitChunks(now: number, count: number): boolean {
    return count === 0 || this.#chunks.take(now, count);
  }

  /** Records a strike at `now`; true when it is the third within 10 s, which closes the client. */
  strike(now: number): boolean {
    return this.#strikes.add(now) >= STRIKES_TO_CLOSE;
  }

  /** Whether a resync at `now` comes at least 2 s after the last one allowed; records it if so. */
  mayResync(now: number): boolean {
    const last = this.#resyncAt;
    if (last !== undefined && now - last < RESYNC_INTERVAL_MS * MICROS_PER_MS) return false;
    this.#resyncAt = now;
    return true;
  }
}
