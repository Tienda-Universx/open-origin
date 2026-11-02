/**
 * The reconstruction property (plan test 7, in process; ADR 0026, "Interest and transactions"),
 * seeded: a model world of beings that walk, cross chunks, arrive, leave, and speak is published
 * tick by tick, now and then in bursts past F, to a presentation with parts of 16 KiB, while
 * clients change their cameras and followed beings at random, resync, lag, lose a message, and
 * reconnect. After every commit the protocol's reducer applies, each client's view must equal the
 * model at the commit's tick: the chunks of its camera and follow window as they were when the
 * transaction started, each with its version, its beings, and its terrain, the followed being's
 * record, and the clock. The run must also have covered drops and re-entries, beings that left a
 * view and came back, fragmented chunks, multi-period transactions, crossings, and playout skips.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  chunkKey,
  type FeedItem,
  type LocalSpeech,
  type ServerMessage,
} from "@open-origin/protocol/public";
import { Random } from "../../../packages/protocol/test/support/random.ts";
import type { Presentation } from "../src/presentation/presentation.ts";
import {
  being,
  chunkOfCell,
  clockAt,
  expected,
  ModelWorld,
  parseKey,
  plain,
  presentationOver,
  shown,
  type TickChanges,
  terrainAt,
  ViewClient,
  windowKeys,
  withinParts,
} from "./support/presentation.ts";

/** The side of the populated area, in cells: 5 × 5 chunks from the origin. */
const SIDE = 160;
const TICKS = 160;
const CLIENTS = 5;

/** What a client asked for: its camera and its followed being. */
type Declared = { readonly camera: readonly ChunkCoord[]; readonly target: number | null };

/** What the run covered, so that the property is never checked vacuously. */
type Coverage = {
  checked: number;
  drops: number;
  reentries: number;
  returns: number;
  fragmented: number;
  multiPeriod: number;
  crossings: number;
  skips: number;
  lost: number;
};

/** A client of the run, what it asked for, and what it showed. */
type Tracked = {
  readonly client: ViewClient;
  readonly id: number;
  declared: Declared;
  /** The request in force when each of its transactions started, by transaction id. */
  readonly starts: Map<number, Declared>;
  /** The periods each of its transactions sent messages in. */
  readonly periods: Map<number, Set<number>>;
  readonly dropped: Set<string>;
  /** The beings it showed after its last commit, and those it showed before but lost. */
  seen: Set<number>;
  readonly lostSight: Set<number>;
  lastTick: number | undefined;
  /** Whether the next period asks for a resync, after a lost message. */
  resyncNext: boolean;
};

/** 130 beings crowded in the chunk (2, 2) and 50 spread over the area. */
function initialBeings(random: Random): BeingPublic[] {
  const crowd = Array.from({ length: 130 }, (_, index) =>
    being(index + 1, [64 + random.below(32), 64 + random.below(32)]),
  );
  const spread = Array.from({ length: 50 }, (_, index) =>
    being(131 + index, [random.below(SIDE), random.below(SIDE)]),
  );
  return [...crowd, ...spread];
}

/** A step of `record` in a random direction, kept in the area, as a walk. */
function walked(random: Random, record: BeingPublic): BeingPublic {
  const dir = random.below(8);
  const [dx, dy] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ][dir] as [number, number];
  const clamp = (value: number) => Math.min(SIDE - 1, Math.max(0, value));
  const cell: [number, number] = [clamp(record.cell[0] + dx), clamp(record.cell[1] + dy)];
  return being(record.id, cell, { kind: "walk", dir });
}

/** The changes of one tick: walks, a death and an arrival now and then, speech, and greetings. */
function changesOf(random: Random, model: ModelWorld, nextId: () => number): TickChanges {
  const tick = model.tick + 1;
  const records = [...model.beings.values()];
  const set = records.filter(() => random.below(100) < 15).map((record) => walked(random, record));
  const leave: number[] = [];
  const feed: FeedItem[] = [];
  const speech: LocalSpeech[] = [];
  if (random.below(10) === 0 && records.length > 0) {
    const gone = random.pick(records);
    leave.push(gone.id);
    feed.push({ kind: "death", tick, being: gone.id, chunk: chunkOfCell(gone.cell) });
    const id = nextId();
    const cell: [number, number] = [random.below(SIDE), random.below(SIDE)];
    set.push(being(id, cell));
    feed.push({ kind: "arrival", tick, being: id, species: "s1", chunk: chunkOfCell(cell) });
  }
  if (random.below(10) < 4 && records.length > 1) {
    const [speaker, hearer] = [random.pick(records), random.pick(records)];
    const at = chunkOfCell(speaker.cell);
    speech.push({
      at,
      speech: { tick, speaker: speaker.id, to: hearer.id, act: "greet", text: plain(`hi ${tick}`) },
    });
    feed.push({ kind: "greeting", tick, from: speaker.id, to: hearer.id, chunk: at });
  }
  return { set: set.filter(({ id }) => !leave.includes(id)), leave, speech, feed };
}

