/**
 * The freeze of the laws of life@2 and of `mind@1` (docs/architecture/mind.md, "Evaluation"): the
 * default laws of life@2 and every parameter of `mind@1` were calibrated together on the T5
 * calibration seeds only, and frozen together. A change to either is a new calibration, and burns
 * every held-out label of T5 already evaluated; these digests make any such change fail a test
 * that says so. freeze.test.ts keeps the freeze of T4 as it was.
 */
import { describe, expect, test } from "bun:test";
import { beings, digest } from "@open-origin/engine";
import * as parameters from "../src/brain/mind/parameters.ts";

/** The seal of the frozen laws of life@2, and the digest of the frozen parameters of mind@1. */
const FROZEN = Object.freeze({
  lifeSeal2: "e69ab5b7506e43a3e1f2680b91707f43",
  mind: "9d94ca01b278b56f5285a086a93fda9c",
});

describe("the frozen laws of life@2 and mind@1", () => {
  test("the default laws of life@2 are the frozen ones: changing them burns the evaluated held-out labels of T5", () => {
    expect(beings.lifeSeal2(beings.defaultLife2())).toBe(FROZEN.lifeSeal2);
  });

  test("every parameter of mind@1 is the frozen one: changing one burns the evaluated held-out labels of T5", () => {
    expect(digest(["frozen-mind", { ...parameters }])).toBe(FROZEN.mind);
  });

  test("the digest covers every parameter of the brain, by name", () => {
    expect(Object.keys(parameters).sort()).toEqual([
      "APPROACH_REACH",
      "BEING_W",
      "CONTRADICTED_CR",
      "FOOD_AT",
      "FOOD_W",
      "HEARD_W",
      "LANDMARK_SPACING",
      "MIND_BEHAVIORS",
      "MIND_BRAIN",
      "MIND_CONCEPTS",
      "RULE_IDS",
      "SEEN_CR",
      "SPEAK_WILL",
      "STRANGER_TRUST",
      "TELL_FLOOR",
      "TESTIMONY_FLOOR",
      "TOLD_CR",
      "TRUST_STEP",
      "UNSPOKEN_BAND",
      "WAIT_MS",
    ]);
  });
});
