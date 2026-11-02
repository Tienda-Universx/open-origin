import type { World } from "@open-origin/engine";
import type { WorldProjection } from "../../src/projection/projection.ts";
import { deepFrozen, type PublishedTick } from "../../src/world/published.ts";

/**
 * The published record of `tick` for a world that holds no beings, such as the counting world:
 * its clock at the dawn of day 0, and no chunk, speech, or feed. Frozen at every level.
 */
export function publishedAt(tick: number): PublishedTick {
  const clock = { tick, day: 0, dayPermille: 0 };
  return deepFrozen({ tick, clock, chunks: [], speech: [], feed: [] });
}

/** The projection of a world that holds no beings and no terrain, such as the counting world. */
export function emptyProjection(_world: World): WorldProjection {
  return {
    project: ({ tick }) => publishedAt(tick),
    readTerrain: () => {
      throw new Error("a world without beings has no terrain");
    },
  };
}
