/**
 * The host's view of a world (ADR 0020, ownership): reads that return detached copies, never a
 * reference to the live state.
 */
import { copyCanonical } from "../canonical/copy.ts";
import type { CanonicalValue } from "../canonical/value.ts";
import { parseChunkKey } from "./chunk.ts";
import type { DeepReadonly, ReadView } from "./contracts.ts";
import { healthyState, readState, type World } from "./world.ts";

/**
 * Reads of `world` for the host. Each call reads the world as it is then and returns a detached
 * copy: changing what it returns never changes the world. readChunk throws
 * EngineError("invalid_value") for a key that is not a chunk key, and returns undefined for a key
 * that has no chunk. readView and every method of the view throw EngineError("world_faulted")
 * once the world is poisoned, and EngineError("world_busy") while a step runs on it or a read
 * runs. readChunk and readGlobal copy a value of the state, so they read it as readState does: a
 * Proxy in it that uses the world meanwhile is refused.
 */
export function readView<G extends CanonicalValue, C extends CanonicalValue>(
  world: World<G, C>,
): ReadView<G, C> {
  healthyState(world, "readView");
  // The ruleset's validators accepted these values as a G and as Cs when they entered the world.
  return {
    get tick() {
      return healthyState(world, "view.tick").kernel.tick;
    },
    get simSecondsPerTick() {
      return healthyState(world, "view.simSecondsPerTick").kernel.config.simSecondsPerTick;
    },
    chunkKeys: () => healthyState(world, "view.chunkKeys").chunks.sortedKeys(),
    readChunk: (key) =>
      readState(world, "view.readChunk", "read", ({ chunks }) => {
        parseChunkKey(key);
        const entry = chunks.get(key);
        return entry === undefined ? undefined : (copyCanonical(entry.value) as DeepReadonly<C>);
      }),
    readGlobal: () =>
      readState(
        world,
        "view.readGlobal",
        "read",
        ({ global }) => copyCanonical(global) as DeepReadonly<G>,
      ),
  };
}
