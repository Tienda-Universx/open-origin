/**
 * The memory and work limits of the presentation's edge (plan tests 7b and 14 in process; ADR 0026,
 * "Limits and backpressure"). A view is trimmed to its limit at L', the follow window first, then
 * the camera in the client's order, and the client is told what was left out in a `notice`, all of
 * it when the followed being's own chunk alone passes the limit. The replaced versions clients pin
 * are held to their limit after each period's fan-out: every client that pins the oldest is
 * aborted, with its view when it pins that version at L, and the third abort within 60 s closes it
 * with 1013. At most 16 chunks of terrain are generated a period, from a queue served first come,
 * first served that holds terrain for its head alone, which a cache that evicts it cannot take
 * back; the clients of a flood are served in the order they arrived, and a generation that throws
 * drops its client alone. Connections, closes, aborts, faults, and waits for terrain leave every
 * count at zero.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  chunkKey,
  MAX_VIEW_CHUNKS,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import type { ClientId } from "../src/presentation/interest.ts";
import type { Ending, Presentation } from "../src/presentation/presentation.ts";
import { guardRetention } from "../src/presentation/retention.ts";
import { TerrainCache, TerrainQueue, WIDEST_TERRAIN_BYTES } from "../src/presentation/terrain.ts";
import { ChunkVersion } from "../src/presentation/version.ts";
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

/** The window of the chunk (10, 10), its center first, then the camera's chunk (0, 0). */
const CENTER_FIRST: ChunkCoord[] = [
  [10, 10],
  [9, 9],
  [10, 9],
  [11, 9],
  [9, 10],
  [11, 10],
  [9, 11],
  [10, 11],
  [11, 11],
  [0, 0],
];

/**
 * A client whose view limit the chunk (10, 10) passes alone, with the 40 beings it holds, being 1
 * among them, while its camera, the empty chunk (0, 0), fits: it shows the camera.
 */
function oversizedCenter() {
  const followed = beingsOf([10, 10], 1, 40);
  const over = presentationOver(new ModelWorld(0, followed), {
    viewBytes: viewBytes(followed) - 1,
  });
  const client = new ViewClient();
  const id = over.presentation.connect(client);
  over.presentation.subscribe(id, [[0, 0]]);
  over.presentation.period();
  expect(keysOf(client)).toEqual(["0,0"]);
  return { ...over, client, id };
}