/** A random camera of up to 8 chunks around the area, empty chunks outside it included. */
function randomCamera(random: Random): ChunkCoord[] {
  const camera = new Map<string, ChunkCoord>();
  const size = random.below(9);
  while (camera.size < size) {
    const at: ChunkCoord = [random.below(7) - 1, random.below(7) - 1];
    camera.set(chunkKey(at), at);
  }
  return [...camera.values()];
}

/** The keys of the chunks the view at `tick` must show for the request `declared`. */
function expectedKeys(model: ModelWorld, tick: number, declared: Declared): Set<string> {
  const target = declared.target === null ? undefined : model.at(tick).beings.get(declared.target);
  const window = target === undefined ? [] : windowKeys(target.cell);
  return new Set([...window, ...declared.camera.map(chunkKey)]);
}

/** The followed being's record at `tick` for the request `declared`, or null. */
function followedAt(model: ModelWorld, tick: number, declared: Declared): BeingPublic | null {
  if (declared.target === null) return null;
  return model.at(tick).beings.get(declared.target) ?? null;
}

/** Checks the view of `tracked` after the commit of `txn` at `tick` against the model. */
function check(
  model: ModelWorld,
  tracked: Tracked,
  { txn, tick }: { readonly txn: number; readonly tick: number },
  coverage: Coverage,
) {
  const { view } = tracked.client.state;
  const declared = tracked.starts.get(txn);
  if (declared === undefined || view === undefined)
    throw new Error(`no view of transaction ${txn}`);
  expect([view.tick, view.clock]).toEqual([tick, clockAt(tick)]);
  const keys = expectedKeys(model, tick, declared);
  expect(shown(tracked.client.state)).toEqual(expected(model, tick, keys, 0));
  for (const [key, chunk] of view.chunks) expect(chunk.terrain).toEqual(terrainAt(parseKey(key)));
  expect(view.followed).toEqual(followedAt(model, tick, declared));
  coverage.checked += 1;
  if (tracked.lastTick !== undefined && tick > tracked.lastTick + 1) coverage.skips += 1;
  tracked.lastTick = tick;
}

/** Counts a being that left the view and came back, and remembers what the view shows. */
function noteSight(tracked: Tracked, coverage: Coverage): void {
  const now = new Set<number>();
  for (const chunk of tracked.client.state.view?.chunks.values() ?? []) {
    for (const id of chunk.beings.keys()) now.add(id);
  }
  for (const id of tracked.seen) if (!now.has(id)) tracked.lostSight.add(id);
  for (const id of now) {
    if (!tracked.lostSight.has(id)) continue;
    coverage.returns += 1;
    tracked.lostSight.delete(id);
  }
  tracked.seen = now;
}

/** Counts what a message covers: drops, re-entries, fragments, and crossings. */
function noteMessage(tracked: Tracked, message: ServerMessage, coverage: Coverage): void {
  if (message.type === "delta") {
    for (const at of message.drop) tracked.dropped.add(chunkKey(at));
    coverage.drops += message.drop.length;
    const gone = new Set(message.chunks.flatMap((chunk) => chunk.gone));
    coverage.crossings += message.chunks
      .flatMap((chunk) => chunk.upsert)
      .filter(({ id }) => gone.has(id)).length;
  }
  if (message.type !== "snapshot") return;
  for (const { at, frag } of message.chunks) {
    if (frag.n > 1 && frag.i === 0) coverage.fragmented += 1;
    if (message.reset || frag.i !== 0 || !tracked.dropped.has(chunkKey(at))) continue;
    coverage.reentries += 1;
    tracked.dropped.delete(chunkKey(at));
  }
}

/** A new client, tracked, with a random request. */
function connect(
  random: Random,
  presentation: Presentation,
  model: ModelWorld,
  coverage: Coverage,
): Tracked {
  const client = new ViewClient();
  const id = presentation.connect(client);
  const tracked: Tracked = {
    client,
    id,
    declared: { camera: [], target: null },
    starts: new Map(),
    periods: new Map(),
    dropped: new Set(),
    seen: new Set(),
    lostSight: new Set(),
    lastTick: undefined,
    resyncNext: false,
  };
  client.onMessage = (message) => {
    if (!("txn" in message)) return;
    if (!tracked.starts.has(message.txn)) tracked.starts.set(message.txn, tracked.declared);
    noteMessage(tracked, message, coverage);
  };
  client.onCommit = (committed) => {
    check(model, tracked, committed, coverage);
    noteSight(tracked, coverage);
  };
  request(random, presentation, model, tracked);
  return tracked;
}

