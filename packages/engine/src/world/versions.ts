/**
 * Replay compatibility (ADR 0020, snapshots; plan §5.2 "Versiones"). A world records, in its
 * snapshot header, the versions of the engine and the ruleset that made it. Replay requires them
 * to equal the running engine's and the world's own ruleset's, so step refuses a world that
 * differs: a snapshot from another version can be loaded, but not replayed.
 */
import { canonicalize } from "../canonical/encode.ts";
import type { Issue } from "../errors.ts";
import { ENGINE_VERSION } from "../version.ts";
import { healthyState, type World, type WorldHeader, type WorldState } from "./world.ts";

/** One version a header records, what it is called, and what the running code says. */
type Compared = readonly [field: keyof WorldHeader, label: string, running: string, source: string];

/** Each difference between the header of `state` and the versions it runs under, in header order. */
export function headerDifferences({ header, ruleset }: WorldState): Issue[] {
  const { versions } = ruleset;
  const compared: Compared[] = [
    ["engineVersion", "engine version", ENGINE_VERSION, "this engine is"],
    ["rulesetVersion", "ruleset version", versions.ruleset, "its ruleset declares"],
    ["generatorVersion", "generator version", versions.generator, "its ruleset declares"],
    ["brainVersion", "brain version", versions.brain, "its ruleset declares"],
  ];
  return compared.flatMap(([field, label, running, source]) => {
    const recorded = header[field];
    if (recorded === running) return [];
    const message =
      `the world records ${label} ${canonicalize(recorded)}, ` +
      `but ${source} ${canonicalize(running)}`;
    return [{ path: `/header/${field}`, message }];
  });
}

/**
 * Each difference between the versions the header of `world` records and those it runs under:
 * ENGINE_VERSION, and its ruleset's versions, in a fresh array, empty when step may replay it.
 * Worlds that createWorld makes never differ. It takes no ruleset, unlike the
 * `versionDifferences(world, ruleset)` of plan §4: a world runs the ruleset it captured, so its
 * own ruleset is the one to compare. Throws EngineError("invalid_input") when `world` is not a
 * world, EngineError("world_busy") while a step runs on it or a read of values of its state runs
 * (readState), and
 * EngineError("world_faulted") when its tick failed.
 */
export function versionDifferences(world: World): Issue[] {
  return headerDifferences(healthyState(world, "versionDifferences"));
}
