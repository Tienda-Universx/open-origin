/**
 * The survival run in a child process (support/survival-child.ts): it refuses the reserve labels
 * and any label outside the preregistration, and its run, with a variant of the laws, another
 * brain, and what it keeps for a resume, is the run of the same scenario in this process.
 */
import { describe, expect, test } from "bun:test";
import { beings, decodeSnapshot, readView } from "@open-origin/engine";
import { randomWalker } from "./support/brains.ts";
import { countingBrain, runScenario } from "./support/metrics.ts";
import { LABELS, scenarioOf, variantLife } from "./support/scenario.ts";
import { startSurvival, survivalResult } from "./support/survival.ts";

const CHILD_MS = 60_000;

describe("a survival run in a child process", () => {
  test.each([
    "open-origin/t4/heldout/7",
    "open-origin/t4/heldout/12",
    "open-origin/t4/default/2",
    "heldout/1",
  ])("refuses %s, which no run may use", async (label) => {
    await expect(survivalResult(startSurvival({ label, ticks: 1 }), CHILD_MS)).rejects.toThrow(
      `${label} is not a label a run may use`,
    );
  });

  test(
    "runs the scenario as this process does, with a variant, another brain, and what it keeps",
    async () => {
      const label = LABELS.calibration[0] as string;
      const input = {
        label,
        ticks: 120,
        variant: "adverse",
        brain: "random-walk@1",
        keep: { at: 20, ticks: 8 },
      } as const;
      const child = startSurvival(input);
      const brain = countingBrain(randomWalker());
      const life = variantLife("adverse");
      const scenario = scenarioOf(label, { controllers: { s1: brain.controller }, life });
      const here = runScenario(scenario, 120, brain);
      const output = await survivalResult(child, CHILD_MS);

      expect(output.record.beings).toEqual(here.beings);
      expect(output.record.decisions).toBe(here.decisions);
      // Each being decided again after its first walk, and walked.
      expect(here.decisions).toBeGreaterThan(8);
      expect(here.beings.every(({ walked }) => walked > 0)).toBe(true);
      expect(output.dayLength).toBe(75_600);
      // What it kept: the snapshot after tick 20, the records of ticks 21 to 28, and the snapshot
      // after tick 28, which decodes with the laws of the variant.
      const kept = output.kept;
      expect(kept?.records.map(({ tick }) => tick)).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
      const ruleset = () => beings.createBeingsRuleset({ controllers: { s1: randomWalker() } });
      expect(readView(decodeSnapshot(kept?.snapshot ?? "", ruleset())).tick).toBe(20);
      const end = readView(decodeSnapshot(kept?.final ?? "", ruleset()));
      expect(end.tick).toBe(28);
      expect(end.readGlobal().life).toEqual({ ...life, deathEnabled: false });
    },
    CHILD_MS,
  );
});
