/**
 * Support for the tests that drive the presentation through the real transport, on loopback: a
 * client of Bun's WebSocket that reads every frame with the protocol's strict schema and applies it
 * with the reference reducer; a presentation port that counts, per client, the frames sent and the
 * messages received, so a test knows when every frame arrived; a wait for a condition with a
 * deadline, which fails instead of hanging; and a raw HTTP request from a chosen local address.
 */
import { connect } from "node:net";
import { PROTOCOL_ID } from "@open-origin/protocol/public";
import type { ClientId } from "../../src/presentation/interest.ts";
import type { ClientSink, Ending } from "../../src/presentation/presentation.ts";
import type { PresentationPort } from "../../src/transport/transport.ts";
import { ViewClient } from "./presentation.ts";

/** The address every listener of these tests binds. */
export const LOOPBACK = "127.0.0.1";

/**
 * Waits until `holds()`, letting the event loop run between checks; throws, naming `what`, after
 * `deadlineMs` of real time.
 */
export async function until(holds: () => boolean, what: string, deadlineMs = 2000): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  while (!holds()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

/**
 * What a client sends with its upgrade, the subprotocol unless told otherwise, and headers; and
 * whether it only counts its frames instead of reading them, for a test that moves megabytes.
 */
export type SocketInit = {
  readonly protocols?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly countOnly?: boolean;
};

/**
 * A client of the public listener: every frame goes through `view`, a ViewClient, which parses it
 * strictly and applies it with `applyMessage`, unless it only counts its frames; a frame the schema
 * rejects is kept in `errors`.
 */
export class SocketClient {
  readonly view = new ViewClient();
  readonly errors: unknown[] = [];
  readonly socket: WebSocket;
  readonly #countOnly: boolean;
  #counted = 0;
  /** The close code, once the socket closed. */
  code: number | undefined;
  /** How many messages it sent. */
  sent = 0;

  private constructor(socket: WebSocket, countOnly: boolean) {
    this.socket = socket;
    this.#countOnly = countOnly;
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", (event) => {
      this.code = event.code;
    });
  }

  /** A client connected to `/ws` on `port`; throws when the upgrade fails. */
  static async open(port: number, init: SocketInit = {}): Promise<SocketClient> {
    const socket = new WebSocket(`ws://${LOOPBACK}:${port}/ws`, {
      protocols: [...(init.protocols ?? [PROTOCOL_ID])],
      headers: { ...init.headers },
    });
    const client = new SocketClient(socket, init.countOnly === true);
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true });
      socket.addEventListener("close", () => resolve(false), { once: true });
    });
    if (!opened) throw new Error(`the upgrade failed and the socket closed with ${client.code}`);
    return client;
  }

  /** How many frames it received. */
  get frames(): number {
    return this.#countOnly ? this.#counted : this.view.texts.length;
  }

  get closed(): boolean {
    return this.code !== undefined;
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data);
    this.sent += 1;
  }

  /** Waits until the socket closed, and returns its code. */
  async closing(what = "the socket to close"): Promise<number> {
    await until(() => this.closed, what);
    return this.code ?? -1;
  }

  #receive(data: unknown): void {
    if (this.#countOnly) {
      this.#counted += 1;
      return;
    }
    try {
      this.view.send(typeof data === "string" ? data : String(data));
    } catch (error) {
      this.errors.push(error);
    }
  }
}

/** The count of `id` in `counts`, zero when absent. */
const countOf = (counts: ReadonlyMap<ClientId, number>, id: ClientId) => counts.get(id) ?? 0;

/**
 * A presentation port over `inner` that counts, per client, the frames its sink sent and the
 * messages it received, records how the presentation ended each client, and the largest amount a
 * sink reported buffered.
 */
export class CountingPort implements PresentationPort {
  readonly #inner: PresentationPort;
  readonly #sent = new Map<ClientId, number>();
  readonly #received = new Map<ClientId, number>();
  readonly ended = new Map<ClientId, Ending>();
  readonly closes: ClientId[] = [];
  readonly drains: ClientId[] = [];
  /** The transport's own sink of each client, for a test that sends through it directly. */
  readonly sinks = new Map<ClientId, ClientSink>();
  /** The client connected last. */
  last: ClientId | undefined;
  peakBuffered = 0;

  constructor(inner: PresentationPort) {
    this.#inner = inner;
  }

  sent(id: ClientId): number {
    return countOf(this.#sent, id);
  }

  received(id: ClientId): number {
    return countOf(this.#received, id);
  }

  connect(sink: ClientSink): ClientId {
    const id = this.#inner.connect(this.#counted(sink, () => id));
    this.sinks.set(id, sink);
    this.last = id;
    return id;
  }

  receive(client: ClientId, text: string): void {
    this.#received.set(client, this.received(client) + 1);
    this.#inner.receive(client, text);
  }

  drained(client: ClientId): void {
    this.drains.push(client);
    this.#inner.drained(client);
  }

  close(client: ClientId): void {
    this.closes.push(client);
    this.#inner.close(client);
  }

  /** `sink`, counted for the client `idOf` names once connect returned. */
  #counted(sink: ClientSink, idOf: () => ClientId): ClientSink {
    return {
      send: (frame) => {
        this.#sent.set(idOf(), this.sent(idOf()) + 1);
        sink.send(frame);
      },
      buffered: () => {
        const bytes = sink.buffered();
        this.peakBuffered = Math.max(this.peakBuffered, bytes);
        return bytes;
      },
      end: (ending) => {
        this.ended.set(idOf(), ending);
        sink.end(ending);
      },
    };
  }
}

/** An HTTP/1.1 upgrade request for `/ws` on `port`, with the subprotocol and `headers`. */
export function upgradeHead(port: number, headers: Readonly<Record<string, string>> = {}): string {
  const all: Record<string, string> = {
    Host: `${LOOPBACK}:${port}`,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Protocol": PROTOCOL_ID,
    ...headers,
  };
  const lines = Object.entries(all).flatMap(([name, value]) =>
    value === "" ? [] : [`${name}: ${value}`],
  );
  return `GET /ws HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}

/** A raw request's answer: its status, its head lowered, and the function that closes it. */
export type RawAnswer = { readonly status: number; readonly head: string; close(): void };

/**
 * Sends `request`, raw, to `port` from the local address `from`, and resolves with the status and
 * the head of the answer once it arrived; the socket stays open until `close`. It settles in every
 * case: it rejects when the connection fails, when it closes before a whole head arrived, or after
 * `deadlineMs`. A local address other than 127.0.0.1 needs Linux, whose loopback is all of
 * 127.0.0.0/8; where it cannot be bound, the rejection says so.
 */
export function rawRequest(
  port: number,
  request: string,
  from = LOOPBACK,
  deadlineMs = 2000,
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOOPBACK, port, localAddress: from });
    const fail = (why: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`a raw request from ${from} to port ${port} ${why}`));
    };
    const timer = setTimeout(() => fail(`got no answer in ${deadlineMs} ms`), deadlineMs);
    let text = "";
    socket.on("error", (error) => fail(`failed: ${String(error)}`));
    socket.on("close", () => fail("closed before a whole answer"));
    socket.on("data", (data) => {
      text += String(data);
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.removeAllListeners("close");
      const head = text.slice(0, end).toLowerCase();
      resolve({ status: Number(head.split(" ")[1]), head, close: () => socket.destroy() });
    });
    socket.write(request);
  });
}
