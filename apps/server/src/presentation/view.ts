/**
 * The limit of a client's view (ADR 0026, "Limits and backpressure": at most 32 MiB encoded,
 * measured at L'). A chunk's size is the bytes of its being records at the playout tick, with the
 * comma between two of them, and the bytes of the widest terrain: an upper bound of what its
 * content adds to the view that needs no terrain generated. An interest whose chunks pass the limit
 * is trimmed deterministically: its chunks are kept in their order, the follow window first, then
 * the camera in the order the client sent it, until the next one would pass the limit; that chunk
 * and every one after it are left out, and the client is told which in a `notice`.
 */
import { type ChunkCoord, CLIENT_LIMITS } from "@open-origin/protocol/public";
import type { Mirror } from "./mirror.ts";
import { WIDEST_TERRAIN_BYTES } from "./terrain.ts";

/** The most bytes of a view. */
export const VIEW_BYTES = CLIENT_LIMITS.maxViewBytes;

/** An interest, trimmed: the chunks kept, and those left out, each in the interest's order. */
export type Trimmed = { readonly kept: ChunkCoord[]; readonly trimmed: ChunkCoord[] };

/** The bytes the chunk `at` adds to a view at the mirror's tick. */
function chunkViewBytes(mirror: Mirror, at: ChunkCoord): number {
  const { bytes, records } = mirror.current(at);
  return bytes + records.length + WIDEST_TERRAIN_BYTES;
}

/** `interest` trimmed to `limit` bytes at the mirror's tick: the longest prefix that fits. */
export function trimView(mirror: Mirror, interest: readonly ChunkCoord[], limit: number): Trimmed {
  const kept: ChunkCoord[] = [];
  let bytes = 0;
  for (const at of interest) {
    bytes += chunkViewBytes(mirror, at);
    if (bytes > limit) return { kept, trimmed: interest.slice(kept.length) };
    kept.push(at);
  }
  return { kept, trimmed: [] };
}
