/**
 * An indexed binary min-heap of window cells over typed arrays, one per search. Each cell is in it
 * at most once, so it never holds more than the window's cells, and a cell whose key falls moves up
 * in place instead of entering again.
 *
 * Cells are ordered by (g + h, h, cell index), where g is the duration from the start and h the
 * heuristic toward the goal: the smaller f first, then the smaller h, which favors cells nearer
 * the goal, then the smaller index. No two cells compare equal, so the order in which cells leave
 * the heap is a function of the keys alone, the same on every run and every engine. Dijkstra's
 * search sets h to 0, which leaves the order (g, cell index).
 */

export type CellHeap = {
  /** The cells, in heap order: slot 0 holds the first, slot s precedes slots 2s + 1 and 2s + 2. */
  readonly slots: Int32Array;
  /** The slot of each cell, or −1 when it is not in the heap. */
  readonly slotOf: Int32Array;
  /** The keys of every cell: the duration from the start, and the heuristic. */
  readonly g: Float64Array;
  readonly h: Float64Array;
  /** How many slots are in use. */
  size: number;
};

/** An empty heap for the cells that `g` and `h` key, one entry each; the search owns the keys. */
export function createHeap(g: Float64Array, h: Float64Array): CellHeap {
  const cells = g.length;
  return { slots: new Int32Array(cells), slotOf: new Int32Array(cells).fill(-1), g, h, size: 0 };
}

/** Whether cell `a` leaves the heap before cell `b`. */
function precedes(heap: CellHeap, a: number, b: number): boolean {
  const ha = heap.h[a] as number;
  const hb = heap.h[b] as number;
  // Sums of safe integers below 2^53, so exact.
  const fa = (heap.g[a] as number) + ha;
  const fb = (heap.g[b] as number) + hb;
  if (fa !== fb) return fa < fb;
  if (ha !== hb) return ha < hb;
  return a < b;
}

/** Puts `cell` in `slot` and records where it is. */
function place(heap: CellHeap, slot: number, cell: number): void {
  heap.slots[slot] = cell;
  heap.slotOf[cell] = slot;
}

/** Moves the cell at `slot` up until its parent precedes it. */
function siftUp(heap: CellHeap, slot: number): void {
  const cell = heap.slots[slot] as number;
  let at = slot;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    const above = heap.slots[parent] as number;
    if (!precedes(heap, cell, above)) break;
    place(heap, at, above);
    at = parent;
  }
  place(heap, at, cell);
}

/** Moves the cell at `slot` down until it precedes both its children. */
function siftDown(heap: CellHeap, slot: number): void {
  const cell = heap.slots[slot] as number;
  let at = slot;
  for (let child = 2 * at + 1; child < heap.size; child = 2 * at + 1) {
    const right = child + 1;
    const first =
      right < heap.size && precedes(heap, heap.slots[right] as number, heap.slots[child] as number)
        ? right
        : child;
    const below = heap.slots[first] as number;
    if (!precedes(heap, below, cell)) break;
    place(heap, at, below);
    at = first;
  }
  place(heap, at, cell);
}

/** Adds `cell`, or moves it up after its key fell: keys only fall while a cell is in the heap. */
export function pushOrRaise(heap: CellHeap, cell: number): void {
  const slot = heap.slotOf[cell] as number;
  if (slot >= 0) {
    siftUp(heap, slot);
    return;
  }
  place(heap, heap.size, cell);
  heap.size += 1;
  siftUp(heap, heap.size - 1);
}

/** Removes and returns the first cell; the heap must not be empty. */
export function popFirst(heap: CellHeap): number {
  const first = heap.slots[0] as number;
  heap.slotOf[first] = -1;
  heap.size -= 1;
  if (heap.size > 0) {
    place(heap, 0, heap.slots[heap.size] as number);
    siftDown(heap, 0);
  }
  return first;
}
