/**
 * World sources (ADR 0025, "Planes and the boundary"): the only way anything enters the world. A
 * source gives the host a world and, for each tick, the commands to apply at it. Its type admits
 * no presentation data. In T6 there are two: the preregistered default world of T5, whose beings
 * the admin spawns at tick 1, and a scripted one for tests. Later, the admin plane and the AI
 * gateway feed the host through sources too, and T7 adds the recovery source.
 */
import type { CanonicalValue, Command, CommandOrigin, Tick, World } from "@open-origin/engine";
import { LABELS2, scenario2Of } from "@open-origin/scenarios";

/** A command before the host stamps it: the host gives it `applyTick` and `seq`. */
export type CommandIntent = {
  readonly type: string;
  readonly origin: CommandOrigin;
  readonly payload: CanonicalValue;
};

/** Where a world and its commands come from. */
export interface WorldSource {
  /** The world at its last tick. The host takes it over: nothing else steps it. */
  readonly world: World;
  /** The commands to apply at `tick`, in order. Asked once per tick, in increasing tick order. */
  commandsAt(tick: Tick): readonly CommandIntent[];
}

/** The intent of `command`: what is left once its tick and its order are taken away. */
function intentOf({ type, origin, payload }: Command): CommandIntent {
  return { type, origin, payload };
}

/** The label of the default world: the preregistered scenario of T5. */
export const DEFAULT_LABEL = LABELS2.default;

/**
 * A preregistered scenario of T5 (`@open-origin/scenarios`), the default one unless another label
 * is given: its world at tick 0, and its admin spawns at tick 1.
 */
export class ScenarioSource implements WorldSource {
  readonly label: string;
  readonly world: World;
  readonly #spawns: readonly CommandIntent[];

  constructor(label: string = DEFAULT_LABEL) {
    const scenario = scenario2Of(label);
    this.label = label;
    this.world = scenario.world;
    this.#spawns = Object.freeze(scenario.spawns.map(intentOf));
  }

  commandsAt(tick: Tick): readonly CommandIntent[] {
    return tick === 1 ? this.#spawns : [];
  }
}

/** A world and a script, for tests: the commands of tick `t` are at index `t − 1`. */
export class ScriptedSource implements WorldSource {
  readonly world: World;
  readonly #script: readonly (readonly CommandIntent[])[];

  constructor(world: World, script: readonly (readonly CommandIntent[])[]) {
    this.world = world;
    this.#script = script;
  }

  commandsAt(tick: Tick): readonly CommandIntent[] {
    return this.#script[tick - 1] ?? [];
  }
}
