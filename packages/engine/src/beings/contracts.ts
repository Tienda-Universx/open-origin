/**
 * The port between the body and a brain (ADR 0023): what the engine gives a brain at a decision,
 * and what a brain may propose. The engine defines it; packages/agents implements brains. A brain
 * is a pure function of its senses: whatever it must remember between decisions travels in
 * `behavior`, which the engine stores in the being and hands back. A brain of beings@2 (ADR 0024)
 * also declares its behaviors and the namespace of its concepts, and senses others and its mind.
 */
import type { DeepReadonly } from "../world/contracts.ts";
import type {
  Activity,
  Behavior,
  Cell,
  Cooldown,
  CooldownRequest,
  Outcome,
  PlanStep,
  Traits2,
  WakeConditions,
} from "./being.ts";

/**
 * The 8 directions, by index: 0 E, 1 NE, 2 N, 3 NW, 4 W, 5 SW, 6 S, 7 SE, counterclockwise from
 * east, with +x east and +y north on worldgen's cell axes. A walk is a string of these indices.
 */
export const DIRECTIONS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([1, 0] as const),
  Object.freeze([1, 1] as const),
  Object.freeze([0, 1] as const),
  Object.freeze([-1, 1] as const),
  Object.freeze([-1, 0] as const),
  Object.freeze([-1, -1] as const),
  Object.freeze([0, -1] as const),
  Object.freeze([1, -1] as const),
]);

export { MAX_INTENTION_STEPS, MAX_WALK_STEPS } from "./being.ts";

/** The window a being senses, `side` cells square from `origin`, indexed `row·side + column`. */
export type SensedWindow = {
  readonly origin: Cell;
  readonly side: number;
  /** Entry `index·8 + d`: milliseconds of the step from cell `index` in direction d, or −1. */
  readonly edgeMs: Int32Array;
  /** Per cell: 0 below the diet's `some`, 1 from `some` to below `plenty`, 2 from `plenty`. */
  readonly foodCue: Uint8Array;
};

/** What a brain receives at a decision: a fresh copy, which shares nothing with the world. */
export type Senses = {
  readonly self: {
    readonly id: number;
    readonly species: string;
    readonly cell: Cell;
    readonly needs: { readonly nutrition: number; readonly rest: number };
    readonly health: number;
    readonly condition: "ok" | "incapacitated";
    readonly traits: {
      readonly appetite: number;
      readonly sleepiness: number;
      readonly curiosity: number;
    };
    readonly activity: Activity;
    readonly behavior: Behavior;
    readonly outcome: Outcome;
    readonly cooldowns: readonly Cooldown[];
  };
  /** The radiance of the instant, a surface observable. */
  readonly light: number;
  readonly window: SensedWindow;
  /** Two u32 draws from the system's stream `beings.brain`, keyed by the being. */
  readonly draws: readonly number[];
};

/**
 * What a brain proposes: one to three steps, when to be woken, what to remember, and optionally up
 * to four targets to avoid for a while, which the engine adds to the being's cooldowns.
 */
export type Intention = {
  readonly steps: readonly PlanStep[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
  readonly cooldowns?: readonly CooldownRequest[];
};

/** A brain: its version, which the ruleset's brain version composes, and its decision. */
export interface Controller {
  readonly brain: string;
  decide(senses: DeepReadonly<Senses>): Intention;
}

/** What a brain of beings@2 receives at a decision: the senses of T4 with the six traits. */
export type Senses2 = Omit<Senses, "self"> & {
  readonly self: Omit<Senses["self"], "traits"> & { readonly traits: Traits2 };
};

/**
 * A brain of beings@2: its version; the 1 to 16 identifiers its `behavior.kind` may take, so that
 * no other value hides information there; the namespace of its concepts, the first segment of the
 * concept ids it may form; and its decision, called without `this`.
 */
export interface Controller2 {
  readonly brain: string;
  readonly behaviors: readonly string[];
  readonly concepts: string;
  decide(senses: DeepReadonly<Senses2>): Intention;
}
