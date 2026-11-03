/**
 * The terminal probe: a minimal public client of the server (plan §7, §11; ADR 0026). It connects
 * over WebSocket with the subprotocol `open-origin.public.v1`, sends `subscribe` and, when asked,
 * `follow`, applies every message with the protocol's reference reducer, `applyMessage`, and prints
 * a screen at each commit: the authoritative clock, the visible chunks and beings, the followed
 * being, and the speech and feed of the last commits. Nothing the server sends reaches the
 * terminal raw (probe-screen.ts, `sanitize`).
 *
 *   bun apps/server/tools/probe.ts [--url ws://127.0.0.1:8080/ws] [--chunk x,y]...
 *     [--around x,y [--radius r]] [--follow id] [--commits n]
 *
 * `--chunk` adds one chunk to the camera, and `--around` the square of chunks within `--radius`
 * (1 unless given) of one; with neither, the camera is empty and the probe sees the clock and the
 * feed. `--follow` follows a being. `--commits` exits after that many commits.
 *
 * It behaves as ADR 0026 asks of a client: after an anomaly it sends `resync`, at most once every
 * RESYNC_INTERVAL_MS; after STALE_AFTER_MS without a message, or when the socket closes, it
 * reconnects with the protocol's backoff (`reconnectDelayMs`), at least 5 s after an HTTP 503, and
 * sends its `subscribe` and `follow` again, since the server keeps no session. Ctrl-C (SIGINT) or
 * SIGTERM closes the socket and exits with 0; a bad argument exits with 2.
 */
import {
  applyMessage,
  type ChunkCoord,
  type ClientState,
  type Committed,
  type FeedItem,
  FollowMessage,
  initialClientState,
  PROTOCOL_ID,
  parseServerMessage,
  RESYNC_INTERVAL_MS,
  reconnectDelayMs,
  type ServerMessage,
  STALE_AFTER_MS,
  SubscribeMessage,
} from "@open-origin/protocol/public";
import { type Link, ROWS, renderScreen, type ShownSpeech } from "./probe-screen.ts";

/** What the probe asks the server for, and when it stops. */
export type ProbeOptions = {
  readonly url: string;
  readonly chunks: readonly ChunkCoord[];
  readonly follow: number | null;
  /** Stops after this many commits; never when undefined. */
  readonly commits: number | undefined;
};

/** The server's address when no `--url` is given: the server's default host and port. */
export const DEFAULT_URL = "ws://127.0.0.1:8080/ws";

const USAGE =
  "usage: bun apps/server/tools/probe.ts [--url ws://host:port/ws] [--chunk x,y]... [--around x,y [--radius r]] [--follow id] [--commits n]";

/** A non-negative safe integer written in plain decimal, or a RangeError naming `what`. */
function wholeNumber(text: string | undefined, what: string): number {
  const value = Number(text);
  if (text === undefined || !/^[0-9]+$/.test(text) || !Number.isSafeInteger(value))
    throw new RangeError(`${what} must be a whole number, not "${text ?? ""}"`);
  return value;
}

/** A chunk written `x,y`, each a safe integer. */
function chunkArg(text: string | undefined): ChunkCoord {
  const match = /^(-?[0-9]+),(-?[0-9]+)$/.exec(text ?? "");
  const x = Number(match?.[1]);
  const y = Number(match?.[2]);
  if (match === null || !Number.isSafeInteger(x) || !Number.isSafeInteger(y))
    throw new RangeError(`a chunk is written x,y, not "${text ?? ""}"`);
  return [x, y];
}

/** The chunks within `radius` of `center`, by row then column. */
function square(center: ChunkCoord, radius: number): ChunkCoord[] {
  const chunks: ChunkCoord[] = [];
  for (let dy = -radius; dy <= radius; dy += 1)
    for (let dx = -radius; dx <= radius; dx += 1) chunks.push([center[0] + dx, center[1] + dy]);
  return chunks;
}

