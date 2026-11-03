/**
 * The reconstruction property (plan test 7, in process; ADR 0026, "Interest and transactions"),
 * seeded: a model world of beings that walk, cross chunks, arrive, leave, and speak is published
 * tick by tick, now and then in bursts past F and with more feed than a tick keeps, to a
 * presentation with parts of 16 KiB and a terrain LRU of 8 entries filled 4 chunks a period, while
 * clients change their cameras and followed beings at random, resync, lag, lose a message, abort,
 * and reconnect. After every commit the protocol's reducer applies, each client's view must equal
 * the model at the commit's tick: the chunks of its camera and follow window as they were when the
 * transaction started, each with its version, its beings, and its terrain, the followed being's
 * record, and the clock; a chunk whose terrain was not at hand may be missing, entering in a later
 * commit, but never one the view showed. Unless a lost message left the client behind, the commit
 * must also bring exactly the feed of (L, L'], L the tick its view showed, each tick's items beyond
 * 64 counted as missed, and exactly the local speech of (L, L'] of the chunks that stayed in view;
 * and no client may get more than its budget or one commit in a period, hello and aborts counted.
 * The run must also have covered drops and re-entries, beings that left a view and came back,
 * fragmented chunks, multi-period transactions, crossings, playout skips, aborts, feed and speech,
 * missed feed, resets after the first, late connections, and commits that left out a chunk waiting
 * for its terrain. Then every client asks once more for a camera and a followed being, and nothing
 * changes after: the world idles and the clients drain. Within the periods the documented bounds
 * give, every view must hold exactly its whole interest, though commits of that phase left out
 * chunks waiting for their terrain: every chunk left out entered.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  type Committed,
  chunkKey,
  type FeedItem,
  type LocalSpeech,
  MAX_FEED_ITEMS_PER_TICK,
  MAX_VIEW_CHUNKS,
  type ServerMessage,
} from "@open-origin/protocol/public";
import { Random } from "../../../packages/protocol/test/support/random.ts";
import type { Presentation } from "../src/presentation/presentation.ts";
import { laneShare, turnPeriods } from "../src/presentation/terrain.ts";
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
const TICKS = 120;
const CLIENTS = 5;
/** Parts of 16 KiB, in a budget of 18 KiB a period: views of a few chunks span several periods. */
const PART_BYTES = 16_384;
const PERIOD_BYTES = 18_432;
/** Every FLOOD_EVERY ticks, a tick publishes FLOOD arrivals: more feed items than a tick keeps. */
const FLOOD_EVERY = 40;
const FLOOD = 70;
/** The most chunks of a camera; with a follow window's 9, a view holds at most VIEW_CHUNKS. */
const CAMERA_CHUNKS = 8;
const VIEW_CHUNKS = CAMERA_CHUNKS + 9;
/**
 * The terrain's LRU keeps 8 entries, fewer than a view's chunks and than the 49 chunks the run can
 * name, and a period generates 4 chunks of terrain: a view that gains more than 4 chunks the LRU
 * lacks waits for some, until the end of the run.
 */
const TERRAIN_ENTRIES = 8;
const TERRAIN_BUDGET = 4;

/**
 * More than the bytes of the frames of any transaction of the run: its chunks, 17 at most, each
 * with the 4,209 bytes of `terrainAt`'s terrain, and the 180 beings, each record of at most 103
 * bytes, take 90,093; the feed and the speech of the whole run, under 700 items of under 128 bytes
 * each, take less than 89,600 more; that leaves 82,451 bytes for the frames' envelopes.
 */
const TXN_BYTES = 256 * 1024;

/**
 * The periods within which, once nothing changes and every client drains, every view holds its
 * whole interest, by the documented bounds at a budget B of 4, with L = 1 and T = 49. Terrain
 * (terrain.ts): a client with at most CLIENTS − 1 ahead is the head of the queue within
 * (CLIENTS − 1) · (T + 1) periods and, its needs no longer changing, has its chunks within
 * ⌈73 / (B − L)⌉ more: 225. A transaction (docs/architecture/server.md) commits within
 * ⌊N / (PERIOD_BYTES − PART_BYTES)⌋ + 1 periods, N < TXN_BYTES the bytes of its frames, plus
 * ⌈CLIENTS / L⌉ in the lane for each of its at most 17 chunks the LRU evicted before it wrote them,
 * one transaction per client in the lane: 214. Those bounds take a client to ask at each of its
 * turns, which a transaction in flight puts off until it commits, so a client waits for three at
 * most: the one in flight as the phase starts, the one in flight once its terrain is at hand, and
 * the one that brings it. In all, 225 + 3 · 214 = 867.
 */
