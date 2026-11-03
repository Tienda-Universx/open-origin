/**
 * The public listener (ADR 0026, "Wire and versioning", "Limits and backpressure"; plan §7 and tests
 * 12 and 13 at the transport), on real sockets on loopback, over a presentation of a model world
 * that the tests drive period by period: its HTTP surface (the health check, 404 with no CORS
 * header, 426 before the upgrade, the `Origin` and `Host` allowlists, and 503 with `Retry-After` at
 * either cap); its socket limits and close codes (1003 for a binary frame, 1009 past 4 KiB, 1008
 * for strikes, 1011 for a fault, 1001 at shutdown); a close that releases the client unless the
 * presentation ended it; a client that stops reading, which lags and whose drain resumes its
 * transaction at once; Bun's own backpressure, which that relies on; and logs that hold no address
 * and no payload.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChunkCoord,
  CLOSE_CODES,
  MAX_CHUNK_BEINGS,
  PROTOCOL_ID,
} from "@open-origin/protocol/public";
import { Presentation } from "../src/presentation/presentation.ts";
import { Capacity } from "../src/transport/capacity.ts";
import { listenerHosts, policyOf, type RequestFacts, route } from "../src/transport/http.ts";
import {
  closeCodeOf,
  FAULT_CLOSE,
  serveTransport,
  type Transport,
  type TransportEvent,
  type TransportOptions,
} from "../src/transport/transport.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import {
  being,
  clockAt,
  ModelWorld,
  Publisher,
  presentationOver,
  terrainAt,
  WORLD_ID,
} from "./support/presentation.ts";
import {
  CountingPort,
  LOOPBACK,
  rawRequest,
  SocketClient,
  until,
  upgradeHead,
} from "./support/sockets.ts";

const running: Transport[] = [];
const sockets: SocketClient[] = [];

afterEach(async () => {
  for (const client of sockets.splice(0)) client.socket.close();
  for (const transport of running.splice(0)) await transport.stop();
});

/** A presentation of a model world with one being in the chunk (0, 0). */
function modelPresentation(options: Parameters<typeof presentationOver>[1] = {}) {
  return presentationOver(new ModelWorld(0, [being(1, [3, 3])]), options);
}

/** A listener on a free loopback port over `presentation`, its port counting what passes. */
function listen(presentation: Presentation, options: Partial<TransportOptions> = {}) {
  const logs: TransportEvent[] = [];
  const counting = new CountingPort(presentation);
  const transport = serveTransport({
    presentation: counting,
    hostname: LOOPBACK,
    port: 0,
    publicOrigins: [],
    allowedHosts: undefined,
    connections: { global: 64, perIp: 16 },
    log: (event) => logs.push(event),
    ...options,
  });
  running.push(transport);
  return { transport, logs, counting, port: transport.port };
}

/** A client of `port`, closed after the test. */
async function client(port: number, init?: Parameters<typeof SocketClient.open>[1]) {
  const opened = await SocketClient.open(port, init);
  sockets.push(opened);
  return opened;
}

/** The headers of `response` whose names start with `access-control-`: CORS, which none sends. */
const corsOf = (response: Response) =>
  [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));