/** The arguments as read, before the protocol's checks. */
type Read = {
  url?: string;
  chunks: ChunkCoord[];
  around?: ChunkCoord;
  radius?: number;
  follow?: number;
  commits?: number;
};

/** How each option stores its value; `--chunk` alone may be given more than once. */
const OPTIONS = new Map<string, (read: Read, value: string | undefined) => void>([
  ["--chunk", (read, value) => read.chunks.push(chunkArg(value))],
  [
    "--url",
    (read, value) => {
      read.url = value ?? "";
    },
  ],
  [
    "--around",
    (read, value) => {
      read.around = chunkArg(value);
    },
  ],
  [
    "--radius",
    (read, value) => {
      read.radius = wholeNumber(value, "--radius");
    },
  ],
  [
    "--follow",
    (read, value) => {
      read.follow = wholeNumber(value, "--follow");
    },
  ],
  [
    "--commits",
    (read, value) => {
      read.commits = wholeNumber(value, "--commits");
    },
  ],
]);

/** Reads the option `name` with its value into `read`; throws for an unknown or repeated one. */
function readOption(read: Read, seen: Set<string>, name: string, value: string | undefined): void {
  const store = OPTIONS.get(name);
  if (store === undefined) throw new RangeError(`unknown argument "${name}"`);
  if (name !== "--chunk" && seen.has(name)) throw new RangeError(`${name} is given twice`);
  seen.add(name);
  store(read, value);
}

/** The url, which must be a ws: or wss: URL. */
function checkedUrl(url: string): string {
  const protocol = URL.canParse(url) ? new URL(url).protocol : "";
  if (protocol !== "ws:" && protocol !== "wss:")
    throw new RangeError(`--url must be a ws: or wss: URL, not "${url}"`);
  return url;
}

/** The camera `read` asks for: its `--chunk`s, then the square of `--around`. */
function cameraOf(read: Read): ChunkCoord[] {
  if (read.radius !== undefined && read.around === undefined)
    throw new RangeError("--radius needs --around");
  const around = read.around === undefined ? [] : square(read.around, read.radius ?? 1);
  const chunks = [...read.chunks, ...around];
  if (!SubscribeMessage.safeParse({ type: "subscribe", chunks }).success)
    throw new RangeError("the camera holds at most 64 chunks, each once and inside the world");
  return chunks;
}

/** The being `read` follows, or null. */
function followOf(read: Read): number | null {
  const follow = read.follow ?? null;
  if (!FollowMessage.safeParse({ type: "follow", being: follow }).success)
    throw new RangeError("--follow takes a being id from 1");
  return follow;
}

/**
 * The options `argv` asks for. Throws a RangeError naming the argument at fault: an unknown one, one
 * given twice, a value that is not what its option takes, `--radius` without `--around`, a camera
 * the protocol refuses (more than 64 chunks, one repeated, or one outside the world), a being id
 * below 1, `--commits 0`, or a URL that is not ws: or wss:.
 */
export function parseProbeArgs(argv: readonly string[]): ProbeOptions {
  const read: Read = { chunks: [] };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2)
    readOption(read, seen, argv[index] ?? "", argv[index + 1]);
  if (read.commits === 0) throw new RangeError("--commits must be at least 1");
  return {
    url: checkedUrl(read.url ?? DEFAULT_URL),
    chunks: cameraOf(read),
    follow: followOf(read),
    commits: read.commits,
  };
}

/** What happens on a socket, as the probe hears it. */
export type SocketEvents = {
  open(): void;
  message(data: unknown): void;
  /** The socket closed; `unavailable` when the server refused its upgrade with HTTP 503. */
  close(unavailable: boolean): void;
};

export type ProbeSocket = { send(text: string): void; close(): void };

/** What the probe needs from outside: sockets, timers, time, randomness, and a screen. */
export type ProbeDeps = {
  readonly connect: (url: string, events: SocketEvents) => ProbeSocket;
  /** Runs `callback` after `ms` milliseconds; returns the function that cancels it. */
  readonly schedule: (ms: number, callback: () => void) => () => void;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** A number in [0, 1), for the backoff's jitter. */
  readonly random: () => number;
  /** Shows a screen, already sanitized. */
  readonly show: (screen: string) => void;
};

