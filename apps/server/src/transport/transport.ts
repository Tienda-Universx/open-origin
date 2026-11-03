/**
 * The public listener (ADR 0025, "Planes and the boundary"; ADR 0026): a `Bun.serve` adapter that
 * drives the presentation plane through four calls only, `connect`, `receive`, `drained`, and
 * `close`, and gives it one sink per socket. It reaches Bun through the global `Bun`, never an
 * import of `bun`, so the plane's boundary holds.
 *
 * - **HTTP.** `http.ts` routes each request: `GET /healthz`, `GET /ws` with the subprotocol, or a
 *   refusal (403 for a `Host` or an `Origin` off its list, 404, 426). An upgrade then takes a slot
 *   under the caps, in all and per IP, or is refused with 503 and `Retry-After`.
 * - **Input.** Bun closes a frame over 4 KiB with 1009 (`maxPayloadLength`); a binary frame is
 *   closed here with 1003; every text frame goes to `receive`, which reads it.
 * - **Output.** The sink sends text frames, reports `getBufferedAmount()`, and closes with the
 *   ending's code: 1008 for strikes, 1013 for slowness, and 1011 for a fault, a code the protocol
 *   leaves to the server. `backpressureLimit` is 1 MiB with `closeOnBackpressureLimit`, twice what
 *   the presentation's budget lets a buffer reach; `idleTimeout` is 120 s, with `sendPings`.
 * - **Lifecycle.** `drain` calls `drained`; a socket's close gives its slot back and calls `close`,
 *   unless the presentation ended the client itself. That call waits for a microtask: Bun can run a
 *   close handler inside a `send` the presentation makes, and the presentation must not lose a
 *   client in the middle of serving it. `stop` stops listening and closes every socket with 1001,
 *   as Bun's `stop(true)` does.
 * - **Logs.** Events with their codes, sizes, statuses, and counts only: never an address, a
 *   header, a payload, or what an error says, which could hold what a client sent.
 */
import { CLOSE_CODES, PROTOCOL_ID } from "@open-origin/protocol/public";
import type { ClientId } from "../presentation/interest.ts";
import type { ClientSink, Ending, Presentation } from "../presentation/presentation.ts";
import { Capacity, type Caps } from "./capacity.ts";
import {
  factsOf,
  healthy,
  listenerHosts,
  type Policy,
  policyOf,
  type RefusalReason,
  refusal,
  route,
  statusOf,
} from "./http.ts";

/** The close code of a fault of the presentation in serving a client: 1011, internal error. */
export const FAULT_CLOSE = 1011;

/** Bun's limits on a socket (ADR 0026, "Limits and backpressure"). */
export const SOCKET_LIMITS = Object.freeze({
  maxPayloadLength: 4096,
  backpressureLimit: 1024 * 1024,
  idleTimeoutSeconds: 120,
});

/** What the transport needs of the presentation plane. */
export type PresentationPort = Pick<Presentation, "connect" | "receive" | "drained" | "close">;

/** One line of the transport's log: no address, header, payload, or error text. */
export type TransportEvent =
  | { readonly event: "refused"; readonly status: number; readonly reason: RefusalReason }
  | { readonly event: "open"; readonly connections: number }
  | { readonly event: "binary_frame"; readonly size: number }
  | { readonly event: "close"; readonly code: number; readonly connections: number }
  | { readonly event: "handler_error"; readonly error: string };

export type TransportOptions = {
  readonly presentation: PresentationPort;
  /** The address to listen on, and the port: 0 lets the system choose one. */
  readonly hostname: string;
  readonly port: number;
  /** The browser origins a socket may come from, matched exactly. */
  readonly publicOrigins: readonly string[];
  /** The `Host` values the listener answers: its own name and address at its port unless given. */
  readonly allowedHosts: readonly string[] | undefined;
  readonly connections: Caps;
  readonly log: (event: TransportEvent) => void;
};

/** A running listener. */
export type Transport = {
  /** The port it listens on: the one given, or the one the system chose for 0. */
  readonly port: number;
  /** The connections that hold a slot now. */
  connections(): number;
  /** Closes every socket with 1001 and stops listening; resolves once every connection closed. */
  stop(): Promise<void>;
};

/** What the transport keeps of a socket: its address, its client, and whether it was ended. */
type Connection = { readonly ip: string; client: ClientId | undefined; ended: boolean };

type Socket = Bun.ServerWebSocket<Connection>;
type Server = Bun.Server<Connection>;

/** The close code of `ending`: its own, or FAULT_CLOSE for a fault. */
export function closeCodeOf(ending: Ending): number {
  return ending.reason === "fault" ? FAULT_CLOSE : ending.code;
}

/** The name of a thrown value, never its message: a message may quote what a client sent. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The listener's state between Bun's callbacks: its caps and its policy. */
class Listener {
  readonly #options: TransportOptions;
  readonly #presentation: PresentationPort;
  readonly #capacity: Capacity;
  #policy: Policy | undefined;

  constructor(options: TransportOptions) {
    this.#options = options;
    this.#presentation = options.presentation;
    this.#capacity = new Capacity(options.connections);
  }

  get connections(): number {
    return this.#capacity.open;
  }

