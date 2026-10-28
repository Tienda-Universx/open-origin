/**
 * The targets of calibration that the laws of life@2 decide alone (docs/architecture/mind.md,
 * "Targets of calibration"), with neutral traits, in the world's day L of the default genesis: an
 * episode of importance 500, never recalled, is forgotten 2 L to 5 L after it happened;
 * familiarity after 1 L of continuous co-presence is at least 500; and after 10 L of absence it is
 * at most half what it was. The engine's own laws compute each, and the stranger's trust of
 * `mind@1` is the trust the engine gives a new relationship.
 */
import { describe, expect, test } from "bun:test";
import { beings, mind } from "@open-origin/engine";
import { STRANGER_TRUST } from "../src/brain/mind/parameters.ts";
import { DAY, SPECIES2 } from "./support/mind-senses.ts";
import { lawTargets } from "./support/mind-targets.ts";
import { SCENARIO_SPS } from "./support/scenario.ts";

describe("the default laws of life@2", () => {
  const targets = lawTargets(SPECIES2, DAY, SCENARIO_SPS);

  test("forget an episode of importance 500, never recalled, 2 L to 5 L after it happened", () => {
    expect(targets.forgottenAfter).toBeGreaterThanOrEqual(2 * DAY);
    expect(targets.forgottenAfter).toBeLessThanOrEqual(5 * DAY);
    // At 3 half-lives the salience is ⌊500/8⌋ = 62, which falls below the floor of 50 when
    // ⌊31·(E mod H)/H⌋ reaches 13: 13·75,600/31 = 31,703.2… seconds into the fourth half-life.
    expect(targets.forgottenAfter).toBe(3 * DAY + 31_704);
  });

  test("give a familiarity of at least 500 after one day of continuous co-presence", () => {
    expect(targets.familiarDay).toBeGreaterThanOrEqual(500);
    expect(targets.familiarDay).toBe(1000);
  });

  test("keep at most half of it after ten days of absence", () => {
    expect(2 * targets.familiarAbsent).toBeLessThanOrEqual(targets.familiarDay);
    expect(targets.familiarAbsent).toBe(500);
  });

  test("give a new relationship the trust mind@1 weighs a stranger with", () => {
    const ctx: mind.MindContext = {
      moment: { tick: 5, secondsPerTick: SCENARIO_SPS },
      laws: { mind: SPECIES2.mind, relations: SPECIES2.relations },
      retention: 1000,
      talkWindow: 18_900,
    };
    const met = mind.perceive(mind.newMind(0), 7, ctx).mind.relations[0];
    expect(met?.tr).toBe(STRANGER_TRUST);
    expect(beings.defaultLife2().species[0]?.traits).toEqual({ min: 800, max: 1200 });
  });
});
