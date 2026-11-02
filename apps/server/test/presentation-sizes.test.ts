/**
 * The worst cases the schemas allow (plan test 7b; ADR 0026, "Fragmentation"), under the default
 * sizes: parts of 64 KiB and a budget of 256 KiB per client and period. A chunk of 1,024 beings,
 * beings@2's bound, every record near the widest the schema allows, enters a view after a chunk of
 * 512: its fragments span parts and periods, no part passes 64 KiB, the view never shows a partial
 * chunk, and it commits at the tick it started at while beings move, arrive, and leave meanwhile;
 * the next transaction then brings what changed. One chunk of 65,536 beings, beings@1's bound,
 * also assembles.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  chunkKey,
  MAX_CHUNK_BEINGS,
  MAX_PART_BYTES,
  MIN_CELL,
  MIN_CHUNK,
} from "@open-origin/protocol/public";
import { Presentation } from "../src/presentation/presentation.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import {
  being,
  clockAt,
  expected,
  ModelWorld,
  Publisher,
  presentationOver,
  shown,
  terrainAt,
  ViewClient,
  WORLD_ID,
  withinParts,
} from "./support/presentation.ts";

/** beings@2's bound on the beings of a chunk. */
const DENSE = 1024;

/**
 * The chunk of 512 beings that enters first, about 110 KB, and the dense chunk after it, about
 * 217 KB, at the world's corner, where every cell coordinate takes 11 characters. A period holds
 * 256 KiB: the dense chunk starts in the first period and cannot end in it, however the parts fall.
 */
const CHUNKS: readonly ChunkCoord[] = [
  [MIN_CHUNK, MIN_CHUNK],
  [MIN_CHUNK + 1, MIN_CHUNK],
];
const SIZES = [512, DENSE];

/** A species identifier of 32 characters, the longest. */
const SPECIES = `s${"x".repeat(31)}`;

/** Being `n` of the dense chunk `chunk`, with a record near the widest the schema allows. */
function wide(chunk: number, n: number): BeingPublic {
  const id = Number.MAX_SAFE_INTEGER - chunk * DENSE - n;
  const cell: [number, number] = [MIN_CELL + chunk * 32 + (n % 32), MIN_CELL + Math.floor(n / 32)];
  return {
    id,
    species: SPECIES,
    stage: "adult",
    born: Number.MAX_SAFE_INTEGER - n,
    cell,
    activity: { kind: "talk", to: Number.MAX_SAFE_INTEGER, act: "unknown" },
  };
}

/** The view of `client` shows only whole chunks, each as the model holds it at the view's tick. */
function whole(model: ModelWorld, client: ViewClient): boolean {
  const view = client.state.view;
  if (view === undefined) return true;
  const keys = [...view.chunks.keys()];
  return Bun.deepEquals(shown(client.state), expected(model, view.tick, keys, 0));
}

describe("a view of dense chunks", () => {
  test("spans parts and periods, never shows a partial chunk, and commits at its tick while the world moves", () => {
    const beings = SIZES.flatMap((size, chunk) =>
      Array.from({ length: size }, (_, n) => wide(chunk, n)),
    );
    expect(Math.min(...beings.map((record) => JSON.stringify(record).length))).toBeGreaterThan(200);
    const model = new ModelWorld(0, beings);
    const { presentation, publisher } = presentationOver(model);
    const client = new ViewClient();
    presentation.subscribe(presentation.connect(client), CHUNKS);
    let period = 0;
    const fragmentPeriods = new Map<string, Set<number>>();
    client.onMessage = (message) => {
      if (message.type !== "snapshot") return;
      for (const { at } of message.chunks) {
        const periods = fragmentPeriods.get(chunkKey(at)) ?? new Set<number>();
        fragmentPeriods.set(chunkKey(at), periods.add(period));
      }
    };
    /** One period: a tick where a being of each chunk walks, one leaves, and one arrives in its place. */
    const advance = () => {
      period += 1;
      const tick = model.tick + 1;
      const walking = CHUNKS.map((_, chunk) => {
        const record = model.beings.get(wide(chunk, 5).id) ?? wide(chunk, 5);
        return { ...record, cell: [record.cell[0] + 1, record.cell[1]] as [number, number] };
      });
      const leaving = wide(1, (tick * 7) % DENSE).id;
      const arriving = { ...wide(1, (tick * 7) % DENSE), id: tick };
      if (period > 1)
        publisher.publish(model.step({ set: [...walking, arriving], leave: [leaving] }));
      presentation.period();
      expect(whole(model, client)).toBe(true);
    };
    while (client.commits.length === 0) advance();
    // The reset started at tick 0, in the first period, and committed at tick 0 periods later.
    expect(client.commits[0]).toMatchObject({ txn: 0, tick: 0, reset: true });
    expect(period).toBeGreaterThanOrEqual(2);
    expect(model.tick).toBeGreaterThan(0);
    expect(shown(client.state)).toEqual(expected(model, 0, CHUNKS.map(chunkKey), 0));
    // The dense chunk's fragments went out in the first two periods.
    expect(fragmentPeriods.get(chunkKey(CHUNKS[1] ?? [0, 0]))).toEqual(new Set([1, 2]));
    // The next transaction brings what changed while the first one was sent.
    while (client.commits.length === 1) advance();
    const { tick } = client.commits[1] ?? { tick: -1 };
    expect(tick).toBeGreaterThan(0);
    expect(shown(client.state)).toEqual(expected(model, tick, CHUNKS.map(chunkKey), 0));
    expect(withinParts(client)).toBe(true);
    expect(client.largest).toBeGreaterThan(MAX_PART_BYTES - 1024);
    expect(client.anomalies).toEqual([]);
  });

  test("of one chunk of 65,536 beings, beings@1's bound, assembles whole", () => {
    const beings = Array.from({ length: MAX_CHUNK_BEINGS }, (_, n) =>
      being(n + 1, [n % 32, Math.floor(n / 32) % 32]),
    );
    // The boot record alone: the world never moves in this test.
    const publisher = new Publisher({
      tick: 0,
      clock: clockAt(0),
      chunks: [{ at: [0, 0], v: 0, upsert: beings, gone: [] }],
      speech: [],
      feed: [],
    });
    const clock = new FakeClock();
    const presentation = new Presentation({
      subscribeToPublished: publisher.subscribe,
      readTerrain: terrainAt,
      clock,
      timer: new FakeTimer(clock),
      tickRateHz: 5,
      batchTicks: 5,
      world: { id: WORLD_ID, durability: "ephemeral" },
    });
    const client = new ViewClient();
    presentation.subscribe(presentation.connect(client), [[0, 0]]);
    let periods = 0;
    while (client.commits.length === 0) {
      presentation.period();
      periods += 1;
    }
    const shownBeings = [...(client.state.view?.chunks.get("0,0")?.beings.values() ?? [])];
    expect(shownBeings.length).toBe(MAX_CHUNK_BEINGS);
    expect(shownBeings.every((record, index) => Bun.deepEquals(record, beings[index]))).toBe(true);
    // About 6 MB in parts of 64 KiB, 256 KiB a period.
    expect(periods).toBeGreaterThan(20);
    expect(withinParts(client)).toBe(true);
    expect(client.anomalies).toEqual([]);
  });
});
