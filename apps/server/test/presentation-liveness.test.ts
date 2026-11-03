/**
 * The duty of liveness of the presentation's edge (ADR 0026, "Ordering and liveness"): while a
 * client is not lagging, it gets at least one message every period, whatever its terrain waits for,
 * so it never takes the silence for a dead connection and reconnects after STALE_AFTER_MS. Terrain
 * never holds up the rest of a view: a transaction brings the chunks whose terrain is at hand, and
 * those still waiting enter a later one.
 */
import { describe, expect, test } from "bun:test";
import { type ChunkCoord, chunkKey } from "@open-origin/protocol/public";
import { being, ModelWorld, presentationOver, ViewClient } from "./support/presentation.ts";

/** A camera of 64 chunks no other client asks for, eight rows of eight from `[x, 1000]`. */
const camera = (x: number): ChunkCoord[] =>
  Array.from({ length: 64 }, (_, n): ChunkCoord => [x + (n % 8), 1000 + Math.floor(n / 8)]);

/** The chunk keys `client` shows, sorted. */
const keysOf = (client: ViewClient) => [...(client.state.view?.chunks.keys() ?? [])].sort();

/** The keys of `chunks`, sorted. */
const sortedKeys = (chunks: readonly ChunkCoord[]) => chunks.map(chunkKey).sort();

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
});
