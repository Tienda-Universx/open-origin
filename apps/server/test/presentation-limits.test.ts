/**
 * The memory and work limits of the presentation's edge (plan tests 7b and 14 in process; ADR 0026,
 * "Limits and backpressure"). A view is trimmed to its limit at L', the follow window first, then
 * the camera in the client's order, and the client is told what was left out in a `notice`. The
 * replaced versions clients pin are held to their limit after each period's fan-out: every client
 * that pins the oldest is aborted, with its view when it pins that version at L, and the third
 * abort within 60 s closes it with 1013. At most 16 chunks of terrain are generated a period, from
 * a fair queue whose terrain a cache that evicts it cannot take back, and every client of a flood
 * is served. Connections, closes, aborts, faults, and waits for terrain leave every count at zero.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  chunkKey,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import type { ClientId } from "../src/presentation/interest.ts";
import type { Presentation } from "../src/presentation/presentation.ts";
import { TerrainCache, TerrainQueue, WIDEST_TERRAIN_BYTES } from "../src/presentation/terrain.ts";
import {
  being,
  ModelWorld,
  presentationOver,
  terrainAt,
  ViewClient,
} from "./support/presentation.ts";

/** The bytes a chunk of `records` adds to a view: its records, their commas, the widest terrain. */
function viewBytes(records: readonly BeingPublic[]): number {
  const bytes = records.reduce((sum, record) => sum + JSON.stringify(record).length, 0);
  return bytes + records.length + WIDEST_TERRAIN_BYTES;
}

/** `count` beings of the chunk `[x, y]`, from id `first`. */
function beingsOf([x, y]: ChunkCoord, first: number, count: number): BeingPublic[] {
  return Array.from({ length: count }, (_, n) =>
    being(first + n, [x * 32 + (n % 32), y * 32 + Math.floor(n / 32)]),
  );
}

/** The chunk keys a client's view shows. */
const keysOf = (client: ViewClient) => [...(client.state.view?.chunks.keys() ?? [])].sort();

/** The chunk keys of `chunks`, sorted. */
const sortedKeys = (chunks: readonly ChunkCoord[]) => chunks.map(chunkKey).sort();

describe("the view's limit", () => {
  test("keeps the follow window first, then the camera in the client's order, and lists the rest in a notice", () => {
    // The followed being's chunk, (10, 10), holds 40 beings; its neighbors are empty. The camera's
    // chunks hold 30, 5, and 1 beings, in the order the client sends them.
    const center: ChunkCoord = [10, 10];
    const camera: ChunkCoord[] = [
      [0, 0],
      [3, 0],
      [6, 0],
    ];
    const followed = beingsOf(center, 1, 40);
    const [big, small, tiny] = [
      beingsOf([0, 0], 100, 30),
      beingsOf([3, 0], 200, 5),
      beingsOf([6, 0], 300, 1),
    ];
    const model = new ModelWorld(0, [...followed, ...big, ...small, ...tiny]);
    const window = viewBytes(followed) + 8 * viewBytes([]);
    // The window and the big chunk fit, the small one does not, and the tiny one, which would fit,
    // comes after it: the prefix stops at the first chunk that does not fit.
    const limit = window + viewBytes(big) + viewBytes(small) - 1;
    const { presentation, advance } = presentationOver(model, { viewBytes: limit });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, camera);
    presentation.follow(id, 1);
    presentation.period();
    expect(client.messages[0]).toMatchObject({ type: "hello", limits: { maxViewBytes: limit } });
    expect(client.messages[1]).toEqual({
      type: "notice",
      seq: 1,
      tick: 0,
      code: "interest_trimmed",
      chunks: [
        [3, 0],
        [6, 0],
      ],
    });
    const windowKeys = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => `${10 + dx},${10 + dy}`));
    expect(keysOf(client)).toEqual([...windowKeys, "0,0"].sort());
    expect(client.state.trimmed).toEqual([
      [3, 0],
      [6, 0],
    ]);
    expect(presentation.telemetry().trims).toBe(1);
    // The same trim again tells nothing new; a camera that fits is not trimmed.
    advance();
    expect(client.messages.filter(({ type }) => type === "notice")).toHaveLength(1);
    expect(presentation.telemetry().trims).toBe(2);
    presentation.subscribe(id, [
      [6, 0],
      [3, 0],
    ]);
    advance();
    expect(keysOf(client)).toEqual([...windowKeys, "3,0", "6,0"].sort());
    expect(client.messages.filter(({ type }) => type === "notice")).toHaveLength(1);
    expect(presentation.telemetry().trims).toBe(2);
  });

  test("is the one hello announces: 32 MiB unless set", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation } = presentationOver(model);
    const client = new ViewClient();
    presentation.connect(client);
    presentation.period();
    expect(client.messages[0]).toMatchObject({ limits: { maxViewBytes: 32 * 1024 * 1024 } });
  });
});

