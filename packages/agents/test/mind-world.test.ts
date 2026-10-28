/**
 * `mind@1` in a world (docs/architecture/mind.md "The brain mind@1" and "Evaluation"): one day of
 * the T5 scenario of calibration/1, its eight beings deciding with `mind@1` under the frozen laws
 * of life@2. The engine refuses none of its intentions, so its acts of speech keep every quota and
 * condition and its operations cite only records the stores keep; every belief operation is its
 * rule applied to what it cites, the episodes it created read from the engine's state; no belief
 * has model-prior-suspect; and the ledger oracle rebuilds every taint and link from the events
 * alone, compared with the state ten times a day. The invariants of the minds at every tick belong
 * to the fuzz and the determinism subject (T5-8), on the engine's test world, whose terrain their
 * oracle of food reads.
 */
import { describe, expect, test } from "bun:test";
import { step } from "@open-origin/engine";
import { beingsById, LedgerOracle } from "../../engine/test/support/beings2-fuzz.ts";
import { mindController } from "../src/index.ts";
import { MindObserver } from "./support/mind-metrics.ts";
import { LABELS2, scenario2Of } from "./support/mind-scenario.ts";

/** One simulated day of the scenario. */
const TICKS = 6_300;

describe("mind@1 over one day of calibration/1", () => {
  test("is never refused, keeps its rules and the laws of the mind, and leaves an exact ledger", () => {
    const observer = new MindObserver();
    const scenario = scenario2Of(LABELS2.calibration[0] as string, {
      controller: (species, dayLength) =>
        observer.controller(mindController({ species, dayLength })),
    });
    const { world } = scenario;
    observer.start(
      world,
      scenario.payloads.map((_, index) => index + 1),
    );
    const oracle = new LedgerOracle();
    const problems: string[] = [];
    const counts = new Map<string, number>();
    for (let tick = 1; tick <= TICKS; tick += 1) {
      const result = step(world, tick === 1 ? scenario.spawns : []);
      observer.observe(result);
      for (const { type } of result.events) counts.set(type, (counts.get(type) ?? 0) + 1);
      problems.push(...oracle.read(result.events));
      if (tick % 630 === 0) problems.push(...oracle.compare(beingsById(world), tick));
    }
    const run = observer.finish(TICKS);
    expect(problems.slice(0, 5)).toEqual([]);
    expect(counts.get("being.intention_rejected") ?? 0).toBe(0);
    expect(run.ruleProblems).toEqual([]);
    expect(run.priorSuspect).toBe(0);
    // Not vacuous: the beings remembered and believed what they saw, met, spoke, and heard.
    const tallies = [...run.tallies.values()];
    const total = (pick: (tally: (typeof tallies)[number]) => number) =>
      tallies.reduce((sum, tally) => sum + pick(tally), 0);
    expect(total((tally) => tally.seenBeliefs)).toBeGreaterThan(8);
    expect(total((tally) => tally.beingEpisodes)).toBeGreaterThan(0);
    expect(total((tally) => tally.greeted)).toBeGreaterThan(0);
    expect(total((tally) => tally.toldBeliefs)).toBeGreaterThan(0);
    expect(counts.get("speech.delivered") ?? 0).toBeGreaterThan(0);
    expect(counts.get("mind.changed") ?? 0).toBeGreaterThan(0);
    expect(run.decisions).toBeGreaterThan(8 * 10);
  }, 30_000);
});
