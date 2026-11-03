/**
 * One connected client of the presentation plane (ADR 0026, "Ordering and liveness" and "Limits
 * and backpressure"): its sink, its view, its order of messages, the messages that wait for their
 * turn, its transaction in flight, its input limits, and what it may still receive this period.
 *
 * A client gets at most `periodBytes` a period, every message counted, and a message goes out only
 * while the bytes its socket buffers are under BUFFER_BYTES. A message is at most 64 KiB, so its
 * buffer stays under BUFFER_BYTES plus one message: always within 512 KiB.
 *
 * Messages that are not parts of a transaction wait in an outbox, which goes before any part. The
 * outbox stays small whatever the client sends while it does not read: a pending `pong`, `status`,
 * or `notice` is replaced by a newer one, and an `error` is queued once per code, so it holds at
 * most hello, one abort, and one message of each other kind.
 */
import { CLOSE_CODES, type ErrorCode } from "@open-origin/protocol/public";
import { type Frame, frameBytes, frameText } from "./frames.ts";
import type { ClientId } from "./interest.ts";
import type { Mirror } from "./mirror.ts";
import { RecentEvents, Session } from "./session.ts";
import type { Transaction, ViewState } from "./txn.ts";

/** The buffered bytes at or above which a client gets nothing: 256 KiB. */
export const BUFFER_BYTES = 256 * 1024;

/** How long a memory-guard abort counts, and how many close the client with 1013. */
const ABORT_WINDOW_MICROS = 60_000_000;
export const ABORTS_TO_CLOSE = 3;

/**
 * Why the presentation ended a connection. `strikes` and `too_slow` carry the close code the
 * transport sends; a `fault` is the presentation's own failure in serving the client, whose code
 * the transport chooses (the protocol fixes none), and its cause, for the transport's log.
 */
export type Ending =
  | { readonly reason: "strikes"; readonly code: typeof CLOSE_CODES.strikes }
  | { readonly reason: "too_slow"; readonly code: typeof CLOSE_CODES.tooSlow }
  | { readonly reason: "fault"; readonly cause: unknown };

export const STRIKES_ENDING: Ending = Object.freeze({
  reason: "strikes",
  code: CLOSE_CODES.strikes,
});
export const TOO_SLOW_ENDING: Ending = Object.freeze({
  reason: "too_slow",
  code: CLOSE_CODES.tooSlow,
});

/** Where a client's messages go: the transport's socket, or a test's double. */
export interface ClientSink {
  /** Sends one text frame. */
  send(frame: string): void;
  /** The bytes the client's socket buffers and has not written yet: Bun's getBufferedAmount(). */
  buffered(): number;
  /**
   * Ends the connection, once. The presentation already released the client, so the transport
   * must not call `receive`, `drained`, or `close` for it again. It must not throw.
   */
  end(ending: Ending): void;
}

/** The outbox slot of a message that coalesces with the pending one of its kind. */
export type Slot = "pong" | "status" | "notice" | `error:${ErrorCode}`;

/** A message that waits in the outbox, and its slot, if it coalesces. */
type Queued = { readonly frame: Frame; readonly slot: Slot | undefined };

/** Why a send did not happen: the period's budget is spent, or the client's buffer is full. */
export type Blocked = "budget" | "lagging";

/** A connected client. */
export class Client {
  readonly id: ClientId;
  readonly sink: ClientSink;
  readonly view: ViewState;
  readonly session: Session;
  /** The aborts of the memory guard that still count toward closing it. */
  readonly aborts = new RecentEvents(ABORT_WINDOW_MICROS);
  /** The `seq` of its next message. */
  seq = 0;
  /** The id of its next transaction. */
  nextTxn = 0;
  /** The period of its last commit: no transaction starts in it, so none commits twice in one. */
  committedIn = -1;
  /** The keys of the chunks the last `notice` listed, joined; empty when nothing is trimmed. */
  trimmed = "";
  txn: Transaction | undefined = undefined;
  readonly #outbox: Queued[] = [];
  /** The period whose budget `#left` holds, and how many bytes of it are left. */
  #budgetOf = -1;
  #left = 0;
  #sentIn = -1;

  constructor(id: ClientId, sink: ClientSink, view: ViewState, now: number) {
    this.id = id;
    this.sink = sink;
    this.view = view;
    this.session = new Session(now);
  }

  /** How many messages wait in the outbox. */
  get waiting(): number {
    return this.#outbox.length;
  }

  /** Queues `frame` before any part; with a slot, it replaces the pending message of that slot. */
  queue(frame: Frame, slot?: Slot): void {
    const index =
      slot === undefined ? -1 : this.#outbox.findIndex((queued) => queued.slot === slot);
    if (index < 0) this.#outbox.push({ frame, slot });
    else this.#outbox[index] = { frame, slot };
  }

  /** The next message to send: the outbox's first, else the transaction's next part. */
  next(): Frame | undefined {
    return this.#outbox[0]?.frame ?? this.txn?.peek();
  }

  /** Whether anything went out to the client in `period`. */
  sentIn(period: number): boolean {
    return this.#sentIn === period;
  }

  /**
   * Sends `frame`, the client's next message, as message `seq` when its buffer is under
   * BUFFER_BYTES and the budget of `period` holds it; otherwise says what stopped it.
   */
  send(frame: Frame, period: number, periodBytes: number): Blocked | undefined {
    if (this.sink.buffered() >= BUFFER_BYTES) return "lagging";
    if (this.#budgetOf !== period) {
      this.#budgetOf = period;
      this.#left = periodBytes;
    }
    const bytes = frameBytes(frame, this.seq);
    if (bytes > this.#left) return "budget";
    this.sink.send(frameText(frame, this.seq));
    this.seq += 1;
    this.#left -= bytes;
    this.#sentIn = period;
    return undefined;
  }

  /**
   * `frame`, which `next` gave, went out: the outbox or the transaction moves on, and a commit
   * applies to the view. Returns whether it was a commit.
   */
  sent(frame: Frame, mirror: Mirror, period: number): boolean {
    if (this.#outbox[0]?.frame === frame) {
      this.#outbox.shift();
      return false;
    }
    const { txn } = this;
    if (txn === undefined) throw new Error(`client ${this.id} sent a part with no transaction`);
    txn.advance();
    if (frame.type !== "commit") return false;
    txn.commit(this.view, mirror);
    this.txn = undefined;
    this.committedIn = period;
    return true;
  }
}
