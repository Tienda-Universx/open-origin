/**
 * The C0 projection of a world of beings (ADR 0026, "Projections and classification"): for each
 * executed tick, the published record the gate releases once the tick is committed. It runs once
 * per tick in the world plane, whoever observes, and reads the world only through `readView`,
 * whose reads are detached copies, so it cannot change what the world computes.
 *
 * A chunk's version moves only when its C0 bytes change: for each chunk the step changed, the
 * projection encodes the public record of each of its beings and compares it with the last one it
 * emitted, which it keeps by chunk and id. A record goes out only when its bytes differ, and an id
 * that left the chunk is listed as gone, so engine dirtiness that changes nothing public, such as
 * a being's needs or mind, emits nothing. Its work per tick grows with the beings of the changed
 * chunks, and its memory with the beings of the world.
 */
import { renderAct } from "@open-origin/agents";
import {
  type beings,
  type ChunkKey,
  parseChunkKey,
  type ReadView,
  readView,
  type StepResult,
  type World,
  worldgen,
} from "@open-origin/engine";
import type { BeingPublic, ChunkCoord, Clock, TerrainPublic } from "@open-origin/protocol/public";
import type { Projector } from "../world/host.ts";
import { deepFrozen, type PublishedChunk, type PublishedTick } from "../world/published.ts";
import { checkedRecord, publicRecordOf } from "./being.ts";
import { calendarClock } from "./clock.ts";
import { projectEvents, type Render } from "./events.ts";
import { type ReadTerrain, terrainReader } from "./terrain.ts";

/**
 * A projection of a world: the full record of its boot tick, each tick's published record, and the
 * public terrain of a chunk.
 */
export interface WorldProjection extends Projector {
  /**
   * The full C0 projection of the world at the tick it booted at, frozen: every chunk that holds a
   * being, with all its records at version `v` = that tick, and no speech or feed. The gate hands it
   * to each listener first, so the presentation's mirror starts complete (ADR 0025, "Executed,
   * committed, published").
   */
  boot(): PublishedTick;
  readTerrain(chunk: ChunkCoord): TerrainPublic;
  /** The items of speech left out so far because their text was not plain text (C3). */
  readonly omittedSpeech: number;
}

export type ProjectionOptions = {
  /** How an act of speech becomes text: speech@1's renderAct unless a test replaces it. */
  readonly render?: Render;
};

/** The encoded public record of each being of a chunk, by id, in the chunk's order of ids. */
type Shown = Map<number, string>;

/**
 * The genesis that `global`, the global value of a world, holds. Throws when it holds none: the
 * world is then not a world of beings, and nothing here could read its beings or its calendar.
 */
function genesisIn(global: unknown): unknown {
  if (typeof global !== "object" || global === null || !("genesis" in global)) {
    throw new Error("the world is not a world of beings: its global value holds no genesis");
  }
  return global.genesis;
}

/** The C0 projection of a world of beings@1 or beings@2, booted at the world's tick. */
export class BeingsProjection implements WorldProjection {
  readonly #view: ReadView<beings.BeingsGlobal, beings.BeingsChunk>;
  readonly #clock: (tick: number) => Clock;
  readonly #terrain: ReadTerrain;
  readonly #render: Render;
  /** The records last emitted, or held at boot, of the beings of each chunk that holds any. */
  readonly #shown = new Map<ChunkKey, Shown>();
  readonly #boot: PublishedTick;
  #tick: number;
  #omittedSpeech = 0;

  /**
   * The projection of `world`, a world of beings whose state it reads as it is now. Throws an
   * Error saying it is not a world of beings when its global value holds no genesis, as a world of
   * another ruleset's does; an EngineError when the genesis it holds is not valid; and an Error
   * when one of its beings has no valid public record.
   */
  constructor(world: World, { render = renderAct }: ProjectionOptions = {}) {
    // A world of beings holds these values; genesisIn refuses a global value without a genesis.
    this.#view = readView(world as World<beings.BeingsGlobal, beings.BeingsChunk>);
    const prepared = worldgen.prepareGenesis(genesisIn(this.#view.readGlobal()));
    this.#clock = calendarClock(prepared, this.#view.simSecondsPerTick);
    this.#terrain = terrainReader(prepared);
    this.#render = render;
    this.#tick = this.#view.tick;
    // Every record is new to an empty projection, so the change of each chunk is all of it.
    const chunks = this.#view.chunkKeys().flatMap((key) => this.#changeOf(key));
    const tick = this.#tick;
    this.#boot = deepFrozen({ tick, clock: this.#clock(tick), chunks, speech: [], feed: [] });
  }

  boot(): PublishedTick {
    return this.#boot;
  }

  /** The items of speech left out so far because their text was not plain text (C3). */
  get omittedSpeech(): number {
    return this.#omittedSpeech;
  }

  /**
   * The published record of the tick `result` reports, which must be the tick after the last one
   * projected, read from the world right after its step: its clock, the chunks whose C0 content
   * it changed, its local speech, and its feed, frozen at every level.
   */
  project(result: StepResult): PublishedTick {
    const { tick } = result;
    if (tick !== this.#tick + 1 || tick !== this.#view.tick) {
      throw new Error(`the projection is at tick ${this.#tick} and cannot project tick ${tick}`);
    }
    this.#tick = tick;
    const chunks = result.changedChunks.flatMap((key) => this.#changeOf(key));
    const { speech, feed, omitted } = projectEvents(tick, result.events, this.#render);
    this.#omittedSpeech += omitted;
    return deepFrozen({ tick, clock: this.#clock(tick), chunks, speech, feed });
  }

  readTerrain(chunk: ChunkCoord): TerrainPublic {
    return this.#terrain(chunk);
  }

  /**
   * How the C0 content of the chunk `key` changed since its records were last emitted: none when
   * no record changed and no being left; otherwise the records whose bytes changed and the ids
   * that left. Every record that goes out, or that boot holds, is checked by the schema.
   */
  #changeOf(key: ChunkKey): PublishedChunk[] {
    const before: Shown = this.#shown.get(key) ?? new Map();
    const now: Shown = new Map();
    const upsert: BeingPublic[] = [];
    for (const being of this.#view.readChunk(key)?.beings ?? []) {
      const record = publicRecordOf(being);
      const bytes = JSON.stringify(record);
      now.set(being.id, bytes);
      if (before.get(being.id) !== bytes) upsert.push(checkedRecord(being.id, record));
    }
    const gone = [...before.keys()].filter((id) => !now.has(id));
    if (now.size === 0) this.#shown.delete(key);
    else this.#shown.set(key, now);
    if (upsert.length === 0 && gone.length === 0) return [];
    const { x, y } = parseChunkKey(key);
    return [{ at: [x, y], v: this.#tick, upsert, gone }];
  }
}
