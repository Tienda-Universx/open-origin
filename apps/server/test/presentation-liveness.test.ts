/**
 * The duty of liveness of the presentation's edge (ADR 0026, "Ordering and liveness"): while a
 * client is not lagging, it gets at least one message every period, whatever its terrain waits for,
 * so it never takes the silence for a dead connection and reconnects after STALE_AFTER_MS. Terrain
 * never holds up the rest of a view: a transaction brings the chunks whose terrain is at hand, and
 * those still waiting enter a later one.
 */
import { describe, expect, test } from "bun:test";
import { type ChunkCoord, chunkKey, MAX_PART_BYTES } from "@open-origin/protocol/public";
import { FEED, Mirror } from "../src/presentation/mirror.ts";
import { type EncodedText, TERRAIN_PENDING } from "../src/presentation/parts.ts";
import { Transaction, ViewState } from "../src/presentation/txn.ts";
import {
  being,
  ModelWorld,
  presentationOver,
  terrainAt,
  ViewClient,
} from "./support/presentation.ts";

/** A camera of 64 chunks no other client asks for, eight rows of eight from `[x, 1000]`. */
const camera = (x: number): ChunkCoord[] =>
  Array.from({ length: 64 }, (_, n): ChunkCoord => [x + (n % 8), 1000 + Math.floor(n / 8)]);

/** The chunk keys `client` shows, sorted. */
const keysOf = (client: ViewClient) => [...(client.state.view?.chunks.keys() ?? [])].sort();

/** The keys of `chunks`, sorted. */
const sortedKeys = (chunks: readonly ChunkCoord[]) => chunks.map(chunkKey).sort();

/** The chunks `[0, y]` to `[n − 1, y]`. */
const row = (y: number, n = 3) => Array.from({ length: n }, (_, x): ChunkCoord => [x, y]);

/** Runs `periods` periods with `step`, and returns, for each client, the periods it heard nothing. */
function silences(clients: readonly ViewClient[], periods: number, step: () => void): number[][] {
  const silent: number[][] = clients.map(() => []);
  for (let period = 1; period <= periods; period += 1) {
    const before = clients.map(({ messages }) => messages.length);
    step();
    for (const [k, client] of clients.entries()) {
      if (client.messages.length === before[k]) silent[k]?.push(period);
    }
  }
  return silent;
}

describe("liveness", () => {
  test("no client that is not lagging goes a period without a message while the world runs, however long its terrain waits", () => {
    const { presentation, advance } = presentationOver(new ModelWorld(0));
    const cameras = [0, 100, 200, 300].map(camera);
    const clients = cameras.map((chunks) => {
      const client = new ViewClient();
      presentation.subscribe(presentation.connect(client), chunks);
      return client;
    });
    // 256 chunks at 16 a period take 16 periods; every client hears from the world in each.
    expect(silences(clients, 17, () => advance())).toEqual([[], [], [], []]);
    expect(clients.map(keysOf)).toEqual(cameras.map(sortedKeys));
    expect(clients.flatMap(({ anomalies }) => anomalies)).toEqual([]);
  });

  test("a client that pans while others wait for terrain keeps hearing its followed being every period", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation, advance } = presentationOver(model);
    const watcher = new ViewClient();
    const id = presentation.connect(watcher);
    presentation.follow(id, 1);
    advance();
    advance();
    for (const x of [100, 200, 300]) {
      presentation.subscribe(presentation.connect(new ViewClient()), camera(x));
    }
    advance();
    presentation.subscribe(id, camera(900));
    /** The ticks at which the watcher's view, after each period, showed the followed being. */
    const seen: number[] = [];
    const silent = silences([watcher], 20, () => {
      // The followed being moves within its chunk each tick.
      advance({ set: [being(1, [5 + (model.tick % 20), 5])] });
      const record = watcher.state.view?.chunks.get("0,0")?.beings.get(1);
      if (JSON.stringify(record) === JSON.stringify(model.beings.get(1))) seen.push(model.tick);
    });
    expect(silent).toEqual([[]]);
    // Each period's commit brings the being's move: the view shows it at every tick.
    expect(seen).toEqual(Array.from({ length: 20 }, (_, n) => model.tick - 19 + n));
    expect(watcher.anomalies).toEqual([]);
  });

  test("a follower whose being moves into chunks whose terrain waits keeps the being's record every period", () => {
    const home: [number, number] = [32 * 500, 32 * 500];
    const model = new ModelWorld(0, [being(1, home)]);
    const { presentation, advance } = presentationOver(model);
    // A client ahead in the queue takes the budget for four periods.
    presentation.subscribe(presentation.connect(new ViewClient()), camera(0));
    const follower = new ViewClient();
    presentation.follow(presentation.connect(follower), 1);
    const followed: unknown[] = [];
    for (let period = 1; period <= 4; period += 1) {
      advance({ set: [being(1, [home[0] + 32 * period, home[1]])] });
      followed.push(follower.state.view?.followed);
    }
    // Its window's terrain waits, so the view shows none of it; each commit still names the being.
    expect(keysOf(follower)).toEqual([]);
    expect(followed).toEqual([1, 2, 3, 4].map((n) => being(1, [home[0] + 32 * n, home[1]])));
    expect(follower.anomalies).toEqual([]);
  });

  test("a client whose transaction waits for terrain hears status meanwhile, and the transaction stays in flight until it commits", () => {
    const { presentation, advance } = presentationOver(new ModelWorld(0), {
      terrainEntries: 2,
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const reader = new ViewClient();
    presentation.subscribe(presentation.connect(reader), row(0, 20));
    // Its first transaction takes 16 chunks and waits in the queue for 4: its third chunk, which
    // the cache of two evicted, waits for the next period, the second part for the one after,
    // and its fifth for the third: in that period it has no part to send.
    const types: string[][] = [];
    for (let period = 0; period < 3; period += 1) {
      const from = reader.messages.length;
      advance();
      types.push(reader.messages.slice(from).map(({ type }) => type));
    }
    expect(types).toEqual([["hello"], ["snapshot"], ["status"]]);
    expect(reader.messages.at(-1)).toMatchObject({ type: "status", state: "running", tick: 0 });
    expect(reader.commits).toEqual([]);
    // It never goes a period in silence, and its transaction commits once every part went out.
    expect(silences([reader], 20, () => advance())).toEqual([[]]);
    expect(reader.commits.length).toBeGreaterThan(0);
    expect(keysOf(reader)).toEqual(sortedKeys(row(0, 20)));
    expect(reader.anomalies).toEqual([]);
  });
});

describe("a transaction", () => {
  test("whose next part waits for terrain says so, stays in flight with its pins, and goes on once the terrain comes", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const mirror = new Mirror();
    mirror.apply(model.boot());
    const json = JSON.stringify(terrainAt([0, 0]));
    let terrain: EncodedText | undefined;
    const txn = Transaction.start({
      txn: 0,
      view: new ViewState(0, mirror.feed.count(FEED)),
      mirror,
      interest: [[0, 0]],
      target: null,
      terrainBytes: () => json.length,
      terrain: () => terrain,
      partBytes: MAX_PART_BYTES,
    });
    expect(txn.peek()).toBe(TERRAIN_PENDING);
    expect(txn.peek()).toBe(TERRAIN_PENDING);
    expect(mirror.pins).toBe(1);
    terrain = { json, bytes: json.length };
    expect(txn.peek()).toMatchObject({ type: "snapshot" });
    txn.advance();
    expect(txn.peek()).toMatchObject({ type: "commit" });
    txn.advance();
    expect(txn.peek()).toBeUndefined();
  });
});