describe("route", () => {
  const policy = policyOf(["localhost:8080", "127.0.0.1:8080"], ["http://localhost:5173"]);
  const socket: RequestFacts = {
    method: "GET",
    path: "/ws",
    host: "localhost:8080",
    origin: null,
    upgrade: "websocket",
    protocols: PROTOCOL_ID,
  };
  const routeOf = (facts: Partial<RequestFacts>): string => {
    const routed = route({ ...socket, ...facts }, policy);
    return routed.kind === "refuse" ? routed.reason : routed.kind;
  };

  test("checks the Host first, then the path, the upgrade and its subprotocol, then the Origin", () => {
    const cases: [Partial<RequestFacts>, string][] = [
      [{}, "socket"],
      [{ host: "LOCALHOST:8080" }, "socket"],
      [{ host: "127.0.0.1:8080", upgrade: "WebSocket" }, "socket"],
      [{ protocols: `other.v1, ${PROTOCOL_ID}` }, "socket"],
      [{ origin: "http://localhost:5173" }, "socket"],
      [{ host: null }, "host"],
      [{ host: "evil.example:8080" }, "host"],
      [{ host: "localhost:8081" }, "host"],
      [{ host: "evil.example", path: "/nowhere", origin: "http://evil.example" }, "host"],
      [{ path: "/healthz" }, "health"],
      [{ path: "/healthz", method: "POST" }, "not_found"],
      [{ method: "POST" }, "not_found"],
      [{ path: "/" }, "not_found"],
      [{ path: "/ws/" }, "not_found"],
      [{ path: "" }, "not_found"],
      [{ protocols: null }, "upgrade_required"],
      [{ protocols: "open-origin.public.v2" }, "upgrade_required"],
      [{ protocols: `${PROTOCOL_ID}x` }, "upgrade_required"],
      [{ upgrade: null }, "upgrade_required"],
      [{ upgrade: "h2c" }, "upgrade_required"],
      [{ upgrade: null, origin: "http://evil.example" }, "upgrade_required"],
      [{ origin: "http://localhost:5174" }, "origin"],
      [{ origin: "http://LOCALHOST:5173" }, "origin"],
      [{ origin: "null" }, "origin"],
      [{ origin: "" }, "origin"],
    ];
    expect(cases.map(([facts]) => routeOf(facts))).toEqual(cases.map(([, expected]) => expected));
  });

  test("allows the listener's own name and address at its port when no Host list is given", () => {
    expect(listenerHosts("127.0.0.1", 9000)).toEqual(["localhost:9000", "127.0.0.1:9000"]);
    expect(listenerHosts("::1", 9000)).toEqual(["localhost:9000", "[::1]:9000"]);
  });
});

describe("Capacity", () => {
  test("refuses past the global cap, and past the cap of one address, and frees on release", () => {
    const capacity = new Capacity({ global: 3, perIp: 2 });
    expect(["a", "a", "a", "b", "c"].map((ip) => capacity.take(ip) ?? "taken")).toEqual([
      "taken",
      "taken",
      "per_ip",
      "taken",
      "global",
    ]);
    expect(capacity.open).toBe(3);
    capacity.release("a");
    expect([capacity.take("c"), capacity.take("a")]).toEqual([undefined, "global"]);
    for (const ip of ["a", "b", "c"]) capacity.release(ip);
    expect(capacity.open).toBe(0);
    expect(() => capacity.release("a")).toThrow("released a connection slot that was not taken");
    expect(() => new Capacity({ global: 0, perIp: 1 })).toThrow(RangeError);
    expect(() => new Capacity({ global: 1, perIp: 1.5 })).toThrow(RangeError);
  });
});

