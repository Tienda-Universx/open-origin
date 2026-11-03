/**
 * The HTTP surface of the public listener (ADR 0026, "Wire and versioning" and "Limits and
 * backpressure"; plan §7, "Origin and Host" and "Side leaks"): which requests it answers, and how.
 * `route` is a pure function of a request's method, path, and headers and of the listener's
 * allowlists, so every refusal is tested without a socket. In order:
 *
 * 1. a `Host` header off the allowlist, or none, is refused with 403 on every path, so a page that
 *    rebinds a name it controls to this machine reaches nothing;
 * 2. `GET /healthz` answers `{"ok":true}`; every other method or path but `GET /ws` is 404;
 * 3. a request to `/ws` that is not a WebSocket upgrade asking for the subprotocol
 *    `open-origin.public.v1` gets 426, before the upgrade;
 * 4. an `Origin`, when the request has one, must equal one of the public origins exactly, or gets
 *    403; a request without one, from a tool that is not a browser, passes.
 *
 * Capacity, which holds state, is checked after these (capacity.ts). No response carries a CORS
 * header, and none repeats what the request sent: each refusal has a fixed text.
 */
import { PROTOCOL_ID, RECONNECT_BACKOFF } from "@open-origin/protocol/public";

/** The paths the listener serves. */
export const HEALTH_PATH = "/healthz";
export const SOCKET_PATH = "/ws";

/** What `route` reads of a request: its method, its path, and four headers, null when absent. */
export type RequestFacts = {
  readonly method: string;
  readonly path: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly upgrade: string | null;
  readonly protocols: string | null;
};

/** The allowlists of a listener: `Host` values, lower-cased, and exact origins. */
export type Policy = {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
};

/** Why a request is refused. */
export type RefusalReason =
  | "host"
  | "origin"
  | "not_found"
  | "upgrade_required"
  | "capacity"
  | "capacity_per_ip"
  | "handshake";

/** What the listener does with a request: answer the health check, upgrade it, or refuse it. */
export type Route =
  | { readonly kind: "health" }
  | { readonly kind: "socket" }
  | { readonly kind: "refuse"; readonly reason: RefusalReason };

const HEALTH: Route = Object.freeze({ kind: "health" });
const SOCKET: Route = Object.freeze({ kind: "socket" });

/** The seconds a client refused for capacity waits at least, as its backoff does (ADR 0026). */
export const RETRY_AFTER_SECONDS = RECONNECT_BACKOFF.afterUnavailableMs / 1000;

/** The status, fixed text, and headers of each refusal. */
const REFUSALS: Readonly<
  Record<
    RefusalReason,
    { readonly status: number; readonly text: string; readonly headers?: Record<string, string> }
  >
> = Object.freeze({
  host: { status: 403, text: "this Host is not allowed" },
  origin: { status: 403, text: "this Origin is not allowed" },
  not_found: { status: 404, text: "not found" },
  upgrade_required: {
    status: 426,
    text: `connect with the WebSocket subprotocol ${PROTOCOL_ID}`,
    headers: { Upgrade: "websocket" },
  },
  capacity: {
    status: 503,
    text: "the server is full",
    headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
  },
  capacity_per_ip: {
    status: 503,
    text: "the server is full",
    headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
  },
  handshake: { status: 400, text: "not a valid WebSocket handshake" },
});

/** The facts of `request`; a URL that does not parse has an empty path, which nothing serves. */
export function factsOf(request: Request): RequestFacts {
  const { headers } = request;
  return {
    method: request.method,
    path: URL.parse(request.url)?.pathname ?? "",
    host: headers.get("host"),
    origin: headers.get("origin"),
    upgrade: headers.get("upgrade"),
    protocols: headers.get("sec-websocket-protocol"),
  };
}

/** The policy of `hosts` and `origins`: a host matches whatever its case, an origin exactly. */
export function policyOf(hosts: readonly string[], origins: readonly string[]): Policy {
  return {
    hosts: new Set(hosts.map((host) => host.toLowerCase())),
    origins: new Set(origins),
  };
}

/** The `Host` values of a listener bound to `hostname` and `port`: its name and its address. */
export function listenerHosts(hostname: string, port: number): string[] {
  const address = hostname.includes(":") ? `[${hostname}]` : hostname;
  return [`localhost:${port}`, `${address}:${port}`];
}

/** Whether the comma-separated `header` lists `token`, compared as `normalize` makes them. */
function lists(header: string | null, token: string, normalize = (text: string) => text): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => normalize(part.trim()) === token);
}

const lowerCase = (text: string) => text.toLowerCase();

/** What the listener does with a request of `facts` under `policy`. */
export function route(facts: RequestFacts, policy: Policy): Route {
  const refuse = (reason: RefusalReason): Route => ({ kind: "refuse", reason });
  if (facts.host === null || !policy.hosts.has(facts.host.toLowerCase())) return refuse("host");
  if (facts.method !== "GET") return refuse("not_found");
  if (facts.path === HEALTH_PATH) return HEALTH;
  if (facts.path !== SOCKET_PATH) return refuse("not_found");
  const upgrade = lists(facts.upgrade, "websocket", lowerCase);
  if (!upgrade || !lists(facts.protocols, PROTOCOL_ID)) return refuse("upgrade_required");
  if (facts.origin !== null && !policy.origins.has(facts.origin)) return refuse("origin");
  return SOCKET;
}

/** The answer to the health check. */
export function healthy(): Response {
  return Response.json({ ok: true });
}

/** The response that refuses a request for `reason`, with its status, fixed text, and headers. */
export function refusal(reason: RefusalReason): Response {
  const { status, text, headers } = REFUSALS[reason];
  return new Response(text, { status, headers: { "Content-Type": "text/plain", ...headers } });
}

/** The status of the refusal for `reason`. */
export function statusOf(reason: RefusalReason): number {
  return REFUSALS[reason].status;
}
