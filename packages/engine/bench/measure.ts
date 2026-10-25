import { heapStats } from "bun:jsc";

/**
 * The live heap after a full collection, in bytes, for the benchmarks' memory rows. JSC's heapSize
 * already holds the extra memory it tracks beside its cells, such as the backing stores of typed
 * arrays, so adding extraMemorySize counts that memory twice: holding 250 MiB of Int32Array grew
 * heapSize, extraMemorySize, and the resident set by about 250 MiB each (Bun 1.4.4, 2026-10-25).
 */
export function liveHeap(): number {
  Bun.gc(true);
  return heapStats().heapSize;
}