/**
 * Chunk P holds one being and never changes; chunk Q holds 150, and one of them moves each tick.
 * Being 2, far from both in chunk (5, 5), never moves either.
 */
const P: ChunkCoord = [0, 0];
const Q: ChunkCoord = [1, 0];

/** The bytes of Q's records: the size of one of its versions, give or take a digit. */
const VERSION_OF_Q = beingsOf(Q, 100, 150).reduce((sum, b) => sum + JSON.stringify(b).length, 0);

/**
 * A presentation over P and Q whose limit of retained bytes is `limit`: unless given, less than one
 * version of Q. Q's content spans two parts of 16 KiB, one a period.
 */
function retaining(limit = VERSION_OF_Q - 1) {
  const model = new ModelWorld(0, [
    being(1, [5, 5]),
    being(2, [165, 165]),
    ...beingsOf(Q, 100, 150),
  ]);
  let step = 0;
  /** One being of Q moves a cell. */
  const moveQ = () => {
    step += 1;
    return { set: [being(100, [32 + (step % 32), 31])] };
  };
  const over = presentationOver(model, {
    partBytes: 16_384,
    periodBytes: 16_384,
    retainedBytes: limit,
  });
  return { ...over, model, moveQ };
}

/**
 * Makes `client` read Q in a transaction, then lags it while Q changes: the memory guard aborts it.
 * Returns the abort it received, once it drains.
 */
function abortOnce(over: ReturnType<typeof retaining>, client: ViewClient) {
  const { presentation, advance, moveQ } = over;
  const before = presentation.telemetry().aborts;
  // A transaction that brings Q starts and sends its first part; the second waits for next period.
  advance(moveQ());
  client.lag = true;
  advance(moveQ());
  expect(presentation.telemetry().aborts).toBe(before + 1);
  client.lag = false;
}

