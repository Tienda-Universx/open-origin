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
import { connect } from "node:net";
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
  type PresentationPort,
  SOCKET_OPTIONS,
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

/** The options of a listener on a free loopback port over `presentation`, logging to `logs`. */
function transportOptions(
  presentation: PresentationPort,
  logs: TransportEvent[],
): TransportOptions {
  return {
    presentation,
    hostname: LOOPBACK,
    port: 0,
    publicOrigins: [],
    allowedHosts: undefined,
    connections: { global: 64, perIp: 16 },
    log: (event) => logs.push(event),
  };
}

/** A listener on a free loopback port over `presentation`, its port counting what passes. */
function listen(presentation: Presentation, options: Partial<TransportOptions> = {}) {
  const logs: TransportEvent[] = [];
  const counting = new CountingPort(presentation);
  const transport = serveTransport({ ...transportOptions(counting, logs), ...options });
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
    version: "13",
  };
  const routeOf = (facts: Partial<RequestFacts>): string => {
    const routed = route({ ...socket, ...facts }, policy);
    return routed.kind === "refuse" ? routed.reason : routed.kind;
  };

  test("checks the Host first, then the method and path, the upgrade, its subprotocol and version, then the Origin", () => {
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
      [{ host: "evil.example", path: "/healthz", method: "POST" }, "host"],
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
      [{ version: "8" }, "version"],
      [{ version: null }, "version"],
      [{ version: "13, 8" }, "version"],
      [{ version: "8", origin: "http://evil.example" }, "version"],
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

  test("refuses a WebSocket version other than 13 with its own 426, which names 13", async () => {
    const { port, logs, counting, transport } = listen(modelPresentation().presentation);
    for (const version of ["8", ""]) {
      const answer = await rawRequest(
        port,
        upgradeHead(port, { "Sec-WebSocket-Version": version }),
      );
      answer.close();
      expect([version, answer.status]).toEqual([version, 426]);
      expect(answer.head).toContain("\r\nsec-websocket-version: 13");
    }
    expect(logs).toEqual([
      { event: "refused", status: 426, reason: "version" },
      { event: "refused", status: 426, reason: "version" },
    ]);
    expect([counting.last, transport.connections()]).toEqual([undefined, 0]);
  });

  test("refuses a handshake Bun cannot complete with 400, and gives its slot back", async () => {
    const { port, logs, transport } = listen(modelPresentation().presentation, {
      connections: { global: 1, perIp: 1 },
    });
    for (const key of ["", "abc"]) {
      const answer = await rawRequest(port, upgradeHead(port, { "Sec-WebSocket-Key": key }));
      answer.close();
      // The answer is the listener's own: its fixed text is 31 bytes.
      expect([key, answer.status, answer.head.includes("content-length: 31")]).toEqual([
        key,
        400,
        true,
      ]);
    }
    expect(logs.filter(({ event }) => event === "refused")).toEqual([
      { event: "refused", status: 400, reason: "handshake" },
      { event: "refused", status: 400, reason: "handshake" },
    ]);
    // The only slot is free: a client connects.
    expect(transport.connections()).toBe(0);
    await client(port);
  });

  test("answers 500 when answering a request throws, and logs the error's name only", async () => {
    const logs: TransportEvent[] = [];
    const { port } = listen(modelPresentation().presentation, {
      log: (event) => {
        if (event.event === "refused") throw new Error("a planted fault zq-canary");
        logs.push(event);
      },
    });
    const response = await fetch(`http://${LOOPBACK}:${port}/nowhere`);
    expect([response.status, await response.text(), corsOf(response)]).toEqual([
      500,
      "internal error",
      [],
    ]);
    expect(logs).toEqual([{ event: "handler_error", error: "Error" }]);
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
    const requests: readonly (readonly [string, string])[] = [
      ["GET", "/ws"],
      ["GET", "/healthz"],
      ["GET", "/nowhere"],
      // The Host is checked before the method: this is 403, not 404.
      ["POST", "/healthz"],
    ];
    for (const [method, path] of requests) {
      const response = await fetch(`http://${LOOPBACK}:${port}${path}`, {
        method,
        headers: { Host: "evil.example" },
      });
      expect([method, path, response.status, corsOf(response)]).toEqual([method, path, 403, []]);
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

  test("close with 1011 when connecting the client throws, and give the slot back", async () => {
    const { presentation } = modelPresentation();
    const failing: PresentationPort = {
      connect: () => {
        throw new Error("a planted connect fault");
      },
      receive: (id, text) => presentation.receive(id, text),
      drained: (id) => presentation.drained(id),
      close: (id) => presentation.close(id),
    };
    const logs: TransportEvent[] = [];
    const transport = serveTransport({ ...transportOptions(failing, logs) });
    running.push(transport);
    // The upgrade completed: the client opens, then hears 1011 at once.
    const victim = await client(transport.port);
    expect(await victim.closing()).toBe(FAULT_CLOSE);
    await until(() => transport.connections() === 0, "the slot");
    expect(logs).toContainEqual({ event: "handler_error", error: "Error" });
    expect(logs).toContainEqual({ event: "close", code: 1011, connections: 0 });
  });

  test("close with 1011 when the presentation throws in a handler, and release the client", async () => {
    const { presentation } = modelPresentation();
    const counting = new CountingPort(presentation);
    const throwing: PresentationPort = {
      connect: (sink) => counting.connect(sink),
      receive: (id, text) => {
        if (text === "boom") throw new Error("a planted receive fault zq-canary");
        counting.receive(id, text);
      },
      drained: (id) => counting.drained(id),
      close: (id) => counting.close(id),
    };
    const logs: TransportEvent[] = [];
    const transport = serveTransport(transportOptions(throwing, logs));
    running.push(transport);
    const victim = await client(transport.port);
    const id = counting.last ?? -1;
    victim.send("boom");
    expect(await victim.closing()).toBe(FAULT_CLOSE);
    await until(() => presentation.usage().clients === 0, "the client to go");
    expect([counting.closes, transport.connections()]).toEqual([[id], 0]);
    expect(logs).toContainEqual({ event: "handler_error", error: "Error" });
    expect(JSON.stringify(logs)).not.toContain("zq-canary");
  });

  test("give the slot back when a client goes in the middle of its handshake", async () => {
    const { presentation } = modelPresentation();
    const { port, counting, transport } = listen(presentation);
    // One sends half a request and leaves; one sends a whole upgrade and leaves before the answer.
    for (const request of [upgradeHead(port).slice(0, 40), upgradeHead(port)]) {
      const socket = connect({ host: LOOPBACK, port });
      socket.on("error", () => undefined);
      socket.end(request);
    }
    await until(() => counting.last !== undefined, "the whole upgrade");
    const id = counting.last ?? -1;
    await until(
      () => transport.connections() === 0 && presentation.usage().clients === 0,
      "the slots and the client to go",
    );
    expect(counting.closes).toEqual([id]);
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

describe("Bun's limits", () => {
  test("are ADR 0026's numbers", () => {
    // This pins the spec's numbers: an idle timeout of 120 s and its pings cannot be observed in a
    // test's time, so these options are checked as data; the buffer's limit is checked below too.
    expect(SOCKET_OPTIONS).toEqual({
      maxPayloadLength: 4096,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      sendPings: true,
    });
  });

  test("close a client that does not read once 1 MiB waits for it, and release it once", async () => {
    const { presentation } = modelPresentation();
    const { port, counting, transport, logs } = listen(presentation);
    const stalled = await client(port, { countOnly: true });
    const id = counting.last ?? -1;
    stalled.socket.pause();
    const sink = counting.sinks.get(id);
    if (sink === undefined) throw new Error("no sink");
    // 8 MiB, sent straight through the sink: loopback takes a few megabytes, and Bun the rest
    // until 1 MiB waits, when it closes the socket.
    const frame = "z".repeat(64 * 1024);
    let peak = 0;
    for (let sent = 0; sent < 128 && transport.connections() > 0; sent += 1) {
      sink.send(frame);
      peak = Math.max(peak, sink.buffered());
      if (sent % 4 === 3) await Bun.sleep(1);
    }
    await until(() => transport.connections() === 0, "Bun to close the socket");
    expect(peak).toBeLessThanOrEqual(1024 * 1024 + frame.length);
    await until(() => counting.closes.length === 1, "the client to go");
    expect([counting.closes, presentation.usage().clients]).toEqual([[id], 0]);
    expect(logs.at(-1)).toMatchObject({ event: "close", connections: 0 });
  });
});

describe("Bun's order", () => {
  test("runs the open handler within upgrade, which the slots of the caps rely on", async () => {
    // The transport takes a slot before `upgrade` and gives it back in the close handler: that is
    // exact only while Bun opens the socket inside `upgrade`, as Bun 1.4.4 does.
    let opened = 0;
    const seen: number[] = [];
    const server = Bun.serve({
      hostname: LOOPBACK,
      port: 0,
      fetch: (request, bun) => {
        const upgraded = bun.upgrade(request);
        seen.push(opened);
        return upgraded ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open: () => {
          opened += 1;
        },
        message: () => undefined,
      },
    });
    try {
      const socket = new WebSocket(`ws://${LOOPBACK}:${server.port}/`);
      await until(() => socket.readyState === WebSocket.OPEN, "the socket");
      expect(seen).toEqual([1]);
      socket.close();
    } finally {
      await server.stop(true);
    }
  });
});

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
    // Periods run until the paused client's buffer holds 256 KiB: past what loopback absorbs, Bun
    // keeps the rest, and the fan-out sends that client nothing. How much loopback absorbs is the
    // kernel's: a send buffer of at most tcp_wmem's maximum, 4 MiB by default, and a receive window
    // that does not grow while the client does not read. The chunk's 6 MB pass it, so the lag must
    // come within the 24 periods of its transaction; the bound of 64 is generous, and only a kernel
    // that absorbs all 6 MB would reach it.
    let periods = 0;
    while (presentation.telemetry().laggingClients === 0 && periods < 64) {
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
    // The presentation guarantees an upper bound on the buffer: under 256 KiB before each message,
    // and a message of at most 64 KiB, within ADR 0026's 512 KiB and far below Bun's close at 1 MiB.
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
      // 16 MiB went out: loopback took the first megabytes, at most tcp_wmem's maximum (4 MiB by
      // default) and a receive window that stays small while nothing reads; Bun buffered the rest
      // and said so.
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