/** The messages besides a commit that change the screen at once. */
const SHOWN_AT_ONCE: ReadonlySet<ServerMessage["type"]> = new Set(["hello", "notice", "error"]);

/** How many items of speech and of the feed the probe keeps: what one screen shows. */
const KEPT = ROWS;

/**
 * One probe: its connection, the reducer's state, and the speech and feed of its last commits.
 * Each connection has a generation, and the events of an older one are ignored, so a socket the
 * probe gave up on cannot act after its replacement opened.
 */
export class Probe {
  readonly #options: ProbeOptions;
  readonly #deps: ProbeDeps;
  #state: ClientState = initialClientState();
  #link: Link = "connecting";
  #socket: ProbeSocket | undefined;
  #generation = 0;
  #attempt = 0;
  #cancelTimer: (() => void) | undefined;
  #stopped = false;
  #wantResync = false;
  #lastResync = Number.NEGATIVE_INFINITY;
  #speech: ShownSpeech[] = [];
  #feed: FeedItem[] = [];
  readonly counts = {
    commits: 0,
    anomalies: 0,
    errors: 0,
    badFrames: 0,
    resyncs: 0,
    reconnects: 0,
  };
  /** The code of the last `error` the server sent, such as `unknown_being`. */
  #lastError: string | undefined;
  readonly done: Promise<void>;
  #resolveDone: () => void = () => undefined;

  constructor(options: ProbeOptions, deps: ProbeDeps) {
    this.#options = options;
    this.#deps = deps;
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  /** The reducer's state now. */
  get state(): ClientState {
    return this.#state;
  }

  /** Opens the first connection. */
  start(): void {
    this.#open();
  }

  /** Closes the socket, cancels every timer, and resolves `done`; nothing reconnects after it. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    this.#cancelTimer?.();
    this.#socket?.close();
    this.#socket = undefined;
    this.#resolveDone();
  }

  #open(): void {
    if (this.#stopped) return;
    this.#generation += 1;
    const generation = this.#generation;
    const live = () => generation === this.#generation;
    this.#link = "connecting";
    this.#socket = this.#deps.connect(this.#options.url, {
      open: () => {
        if (live()) this.#opened();
      },
      message: (data) => {
        if (live()) this.#message(data);
      },
      close: (unavailable) => {
        if (live()) this.#retry(unavailable);
      },
    });
    // A connection that does not open within STALE_AFTER_MS is given up as a silent one is.
    this.#armSilence();
  }

  /** Sends the camera and the followed being, which the server forgets with every connection. */
  #opened(): void {
    this.#link = "open";
    this.#send({ type: "subscribe", chunks: this.#options.chunks });
    if (this.#options.follow !== null) this.#send({ type: "follow", being: this.#options.follow });
    this.#armSilence();
  }

  #send(message: object): void {
    this.#socket?.send(JSON.stringify(message));
  }

  /** The socket closed or went silent: the probe gives it up and reconnects after the backoff. */
  #retry(unavailable: boolean): void {
    this.#generation += 1;
    this.#cancelTimer?.();
    this.#socket?.close();
    this.#socket = undefined;
    this.#link = "waiting";
    const delay = reconnectDelayMs(this.#attempt, this.#deps.random(), unavailable);
    this.#attempt += 1;
    this.counts.reconnects += 1;
    this.#show();
    this.#cancelTimer = this.#deps.schedule(delay, () => this.#open());
  }

