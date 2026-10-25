/**
 * The freeze of laws and brain (docs/architecture/beings.md, "Evaluation" and "Calibration"): the
 * default laws of life and every parameter of `utility@1` were calibrated on the calibration
 * seeds only and frozen together. A change to either is a new calibration, and burns every
 * held-out seed already evaluated; these digests make any such change fail a test that says so.
 */
import { describe, expect, test } from "bun:test";
import { beings, digest } from "@open-origin/engine";
import * as parameters from "../src/brain/parameters.ts";

/** The seal of the frozen laws, and the digest of the frozen parameters of the brain. */
const FROZEN = Object.freeze({
  lifeSeal: "9f8702b422d3a9f81a3ec91e1890864b",
  brain: "272ee04d94bccbc662e9be12b383fff9",
});

describe("the frozen laws and brain", () => {
  test("the default laws are the frozen ones: changing them burns the evaluated held-out seeds", () => {
    expect(beings.lifeSeal(beings.defaultLife())).toBe(FROZEN.lifeSeal);
  });

  test("every parameter of utility@1 is the frozen one: changing one burns the evaluated held-out seeds", () => {
    expect(digest(["frozen-brain", { ...parameters }])).toBe(FROZEN.brain);
  });

  test("the digest covers every parameter of the brain, by name", () => {
    expect(Object.keys(parameters).sort()).toEqual([
      "ALERTNESS",
      "BEHAVIORS",
      "COMMITMENT",
      "CUE_WORTH",
      "DARKNESS",
      "DAWN_LIGHT",
      "DUSK_LIGHT",
      "EXHAUSTION_GUARD",
      "KEEP_EATING",
      "KEEP_SLEEPING",
      "MEAL_COOLDOWN_MS",
      "MEAL_TARGET",
      "NIGHT_REST_MS",
      "NIGHT_SLEEP",
      "REST_MS",
      "REST_SCORE",
      "ROUTE_COOLDOWN_MS",
      "ROUTE_WORTH",
      "SEARCH_ANCHOR_MS",
      "SEARCH_RANGE",
      "SEARCH_STEP",
      "SLEEP_TARGET",
      "SPIRAL_LEGS",
      "START_EATING",
      "STARVING",
      "SWITCH_MARGIN",
      "TURNS",
      "URGENT_SLEEP",
      "UTILITY_BRAIN",
      "WANDER_DRIVE",
      "WANDER_PAUSE_MS",
      "WANDER_REACH",
      "WANDER_SIGHT",
    ]);
  });
});
