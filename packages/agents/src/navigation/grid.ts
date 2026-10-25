/**
 * The window grid that navigation searches: the part of a being's senses that holds the duration
 * of every step (docs/architecture/beings.md, "Senses"). The indexing and the direction vectors
 * here are the contract the engine, the brain, and every oracle share.
 */

/**
 * A square window of `side` cells and the 8 edges of each. Cell (x, y) of the world has index
 * `(y − origin.y)·side + (x − origin.x)`, so the cell in column c and row r of the window has index
 * `r·side + c`, rows growing northward. Entry `index·8 + d` of `edgeMs` is the duration in integer
 * milliseconds of the step from that cell in direction d, or −1 when it is impassable.
 */
export type WindowGrid = { readonly side: number; readonly edgeMs: Int32Array };

/** The largest side of a window: 2R + 1 for the largest senses radius R, 32. */
export const MAX_WINDOW_SIDE = 65;
