/**
 * `mind@1` in a world (docs/architecture/mind.md "The brain mind@1" and "Evaluation"): one day of
 * the T5 scenario of calibration/1, its eight beings deciding with `mind@1` under the frozen laws
 * of life@2. The engine refuses none of its intentions, so its acts of speech keep every quota and
 * condition and its operations cite only records the stores keep; every belief operation is its
 * rule applied to what it cites, the episodes it created read from the engine's state; no belief
 * has model-prior-suspect; and the ledger oracle rebuilds every taint and link from the events
 * alone, compared with the state ten times a day. The whole-decision ablation of "Evaluation",
 * items (a) and (b), replays every decision that proposed a belief operation (T5-8). The invariants
 * of the minds at every tick, whose oracle of food reads a scenario's terrain too, run on the first
 * ticks of this label in mind-fuzz.test.ts, since at every tick of a day they would cost seconds.
 */
import { describe, expect, test } from "bun:test";
import { type beings, step } from "@open-origin/engine";
import { beingsById, LedgerOracle } from "../../engine/test/support/beings2-fuzz.ts";
import { mindController } from "../src/index.ts";
import { ablationA, ablationB, formationsOf } from "./support/mind-ablation.ts";
import { MindObserver } from "./support/mind-metrics.ts";
import { LABELS2, scenario2Of } from "./support/mind-scenario.ts";
import type { Senses2 } from "./support/mind-senses.ts";

/** One simulated day of the scenario. */
const TICKS = 6_300;

/** A decision that proposed a belief operation: what it sensed and what it proposed. */
type Recorded = { readonly senses: Senses2; readonly intention: beings.Intention2 };

/** `inner`, which also keeps in `decisions` each decision that proposed a belief operation. */
function recording(inner: beings.Controller2, decisions: Recorded[]): beings.Controller2 {
  return {
    ...inner,
    decide: (senses) => {
      const intention = inner.decide(senses);
      if (formationsOf(senses, intention).length > 0) decisions.push({ senses, intention });
      return intention;
    },
  };
}

/** Every miss of the ablations (a) and (b) on `decisions`, and how many operations they replayed. */
function ablations(decisions: readonly Recorded[], brain: beings.Controller2) {
  const decide = (senses: Senses2) => brain.decide(senses);
  const misses: string[] = [];
  let operations = 0;
  let removable = 0;
  for (const { senses, intention } of decisions) {
    operations += formationsOf(senses, intention).length;
    const a = ablationA(senses, intention, decide);
    removable += a.removable;
    const b = ablationB(senses, intention, decide);
    const name = `being ${senses.self.id}`;
    for (const miss of a.misses) misses.push(`${name} (a): ${JSON.stringify(miss)}`);
    for (const miss of b) misses.push(`${name} (b): ${JSON.stringify(miss)}`);
  }
  return { misses, operations, removable };
}

describe("mind@1 over one day of calibration/1", () => {
  test("is never refused, keeps its rules, the laws of the mind, and its ablations, and leaves an exact ledger", () => {
    const observer = new MindObserver();
    const decisions: Recorded[] = [];
    let brain: beings.Controller2 | undefined;
    const scenario = scenario2Of(LABELS2.calibration[0] as string, {
      controller: (species, dayLength) => {
        brain = mindController({ species, dayLength });
        return observer.controller(recording(brain, decisions));
      },
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
    // The ablations of whole decisions, on every decision that proposed a belief operation.
    const replayed = ablations(decisions, brain as beings.Controller2);
    expect(replayed.misses.slice(0, 3)).toEqual([]);
    // Not vacuous: the day's operations, pinned, and those citing a record that (a) removes: a
    // relationship, or the message a heard episode copies, not only what the being sees.
    expect({ operations: replayed.operations, removable: replayed.removable }).toEqual({
      operations: 30,
      removable: 7,
    });
  }, 30_000);
});