  /** A connection that hears nothing for STALE_AFTER_MS is given up. */
  #armSilence(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#deps.schedule(STALE_AFTER_MS, () => this.#retry(false));
  }

  #message(data: unknown): void {
    this.#armSilence();
    const parsed = typeof data === "string" ? parseServerMessage(data) : undefined;
    if (parsed === undefined || !parsed.ok) {
      // A frame the strict schema refuses is not applied: the next one shows a seq gap.
      this.counts.badFrames += 1;
      return;
    }
    const { message } = parsed;
    const applied = applyMessage(this.#state, message);
    this.#state = applied.state;
    this.#note(message, applied.anomaly !== undefined);
    this.#resyncWhenAllowed();
    if (applied.committed !== undefined) this.#committed(applied.committed);
    else if (SHOWN_AT_ONCE.has(message.type)) this.#show();
  }

  /**
   * What `message` changes besides the view: a hello starts the backoff over and forgets a resync
   * asked on the connection before; an anomaly asks for a resync; an error is counted and kept.
   */
  #note(message: ServerMessage, anomaly: boolean): void {
    if (message.type === "hello") {
      this.#attempt = 0;
      this.#wantResync = false;
    }
    if (message.type === "error") {
      this.counts.errors += 1;
      this.#lastError = message.code;
    }
    if (!anomaly) return;
    this.counts.anomalies += 1;
    this.#wantResync = true;
  }

  /** Sends `resync` once an anomaly asked for one and RESYNC_INTERVAL_MS passed since the last. */
  #resyncWhenAllowed(): void {
    const now = this.#deps.now();
    if (!this.#wantResync || now - this.#lastResync < RESYNC_INTERVAL_MS) return;
    this.#wantResync = false;
    this.#lastResync = now;
    this.counts.resyncs += 1;
    this.#send({ type: "resync" });
  }

  #committed(committed: Committed): void {
    this.counts.commits += 1;
    this.#speech = [...this.#speech, ...committed.speech].slice(-KEPT);
    this.#feed = [...this.#feed, ...committed.feed].slice(-KEPT);
    this.#show();
    if (this.counts.commits === this.#options.commits) this.stop();
  }

  #show(): void {
    this.#deps.show(
      renderScreen({
        url: this.#options.url,
        link: this.#link,
        state: this.#state,
        speech: this.#speech,
        feed: this.#feed,
        counts: this.counts,
        lastError: this.#lastError,
      }),
    );
  }
}

/** Whether a WebSocket error event reports the server's refusal with HTTP 503. */
export function refusedAsUnavailable(event: Event): boolean {
  const message = "message" in event ? String(event.message) : "";
  // Bun's client reports a refused upgrade only in the error's text: "Expected 101 status code: 503".
  return /\b503\b/.test(message);
}

/** A WebSocket of the runtime, with the public subprotocol. */
function connectSocket(url: string, events: SocketEvents): ProbeSocket {
  const socket = new WebSocket(url, PROTOCOL_ID);
  let unavailable = false;
  socket.addEventListener("open", () => events.open());
  socket.addEventListener("message", (event) => events.message(event.data));
  socket.addEventListener("error", (event) => {
    unavailable ||= refusedAsUnavailable(event);
  });
  socket.addEventListener("close", () => events.close(unavailable));
  return { send: (text) => socket.send(text), close: () => socket.close(1000) };
}

/** Clears a terminal and moves the cursor home: the probe's own sequence, never the server's. */
const CLEAR = "\u001b[H\u001b[2J";

/** The process's sockets, timers, clock, and stdout: a screen replaces the last one on a TTY. */
export function processDeps(): ProbeDeps {
  const tty = process.stdout.isTTY === true;
  return {
    connect: connectSocket,
    schedule: (ms, callback) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
    now: () => performance.now(),
    random: Math.random,
    show: (screen) => process.stdout.write(tty ? `${CLEAR}${screen}\n` : `${screen}\n\n`),
  };
}

/** Runs the probe of `argv` until a signal or its last commit; exits 2 on a bad argument. */
async function main(argv: readonly string[]): Promise<void> {
  let options: ProbeOptions;
  try {
    options = parseProbeArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exit(2);
  }
  const probe = new Probe(options, processDeps());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => probe.stop());
  probe.start();
  await probe.done;
  process.exit(0);
}

if (import.meta.main) await main(process.argv.slice(2));