function settlePeriods(): number {
  const budget = TERRAIN_BUDGET;
  const lane = laneShare(budget);
  const terrain =
    (CLIENTS - 1) * (turnPeriods(budget) + 1) + Math.ceil(MAX_VIEW_CHUNKS / (budget - lane));
  const parts = Math.floor(TXN_BYTES / (PERIOD_BYTES - PART_BYTES)) + 1;
  return terrain + 3 * (parts + VIEW_CHUNKS * Math.ceil(CLIENTS / lane));
}

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
  aborts: number;
  feed: number;
  missedFeed: number;
  speech: number;
  resets: number;
  lateJoins: number;
  /** Commits that left out a chunk whose terrain was not at hand. */
  waits: number;
};

/** What a client's view showed when a commit arrived, and whether it was the server's view. */
type Before = {
  /** False when a message was lost since the last reset: the view may be behind the server's. */
  readonly synced: boolean;
  readonly tick: number;
  readonly keys: ReadonlySet<string>;
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
  /** The view when the last commit arrived, before the reducer applied it. */
  before: Before | undefined;
  /** The anomalies when the last reset applied: any later one means a message was lost. */
  anomaliesAtSync: number;
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
  if (tick % FLOOD_EVERY === 0) {
    for (let index = 0; index < FLOOD; index += 1)
      feed.push({
        kind: "arrival",
        tick,
        being: 100_000 + tick * FLOOD + index,
        species: "s1",
        chunk: [0, 0],
      });
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
  const size = random.below(CAMERA_CHUNKS + 1);
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

/**
 * Checks the view of `tracked` after the commit of `txn` at `tick` against the model. A chunk that
 * would enter but whose terrain is not at hand waits for a later transaction, so the view may lack
 * some chunks of the interest, never one it showed before but in a reset.
 */
function check(
  model: ModelWorld,
  tracked: Tracked,
  { txn, tick, reset }: { readonly txn: number; readonly tick: number; readonly reset: boolean },
  coverage: Coverage,
) {
  const { view } = tracked.client.state;
  const declared = tracked.starts.get(txn);
  if (declared === undefined || view === undefined)
    throw new Error(`no view of transaction ${txn}`);
  expect([view.tick, view.clock]).toEqual([tick, clockAt(tick)]);
  const keys = expectedKeys(model, tick, declared);
  const showing = shown(tracked.client.state);
  const missing = [...keys].filter((key) => !showing.has(key));
  const { before } = tracked;
  if (!reset && before?.synced === true) {
    expect(missing.filter((key) => before.keys.has(key))).toEqual([]);
  }
  if (missing.length > 0) coverage.waits += 1;
  const present = [...keys].filter((key) => showing.has(key));
  expect(showing).toEqual(expected(model, tick, present, 0));
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

/** The feed the model published in (from, to]: the items each tick keeps, and how many in all. */
function feedBetween(model: ModelWorld, from: number, to: number) {
  const kept: FeedItem[] = [];
  let total = 0;
  for (let tick = from + 1; tick <= to; tick += 1) {
    const { feed } = model.messagesAt(tick);
    kept.push(...feed.slice(0, MAX_FEED_ITEMS_PER_TICK));
    total += feed.length;
  }
  return { kept, total };
}

/** `speech` by the key of its chunk, in order. */
function byChunk(speech: readonly LocalSpeech[]): Map<string, LocalSpeech[]> {
  const chunks = new Map<string, LocalSpeech[]>();
  for (const item of speech) {
    const key = chunkKey(item.at);
    chunks.set(key, [...(chunks.get(key) ?? []), item]);
  }
  return chunks;
}

/** The speech the model published in (from, to] in the chunks `keys`, by chunk key. */
function speechBetween(model: ModelWorld, from: number, to: number, keys: ReadonlySet<string>) {
  const speech: LocalSpeech[] = [];
  for (let tick = from + 1; tick <= to; tick += 1) {
    speech.push(...model.messagesAt(tick).speech.filter(({ at }) => keys.has(chunkKey(at))));
  }
  return byChunk(speech);
}

/**
 * Checks the feed and the speech of the commit `committed` of `tracked`, unless a lost message
 * left its view behind the server's: they are exactly those the model published in (L, L'], L the
 * tick the view showed, the feed whole and the speech of the chunks that stayed in view. In 120
 * ticks no ring drops an item: only the feed items of a tick beyond 64 are missed.
 */
function checkMessages(
  model: ModelWorld,
  tracked: Tracked,
  committed: Committed,
  coverage: Coverage,
): void {
  const before = tracked.before;
  if (before === undefined || !before.synced) return;
  const { kept, total } = feedBetween(model, before.tick, committed.tick);
  expect(committed.feed).toEqual(kept);
  expect(committed.missed).toBe(total - kept.length);
  const shownNow = new Set(tracked.client.state.view?.chunks.keys());
  const stayed = committed.reset ? [] : [...before.keys].filter((key) => shownNow.has(key));
  const speech = speechBetween(model, before.tick, committed.tick, new Set(stayed));
  expect(byChunk(committed.speech)).toEqual(speech);
  expect(committed.speechMissed).toEqual([]);
  noteMessages(model, tracked, { committed, before, spoken: speech.size }, coverage);
}

/**
 * Counts what a checked commit covers: feed, missed feed, speech (`spoken`, the chunks it brought
 * speech of), resets after the first, and late connections.
 */
function noteMessages(
  model: ModelWorld,
  tracked: Tracked,
  checked: { readonly committed: Committed; readonly before: Before; readonly spoken: number },
  coverage: Coverage,
): void {
  const { committed, before } = checked;
  const first = tracked.client.commits.length === 1;
  const fed = committed.feed.length > 0;
  if (fed) coverage.feed += 1;
  if (committed.missed > 0) coverage.missedFeed += 1;
  if (checked.spoken > 0) coverage.speech += 1;
  if (committed.reset && !first && fed) coverage.resets += 1;
  if (first && feedBetween(model, 0, before.tick).total > 0) coverage.lateJoins += 1;
}

/** What the view of `tracked` shows as a commit arrives, before the reducer applies it. */
function beforeCommit({ client, anomaliesAtSync }: Tracked): Before | undefined {
  const { view } = client.state;
  if (view === undefined) return undefined;
  const synced = client.anomalies.length === anomaliesAtSync;
  return { synced, tick: view.tick, keys: new Set(view.chunks.keys()) };
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
    before: undefined,
    anomaliesAtSync: 0,
  };
  client.onMessage = (message) => {
    if (!("txn" in message)) return;
    if (!tracked.starts.has(message.txn)) tracked.starts.set(message.txn, tracked.declared);
    if (message.type === "abort") coverage.aborts += 1;
    if (message.type === "commit") tracked.before = beforeCommit(tracked);
    noteMessage(tracked, message, coverage);
  };
  client.onCommit = (committed) => {
    check(model, tracked, committed, coverage);
    checkMessages(model, tracked, committed, coverage);
    if (committed.reset) tracked.anomaliesAtSync = client.anomalies.length;
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
  } else if (roll < 21) presentation.abort(tracked.id);
  else if (roll < 22) presentation.abort(tracked.id, { releaseView: true });
}

/** No client got more than its budget or more than one commit in the period, every message counted. */
function checkPeriod(
  live: readonly Tracked[],
  frames: readonly number[],
  commits: readonly number[],
) {
  for (const [index, { client }] of live.entries()) {
    const sent = client.sizes.slice(frames[index] ?? 0).reduce((sum, size) => sum + size, 0);
    expect(sent).toBeLessThanOrEqual(PERIOD_BYTES);
    expect(client.commits.length - (commits[index] ?? 0)).toBeLessThanOrEqual(1);
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
    partBytes: PART_BYTES,
    periodBytes: PERIOD_BYTES,
    terrainEntries: TERRAIN_ENTRIES,
    terrainPerPeriod: TERRAIN_BUDGET,
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
    aborts: 0,
    feed: 0,
    missedFeed: 0,
    speech: 0,
    resets: 0,
    lateJoins: 0,
    waits: 0,
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
    const frames = live.map((tracked) => tracked.client.sizes.length);
    const commits = live.map((tracked) => tracked.client.commits.length);
    presentation.period();
    checkPeriod(live, frames, commits);
    for (const [index, tracked] of live.entries()) notePeriod(tracked, before[index] ?? 0, period);
  }
  return { random, model, publisher, presentation, all, live, coverage };
}

/** Whether the view of `tracked` is the server's and holds exactly its whole interest at its tick. */
function whole(model: ModelWorld, tracked: Tracked): boolean {
  const { view } = tracked.client.state;
  if (view === undefined || tracked.client.anomalies.length !== tracked.anomaliesAtSync)
    return false;
  const keys = expectedKeys(model, view.tick, tracked.declared);
  return keys.size === view.chunks.size && [...keys].every((key) => view.chunks.has(key));
}

/**
 * The end of the run: every client asks once more for a camera and a followed being, whose chunks
 * the small LRU mostly lacks, and then nothing changes. The world idles, its beings still, while
 * every client drains: no more requests, aborts, or lag, and no resync but the one a lost message
 * calls for. Returns the period by which every view held exactly its whole interest, at most
 * `limit`, or undefined.
 */
function settle(ran: ReturnType<typeof run>, limit: number): number | undefined {
  const { random, model, publisher, presentation, live } = ran;
  for (const tracked of live) {
    tracked.client.lag = false;
    tracked.client.lose = 0;
    const synced = tracked.client.anomalies.length === tracked.anomaliesAtSync;
    if (tracked.resyncNext || !synced) presentation.resync(tracked.id);
    tracked.resyncNext = false;
    request(random, presentation, model, tracked);
  }
  for (let period = 1; period <= limit; period += 1) {
    const frames = live.map((tracked) => tracked.client.sizes.length);
    const commits = live.map((tracked) => tracked.client.commits.length);
    publisher.publish(model.step());
    presentation.period();
    checkPeriod(live, frames, commits);
    if (live.every((tracked) => whole(model, tracked))) return period;
  }
  return undefined;
}

/** Adds what `tracked` covered, and checks that only a lost message made an anomaly. */
function tally(tracked: Tracked, coverage: Coverage): void {
  // Only the messages deliberately lost made anomalies, each a seq gap.
  coverage.lost += tracked.client.anomalies.length;
  expect(tracked.client.anomalies.every(({ kind }) => kind === "seq_gap")).toBe(true);
  expect(withinParts(tracked.client, PART_BYTES)).toBe(true);
  for (const periods of tracked.periods.values()) if (periods.size > 1) coverage.multiPeriod += 1;
}

describe("the reconstruction property", () => {
  test("every commit leaves each client's view equal to the world at its tick", () => {
    const ran = run(0x7e57);
    const { all, live, coverage, presentation, model } = ran;
    for (const tracked of all) tally(tracked, coverage);
    for (const [what, count] of Object.entries(coverage)) {
      if (count === 0) throw new Error(`the run covered no ${what}`);
    }
    // Lagging clients, transactions of several periods, and aborted ones commit less often than
    // once a tick.
    expect(coverage.checked).toBeGreaterThan(140);
    // A chunk left out to wait for its terrain enters: once nothing changes, every view holds its
    // whole interest, though commits of the phase left out chunks waiting for theirs.
    const waits = coverage.waits;
    expect(settle(ran, settlePeriods())).toBeDefined();
    expect(coverage.waits).toBeGreaterThan(waits);
    for (const tracked of live) {
      const { view } = tracked.client.state;
      if (view === undefined) throw new Error(`client ${tracked.id} shows no view`);
      const keys = expectedKeys(model, view.tick, tracked.declared);
      expect(shown(tracked.client.state)).toEqual(expected(model, view.tick, keys, 0));
      expect(view.followed).toEqual(followedAt(model, view.tick, tracked.declared));
    }
    expect(presentation.usage().terrain).toEqual({ queued: 0, held: 0 });
    for (const tracked of live) presentation.close(tracked.id);
    expect(presentation.usage()).toMatchObject({ clients: 0, pins: 0, retainedBytes: 0 });
  });
});
