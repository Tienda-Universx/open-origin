/**
 * The terrain of the presentation's edge (ADR 0026, "Limits and backpressure": at most 16 chunks
 * generated a period, from a fair queue, with an LRU of 2,048 entries). A transaction brings the
 * entering chunks whose terrain is at hand; the others wait in a queue served first come, first
 * served, its head for a bounded turn, with terrain held for the head alone, which a cache that
 * evicts it cannot take back. A waiting client keeps its place when its chunks change. A
 * transaction in flight holds no terrain: it reads it as it writes its parts, and what the cache
 * evicted meanwhile is served first the next period and held until it is read. A generation that
 * throws drops its client alone.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChunkCoord,
  chunkKey,
  encodeTerrain,
  MAX_VIEW_CHUNKS,
  type TerrainPublic,
} from "@open-origin/protocol/public";
import type { ClientId } from "../src/presentation/interest.ts";
import type { Ending } from "../src/presentation/presentation.ts";
import { TERRAIN_PER_PERIOD, TerrainCache, TerrainQueue } from "../src/presentation/terrain.ts";
import {
  being,
  ModelWorld,
  presentationOver,
  terrainAt,
  ViewClient,
  windowKeys,
} from "./support/presentation.ts";

/** The chunk keys a client's view shows, sorted. */
const keysOf = (client: ViewClient) => [...(client.state.view?.chunks.keys() ?? [])].sort();

/** The chunk keys of `chunks`, sorted. */
const sortedKeys = (chunks: readonly ChunkCoord[]) => chunks.map(chunkKey).sort();

/** The chunks `[0, y]` to `[n − 1, y]`. */
const row = (y: number, n = 3) => Array.from({ length: n }, (_, x): ChunkCoord => [x, y]);

/** The chunk keys of the terrain a queue returned, sorted. */
const takenKeys = (taken: ReadonlyMap<string, unknown>) => [...taken.keys()].sort();

/**
 * The periods of a head's turn at the default budget, from the rule: those that generate twice a
 * full view's chunks.
 */
const TURN = Math.ceil((2 * MAX_VIEW_CHUNKS) / TERRAIN_PER_PERIOD);

/** A readTerrain that logs the key of each chunk it generates. */
function countingTerrain() {
  const calls: string[] = [];
  const read = (at: ChunkCoord): TerrainPublic => {
    calls.push(chunkKey(at));
    return terrainAt(at);
  };
  return { calls, read };
}

/** The fault callback of a queue whose generations never throw: a fault fails the test. */
const noFault = (client: ClientId, cause: unknown) => {
  throw new Error(`the terrain of client ${client} threw`, { cause });
};

/** One period of `queue` as the presentation runs it with no client asking: its head, then the rest. */
const runPeriod = (queue: TerrainQueue) => {
  queue.period(noFault);
  queue.prefetch(noFault);
};

/** A client that records how the presentation ended it, a fault included, instead of failing. */
class EndedClient extends ViewClient {
  ending: Ending | undefined;

  override end(ending: Ending): void {
    this.ending = ending;
  }
}

/**
 * Runs periods until every client of `views` shows its view, at most `limit`: how many ran, or
 * undefined when some client still does not show it.
 */
function untilShown(
  advance: () => void,
  views: ReadonlyMap<ViewClient, readonly ChunkCoord[]>,
  limit: number,
): number | undefined {
  for (let period = 1; period <= limit; period += 1) {
    advance();
    const shown = [...views].every(
      ([client, view]) => keysOf(client).join() === sortedKeys(view).join(),
    );
    if (shown) return period;
  }
  return undefined;
}

