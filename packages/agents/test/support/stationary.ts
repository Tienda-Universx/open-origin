import { beings, worldgen } from "@open-origin/engine";
import { stationaryHorizon } from "../../../engine/test/support/beings-world.ts";
import { labelSeeds } from "./scenario.ts";

/**
 * The settings of the stationary control (docs/architecture/beings.md, "Negative controls"), which
 * the survival test runs on the calibration labels, the default label, and heldout/1, and the soak
 * on every held-out label. Only the length of a tick and the reach of the senses differ from the
 * scenario: the laws of the body and of food do not depend on either (ADR 0023).
 */

/** 600 s per tick, so that the stationary horizon H, 47.7 days, takes about 6,000 ticks. */
export const STATIONARY_SPS = 600;

/** The default laws with a senses radius of 1: a brain that looks only at its own cell. */
export function stationaryLife(): beings.LifeConfig {
  const life = beings.defaultLife();
  return {
    ...life,
    species: life.species.map((species) => ({ ...species, senses: { radius: 1 } })),
  };
}

/** The ticks of H and of ten days, at STATIONARY_SPS, under the default genesis of `label`. */
export function stationaryTicks(label: string): {
  readonly horizon: number;
  readonly tenDays: number;
} {
  const genesis = worldgen.defaultGenesis(labelSeeds(label).terrain);
  const species = beings.defaultLife().species[0] as beings.Species;
  const { days } = stationaryHorizon(species, genesis);
  const length = genesis.laws.day.length;
  return {
    horizon: Math.ceil((days * length) / STATIONARY_SPS),
    tenDays: Math.ceil((10 * length) / STATIONARY_SPS),
  };
}