/** The notices `client` received. */
const noticesOf = (client: ViewClient) =>
  client.messages.flatMap((message) => (message.type === "notice" ? [message] : []));

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

  test("drops the whole view when the followed being's own chunk alone passes the limit, and lists every chunk in a notice", () => {
    const { presentation, advance, client, id } = oversizedCenter();
    presentation.follow(id, 1);
    advance();
    // The prefix that fits is empty: the window, the followed being's chunk first, and the camera
    // are all left out, and the view drops the chunk it showed.
    expect(noticesOf(client)).toEqual([
      { type: "notice", seq: 3, tick: 0, code: "interest_trimmed", chunks: CENTER_FIRST },
    ]);
    expect(keysOf(client)).toEqual([]);
    expect(client.state.trimmed).toEqual(CENTER_FIRST);
    // The transaction still names the followed being, whose record the view keeps.
    expect(client.state.view?.followed).toEqual(being(1, [320, 320]));
    expect(presentation.telemetry().trims).toBe(1);
    expect(client.anomalies).toEqual([]);
  });

  test("tells the client again when the chunks left out change after none were", () => {
    const { presentation, advance, client, id } = oversizedCenter();
    presentation.follow(id, 1);
    advance();
    // Following no one, the camera fits: nothing is left out, and no notice says so.
    presentation.follow(id, null);
    advance();
    expect(keysOf(client)).toEqual(["0,0"]);
    expect(noticesOf(client)).toHaveLength(1);
    // The same chunks left out again are a change from none: a second notice lists them.
    presentation.follow(id, 1);
    advance();
    expect(noticesOf(client).map(({ chunks }) => chunks)).toEqual([CENTER_FIRST, CENTER_FIRST]);
    expect(keysOf(client)).toEqual([]);
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

/** A client as the memory guard reads it, with a name the test reports aborts by. */
type Pinning = {
  readonly name: string;
  view: { pinned: Map<string, ChunkVersion> };
  txn: { pins: Map<string, ChunkVersion> } | undefined;
};

/** A client whose view at L pins `view` and whose transaction, if any, pins `txn`. */
function pinning(name: string, view: ChunkVersion[], txn?: ChunkVersion[]): Pinning {
  const byKey = (versions: ChunkVersion[]) => new Map(versions.map((v) => [v.key, v]));
  return { name, view: { pinned: byKey(view) }, txn: txn && { pins: byKey(txn) } };
}

/**
 * The guard over `clients` and `versions`, the replaced versions, oldest first, each one byte while
 * a client pins it. It aborts as the presentation does: a client's transaction goes, and its view
 * too at L. The guard reads the clients through an iterable that counts the clients it yields.
 */
function guarding(versions: readonly ChunkVersion[], clients: readonly Pinning[], limit: number) {
  const pinned = (version: ChunkVersion) =>
    clients.some(
      ({ view, txn }) =>
        view.pinned.get(version.key) === version || txn?.pins.get(version.key) === version,
    );
  const mirror = {
    get retainedBytes() {
      return versions.filter(pinned).length;
    },
    oldestRetained: () => versions.find(pinned),
    retains: (version: ChunkVersion) => versions.includes(version) && pinned(version),
  };
  let read = 0;
  const counted = {
    *[Symbol.iterator]() {
      for (const client of clients) {
        read += 1;
        yield client;
      }
    },
  };
  const aborts: [string, boolean][] = [];
  const abort = (client: Pinning, atL: boolean) => {
    aborts.push([client.name, atL]);
    client.txn = undefined;
    if (atL) client.view.pinned = new Map();
  };
  const aborted = guardRetention(mirror, limit, counted, abort);
  return {
    aborted: [...aborted].map(({ name }) => name),
    aborts,
    read,
    left: mirror.retainedBytes,
  };
}

/** The version `v` of the chunk `[x, 0]`. */
const versionOf = (x: number, v: number) => ChunkVersion.empty([x, 0], v);

describe("the memory guard", () => {
  test("aborts every client that pins the oldest retained version, with its view when it pins it at L, and reports each client once", () => {
    const [a1, b1, a2, b2] = [versionOf(0, 1), versionOf(1, 1), versionOf(0, 2), versionOf(1, 2)];
    const clients = [
      pinning("at L", [a1]),
      // Its transaction pins a1, and its view b1: two aborts in one check, reported once.
      pinning("both", [b1], [a1]),
      pinning("current", [a2, b2]),
      pinning("in transaction", [a2], [b1]),
    ];
    // Down to one byte, the oldest goes alone: one version, b1, may stay.
    expect(guarding([a1, b1], clients, 1)).toEqual({
      aborted: ["at L", "both"],
      aborts: [
        ["at L", true],
        ["both", false],
      ],
      read: 4,
      left: 1,
    });
  });

  test("frees every version over the limit", () => {
    const [a1, b1, a2, b2] = [versionOf(0, 1), versionOf(1, 1), versionOf(0, 2), versionOf(1, 2)];
    const clients = [
      pinning("at L", [a1]),
      pinning("both", [b1], [a1]),
      pinning("current", [a2, b2]),
      pinning("in transaction", [a2], [b1]),
    ];
    expect(guarding([a1, b1], clients, 0)).toEqual({
      aborted: ["at L", "both", "in transaction"],
      aborts: [
        ["at L", true],
        ["both", false],
        ["both", true],
        ["in transaction", false],
      ],
      read: 4,
      left: 0,
    });
  });

  test("reads every client once a check, however many versions it frees, and none under the limit", () => {
    const versions = Array.from({ length: 50 }, (_, x) => versionOf(x, 1));
    const clients = versions.map((version, x) => pinning(`client ${x}`, [], [version]));
    const freed = guarding(versions, clients, 0);
    expect(freed.aborted).toEqual(clients.map(({ name }) => name));
    expect([freed.read, freed.left]).toEqual([50, 0]);
    const within = guarding(
      versions,
      versions.map((version, x) => pinning(`${x}`, [version])),
      50,
    );
    expect([within.aborted, within.read, within.left]).toEqual([[], 0, 50]);
  });

  test("fails fast when aborting the clients that pin the oldest version does not free it", () => {
    const old = versionOf(0, 1);
    const stuck = pinning("stuck", [old]);
    const mirror = { retainedBytes: 1, oldestRetained: () => old, retains: () => true };
    expect(() => guardRetention(mirror, 0, [stuck], () => undefined)).toThrow(
      "the retained version 1 of chunk 0,0 is still pinned once its clients were aborted",
    );
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

/** The chunks `[0, y]` to `[n − 1, y]`. */
const row = (y: number, n = 3) => Array.from({ length: n }, (_, x): ChunkCoord => [x, y]);

/** The chunk keys of the terrain a queue returned, sorted; none when it returned nothing. */
const takenKeys = (taken: ReadonlyMap<string, unknown> | undefined) =>
  [...(taken?.keys() ?? [])].sort();

/** The fault callback of a queue whose generations never throw: a fault fails the test. */
const noFault = (client: ClientId, cause: unknown) => {
  throw new Error(`the terrain of client ${client} threw`, { cause });
};

describe("terrain", () => {
  test("a flood of clients, each entering 64 new chunks, generates at most 16 a period, each once, and serves every client in arrival order", () => {
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
    const held: number[] = [];
    /** The period at which each client first showed its whole camera. */
    const served = new Map<number, number>();
    for (let period = 1; served.size < clients.length && period <= 60; period += 1) {
      const before = calls.length;
      advance();
      perPeriod.push(calls.length - before);
      held.push(presentation.usage().terrain.held);
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
    // The queue serves the waiting clients first come, first served: each client's 64 chunks take
    // four periods, its view two more to send, and the clients finish in the order they asked.
    expect(clients.map((_, k) => served.get(k))).toEqual([5, 9, 13, 17, 21, 25, 29, 33, 37, 41]);
    // Terrain is held for the head of the queue alone: at the end of a period, the head holds 16
    // chunks more, until its transaction starts and the next client, with nothing cached yet, is
    // the head. Not one chunk is held for the nine clients behind it.
    expect(held).toEqual([...Array.from({ length: 10 }, () => [16, 32, 48, 0]).flat(), 0]);
    expect(presentation.telemetry().terrainQueue).toBe(0);
    expect(presentation.usage().terrain).toEqual({ queued: 0, held: 0 });
  });

  test("the queue serves its clients first come, first served: the head gets the period's generations until it needs nothing more, then the next", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read), 2);
    const [a, b, c] = [row(0), row(1), row(2, 2)];
    // Client 1 spends the budget at once and waits for one chunk; clients 2 and 3 wait for all.
    expect(queue.take(1, a)).toBeUndefined();
    expect(queue.take(2, b)).toBeUndefined();
    expect(queue.take(3, c)).toBeUndefined();
    expect(calls).toEqual(["0,0", "1,0"]);
    expect([queue.queued, queue.held]).toEqual([6, 2]);
    // The head needs one more chunk; the rest of the budget goes to the next client.
    queue.period(noFault);
    expect(calls.slice(2)).toEqual(["2,0", "0,1"]);
    expect([queue.queued, queue.held]).toEqual([4, 3]);
    // Until its transaction starts, the head keeps its place and its terrain; the next is served.
    queue.period(noFault);
    expect(calls.slice(4)).toEqual(["1,1", "2,1"]);
    expect([queue.queued, queue.held]).toEqual([2, 3]);
    expect(takenKeys(queue.take(1, a))).toEqual(sortedKeys(a));
    // Client 2 is the head now, and holds what the cache has of its chunks: all three.
    expect([queue.queued, queue.held]).toEqual([2, 3]);
    queue.period(noFault);
    expect(calls.slice(6)).toEqual(["0,2", "1,2"]);
    expect(takenKeys(queue.take(2, b))).toEqual(sortedKeys(b));
    expect(takenKeys(queue.take(3, c))).toEqual(sortedKeys(c));
    expect(calls).toHaveLength(8);
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });

  test("held for the head of the queue alone, its terrain is never generated twice when the cache evicts it", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read, 2), 1);
    const [mine, theirs] = [row(0), row(1)];
    expect(queue.take(1, mine)).toBeUndefined();
    expect(queue.take(2, theirs)).toBeUndefined();
    const held: number[] = [];
    for (let period = 0; period < 5; period += 1) {
      queue.period(noFault);
      held.push(queue.held);
    }
    // Six chunks went through a cache of two: the head's three are held for it, and no more.
    expect(calls).toEqual([...mine, ...theirs].map(chunkKey));
    expect(held).toEqual([2, 3, 3, 3, 3]);
    expect(takenKeys(queue.take(1, mine))).toEqual(sortedKeys(mine));
    expect(calls).toHaveLength(6);
    // Client 2 held nothing behind the head: the chunk of it the cache evicted, the first, is
    // generated again once client 2 is the head.
    expect([queue.queued, queue.held]).toEqual([1, 2]);
    expect(queue.take(2, theirs)).toBeUndefined();
    queue.period(noFault);
    expect(takenKeys(queue.take(2, theirs))).toEqual(sortedKeys(theirs));
    expect(calls).toEqual([...mine, ...theirs].map(chunkKey).concat("0,1"));
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });

  test("a client whose needs change goes to the back, with nothing held; one whose needs stay the same keeps its place", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read), 1);
    const [a, b] = [row(0), row(1, 2)];
    const moved: ChunkCoord[] = [[9, 9]];
    expect(queue.take(1, a)).toBeUndefined();
    expect(queue.take(2, b)).toBeUndefined();
    // The same chunks in another order are the same needs: client 1 stays the head.
    expect(queue.take(1, [...a].reverse())).toBeUndefined();
    queue.period(noFault);
    expect(calls).toEqual(["0,0", "2,0"]);
    expect(queue.held).toBe(2);
    // Its needs change: it goes behind client 2, and nothing is held for it.
    expect(queue.take(1, moved)).toBeUndefined();
    expect([queue.queued, queue.held]).toEqual([3, 0]);
    queue.period(noFault);
    queue.period(noFault);
    expect(calls.slice(2)).toEqual(["0,1", "1,1"]);
    expect(takenKeys(queue.take(2, b))).toEqual(sortedKeys(b));
    queue.period(noFault);
    expect(calls.slice(4)).toEqual(["9,9"]);
    expect(takenKeys(queue.take(1, moved))).toEqual(["9,9"]);
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });

  test("a queued generation that throws drops the client that waits for it alone, and the queue goes on with the next", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const failure = new Error("no terrain for chunk 9,51");
    const { calls, read } = countingTerrain();
    const readTerrain = (at: ChunkCoord): TerrainPublic => {
      const terrain = read(at);
      if (chunkKey(at) === "9,51") throw failure;
      return terrain;
    };
    const { presentation, advance } = presentationOver(model, { readTerrain, terrainPerPeriod: 3 });
    const [first, broken, last] = [new EndedClient(), new EndedClient(), new EndedClient()];
    const cameras = new Map<EndedClient, ChunkCoord[]>([
      [first, row(50, 4)],
      [broken, [...row(51, 2), [9, 51]]],
      [last, row(52)],
    ]);
    for (const [client, camera] of cameras)
      presentation.subscribe(presentation.connect(client), camera);
    /** The chunks each period generates. */
    const generated: string[][] = [];
    for (let period = 0; period < 5; period += 1) {
      const before = calls.length;
      advance();
      generated.push(calls.slice(before));
      if (period === 1) expect(broken.ending).toBeUndefined();
    }
    // The first client asks for four chunks and gets three at once; the queue gives it the fourth,
    // then the broken client its first two. Its third throws in the queue: it is dropped, and the
    // rest of that period's budget goes to the last client.
    expect(generated).toEqual([
      ["0,50", "1,50", "2,50"],
      ["3,50", "0,51", "1,51"],
      ["9,51", "0,52", "1,52"],
      ["2,52"],
      [],
    ]);
    expect(broken.ending).toEqual({ reason: "fault", cause: failure });
    expect(presentation.telemetry()).toMatchObject({ faults: 1, connections: 2, terrainQueue: 0 });
    expect(keysOf(first)).toEqual(sortedKeys(row(50, 4)));
    expect(keysOf(last)).toEqual(sortedKeys(row(52)));
    expect([first.ending, last.ending]).toEqual([undefined, undefined]);
    expect(presentation.usage()).toMatchObject({
      clients: 2,
      terrain: { queued: 0, held: 0 },
      faults: 1,
      failed: false,
    });
  });

  test("a client needs at most the chunks of a full view", () => {
    const queue = new TerrainQueue(new TerrainCache(terrainAt), 1);
    const tooMany = row(0, MAX_VIEW_CHUNKS + 1);
    expect(() => queue.take(1, tooMany)).toThrow(
      `a client needs at most ${MAX_VIEW_CHUNKS} chunks of terrain, not ${MAX_VIEW_CHUNKS + 1}`,
    );
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });
});

/** A client that records how the presentation ended it, a fault included, instead of failing. */
class EndedClient extends ViewClient {
  ending: Ending | undefined;

  override end(ending: Ending): void {
    this.ending = ending;
  }
}

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