describe("the limit of retained versions", () => {
  test("aborts the client that pins the oldest, keeping its view when it pins that version only in its transaction", () => {
    const over = retaining();
    const { presentation, advance, moveQ } = over;
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [P]);
    presentation.period();
    expect(keysOf(client)).toEqual(["0,0"]);
    presentation.subscribe(id, [P, Q]);
    abortOnce(over, client);
    expect(presentation.usage()).toMatchObject({ retainedBytes: 0, retained: 0 });
    // Back from its lag, the client hears the abort first; its view at L stays, and the next
    // transaction brings Q into it, with no reset.
    const seen = client.messages.length;
    advance(moveQ());
    const next = client.messages.slice(seen);
    expect(next[0]).toMatchObject({ type: "abort", txn: 1, tick: 1 });
    expect(next[1]).toMatchObject({ type: "snapshot", txn: 2, reset: false });
    advance(moveQ());
    expect(keysOf(client)).toEqual(["0,0", "1,0"]);
    expect(client.commits.at(-1)).toMatchObject({ txn: 2, reset: false });
    expect(client.anomalies).toEqual([]);
  });

  test("releases the view of a client that pins the oldest at L, so its next transaction is a reset", () => {
    const { presentation, advance, moveQ } = retaining();
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [Q]);
    // The reset spans two periods; the next transaction brings the view to tick 2.
    presentation.period();
    advance();
    advance();
    expect(client.commits.at(-1)).toMatchObject({ tick: 2 });
    client.lag = true;
    advance(moveQ());
    expect(presentation.telemetry().aborts).toBe(1);
    expect(presentation.usage()).toMatchObject({ pins: 0, retainedBytes: 0 });
    client.lag = false;
    const seen = client.messages.length;
    advance(moveQ());
    advance(moveQ());
    // Nothing was in flight: no abort, and the next transaction is a reset of the whole view.
    expect(client.messages.slice(seen).some(({ type }) => type === "abort")).toBe(false);
    expect(client.commits.at(-1)).toMatchObject({ reset: true });
    expect(keysOf(client)).toEqual(["1,0"]);
  });

  test("aborts only the clients that pin the oldest retained version, the furthest behind", () => {
    // The limit holds one version of Q, not two.
    const { presentation, advance, moveQ } = retaining(Math.floor(VERSION_OF_Q * 1.5));
    const [behind, after] = [new ViewClient(), new ViewClient()];
    for (const client of [behind, after]) presentation.subscribe(presentation.connect(client), [Q]);
    presentation.period();
    advance();
    advance();
    behind.lag = true;
    // Q is replaced: `behind` alone keeps its version of tick 0, within the limit.
    advance(moveQ());
    expect(presentation.telemetry().aborts).toBe(0);
    expect(presentation.usage().retained).toBe(1);
    after.lag = true;
    // `after` keeps the version of tick 3, and the two pass the limit: only the oldest goes.
    advance(moveQ());
    expect(presentation.telemetry().aborts).toBe(1);
    expect(presentation.usage().retained).toBe(1);
    behind.lag = false;
    after.lag = false;
    const seen = behind.messages.length;
    advance(moveQ());
    advance(moveQ());
    expect(behind.messages.slice(seen).some(({ type }) => type === "abort")).toBe(false);
    expect(behind.commits.at(-1)).toMatchObject({ reset: true });
    expect(after.commits.at(-1)).toMatchObject({ reset: false });
  });

  test("closes a client with 1013 at its third abort within 60 s, and not when the first is 60 s old", () => {
    const over = retaining();
    const { presentation, advance, clock } = over;
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [P]);
    presentation.period();
    presentation.subscribe(id, [P, Q]);
    const at = (micros: number) => clock.advance(micros - clock.time);
    for (const time of [0, 1_000_000, 60_000_000]) {
      at(time);
      abortOnce(over, client);
    }
    // At 60 s, the abort at 0 s no longer counts: two count, and the client stays.
    expect(client.ended).toBeUndefined();
    at(60_999_999);
    abortOnce(over, client);
    expect(client.ended).toEqual({ reason: "too_slow", code: 1013 });
    expect(presentation.telemetry()).toMatchObject({ aborts: 4, slowCloses: 1, connections: 0 });
    expect(() => presentation.close(id)).toThrow(`client ${id} is not connected`);
    advance();
    expect(presentation.usage()).toMatchObject({ clients: 0, pins: 0, retainedBytes: 0 });
  });
});

/** A readTerrain that counts its calls. */
function countingTerrain() {
  const calls: string[] = [];
  const read = (at: ChunkCoord): TerrainPublic => {
    calls.push(chunkKey(at));
    return terrainAt(at);
  };
  return { calls, read };
}

describe("terrain", () => {
  test("a flood of clients, each entering 64 new chunks, generates at most 16 a period, each once, and serves every client", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { calls, read } = countingTerrain();
    const { presentation, advance } = presentationOver(model, { readTerrain: read });
    const clients = Array.from({ length: 10 }, (_, k) => {
      const client = new ViewClient();
      const camera = Array.from({ length: 64 }, (_, n): ChunkCoord => [100 + n, 10 * k]);
      presentation.subscribe(presentation.connect(client), camera);
      return { client, camera };
    });
    const perPeriod: number[] = [];
    /** The period at which each client first showed its whole camera. */
    const served = new Map<number, number>();
    for (let period = 1; served.size < clients.length && period <= 60; period += 1) {
      const before = calls.length;
      advance();
      perPeriod.push(calls.length - before);
      for (const [k, { client, camera }] of clients.entries()) {
        if (!served.has(k) && keysOf(client).join() === sortedKeys(camera).join())
          served.set(k, period);
      }
    }
    expect(Math.max(...perPeriod)).toBe(16);
    expect(calls.length).toBe(640);
    expect(new Set(calls).size).toBe(640);
    // 640 chunks at 16 a period take 40 periods; each client's view then takes two to send.
    expect(served.size).toBe(10);
    expect(Math.max(...served.values())).toBeLessThanOrEqual(42);
    // The queue serves the waiting clients in turn: the last nine finish within two periods.
    const finish = [...served.values()].sort((a, b) => a - b);
    expect((finish.at(-1) ?? 0) - (finish[1] ?? 0)).toBeLessThanOrEqual(2);
    expect(presentation.telemetry().terrainQueue).toBe(0);
    expect(presentation.usage().terrain).toEqual({ queued: 0, held: 0 });
  });

  test("kept for a waiting client, it is never generated twice when the cache evicts it", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read, 2), 1);
    const row = (y: number) => [0, 1, 2].map((x): ChunkCoord => [x, y]);
    const [mine, theirs] = [row(0), row(1)];
    const faults: unknown[] = [];
    const fault = (_client: ClientId, cause: unknown) => faults.push(cause);
    queue.period(fault);
    expect(queue.take(1, mine)).toBeUndefined();
    expect(queue.take(2, theirs)).toBeUndefined();
    for (let period = 0; period < 5; period += 1) queue.period(fault);
    // Six chunks went through a cache of two: those of client 1 are kept for it all the same.
    expect(calls).toHaveLength(6);
    expect(queue.held).toBe(6);
    expect([...(queue.take(1, mine)?.keys() ?? [])].sort()).toEqual(sortedKeys(mine));
    expect([...(queue.take(2, theirs)?.keys() ?? [])].sort()).toEqual(sortedKeys(theirs));
    expect(calls).toHaveLength(6);
    expect([queue.queued, queue.held, faults.length]).toEqual([0, 0, 0]);
  });
});

