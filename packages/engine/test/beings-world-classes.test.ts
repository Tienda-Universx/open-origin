/**
 * The classes of a chunk and of the global value of a world of beings (ADR 0026, "Projections and
 * classification"): CHUNK_CLASSES classifies every member of a chunk the engine holds, under
 * beings@1 and beings@2 alike, its beings by BEING_CLASSES, its depletion and `due` as C3; and
 * GLOBAL_CLASSES classifies the whole global value as C3. The registry names exactly the members
 * the validators accept, so a member added to either without a class fails here.
 */
import { describe, expect, test } from "bun:test";
import { beings, createWorld, readView } from "../src/index.ts";
import { type BeingsWorld, idler, runTo, SPECIES, testGenesis } from "./support/beings-world.ts";
import { being2, beings2World, chunksOf, idler2, SPECIES2 } from "./support/beings2-world.ts";
import { memberOf, secretPaths, unclassified } from "./support/classes.ts";
import { heard, mindOf, own } from "./support/mind-records.ts";

const { BEING_CLASSES, CHUNK_CLASSES, GLOBAL_CLASSES } = beings;

/** Depletion entries of a chunk, ordered by cell, as a meal leaves them. */
const DEPLETION: beings.Depletion[] = [
  { cell: 3, taken: 9, since: 0 },
  { cell: 40, taken: 2, since: 0 },
];

/** A being of beings@1 placed on `cell`: a being of beings@2 without its mind and new traits. */
function being1(id: number, cell: readonly [number, number]): beings.Being {
  const { mind: _mind, traits, ...rest } = being2(id, cell);
  const { appetite, sleepiness, curiosity } = traits;
  return { ...rest, species: SPECIES.id, traits: { appetite, sleepiness, curiosity } };
}

/** The chunks of `placed`, the chunk "0,0" with DEPLETION, and the occupancy index. */
function placedChunks(placed: readonly beings.Being[]) {
  const chunks = chunksOf(placed);
  const origin = chunks["0,0"];
  if (origin === undefined) throw new Error("no being stands in the chunk 0,0");
  origin.depletion = DEPLETION.map((entry) => ({ ...entry }));
  return { chunks, occupancy: Object.keys(chunks).sort() };
}

/** A world of beings@1 with two beings, one where food was eaten, stepped three ticks. */
function world1(): BeingsWorld {
  const { chunks, occupancy } = placedChunks([being1(1, [0, 0]), being1(2, [40, 0])]);
  const world: BeingsWorld = createWorld({
    seed: [1, 2],
    simSecondsPerTick: 12,
    global: { ...beings.beingsGlobal(testGenesis(), beings.defaultLife()), occupancy },
    chunks,
    ruleset: beings.createBeingsRuleset({ controllers: { [SPECIES.id]: idler(1000) } }),
  });
  runTo(world, 3);
  return world;
}

/** A world of beings@2 with two beings, one minding a tainted message, stepped three ticks. */
function world2(): BeingsWorld {
  const held = mindOf({
    episodes: [own(1, { cell: [0, 0], v: 2 }), heard(2, 2, { tn: 2, ex: 4 })],
  });
  const placed = [being2(1, [0, 0], { mind: held }), being2(2, [40, 0])];
  const { chunks } = placedChunks(placed);
  const world = beings2World({ controllers: { [SPECIES2.id]: idler2(1000) }, chunks });
  runTo(world, 3);
  return world;
}

/** A copy of the record `value` without its member `name`. */
function withoutMember(value: object, name: string): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));
}

/** Every chunk and the global value of `world`, as the host reads them. */
function valuesOf(world: BeingsWorld) {
  const view = readView(world);
  const chunks = view.chunkKeys().map((key) => ({ key, chunk: view.readChunk(key) }));
  return { tick: view.tick, chunks, global: view.readGlobal() };
}

const WORLDS = [
  { version: "beings@1", world: world1 },
  { version: "beings@2", world: world2 },
] as const;