/** A new random camera and followed being for `tracked`. */
function request(
  random: Random,
  presentation: Presentation,
  model: ModelWorld,
  tracked: Tracked,
): void {
  const camera = randomCamera(random);
  const beings = [...model.beings.keys()];
  const target = random.below(3) === 0 || beings.length === 0 ? null : random.pick(beings);
  presentation.subscribe(tracked.id, camera);
  presentation.follow(tracked.id, target);
  tracked.declared = { camera, target };
}

/** One client's churn between two periods. */
function churn(
  random: Random,
  presentation: Presentation,
  model: ModelWorld,
  tracked: Tracked,
): void {
  if (tracked.resyncNext) {
    presentation.resync(tracked.id);
    tracked.resyncNext = false;
  }
  const roll = random.below(100);
  if (roll < 10) request(random, presentation, model, tracked);
  else if (roll < 13) presentation.resync(tracked.id);
  else if (roll < 18) tracked.client.lag = !tracked.client.lag;
  else if (roll < 20 && tracked.client.commits.length > 0) {
    tracked.client.lose = 1;
    tracked.resyncNext = true;
  }
}

/** Records the period in which each transaction of `tracked` sent the messages after `from`. */
function notePeriod(tracked: Tracked, from: number, period: number): void {
  for (const message of tracked.client.messages.slice(from)) {
    if (!("txn" in message)) continue;
    const periods = tracked.periods.get(message.txn) ?? new Set<number>();
    periods.add(period);
    tracked.periods.set(message.txn, periods);
  }
}

/** Runs the property over `seed`; returns what it covered and the clients that took part. */
function run(seed: number) {
  const random = new Random(seed);
  const model = new ModelWorld(0, initialBeings(random));
  const { presentation, publisher } = presentationOver(model, {
    partBytes: 16_384,
    periodBytes: 18_432,
  });
  const coverage: Coverage = {
    checked: 0,
    drops: 0,
    reentries: 0,
    returns: 0,
    fragmented: 0,
    multiPeriod: 0,
    crossings: 0,
    skips: 0,
    lost: 0,
  };
  let next = 1000;
  const nextId = () => {
    next += 1;
    return next;
  };
  const all: Tracked[] = [];
  let live = Array.from({ length: CLIENTS }, () => connect(random, presentation, model, coverage));
  all.push(...live);
  for (let period = 1; model.tick < TICKS; period += 1) {
    // Now and then a burst of more than F ticks: the playout skips to the newest.
    const burst = period % 25 === 0 ? 7 : 1;
    for (let tick = 0; tick < burst; tick += 1)
      publisher.publish(model.step(changesOf(random, model, nextId)));
    for (const tracked of live) churn(random, presentation, model, tracked);
    if (random.below(50) === 0) {
      const [closed, ...rest] = live;
      if (closed !== undefined) presentation.close(closed.id);
      const fresh = connect(random, presentation, model, coverage);
      live = [...rest, fresh];
      all.push(fresh);
    }
    const before = live.map((tracked) => tracked.client.messages.length);
    presentation.period();
    for (const [index, tracked] of live.entries()) notePeriod(tracked, before[index] ?? 0, period);
  }
  return { all, live, coverage, presentation };
}

/** Adds what `tracked` covered, and checks that only a lost message made an anomaly. */
function tally(tracked: Tracked, coverage: Coverage): void {
  // Only the messages deliberately lost made anomalies, each a seq gap.
  coverage.lost += tracked.client.anomalies.length;
  expect(tracked.client.anomalies.every(({ kind }) => kind === "seq_gap")).toBe(true);
  expect(withinParts(tracked.client)).toBe(true);
  for (const periods of tracked.periods.values()) if (periods.size > 1) coverage.multiPeriod += 1;
}

describe("the reconstruction property", () => {
  test("every commit leaves each client's view equal to the world at its tick", () => {
    const { all, live, coverage, presentation } = run(0x7e57);
    for (const tracked of all) tally(tracked, coverage);
    for (const [what, count] of Object.entries(coverage)) {
      if (count === 0) throw new Error(`the run covered no ${what}`);
    }
    // Lagging clients and transactions of several periods commit less often than once a tick.
    expect(coverage.checked).toBeGreaterThan(150);
    for (const tracked of live) presentation.close(tracked.id);
    expect(presentation.usage()).toMatchObject({ clients: 0, pins: 0, retainedBytes: 0 });
  });
});
