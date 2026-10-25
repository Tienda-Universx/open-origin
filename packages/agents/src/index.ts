/**
 * The brain of the beings (ADR 0023): pure policies over the senses the engine builds, which only
 * propose. This package imports only the engine's public entry and keeps no module state.
 */
export { dijkstra, pathTo, type ShortestPaths } from "./navigation/dijkstra.ts";
export { MAX_WINDOW_SIDE, type WindowGrid } from "./navigation/grid.ts";