  /** Answers `request`: the health check, an upgrade, or a refusal. */
  readonly answer = (request: Request, server: Server): Response | undefined => {
    const routed = route(factsOf(request), this.#policyOf(server));
    if (routed.kind === "health") return healthy();
    if (routed.kind === "refuse") return this.#refuse(routed.reason);
    return this.#upgrade(request, server);
  };

  /** A fetch that threw: a bug of the listener, logged by name and answered with 500. */
  readonly failed = (error: unknown): Response => {
    this.#log({ event: "handler_error", error: nameOf(error) });
    return new Response("internal error", { status: 500 });
  };

  readonly handlers: Bun.WebSocketHandler<Connection> = {
    maxPayloadLength: SOCKET_LIMITS.maxPayloadLength,
    backpressureLimit: SOCKET_LIMITS.backpressureLimit,
    closeOnBackpressureLimit: true,
    idleTimeout: SOCKET_LIMITS.idleTimeoutSeconds,
    sendPings: true,
    open: (socket) => this.#open(socket),
    message: (socket, message) => this.#message(socket, message),
    drain: (socket) => this.#drain(socket),
    close: (socket, code) => this.#close(socket, code),
    error: (error, socket) => {
      this.#log({ event: "handler_error", error: nameOf(error) });
      socket.close(FAULT_CLOSE);
    },
  };

  #log(event: TransportEvent): void {
    this.#options.log(event);
  }

  /** The policy of the listener, whose default hosts need the port it bound. */
  #policyOf(server: Server): Policy {
    if (this.#policy !== undefined) return this.#policy;
    const { allowedHosts, hostname, publicOrigins } = this.#options;
    const port = server.port;
    if (port === undefined) throw new Error("the public listener has no port");
    this.#policy = policyOf(allowedHosts ?? listenerHosts(hostname, port), publicOrigins);
    return this.#policy;
  }

  #refuse(reason: RefusalReason): Response {
    this.#log({ event: "refused", status: statusOf(reason), reason });
    return refusal(reason);
  }

  /** Takes a slot for the request's address and upgrades it, or refuses it. */
  #upgrade(request: Request, server: Server): Response | undefined {
    const ip = server.requestIP(request)?.address;
    if (ip === undefined) return this.#refuse("handshake");
    const full = this.#capacity.take(ip);
    if (full !== undefined) return this.#refuse(full === "global" ? "capacity" : "capacity_per_ip");
    const data: Connection = { ip, client: undefined, ended: false };
    // Bun runs the open handler within upgrade; on failure nothing opened, so the slot goes back.
    if (server.upgrade(request, { data, headers: { "Sec-WebSocket-Protocol": PROTOCOL_ID } })) {
      return undefined;
    }
    this.#capacity.release(ip);
    return this.#refuse("handshake");
  }

  #open(socket: Socket): void {
    socket.data.client = this.#presentation.connect(this.#sinkOf(socket));
    this.#log({ event: "open", connections: this.#capacity.open });
  }

  /** The sink of `socket`: text frames, its buffered bytes, and a close with the ending's code. */
  #sinkOf(socket: Socket): ClientSink {
    return {
      send: (frame) => {
        socket.sendText(frame);
      },
      buffered: () => socket.getBufferedAmount(),
      end: (ending) => {
        socket.data.ended = true;
        socket.close(closeCodeOf(ending));
      },
    };
  }

  /** The client of `socket`, unless it has none yet or the presentation ended it. */
  #clientOf(socket: Socket): ClientId | undefined {
    return socket.data.ended ? undefined : socket.data.client;
  }

  #message(socket: Socket, message: string | Buffer): void {
    const client = this.#clientOf(socket);
    if (client === undefined) return;
    if (typeof message !== "string") {
      this.#log({ event: "binary_frame", size: message.byteLength });
      socket.close(CLOSE_CODES.binaryFrame);
      return;
    }
    this.#presentation.receive(client, message);
  }

  #drain(socket: Socket): void {
    const client = this.#clientOf(socket);
    if (client !== undefined) this.#presentation.drained(client);
  }

  /** Gives the slot back and, unless the presentation ended the client, closes it there. */
  #close(socket: Socket, code: number): void {
    this.#capacity.release(socket.data.ip);
    const { data } = socket;
    const client = this.#clientOf(socket);
    data.client = undefined;
    if (client !== undefined) {
      queueMicrotask(() => {
        if (!data.ended) this.#presentation.close(client);
      });
    }
    this.#log({ event: "close", code, connections: this.#capacity.open });
  }
}

/** Starts the public listener of `options`. */
export function serveTransport(options: TransportOptions): Transport {
  const listener = new Listener(options);
  const server: Server = Bun.serve<Connection>({
    hostname: options.hostname,
    port: options.port,
    development: false,
    fetch: listener.answer,
    error: listener.failed,
    websocket: listener.handlers,
  });
  const port = server.port;
  if (port === undefined) throw new Error("the public listener bound no port");
  return Object.freeze({
    port,
    connections: () => listener.connections,
    // Bun closes every socket with 1001, the shutdown code, running each close handler.
    stop: () => server.stop(true),
  });
}
