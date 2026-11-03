/**
 * The worst cases the schemas allow (plan test 7b; ADR 0026, "Fragmentation"), under the default
 * sizes unless said: parts of 64 KiB and a budget of 256 KiB per client and period. A chunk of 1,024
 * beings, beings@2's bound, every record near the widest the schema allows, enters a view after a
 * chunk of 512: its fragments span parts and periods, no part passes 64 KiB, the view never shows a
 * partial chunk, and it commits at the tick it started at while beings move, arrive, and leave
 * meanwhile; the next transaction then brings what changed. The largest view of beings@2, 73 such
 * chunks, and one chunk of 65,536 such beings, beings@1's bound, in parts of 16 KiB, the smallest,
 * each assemble whole in one transaction: no part passes its limit, no period its budget, the
 * transaction stays within the reducer's 1,024 parts and within the periods its bytes need, and the
 * view does not change until the commit. One chunk of 65,536 narrow records also assembles.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  type ClientState,
  chunkKey,
  MAX_CHUNK_BEINGS,
  MAX_PART_BYTES,
  MAX_TRANSACTION_PARTS,
  MIN_CHUNK,
} from "@open-origin/protocol/public";
import {
  MIN_PART_BYTES,
  PERIOD_BYTES,
  Presentation,
  type PresentationOptions,
} from "../src/presentation/presentation.ts";
import type { PublishedChunk } from "../src/world/published.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import {
  being,
  bytesPerPeriod,
  type ChunkState,
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

/**
 * Being `n` of the `k`th dense chunk, `at`, with a record near the widest the schema allows: its
 * id, birth, and hearer take 16 digits, its species 32 characters, and near the world's corner each
 * cell coordinate 11 characters. Every 1,024 beings fill the chunk's cells once.
 */
function wideAt([x, y]: ChunkCoord, k: number, n: number): BeingPublic {
  const cell: [number, number] = [x * 32 + (n % 32), y * 32 + (Math.floor(n / 32) % 32)];
  return {
    id: Number.MAX_SAFE_INTEGER - k * DENSE - n,
    species: SPECIES,
    stage: "adult",
    born: Number.MAX_SAFE_INTEGER - n,
    cell,
    activity: { kind: "talk", to: Number.MAX_SAFE_INTEGER, act: "unknown" },
  };
}

/** Being `n` of the dense chunk `CHUNKS[chunk]`. */
const wide = (chunk: number, n: number) => wideAt([MIN_CHUNK + chunk, MIN_CHUNK], chunk, n);

/** A presentation over a world that never moves from its boot record, the chunks `chunks`. */
function still(
  chunks: readonly PublishedChunk[],
  options: Partial<Pick<PresentationOptions, "partBytes">> = {},
): Presentation {
  const publisher = new Publisher({ tick: 0, clock: clockAt(0), chunks, speech: [], feed: [] });
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
    ...options,
  });
}

/** The view of `chunks` whole, at their versions. */
function wholeView(chunks: readonly PublishedChunk[]): Map<string, ChunkState> {
  return new Map(
    chunks.map(({ at, v, upsert }) => [
      chunkKey(at),
      { v, beings: new Map(upsert.map((record) => [record.id, record])) },
    ]),
  );
}

/**
 * Runs periods until the first transaction of `client`, the only client, commits: the view hello
 * made, empty, must not change before. Returns the bytes sent in each period.
 */
function untilCommit(presentation: Presentation, client: ViewClient): number[] {
  const counts: number[] = [];
  let hello: ClientState["view"];
  let changed = false;
  while (client.commits.length === 0) {
    presentation.period();
    counts.push(client.sizes.length);
    hello ??= client.state.view;
    if (client.commits.length === 0) changed ||= client.state.view !== hello;
  }
  expect([hello?.chunks.size, changed]).toEqual([0, false]);
  return bytesPerPeriod(client, counts);
}

/**
 * Every period of `bytes` sent at most the budget, and each but the last more than the budget minus
 * a part, since a period stops only at a message that does not fit: the transaction took no period
 * its bytes did not need.
 */
