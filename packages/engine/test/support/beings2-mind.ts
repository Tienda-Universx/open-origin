import {
  beings,
  type CanonicalValue,
  createWorld,
  type EngineEvent,
  type Ruleset,
  type TickContext,
  worldgen,
} from "../../src/index.ts";
import { type BeingsWorld, baseFood, behavior, PREPARED, testGenesis } from "./beings-world.ts";
import { type Senses2, SPECIES2 } from "./beings2-world.ts";

/**
 * Helpers for the tests of the mental operations of beings@2 and their ledger (ADR 0024,
 * docs/architecture/mind.md "Beliefs" and "Events"): cells where beings may stand, the food cue an
 * independent reading of the terrain gives, scripted decisions, and readers of the events of a mind.
 */

export type Cell = readonly [number, number];

/** An intention of beings@2 that idles for `ms`, with the mental operations `mind`. */
export function idling(ms: number, mind?: beings.MindIntention): beings.Intention2 {
  return {
    steps: [{ kind: "idle", ms }],
    wakeWhen: {},
    behavior: behavior("rest"),
    ...(mind === undefined ? {} : { mind }),
  };
}

/** Whether a being may stand at `cell`: no deeper liquid than the species wades. */
export function standable(cell: Cell): boolean {
  const level = worldgen.liquidLevel(worldgen.genesisOf(PREPARED));
  const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
  const [elevation = -1] = worldgen.sampleSurface(PREPARED, rect, 0).elevation;
  return level - elevation <= SPECIES2.locomotion.maxWade;
}

/** The band of `units` of food by the cue of the species' diet: 0, 1 from `some`, 2 from `plenty`. */
export function bandOf(units: number): number {
  const { some, plenty } = SPECIES2.diet.cue;
  if (units >= plenty) return 2;
  return units >= some ? 1 : 0;
}

/** The band of the food at `cell` in the test genesis before any being ate, read from the terrain. */
export function baseBand(cell: Cell): number {
  return bandOf(baseFood(cell));
}

/**
 * The first cell, scanning rows north of `from` eastward, where a being may stand at both `cell`
 * and `cell` + `offset`, and `accept` holds for the two.
 */
export function standingPair(
  from: Cell,
  offset: Cell,
  accept: (a: Cell, b: Cell) => boolean,
): readonly [Cell, Cell] {
  for (let y = from[1]; y < from[1] + 64; y += 1) {
    for (let x = from[0]; x < from[0] + 64; x += 1) {
      const a: Cell = [x, y];
      const b: Cell = [x + offset[0], y + offset[1]];
      if (standable(a) && standable(b) && accept(a, b)) return [a, b];
    }
  }
  throw new Error(`no pair of standable cells near ${from} at the offset ${offset}`);
}

/** The payloads of the events of `type` of the being `id`, with their ticks. */
export function eventsOf(
  events: readonly EngineEvent[],
  type: string,
  id: number,
): { readonly tick: number; readonly payload: unknown }[] {
  return events
    .filter((event) => event.type === type && (event.payload as { id: number }).id === id)
    .map(({ tick, payload }) => ({ tick, payload }));
}

/** The type and payload of each event of `events` at `tick`, in order. */
export function eventsAt(events: readonly EngineEvent[], tick: number): [string, unknown][] {
  return events.filter((event) => event.tick === tick).map(({ type, payload }) => [type, payload]);
}

/** A fresh copy of the cell of the being that sensed `senses`, which no other value shares. */
export function cellOf(senses: Senses2): Cell {
  const [x = Number.NaN, y = Number.NaN] = senses.self.cell;
  return [x, y];
}

/** The senses of a first decision: one whose outcome is still the spawn's or the record's `none`. */
export function isFirst(senses: Senses2): boolean {
  return senses.self.outcome.result === "none";
}

/** A mind as a commit of the world saw it: the tick its system last ran, and the being's activity. */
export type Committed = {
  readonly tick: number;
  readonly id: number;
  readonly mind: object;
  readonly activity: string;
};

/**
 * A world of beings@2 under audit, as beings2World makes it, whose validateChunk, which the commit
 * runs on every chunk a tick changed, records in `seen` the very mind object of each being it
 * holds: the read view copies chunks, so only the commit shows whether a mind was copied.
 */
export function watchedWorld(options: {
  readonly controllers: { readonly [species: string]: beings.Controller2 };
  readonly life: beings.LifeConfig2;
  readonly chunks: { readonly [key: string]: beings.BeingsChunk };
  readonly seen: Committed[];
}): BeingsWorld {
  const ruleset = beings.createBeingsRuleset({
    controllers: options.controllers,
    rules: "beings@2",
  });
  let tick = 0;
  const watched: Ruleset<beings.BeingsGlobal, beings.BeingsChunk> = {
    ...ruleset,
    systems: ruleset.systems.map((system) => ({
      ...system,
      run: (ctx: TickContext<beings.BeingsGlobal, beings.BeingsChunk>) => {
        tick = ctx.tick;
        return system.run(ctx);
      },
    })),
    validateChunk: (key, value) => {
      for (const being of (value as beings.BeingsChunk).beings as beings.Being2[])
        options.seen.push({ tick, id: being.id, mind: being.mind, activity: being.activity.kind });
      return ruleset.validateChunk(key, value);
    },
  };
  const occupancy = Object.keys(options.chunks).sort();
  return createWorld(
    {
      seed: [1, 2],
      simSecondsPerTick: 12,
      global: { ...beings.beingsGlobal(testGenesis(), options.life), occupancy },
      chunks: options.chunks as { [key: string]: CanonicalValue } as never,
      ruleset: watched,
    },
    { audit: true },
  );
}
