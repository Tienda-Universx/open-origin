/**
 * The version of the procedural generator (ADR 0021, versioning). It covers terrain, the calendar,
 * the observables, and the genesis schema, and it is frozen with its golden values when T3 closes:
 * after that, any different output for any input, or any new law, needs "worldgen@2". A ruleset
 * that uses worldgen declares `versions.generator = WORLDGEN_VERSION`.
 */
export const WORLDGEN_VERSION = "worldgen@1";