function expectPeriods(bytes: readonly number[], partBytes: number): void {
  const total = bytes.reduce((sum, sent) => sum + sent, 0);
  expect(Math.max(...bytes)).toBeLessThanOrEqual(PERIOD_BYTES);
  expect(bytes.slice(0, -1).every((sent) => sent > PERIOD_BYTES - partBytes)).toBe(true);
  expect(bytes.length).toBeGreaterThanOrEqual(Math.ceil(total / PERIOD_BYTES));
}

/**
 * The largest view of beings@2 at the world's corner: the follow window, the 3 × 3 chunks around
 * the chunk (1, 1) from the corner, and beside it a camera of 8 × 8 chunks.
 */
function largestView(): { readonly window: ChunkCoord[]; readonly camera: ChunkCoord[] } {
  const window: ChunkCoord[] = [];
  const camera: ChunkCoord[] = [];
  for (let x = 0; x < 11; x += 1) {
    for (let y = 0; y < 8; y += 1) {
      const at: ChunkCoord = [MIN_CHUNK + x, MIN_CHUNK + y];
      if (x >= 3) camera.push(at);
      else if (y < 3) window.push(at);
    }
  }
  return { window, camera };
}

/** The snapshot parts `client` received. */
const snapshots = (client: ViewClient) =>
  client.messages.filter(({ type }) => type === "snapshot").length;

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

  test("of the largest view of beings@2, 73 chunks of 1,024 wide records, assembles whole within every bound", () => {
    const { window, camera } = largestView();
    const chunks = [...window, ...camera].map((at, k) => ({
      at,
      v: 0,
      upsert: Array.from({ length: DENSE }, (_, n) => wideAt(at, k, n)),
      gone: [],
    }));
    // The followed being is in the window's middle chunk.
    const followed = chunks[4]?.upsert[5];
    expect([chunks.length, chunkKey(chunks[4]?.at ?? [0, 0])]).toEqual([
      73,
      chunkKey([MIN_CHUNK + 1, MIN_CHUNK + 1]),
    ]);
    const presentation = still(chunks);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, camera);
    presentation.follow(id, followed?.id ?? null);
    const bytes = untilCommit(presentation, client);
    expect(shown(client.state)).toEqual(wholeView(chunks));
    expect(client.state.view?.followed).toEqual(followed);
    expect(withinParts(client)).toBe(true);
    expectPeriods(bytes, MAX_PART_BYTES);
    expect(snapshots(client)).toBeLessThanOrEqual(MAX_TRANSACTION_PARTS);
    expect(client.anomalies).toEqual([]);
    presentation.close(id);
    expect(presentation.usage()).toMatchObject({ pins: 0, retainedBytes: 0 });
  });

  test("of one chunk of 65,536 wide records, beings@1's bound, assembles whole in parts of 16 KiB within the reducer's parts", () => {
    const at: ChunkCoord = [MIN_CHUNK, MIN_CHUNK];
    const records = Array.from({ length: MAX_CHUNK_BEINGS }, (_, n) => wideAt(at, 0, n));
    expect(
      Math.min(...records.slice(0, DENSE).map((record) => JSON.stringify(record).length)),
    ).toBeGreaterThan(200);
    const chunks = [{ at, v: 0, upsert: records, gone: [] }];
    const presentation = still(chunks, { partBytes: MIN_PART_BYTES });
    const client = new ViewClient();
    presentation.subscribe(presentation.connect(client), [at]);
    const bytes = untilCommit(presentation, client);
    expect(shown(client.state)).toEqual(wholeView(chunks));
    expect(withinParts(client, MIN_PART_BYTES)).toBe(true);
    expectPeriods(bytes, MIN_PART_BYTES);
    // About 13.5 MB in parts of 16 KiB: more than 800 parts, fewer than the reducer's 1,024.
    expect(snapshots(client)).toBeGreaterThan(800);
    expect(snapshots(client)).toBeLessThanOrEqual(MAX_TRANSACTION_PARTS);
    expect(client.anomalies).toEqual([]);
  });

  test("of one chunk of 65,536 beings, beings@1's bound, assembles whole", () => {
    const beings = Array.from({ length: MAX_CHUNK_BEINGS }, (_, n) =>
      being(n + 1, [n % 32, Math.floor(n / 32) % 32]),
    );
    // The boot record alone: the world never moves in this test.
    const presentation = still([{ at: [0, 0], v: 0, upsert: beings, gone: [] }]);
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