describe("the terrain queue", () => {
  test("serves its clients first come, first served: the head gets the period's generations until it needs nothing more, then the next", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read), 2);
    const [a, b, c] = [row(0), row(1), row(2, 2)];
    // Client 1 takes two chunks at once and waits for one; clients 2 and 3 wait for all.
    expect(takenKeys(queue.take(1, a))).toEqual(["0,0", "1,0"]);
    expect(takenKeys(queue.take(2, b))).toEqual([]);
    expect(takenKeys(queue.take(3, c))).toEqual([]);
    expect([queue.queued, queue.held]).toEqual([6, 0]);
    // The head needs one more chunk, held for it; the rest of the budget goes to the next client.
    runPeriod(queue);
    expect(calls).toEqual(["0,0", "1,0", "2,0", "0,1"]);
    expect([queue.queued, queue.held]).toEqual([4, 1]);
    // The head takes what it holds and leaves; client 2 is the head, and holds what the cache has.
    expect(takenKeys(queue.take(1, [[2, 0]]))).toEqual(["2,0"]);
    expect([queue.queued, queue.held]).toEqual([4, 1]);
    runPeriod(queue);
    expect(calls.slice(4)).toEqual(["1,1", "2,1"]);
    expect(takenKeys(queue.take(2, b))).toEqual(sortedKeys(b));
    runPeriod(queue);
    expect(calls.slice(6)).toEqual(["0,2", "1,2"]);
    expect(takenKeys(queue.take(3, c))).toEqual(sortedKeys(c));
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });

  test("holds terrain for its head alone: a cache that evicts it never makes the head generate it again", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read, 2), 1);
    const [mine, theirs] = [row(0), row(1)];
    expect(takenKeys(queue.take(1, mine))).toEqual(["0,0"]);
    expect(takenKeys(queue.take(2, theirs))).toEqual([]);
    const held: number[] = [];
    for (let period = 0; period < 5; period += 1) {
      runPeriod(queue);
      held.push(queue.held);
    }
    // Six chunks went through a cache of two: the head's two missing are held for it, no more.
    expect(calls).toEqual([...mine, ...theirs].map(chunkKey));
    expect(held).toEqual([1, 2, 2, 2, 2]);
    expect(takenKeys(queue.take(1, row(0).slice(1)))).toEqual(["1,0", "2,0"]);
    expect(calls).toHaveLength(6);
    // Client 2 held nothing behind the head: the chunk of it the cache evicted, the first, is
    // generated again once client 2 is the head; it takes the others at once.
    expect([queue.queued, queue.held]).toEqual([1, 2]);
    expect(takenKeys(queue.take(2, theirs))).toEqual(["1,1", "2,1"]);
    runPeriod(queue);
    expect(takenKeys(queue.take(2, [[0, 1]]))).toEqual(["0,1"]);
    expect(calls).toEqual([...mine, ...theirs].map(chunkKey).concat("0,1"));
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });

  test("a waiting client keeps its place when its chunks change, and takes what it holds that it still needs", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read), 1);
    const b = row(1, 2);
    expect(takenKeys(queue.take(1, row(0)))).toEqual(["0,0"]);
    expect(takenKeys(queue.take(2, b))).toEqual([]);
    expect(
      takenKeys(
        queue.take(1, [
          [2, 0],
          [1, 0],
        ]),
      ),
    ).toEqual([]);
    runPeriod(queue);
    expect(calls).toEqual(["0,0", "2,0"]);
    expect(queue.held).toBe(1);
    // Its chunks change: client 1 stays the head, takes the one it holds, and waits for the new.
    const moved: ChunkCoord[] = [
      [2, 0],
      [9, 9],
    ];
    expect(takenKeys(queue.take(1, moved))).toEqual(["2,0"]);
    expect([queue.queued, queue.held]).toEqual([3, 0]);
    runPeriod(queue);
    expect(calls.slice(2)).toEqual(["9,9"]);
    expect(takenKeys(queue.take(1, [[9, 9]]))).toEqual(["9,9"]);
    runPeriod(queue);
    runPeriod(queue);
    expect(calls.slice(3)).toEqual(["0,1", "1,1"]);
    expect(takenKeys(queue.take(2, b))).toEqual(sortedKeys(b));
    expect([queue.queued, queue.held]).toEqual([0, 0]);
  });

  test("a head whose chunks keep changing gives up the head after its turn, and the next client is served", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read), TERRAIN_PER_PERIOD);
    /** Twenty chunks no other step asks for: more than a period generates. */
    const fresh = (n: number) => row(100 + n, 20);
    const next = row(1);
    queue.take(1, fresh(0));
    queue.take(2, next);
    const nextKeys = new Set(next.map(chunkKey));
    /** The period in which client 2's chunks were first generated. */
    let served: number | undefined;
    for (let period = 1; period <= TURN + 1; period += 1) {
      const before = calls.length;
      queue.period(noFault);
      if (served === undefined && calls.slice(before).some((key) => nextKeys.has(key)))
        served = period;
      // Client 1 asks for other chunks each period: it keeps the head until its turn ends, and
      // its requests leave nothing of the budget for the client behind it.
      queue.take(1, fresh(period));
      queue.prefetch(noFault);
    }
    // Its turn is TURN periods: in the next, it is behind client 2, which is served first.
    expect(served).toBe(TURN + 1);
    expect(takenKeys(queue.take(2, next))).toEqual(sortedKeys(next));
    expect(queue.held).toBeLessThanOrEqual(MAX_VIEW_CHUNKS);
  });

  test("while clients wait, only the head generates at once: what the pass leaves goes to the head's own request, then to the clients behind it", () => {
    const { calls, read } = countingTerrain();
    const queue = new TerrainQueue(new TerrainCache(read), 4);
    expect(takenKeys(queue.take(1, row(0, 5)))).toEqual(sortedKeys(row(0, 4)));
    expect(takenKeys(queue.take(2, row(1, 2)))).toEqual([]);
    queue.period(noFault);
    // Three of the period's four generations are left: client 2, behind the head, waits for them.
    expect(takenKeys(queue.take(2, row(1, 2)))).toEqual([]);
    expect(calls).toEqual(["0,0", "1,0", "2,0", "3,0", "4,0"]);
    // The head asks for one chunk more, and has it at once.
    const moved: ChunkCoord[] = [
      [4, 0],
      [9, 9],
    ];
    expect(takenKeys(queue.take(1, moved))).toEqual(sortedKeys(moved));
    queue.prefetch(noFault);
    expect(calls.slice(5)).toEqual(["9,9", "0,1", "1,1"]);
    expect(takenKeys(queue.take(2, row(1, 2)))).toEqual(sortedKeys(row(1, 2)));
  });

  test("a chunk a transaction in flight cannot read is served first the next period, and held until it reads it", () => {
    const failure = new Error("no terrain for chunk 5,5");
    const { calls, read } = countingTerrain();
    const readTerrain = (at: ChunkCoord): TerrainPublic => {
      const terrain = read(at);
      if (chunkKey(at) === "5,5") throw failure;
      return terrain;
    };
    const queue = new TerrainQueue(new TerrainCache(readTerrain, 2), 2);
    // Client 1 takes two chunks at once and waits for two more.
    expect(takenKeys(queue.take(1, row(0, 4)))).toEqual(["0,0", "1,0"]);
    // The transactions in flight of clients 3 and 4 miss their next chunks: a client waits, so
    // nothing is generated at once.
    expect(queue.read(3, [9, 9])).toBeUndefined();
    expect(queue.read(4, [5, 5])).toBeUndefined();
    expect([queue.queued, queue.held]).toEqual([4, 0]);
    const faults: [ClientId, unknown][] = [];
    queue.period((client, cause) => faults.push([client, cause]));
    // They go first, ahead of the head: client 3's chunk is held for it; client 4's throws, and
    // client 4 is reported once and forgotten.
    expect(calls.slice(2)).toEqual(["9,9", "5,5"]);
    expect(faults).toEqual([[4, failure]]);
    expect([queue.queued, queue.held]).toEqual([2, 1]);
    // The head's two chunks pass through the cache of two, which evicts client 3's: it is held.
    queue.period(noFault);
    expect(calls.slice(4)).toEqual(["2,0", "3,0"]);
    expect(queue.read(3, [9, 9])?.json).toBe(JSON.stringify(terrainAt([9, 9])));
    expect(calls).toHaveLength(6);
    expect([queue.queued, queue.held]).toEqual([0, 2]);
    expect(takenKeys(queue.take(1, row(0, 4).slice(2)))).toEqual(["2,0", "3,0"]);
    expect([queue.queued, queue.held, faults.length]).toEqual([0, 0, 1]);
  });

  test("a generation that throws removes its client from the queue, reports it once, and the queue serves the next in the same period", () => {
    const failure = new Error("no terrain for chunk 1,0");
    const { calls, read } = countingTerrain();
    const readTerrain = (at: ChunkCoord): TerrainPublic => {
      const terrain = read(at);
      if (chunkKey(at) === "1,0") throw failure;
      return terrain;
    };
    const queue = new TerrainQueue(new TerrainCache(readTerrain), 3);
    const faults: [ClientId, unknown][] = [];
    const record = (client: ClientId, cause: unknown) => faults.push([client, cause]);
    // Client 3 spends the budget at once; clients 1 and 2 wait.
    expect(takenKeys(queue.take(3, row(9)))).toEqual(sortedKeys(row(9)));
    expect(takenKeys(queue.take(1, row(0)))).toEqual([]);
    expect(takenKeys(queue.take(2, row(1, 1)))).toEqual([]);
    queue.period(record);
    // Client 1's second chunk throws: the queue forgets client 1, whatever the callback does, and
    // the rest of the budget goes to client 2, the head now.
    expect(calls.slice(3)).toEqual(["0,0", "1,0", "0,1"]);
    expect(faults).toEqual([[1, failure]]);
    expect([queue.queued, queue.held]).toEqual([0, 1]);
    expect(takenKeys(queue.take(2, row(1, 1)))).toEqual(["0,1"]);
    queue.period(record);
    expect(calls).toHaveLength(6);
    expect(faults).toHaveLength(1);
    expect([queue.queued, queue.held]).toEqual([0, 0]);
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

describe("terrain in the presentation", () => {
  test("a flood of clients, each entering 64 new chunks, generates at most 16 a period, each once, and grows every view in arrival order", () => {
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
    /** How many chunks the first client showed after each period. */
    const firstShows: number[] = [];
    /** The period at which each client first showed its whole camera. */
    const served = new Map<number, number>();
    for (let period = 1; served.size < clients.length && period <= 60; period += 1) {
      const before = calls.length;
      advance();
      perPeriod.push(calls.length - before);
      firstShows.push(keysOf(clients[0]?.client ?? new ViewClient()).length);
      for (const [k, { client, camera }] of clients.entries()) {
        if (!served.has(k) && keysOf(client).join() === sortedKeys(camera).join())
          served.set(k, period);
      }
    }
    expect(Math.max(...perPeriod)).toBe(16);
    expect(calls.length).toBe(640);
    expect(new Set(calls).size).toBe(640);
    // The queue serves the waiting clients first come, first served, and each view grows as its
    // terrain comes: the first client shows 16 chunks more each period, and each client its whole
    // camera four periods after the one before it.
    expect(firstShows.slice(0, 5)).toEqual([16, 32, 48, 64, 64]);
    expect(clients.map((_, k) => served.get(k))).toEqual([4, 8, 12, 16, 20, 24, 28, 32, 36, 40]);
    expect(presentation.usage().terrain).toEqual({ queued: 0, held: 0 });
  });

  test("a follower whose window moves every tick keeps its place while 50 clients flood the queue, and shows its whole window within its turn", () => {
    const home: [number, number] = [32 * 400, 32 * 400];
    const model = new ModelWorld(0, [being(1, home)]);
    const { presentation, advance } = presentationOver(model);
    const join = (camera: readonly ChunkCoord[]) => {
      const client = new ViewClient();
      presentation.subscribe(presentation.connect(client), camera);
      return client;
    };
    join(row(0, 64));
    const follower = new ViewClient();
    presentation.follow(presentation.connect(follower), 1);
    for (let k = 1; k < 50; k += 1) join(row(k, 16));
    let whole: number | undefined;
    const sizes: number[] = [];
    for (let period = 1; whole === undefined && period <= 2 * (TURN + 1); period += 1) {
      // The followed being moves one chunk a tick: its window gains three chunks each period.
      advance({ set: [being(1, [home[0] + 32 * period, home[1]])] });
      sizes.push(keysOf(follower).length);
      const window = windowKeys([home[0] + 32 * period, home[1]]).sort();
      if (keysOf(follower).join() === window.join()) whole = period;
    }
    // One client is ahead of it: the follower is the head once that client has its chunks, and
    // shows its whole window then, while the flood still waits.
    expect(sizes).toEqual([0, 0, 0, 0, 9]);
    expect(whole).toBe(5);
    expect(presentation.usage().terrain.queued).toBeGreaterThan(0);
  });

  test("a transaction in flight keeps no terrain: what the cache evicts while its client lags is generated again as its parts go out, ahead of a flooded queue, and every transaction commits once its client drains", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { calls, read } = countingTerrain();
    const { presentation, advance } = presentationOver(model, {
      readTerrain: read,
      terrainEntries: 8,
      terrainPerPeriod: 48,
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const views = new Map<ViewClient, ChunkCoord[]>();
    for (let k = 0; k < 6; k += 1) {
      const client = new ViewClient();
      presentation.subscribe(presentation.connect(client), row(200 + k, 8));
      views.set(client, row(200 + k, 8));
    }
    const laggers = [...views.keys()];
    advance();
    for (const client of laggers) client.lag = true;
    for (let k = 0; k < 4; k += 1) {
      presentation.subscribe(presentation.connect(new ViewClient()), row(300 + k, 64));
    }
    const held: number[] = [];
    for (let period = 0; period < 3; period += 1) {
      advance();
      held.push(presentation.usage().terrain.held);
    }
    const lagged = new Set([...views.values()].flat().map(chunkKey));
    const before = calls.length;
    for (const client of laggers) client.lag = false;
    const committed = untilShown(() => advance(), views, 10);
    const again = calls.slice(before).filter((key) => lagged.has(key));
    // While they lagged, only the head of the queue held terrain apart from the cache: the six
    // transactions in flight held none.
    expect(held).toEqual([0, 16, 16]);
    // Back, each transaction reads the terrain of chunks 6 and 7, which the cache evicted: the
    // first in the next period, the second in the one after, ahead of the queue, which still
    // waits; each then commits.
    expect(again).toEqual(
      [6, 7].flatMap((x) => [200, 201, 202, 203, 204, 205].map((y) => `${x},${y}`)),
    );
    expect(committed).toBe(3);
    expect(presentation.usage().terrain.queued).toBeGreaterThan(0);
    expect(laggers.flatMap((client) => client.anomalies)).toEqual([]);
  });

  test("a terrain read again with other bytes than its transaction planned drops that client alone", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const reads = new Map<string, number>();
    /** The terrain of a chunk, with wider fields from its second generation on: other bytes. */
    const readTerrain = (at: ChunkCoord): TerrainPublic => {
      const count = (reads.get(chunkKey(at)) ?? 0) + 1;
      reads.set(chunkKey(at), count);
      if (count === 1) return terrainAt(at);
      const zero = Array(1024).fill(0);
      return encodeTerrain(
        { elevation: zero, liquidDepth: zero, substrate: zero },
        {
          elevation: { min: -100_000, max: 100_000 },
          liquidDepth: { min: 0, max: 100_000 },
          substrate: { min: 0, max: 15 },
        },
      );
    };
    const { presentation, advance } = presentationOver(model, {
      readTerrain,
      terrainEntries: 2,
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const [changed, other] = [new EndedClient(), new EndedClient()];
    presentation.subscribe(presentation.connect(changed), row(0, 4));
    // The cache of two keeps the transaction's first two chunks: its third is generated again, as
    // it writes its first part.
    advance();
    expect(changed.ending).toMatchObject({ reason: "fault" });
    const cause = changed.ending?.reason === "fault" ? changed.ending.cause : undefined;
    expect(String(cause)).toMatch(
      /^Error: the terrain of chunk 2,0 has \d+ bytes, not the 4209 planned$/,
    );
    presentation.subscribe(presentation.connect(other), [[0, 9]]);
    advance();
    expect(keysOf(other)).toEqual(["0,9"]);
    expect(presentation.usage()).toMatchObject({ clients: 1, faults: 1, failed: false });
  });

  test("an aborted transaction that waited for terrain leaves nothing in the queue", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation, advance } = presentationOver(model, {
      terrainEntries: 2,
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const reader = new ViewClient();
    const id = presentation.connect(reader);
    presentation.subscribe(id, row(0, 9));
    advance();
    reader.lag = true;
    presentation.subscribe(presentation.connect(new ViewClient()), row(1, 64));
    advance();
    const waiting = presentation.usage().terrain.queued;
    reader.lag = false;
    advance();
    // Back, the reader's transaction sends its second part, then waits for the evicted terrain of
    // its third: one chunk more in the queue, as the waiting client's head pass took 16.
    const back = presentation.usage().terrain.queued;
    expect(back).toBe(waiting - 16 + 2);
    presentation.abort(id);
    expect(presentation.usage().terrain.queued).toBe(back - 1);
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
    // The first client takes three chunks at once and waits for the fourth, which the queue gives
    // it, then the broken client its first two. Its third throws in the queue: it is dropped, and
    // the rest of that period's budget goes to the last client.
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
    expect(presentation.usage()).toMatchObject({
      clients: 2,
      terrain: { queued: 0, held: 0 },
      faults: 1,
      failed: false,
    });
  });
});
