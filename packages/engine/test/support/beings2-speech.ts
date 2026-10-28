import type { beings, EngineEvent, mind } from "../../src/index.ts";
import { type BeingsWorld, behavior, beingOf } from "./beings-world.ts";
import { type Cell, idling, standable, standingPair } from "./beings2-mind.ts";
import { beings2World, brain2, chunksOf, type Senses2 } from "./beings2-world.ts";

/**
 * Helpers for the tests of speech in beings@2 (ADR 0024, docs/architecture/mind.md "Speech"):
 * cells in and out of reach of a speaker, intentions that talk, and worlds whose beings follow a
 * script by the index of their decision, recording what they sensed at each.
 */

export const LONG = 6_000_000;

/**
 * A row of cells where beings may stand, east of A: B two cells away and NEAR one, both within
 * the default `speech.range` of 3; FOUR four cells away, within dim sight but out of reach; and
 * FAR, 20 cells away, out of sight.
 */
export const [A, B] = standingPair([-128, -128], [2, 0], (a) =>
  [1, 3, 4, 20].every((dx) => standable([a[0] + dx, a[1]])),
);
export const NEAR: Cell = [A[0] + 1, A[1]];
export const THREE: Cell = [A[0] + 3, A[1]];
export const FOUR: Cell = [A[0] + 4, A[1]];
export const FAR: Cell = [A[0] + 20, A[1]];

/** An intention whose one step is a talk to `to`, with `about` when given, and `mind`. */
export function talk(
  to: number,
  act: mind.Act,
  about?: number | string,
  ops?: beings.MindIntention,
): beings.Intention2 {
  return {
    steps: [{ kind: "talk", to, act, ...(about === undefined ? {} : { about }) }],
    wakeWhen: {},
    behavior: behavior("x"),
    ...(ops === undefined ? {} : { mind: ops }),
  };
}

/** What a being proposes at its decision of index `decision`, from 0. */
export type Script = (senses: Senses2, decision: number) => beings.Intention2;

/**
 * A world of beings@2 holding `placed`, where each being follows its script, by id, and idles long
 * when it has none; what each being sensed at each decision is kept in `sensed`, by id.
 */
export function scripted(
  placed: readonly beings.Being2[],
  scripts: { readonly [id: number]: Script },
  options: { readonly life?: beings.LifeConfig2; readonly seed?: readonly [number, number] } = {},
): { readonly world: BeingsWorld; readonly sensed: Map<number, Senses2[]> } {
  const sensed = new Map<number, Senses2[]>();
  const brain = brain2((senses) => {
    const id = senses.self.id;
    const before = sensed.get(id) ?? [];
    sensed.set(id, [...before, senses]);
    return scripts[id]?.(senses, before.length) ?? idling(LONG);
  });
  const world = beings2World({
    controllers: { s1: brain },
    chunks: chunksOf(placed),
    ...(options.life === undefined ? {} : { life: options.life }),
    ...(options.seed === undefined ? {} : { seed: [options.seed[0], options.seed[1]] }),
  });
  return { world, sensed };
}

/** The mind of the being `id` of `world`. */
export function mindIn(world: BeingsWorld, id: number): mind.Mind {
  return (beingOf(world, id) as beings.Being2).mind;
}

/** The type and payload of every event of `events` of the type `type`, with its tick. */
export function eventsOfType(
  events: readonly EngineEvent[],
  type: string,
): { readonly tick: number; readonly payload: unknown }[] {
  return events
    .filter((event) => event.type === type)
    .map(({ tick, payload }) => ({ tick, payload }));
}

/** The events of `events` at `tick` that concern the being `id`, as [type, payload]. */
export function eventsOfBeing(
  events: readonly EngineEvent[],
  tick: number,
  id: number,
): [string, unknown][] {
  return events
    .filter((event) => event.tick === tick && (event.payload as { id?: number }).id === id)
    .map(({ type, payload }) => [type, payload]);
}
