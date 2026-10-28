/**
 * The brain of the beings (ADR 0023): pure policies over the senses the engine builds, which only
 * propose, and the templates that render their acts of speech (ADR 0024). This package imports
 * only the engine's public entry and keeps no module state.
 */

export { MIND_BRAIN } from "./brain/mind/parameters.ts";
export { type MindConfig, mindController } from "./brain/mind.ts";
export { UTILITY_BRAIN } from "./brain/parameters.ts";
export { utilityController } from "./brain/utility.ts";
export { aStar, octileMs, type Route, type StepBounds } from "./navigation/astar.ts";
export { dijkstra, pathTo, type ShortestPaths } from "./navigation/dijkstra.ts";
export { MAX_WINDOW_SIDE, type WindowGrid } from "./navigation/grid.ts";
export { type Names, renderAct, SPEECH_TEMPLATES, type UtteredAct } from "./speech/templates.ts";