/** A sink that throws on its `failOn`th message, as a socket that broke would. */
function breaking(failOn: number) {
  let sent = 0;
  const ended: string[] = [];
  return {
    ended,
    sink: {
      send: () => {
        sent += 1;
        if (sent === failOn) throw new Error("socket gone");
      },
      buffered: () => 0,
      end: ({ reason }: { readonly reason: string }) => ended.push(reason),
    },
  };
}

/** The usage of a presentation every client left. */
const EMPTY = {
  clients: 0,
  interest: { clients: 0, indexEntries: 0, following: 0 },
  pins: 0,
  retainedBytes: 0,
  retained: 0,
  terrain: { queued: 0, held: 0 },
};

/** Connects `client` and sends its camera, and, when given, the being it follows. */
function join(
  presentation: Presentation,
  client: ViewClient,
  camera: readonly ChunkCoord[],
  being?: number,
): ClientId {
  const id = presentation.connect(client);
  presentation.receive(id, JSON.stringify({ type: "subscribe", chunks: camera }));
  if (being !== undefined) presentation.receive(id, JSON.stringify({ type: "follow", being }));
  return id;
}

/**
 * One cycle of clients that a fault, strikes, and slowness close, one aborted and closed, and one
 * that waits for terrain and closes; then nothing is left.
 */
function cycle(over: ReturnType<typeof retaining>, index: number): void {
  const { presentation, advance, moveQ, clock } = over;
  // Each cycle's aborts and strikes are a minute apart from the last.
  clock.advance(61_000_000);
  const [plain, slow, striker] = [new ViewClient(), new ViewClient(), new ViewClient()];
  const plainId = join(presentation, plain, [P], 2);
  const slowId = join(presentation, slow, [P]);
  const strikerId = join(presentation, striker, [P]);
  const broken = breaking(2);
  presentation.subscribe(presentation.connect(broken.sink), [P]);
  presentation.period();
  expect(broken.ended).toEqual(["fault"]);
  for (const text of ["{", "{", "{"]) presentation.receive(strikerId, text);
  expect(striker.ended).toMatchObject({ reason: "strikes" });
  presentation.subscribe(slowId, [P, Q]);
  for (let abort = 0; abort < 3; abort += 1) abortOnce(over, slow);
  expect(slow.ended).toMatchObject({ reason: "too_slow" });
  presentation.abort(plainId, { releaseView: true });
  // A client that waits for terrain: far chunks, more than a period generates.
  const far = Array.from({ length: 40 }, (_, n): ChunkCoord => [500 + index * 40 + n, 0]);
  const farId = join(presentation, new ViewClient(), far);
  advance(moveQ());
  expect(presentation.usage().terrain.queued).toBeGreaterThan(0);
  presentation.close(plainId);
  presentation.close(farId);
  expect(presentation.usage()).toMatchObject(EMPTY);
}

describe("cleanup", () => {
  test("connect and close cycles, aborts, faults, strikes, slowness, and waits for terrain leave every count at zero", () => {
    const over = retaining();
    for (let index = 0; index < 6; index += 1) cycle(over, index);
    expect(over.presentation.usage()).toMatchObject({ ...EMPTY, failed: false });
    expect(over.presentation.telemetry()).toMatchObject({
      connections: 0,
      laggingClients: 0,
      retainedBytes: 0,
      terrainQueue: 0,
      aborts: 18,
      faults: 6,
      strikeCloses: 6,
      slowCloses: 6,
    });
    expect(over.presentation.followers(2)).toBe(0);
  });
});