describe("the classes of a chunk and of the global value", () => {
  for (const { version, world } of WORLDS) {
    test(`classify every member of every chunk and of the global value of ${version}`, () => {
      const { tick, chunks, global } = valuesOf(world());
      expect(tick).toBe(3);
      // Not vacuous: two chunks, beings in each, and the eaten cells of the first.
      expect(chunks.map(({ key }) => key)).toEqual(["0,0", "1,0"]);
      expect(chunks.map(({ chunk }) => chunk?.beings.length)).toEqual([1, 1]);
      expect(chunks[0]?.chunk?.depletion).toEqual(DEPLETION);
      for (const { chunk } of chunks) expect(unclassified(CHUNK_CLASSES, chunk)).toEqual([]);
      expect(unclassified(GLOBAL_CLASSES, global)).toEqual([]);
      expect(Object.keys(global).sort()).toEqual(
        (GLOBAL_CLASSES.members ?? []).map(({ name }) => name),
      );
    });
  }

  test("reports a member they do not name, so that one added without a class fails here", () => {
    const { chunks, global } = valuesOf(world2());
    const chunk = chunks[0]?.chunk as beings.BeingsChunk;
    const added = { ...chunk, extra: 1, depletion: [{ ...DEPLETION[0], later: 2 }] };
    expect(unclassified(CHUNK_CLASSES, added).sort()).toEqual(["/depletion/0/later", "/extra"]);
    expect(unclassified(GLOBAL_CLASSES, { ...global, extra: 1 })).toEqual(["/extra"]);
  });

  test("name exactly the members the validators of a chunk and of the global value accept", () => {
    const { chunks, global } = valuesOf(world2());
    const chunk = chunks[0]?.chunk as beings.BeingsChunk;
    const ruleset = beings.createBeingsRuleset({
      controllers: { [SPECIES2.id]: idler2(1000) },
      rules: "beings@2",
    });
    const chunkIssues = (value: unknown) => beings.beingsChunkIssues("0,0", value, "beings@2");
    // A deliberately invalid global value, which the validator's type cannot describe.
    const globalIssues = (value: object) => ruleset.validateGlobal(value as never);
    expect(chunkIssues(chunk)).toEqual([]);
    expect(globalIssues(global)).toEqual([]);
    // Every member the registry names is one the validator requires.
    for (const { name } of CHUNK_CLASSES.members ?? [])
      expect([name, chunkIssues(withoutMember(chunk, name)).length > 0]).toEqual([name, true]);
    for (const { name } of GLOBAL_CLASSES.members ?? [])
      expect([name, globalIssues(withoutMember(global, name)).length > 0]).toEqual([name, true]);
    // And a member it does not name is one the validator refuses.
    expect(chunkIssues({ ...chunk, extra: 1 }).map(({ path }) => path)).toContain("/extra");
    expect(globalIssues({ ...global, extra: 1 }).map(({ path }) => path)).toContain("/extra");
  });

  test("classify the beings of a chunk by BEING_CLASSES, and its depletion and due as C3", () => {
    expect(CHUNK_CLASSES.class).toBe("C0");
    expect(memberOf(CHUNK_CLASSES, "beings")?.each).toBe(BEING_CLASSES);
    const { chunks } = valuesOf(world1());
    const chunk = chunks[0]?.chunk as beings.BeingsChunk;
    // A being of beings@1 holds no C3 member, so the chunk's C3 paths are its depletion and due.
    expect(secretPaths(CHUNK_CLASSES, chunk)).toEqual([
      "/depletion",
      "/depletion/0",
      "/depletion/0/cell",
      "/depletion/0/since",
      "/depletion/0/taken",
      "/depletion/1",
      "/depletion/1/cell",
      "/depletion/1/since",
      "/depletion/1/taken",
      "/due",
    ]);
  });

  test("classify the whole global value as C3, every member of it", () => {
    expect(GLOBAL_CLASSES.class).toBe("C3");
    const { global } = valuesOf(world2());
    expect(secretPaths(GLOBAL_CLASSES, global).sort()).toEqual([
      "/genesis",
      "/genesisSeal",
      "/life",
      "/lifeSeal",
      "/occupancy",
      "/prunedDay",
    ]);
    expect([CHUNK_CLASSES, GLOBAL_CLASSES].every((node) => Object.isFrozen(node))).toBe(true);
  });
});
