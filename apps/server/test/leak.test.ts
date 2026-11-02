/**
 * No C1, C3, or C4 datum reaches a published tick (plan test 11; ADR 0026, "Projections and
 * classification"). Three worlds run as the world plane runs them, through the host, the gate,
 * and the projection: the mind@1 subject, which greets, tells, takes a tainted research injection,
 * and crosses chunks; the default scenario, whose seeds are wide words; and the canary world,
 * whose sitter holds distinctive C1 and C3 values. Every published tick is serialized and read
 * back with the protocol's strict schemas, and its text holds no taint, no seed or terrain seed,
 * no seal, no checksum or state root of the run, and no canary, while the world itself holds them.
 */
import { describe, expect, test } from "bun:test";
import { type beings, readView, stateRoot, type World } from "@open-origin/engine";
import {
  BeingPublic,
  Clock,
  chunkKey,
  FeedItem,
  parseServerMessage,
  Speech,
} from "@open-origin/protocol/public";
import { LABELS2, labelSeeds } from "@open-origin/scenarios";
import { mindRuleset } from "../../../packages/agents/test/support/mind-ruleset.ts";
import {
  mindWorld,
  SUBJECT_SEEDS,
  SUBJECT_TICKS,
  subjectScript,
} from "../../../packages/agents/test/support/mind-subject.ts";
import type { SuiteRuleset } from "../../../packages/engine/test/support/determinism-records.ts";
import { BeingsProjection } from "../src/projection/projection.ts";
import type { PublishedTick } from "../src/world/published.ts";
import { ScenarioSource, ScriptedSource } from "../src/world/source.ts";
import {
  CANARY_NUMBERS,
  CANARY_TEXTS,
  CANARY_TRAITS,
  canaryScript,
  canaryWorld,
} from "./support/canary-world.ts";
import { type PublishedRun, publishedRun } from "./support/runs.ts";

/** Names of taints and C3 members that no public message may hold, as text or as a key. */
const FORBIDDEN_NAMES = [
  "model-prior-suspect",
  "human-external",
  "implementation-leak",
  '"tn"',
  '"ex"',
  '"exposure"',
  '"captured"',
  '"needs"',
  '"traits"',
  '"mind"',
  '"depletion"',
  '"due"',
  '"genesis"',
  '"life"',
  '"seed"',
  '"simSecondsPerTick"',
];

/** The keys a published tick, its chunks, and its speech hold: no other. */
const TICK_KEYS = ["chunks", "clock", "feed", "speech", "tick"];
const CHUNK_KEYS = ["at", "gone", "upsert", "v"];
const SPEECH_KEYS = ["at", "speech"];

/**
 * Checks `published` as a client would read it, once serialized: every record parses with its
 * strict schema, every envelope holds only its own keys, and a delta, the feed's events, a commit,
 * and a snapshot built from it parse as server messages of the public protocol.
 */
function expectWire(published: PublishedTick, seq: number) {
  const read: PublishedTick = JSON.parse(JSON.stringify(published));
  expect(Object.keys(read).sort()).toEqual(TICK_KEYS);
  expect(Clock.safeParse(read.clock).success).toBe(true);
  for (const chunk of read.chunks) {
    expect(Object.keys(chunk).sort()).toEqual(CHUNK_KEYS);
    for (const record of chunk.upsert) expect(BeingPublic.safeParse(record).success).toBe(true);
  }
  for (const local of read.speech) {
    expect(Object.keys(local).sort()).toEqual(SPEECH_KEYS);
    expect(Speech.safeParse(local.speech).success).toBe(true);
  }
  for (const item of read.feed) expect(FeedItem.safeParse(item).success).toBe(true);
  const header = { seq, tick: read.tick, txn: read.tick };
  const spoken = (at: [number, number]) =>
    read.speech.filter((local) => chunkKey(local.at) === chunkKey(at)).map(({ speech }) => speech);
  const chunks = read.chunks.map((chunk) => ({ ...chunk, speech: spoken(chunk.at) }));
  const snapshot = read.chunks.map(({ at, v, upsert }) => ({
    at,
    v,
    beings: upsert,
    frag: { i: 0, n: 1 },
  }));
  const messages = [
    { type: "delta", ...header, chunks, drop: [] },
    { type: "events", ...header, items: read.feed },
    { type: "commit", ...header, clock: read.clock },
    { type: "snapshot", ...header, reset: true, chunks: snapshot },
  ];
  for (const message of messages)
    expect([message.type, parseServerMessage(JSON.stringify(message)).ok]).toEqual([
      message.type,
      true,
    ]);
}

/** The serialized published ticks of `run`, all of them. */
const textOf = ({ published }: PublishedRun) => JSON.stringify(published);

/** Every value of `run`'s journal that is C3 and textual: the checksum of every tick. */
const checksumsOf = ({ records }: PublishedRun) => records.map(({ checksum }) => checksum);

/** The C3 digests of `world`'s global value: the genesis seal and the life seal. */
function sealsOf(world: World): string[] {
  const global = readView(world as World<beings.BeingsGlobal, beings.BeingsChunk>).readGlobal();
  return [global.genesisSeal, global.lifeSeal];
}