describe("the HTTP surface", () => {
  test("answers /healthz with {ok} and every other path with 404, with no CORS header", async () => {
    const { port } = listen(modelPresentation().presentation);
    const base = `http://${LOOPBACK}:${port}`;
    const health = await fetch(`${base}/healthz`);
    expect([health.status, health.headers.get("content-type")]).toEqual([
      200,
      "application/json;charset=utf-8",
    ]);
    expect(await health.json()).toEqual({ ok: true });
    const answers = [health];
    for (const path of ["/", "/ws/x", "/healthz/", "/index.html", "/admin"]) {
      const response = await fetch(`${base}${path}`);
      expect([path, response.status]).toEqual([path, 404]);
      answers.push(response);
    }
    const post = await fetch(`${base}/healthz`, { method: "POST" });
    expect(post.status).toBe(404);
    expect([...answers, post].flatMap(corsOf)).toEqual([]);
  });

  test("refuses /ws with 426 before the upgrade without the subprotocol or an upgrade", async () => {
    const { port, counting } = listen(modelPresentation().presentation);
    const heads = [
      upgradeHead(port, { "Sec-WebSocket-Protocol": "" }),
      upgradeHead(port, { "Sec-WebSocket-Protocol": "open-origin.public.v2" }),
      `GET /ws HTTP/1.1\r\nHost: ${LOOPBACK}:${port}\r\n\r\n`,
    ];
    for (const head of heads) {
      const answer = await rawRequest(port, head);
      answer.close();
      expect(answer.status).toBe(426);
      expect(answer.head).toContain("\r\nupgrade: websocket");
      expect(answer.head).not.toContain("access-control-");
    }
    // The browser API cannot connect without the subprotocol either.
    await expect(SocketClient.open(port, { protocols: [] })).rejects.toThrow("the upgrade failed");
    expect(counting.last).toBeUndefined();
  });

  test("accepts an Origin only when it matches exactly, and a request without one", async () => {
    const origins = ["http://localhost:5173"];
    const { port, counting } = listen(modelPresentation().presentation, { publicOrigins: origins });
    for (const origin of ["http://evil.example", "http://localhost:5174", "null"]) {
      const refused = await rawRequest(port, upgradeHead(port, { Origin: origin }));
      refused.close();
      expect([origin, refused.status]).toEqual([origin, 403]);
    }
    expect(counting.last).toBeUndefined();
    const allowed = await rawRequest(port, upgradeHead(port, { Origin: "http://localhost:5173" }));
    allowed.close();
    expect(allowed.status).toBe(101);
    expect(allowed.head).toContain(`\r\nsec-websocket-protocol: ${PROTOCOL_ID}`);
    const tool = await client(port);
    expect(tool.socket.protocol).toBe(PROTOCOL_ID);
  });

  test("refuses a Host off its list on every path, and allows the list it is given", async () => {
    const { port } = listen(modelPresentation().presentation);
    for (const path of ["/ws", "/healthz", "/nowhere"]) {
      const response = await fetch(`http://${LOOPBACK}:${port}${path}`, {
        headers: { Host: "evil.example" },
      });
      expect([path, response.status, corsOf(response)]).toEqual([path, 403, []]);
    }
    const refused = await rawRequest(port, upgradeHead(port, { Host: `evil.example:${port}` }));
    refused.close();
    expect(refused.status).toBe(403);
    const named = listen(modelPresentation().presentation, { allowedHosts: ["play.example"] });
    const ownName = await fetch(`http://${LOOPBACK}:${named.port}/healthz`);
    const listed = await fetch(`http://${LOOPBACK}:${named.port}/healthz`, {
      headers: { Host: "PLAY.example" },
    });
    expect([ownName.status, listed.status]).toEqual([403, 200]);
  });

  test("refuses at the cap of one address with 503 and Retry-After, not another address", async () => {
    const { port, logs } = listen(modelPresentation().presentation, {
      connections: { global: 4, perIp: 1 },
    });
    await client(port);
    const same = await rawRequest(port, upgradeHead(port));
    same.close();
    expect(same.status).toBe(503);
    expect(same.head).toContain("\r\nretry-after: 5");
    const other = await rawRequest(port, upgradeHead(port), "127.0.0.2");
    expect(other.status).toBe(101);
    other.close();
    expect(logs).toContainEqual({ event: "refused", status: 503, reason: "capacity_per_ip" });
  });

  test("refuses past the global cap with 503 and Retry-After, and frees a slot on close", async () => {
    const { port, logs, transport } = listen(modelPresentation().presentation, {
      connections: { global: 2, perIp: 2 },
    });
    const first = await client(port);
    await client(port);
    const refused = await rawRequest(port, upgradeHead(port), "127.0.0.2");
    refused.close();
    expect([refused.status, refused.head.includes("\r\nretry-after: 5")]).toEqual([503, true]);
    expect(logs).toContainEqual({ event: "refused", status: 503, reason: "capacity" });
    first.socket.close();
    await until(() => transport.connections() === 1, "the slot to free");
    const admitted = await rawRequest(port, upgradeHead(port), "127.0.0.2");
    admitted.close();
    expect(admitted.status).toBe(101);
  });
});

