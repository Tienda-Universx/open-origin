/**
 * The survival run in a child process (support/survival-child.ts): it refuses the reserve labels,
 * any label outside the preregistration, and any brain or variant it does not know; its run, with
 * a variant of the laws, another brain, and what it keeps for a resume, is the run of the same
 * scenario in this process, and so is the stationary control's; and a child that returns JSON of
 * another shape is reported with what it wrote.
 */
import { describe, expect, test } from "bun:test";
import { beings, decodeSnapshot, readView } from "@open-origin/engine";
import { randomWalker, stationary } from "./support/brains.ts";
import { startJsonChild } from "./support/child.ts";
import { countingBrain, runScenario } from "./support/metrics.ts";
import { LABELS, scenarioOf, variantLife } from "./support/scenario.ts";
import { STATIONARY_SPS, stationaryLife } from "./support/stationary.ts";
import { type SurvivalInput, startSurvival, survivalResult } from "./support/survival.ts";

const FAKE = Bun.fileURLToPath(new URL("./support/fake-child.ts", import.meta.url));
const CALIBRATION_1 = LABELS.calibration[0] as string;

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

  test.each([
    [{ brain: "omniscient@1" }, "omniscient@1 is not a brain a run may use"],
    [{ variant: "lenient" }, "lenient is not a variant of the laws"],
    [
      { brain: "stationary@1", variant: "adverse" },
      "the stationary control runs under the default laws only",
    ],
  ])("refuses %j: %s", async (change, message) => {
    const input = { label: CALIBRATION_1, ticks: 1, ...change } as unknown as SurvivalInput;
    await expect(survivalResult(startSurvival(input), CHILD_MS)).rejects.toThrow(message);
  });

  test.each([
    ["null", null],
    ["a record without beings", { record: { beings: 3 }, dayLength: 1 }],
  ])("that returns %s is reported with what it wrote", async (_what, echo) => {
    const child = startJsonChild(FAKE, { echo }, "odd");
    await expect(survivalResult(child, CHILD_MS)).rejects.toThrow(
      `the child process fake-child.ts (odd) returned no record of a run: ${JSON.stringify(echo)}`,
    );
  });

  test(
    "runs the stationary control at its settings as this process does, with the tick of each incapacity",
    async () => {
      const label = LABELS.calibration[2] as string;
      const child = startSurvival({ label, ticks: 430, brain: "stationary@1" });
      const brain = countingBrain(stationary());
      const scenario = scenarioOf(label, {
        controllers: { s1: brain.controller },
        life: stationaryLife(),
        simSecondsPerTick: STATIONARY_SPS,
      });
      const first = new Map<number, number>();
      const here = runScenario(scenario, 430, brain, ({ tick, events }) => {
        for (const { type, payload } of events) {
          const { id } = payload as { id: number };
          if (type === "being.incapacitated" && !first.has(id)) first.set(id, tick);
        }
      });
      const output = await survivalResult(child, CHILD_MS);
      expect(output.simSecondsPerTick).toBe(STATIONARY_SPS);
      expect(output.record.beings).toEqual(here.beings);
      expect(output.incapacitatedAt).toEqual([...first].sort(([a], [b]) => a - b));
      // Not vacuous: every being of calibration/3 was incapacitated within these 430 ticks.
      expect(output.incapacitatedAt).toHaveLength(8);
    },
    CHILD_MS,
  );

  test(
    "runs the scenario as this process does, with a variant, another brain, and what it keeps",
    async () => {
      const label = CALIBRATION_1;
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
      expect([output.dayLength, output.simSecondsPerTick, output.incapacitatedAt]).toEqual([
        75_600,
        12,
        [],
      ]);
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