/** The decimal and hexadecimal texts of each word of `words`, a seed's u32 words. */
function seedTexts(words: readonly number[]): string[] {
  return words.flatMap((word) => [
    String(word),
    word.toString(16),
    word.toString(16).padStart(8, "0"),
  ]);
}

/** The texts of `forbidden` that `text` holds: none, for a projection that leaks nothing. */
function found(text: string, forbidden: readonly string[]): string[] {
  return forbidden.filter((entry) => text.includes(entry));
}

/** The text of every chunk of `world`, as the engine holds it: C0, C1, and C3 alike. */
function stateText(world: World): string {
  const view = readView(world);
  return JSON.stringify(view.chunkKeys().map((key) => view.readChunk(key)));
}

describe("what the world plane publishes", () => {
  test("holds no C1 or C3 datum of the mind@1 subject, which greets, tells, and is injected", async () => {
    const world = mindWorld(SUBJECT_SEEDS[0], mindRuleset() as unknown as SuiteRuleset, false);
    const projection = new BeingsProjection(world);
    const run = await publishedRun(
      new ScriptedSource(world, subjectScript()),
      projection,
      SUBJECT_TICKS,
    );
    // The facts the scan needs happened: greets, tells, a tainted injection, a crossing.
    const events = run.records.flatMap((record) => record.events);
    const acts = events
      .filter(({ type }) => type === "speech.uttered")
      .map(({ payload }) => JSON.stringify(payload));
    expect(acts.some((act) => act.includes('"act":"greet"'))).toBe(true);
    expect(acts.some((act) => act.includes('"act":"tell"'))).toBe(true);
    expect(events.map(({ type }) => type)).toContain("mind.injected");
    expect(stateText(world)).toMatch(/"tn":[1-9]/);
    expect(stateText(world)).toContain('"exposure"');
    const crossed = run.published.some(({ chunks }) => {
      const gone = chunks.flatMap((chunk) => chunk.gone);
      return chunks.some(({ upsert }) => upsert.some(({ id }) => gone.includes(id)));
    });
    expect(crossed).toBe(true);
    expect(run.published.map(({ tick }) => tick)).toEqual(
      Array.from({ length: SUBJECT_TICKS }, (_, index) => index + 1),
    );
    for (const [index, published] of run.published.entries()) expectWire(published, index + 1);
    const forbidden = [
      ...FORBIDDEN_NAMES,
      ...sealsOf(world),
      ...checksumsOf(run),
      stateRoot(world),
    ];
    expect(found(textOf(run), forbidden)).toEqual([]);
  });

  test("holds no seed, terrain seed, seal, or checksum of the default scenario", async () => {
    const source = new ScenarioSource();
    const projection = new BeingsProjection(source.world);
    const run = await publishedRun(source, projection, 200);
    const seeds = labelSeeds(LABELS2.default);
    const global = readView(
      source.world as World<beings.BeingsGlobal, beings.BeingsChunk>,
    ).readGlobal();
    // The world holds these seeds: the terrain's in its genesis, the world's in its snapshot.
    expect(global.genesis.terrainSeed).toEqual(seeds.terrain);
    expect(seeds.world.every((word) => word > 0xff_ffff)).toBe(true);
    // Its eight spawns arrive at tick 1, each in the feed with its species and chunk.
    expect(run.published[0]?.feed.map(({ kind }) => kind)).toEqual(Array(8).fill("arrival"));
    for (const [index, published] of run.published.entries()) expectWire(published, index + 1);
    const forbidden = [
      ...FORBIDDEN_NAMES,
      ...seedTexts(seeds.world),
      ...seedTexts(seeds.terrain),
      ...sealsOf(source.world),
      ...checksumsOf(run),
      stateRoot(source.world),
    ];
    expect(found(textOf(run), forbidden)).toEqual([]);
  });

  test("holds none of the canaries planted in the C1 and C3 data of the canary world", async () => {
    const world = canaryWorld();
    const projection = new BeingsProjection(world);
    const run = await publishedRun(new ScriptedSource(world, canaryScript()), projection, 40);
    const canaries = [
      ...CANARY_TEXTS,
      ...CANARY_NUMBERS.map(String),
      ...Object.values(CANARY_TRAITS).map(String),
    ];
    // The run held every canary: the sitter's state, and the journal's injection, which the
    // sitter heard and, having no thought for it, let go. Records went out all along.
    expect(found(stateText(world) + JSON.stringify(run.records), canaries)).toEqual(canaries);
    expect(run.published.flatMap(({ chunks }) => chunks).length).toBeGreaterThan(8);
    for (const [index, published] of run.published.entries()) expectWire(published, index + 1);
    const forbidden = [
      ...FORBIDDEN_NAMES,
      ...canaries,
      ...seedTexts([0x5eed_c0de, 0x0dd_ba11]),
      ...sealsOf(world),
      ...checksumsOf(run),
      stateRoot(world),
    ];
    expect(found(textOf(run), forbidden)).toEqual([]);
  });
});