describe("sockets", () => {
  test("carry hello and a transaction, and a close releases the client", async () => {
    const { presentation, advance } = modelPresentation();
    const { port, counting, transport } = listen(presentation);
    const watcher = await client(port);
    const id = counting.last ?? -1;
    watcher.send(JSON.stringify({ type: "subscribe", chunks: [[0, 0]] }));
    await until(() => counting.received(id) === 1, "the subscribe");
    advance();
    await until(() => watcher.view.commits.length === 1, "a commit");
    expect(watcher.view.messages.map(({ type }) => type)).toEqual(["hello", "snapshot", "commit"]);
    expect(watcher.view.state.view?.chunks.get("0,0")?.beings.get(1)).toEqual(being(1, [3, 3]));
    expect([watcher.errors, watcher.view.anomalies]).toEqual([[], []]);
    watcher.socket.close();
    await until(() => presentation.usage().clients === 0, "the client to go");
    expect([counting.closes, transport.connections()]).toEqual([[id], 0]);
  });

  test("close a binary frame with 1003 and a frame over 4 KiB with 1009; 4 KiB passes", async () => {
    const { presentation } = modelPresentation();
    const { port, counting, logs } = listen(presentation);
    const binary = await client(port);
    binary.send(new Uint8Array([1, 2, 3]));
    expect(await binary.closing()).toBe(CLOSE_CODES.binaryFrame);
    expect(logs).toContainEqual({ event: "binary_frame", size: 3 });
    const large = await client(port);
    const id = counting.last ?? -1;
    large.send(`"${"x".repeat(4094)}"`);
    await until(() => counting.received(id) === 1, "the frame of 4 KiB");
    await until(() => large.view.messages.some(({ type }) => type === "error"), "its error");
    large.send(`"${"x".repeat(4095)}"`);
    expect(await large.closing()).toBe(CLOSE_CODES.tooLarge);
    expect(counting.received(id)).toBe(1);
    await until(() => presentation.usage().clients === 0, "both clients to go");
    expect(counting.closes.length).toBe(2);
  });

  test("close with 1008 on the third strike and with 1011 on a fault, ended by the presentation", async () => {
    const fails = (at: ChunkCoord) => at[0] === 9;
    const { presentation, advance } = modelPresentation({
      readTerrain: (at) => {
        if (fails(at)) throw new Error("a planted terrain fault");
        return terrainAt(at);
      },
    });
    const { port, counting } = listen(presentation);
    const striker = await client(port);
    const struck = counting.last ?? -1;
    for (const text of ["{", '{"type":"ping","nonce":1,"__proto__":{}}', '{"type":"pause"}']) {
      striker.send(text);
    }
    expect(await striker.closing()).toBe(CLOSE_CODES.strikes);
    const errors = striker.view.messages.flatMap((message) =>
      message.type === "error" ? [message.code] : [],
    );
    expect(errors).toEqual(["bad_json", "bad_message"]);
    const faulty = await client(port);
    const faulted = counting.last ?? -1;
    faulty.send(JSON.stringify({ type: "subscribe", chunks: [[9, 9]] }));
    await until(() => counting.received(faulted) === 1, "the subscribe");
    advance();
    expect(await faulty.closing()).toBe(FAULT_CLOSE);
    expect([counting.ended.get(struck)?.reason, counting.ended.get(faulted)?.reason]).toEqual([
      "strikes",
      "fault",
    ]);
    // The presentation released both itself: the transport closed neither there again.
    await Bun.sleep(1);
    expect([counting.closes, presentation.usage().clients]).toEqual([[], 0]);
  });

  test("close every socket with 1001 when the listener stops", async () => {
    const { presentation } = modelPresentation();
    const { port, transport } = listen(presentation);
    const clients = [await client(port), await client(port)];
    await transport.stop();
    expect(await Promise.all(clients.map((one) => one.closing()))).toEqual([1001, 1001]);
    await until(() => presentation.usage().clients === 0, "the clients to go");
    expect(transport.connections()).toBe(0);
    const refused = await fetch(`http://${LOOPBACK}:${port}/healthz`).catch(() => "refused");
    expect(refused).toBe("refused");
  });

  test("map each ending to its close code", () => {
    expect([
      closeCodeOf({ reason: "strikes", code: CLOSE_CODES.strikes }),
      closeCodeOf({ reason: "too_slow", code: CLOSE_CODES.tooSlow }),
      closeCodeOf({ reason: "fault", cause: new Error("x") }),
    ]).toEqual([1008, 1013, 1011]);
  });
});

/**
 * A presentation over a world that never moves from its boot record: one chunk at (0, 0) of
 * 65,536 beings, beings@1's bound, about 6 MB to send, more than loopback's buffers hold.
 */
function densePresentation(): Presentation {
  const beings = Array.from({ length: MAX_CHUNK_BEINGS }, (_, n) =>
    being(n + 1, [n % 32, Math.floor(n / 32) % 32]),
  );
  const boot = { tick: 0, clock: clockAt(0), speech: [], feed: [] };
  const publisher = new Publisher({
    ...boot,
    chunks: [{ at: [0, 0], v: 0, upsert: beings, gone: [] }],
  });
  const clock = new FakeClock();
  return new Presentation({
    subscribeToPublished: publisher.subscribe,
    readTerrain: terrainAt,
    clock,
    timer: new FakeTimer(clock),
    tickRateHz: 5,
    batchTicks: 5,
    world: { id: WORLD_ID, durability: "ephemeral" },
    worldState: () => "running",
  });
}

describe("backpressure (plan test 13)", () => {
  test("a client that stops reading lags alone, and its drain resumes its transaction at once", async () => {
    const presentation = densePresentation();
    const { port, counting } = listen(presentation);
    const reader = await client(port, { countOnly: true });
    const readerId = counting.last ?? -1;
    const paused = await client(port, { countOnly: true });
    const pausedId = counting.last ?? -1;
    paused.socket.pause();
    for (const one of [reader, paused])
      one.send(JSON.stringify({ type: "subscribe", chunks: [[0, 0]] }));
    await until(() => counting.received(pausedId) === 1, "the subscribes");
    // Periods run until the paused client's buffer holds 256 KiB: past what loopback's buffers
    // absorb, Bun keeps the rest, and the fan-out sends that client nothing.
    let periods = 0;
    while (presentation.telemetry().laggingClients === 0 && periods < 40) {
      presentation.period();
      periods += 1;
      await until(() => reader.frames === counting.sent(readerId), "the reader to read");
    }
    expect(presentation.telemetry().laggingClients).toBe(1);
    const before = counting.sent(pausedId);
    expect(before).toBeGreaterThan(paused.frames);
    // It reads again: Bun drains its buffer, and the presentation sends it more within the period
    // it lagged in, before any other period runs.
    paused.socket.resume();
    await until(() => counting.sent(pausedId) > before, "a send after the drain");
    expect(counting.drains).toContain(pausedId);
    // The buffer never passed what the presentation's budget allows, far below Bun's close at 1 MiB.
    expect(counting.peakBuffered).toBeGreaterThanOrEqual(256 * 1024);
    expect(counting.peakBuffered).toBeLessThan(512 * 1024);
    expect([reader.closed, paused.closed]).toEqual([false, false]);
  });

  test("Bun's own: a paused client makes send return −1, then drains and loses nothing", async () => {
    let peer: Bun.ServerWebSocket<undefined> | undefined;
    let drains = 0;
    const server = Bun.serve({
      hostname: LOOPBACK,
      port: 0,
      fetch: (request, bun) =>
        bun.upgrade(request) ? undefined : new Response("no", { status: 400 }),
      websocket: {
        backpressureLimit: 64 * 1024 * 1024,
        open: (socket) => {
          peer = socket;
        },
        message: () => undefined,
        drain: () => {
          drains += 1;
        },
      },
    });
    try {
      const socket = new WebSocket(`ws://${LOOPBACK}:${server.port}/`);
      let received = 0;
      socket.addEventListener("message", (event) => {
        received += String(event.data).length;
      });
      socket.pause();
      await until(() => peer !== undefined && socket.readyState === WebSocket.OPEN, "the socket");
      const frame = "x".repeat(64 * 1024);
      const statuses = new Set<number>();
      for (let sent = 0; sent < 256; sent += 1) {
        statuses.add(Math.sign(peer?.send(frame) ?? 0));
        if (sent % 8 === 7) await Bun.sleep(1);
      }
      // 16 MiB went out: loopback took the first megabytes, then Bun buffered and said so.
      expect([...statuses].sort()).toEqual([-1, 1]);
      expect(peer?.getBufferedAmount()).toBeGreaterThan(1024 * 1024);
      socket.resume();
      await until(() => received === 256 * frame.length, "every byte", 5000);
      expect(drains).toBeGreaterThan(0);
      socket.close();
    } finally {
      await server.stop(true);
    }
  });
});

describe("logs", () => {
  test("hold events, codes, sizes, and counts, never an address or what a client sent", async () => {
    const { presentation } = modelPresentation();
    const { port, logs } = listen(presentation, { connections: { global: 4, perIp: 1 } });
    const canary = "zq-canary-7d1f";
    const one = await client(port, { headers: { Origin: `http://${canary}.example` } }).catch(
      () => undefined,
    );
    expect(one).toBeUndefined();
    const talker = await client(port);
    talker.send(`{"type":"${canary}"}`);
    talker.send(new TextEncoder().encode(canary));
    expect(await talker.closing()).toBe(CLOSE_CODES.binaryFrame);
    const text = JSON.stringify(logs);
    expect(logs.map(({ event }) => event)).toEqual(["refused", "open", "binary_frame", "close"]);
    expect([text.includes(canary), text.includes("127.0.0"), text.includes(PROTOCOL_ID)]).toEqual([
      false,
      false,
      false,
    ]);
  });
});
