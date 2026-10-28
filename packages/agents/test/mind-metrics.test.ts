/**
 * The metrics of a run of `mind@1` (packages/agents/test/support/mind-metrics.ts), against events
 * written by hand: greetings delivered and received, conversations of a pair, each act delivered
 * within `speech.gap` of the one before and both ways, acts started and the time asleep, the share
 * of awake time spent talking, the lineage of the ledger, and the items of the mind a being misses.
 * The observer reads a world of the T5 scenario that never steps, so its laws are the frozen ones.
 */
import { describe, expect, test } from "bun:test";
import type { EngineEvent, StepResult } from "@open-origin/engine";
import {
  diverse,
  MindObserver,
  type MindTally,
  mindMisses,
  talkingShare,
} from "./support/mind-metrics.ts";
import { LABELS2, scenario2Of } from "./support/mind-scenario.ts";

/** A step of `tick` whose events are `events`, each `[type, payload]`. */
function stepOf(tick: number, events: readonly (readonly [string, object])[]): StepResult {
  const made: EngineEvent[] = events.map(([type, payload], seq) => ({
    tick,
    seq,
    type,
    payload: payload as EngineEvent["payload"],
    cause: { kind: "system", system: "beings" } as unknown as EngineEvent["cause"],
  }));
  return {
    tick,
    checksum: "" as StepResult["checksum"],
    events: made,
    changedChunks: [],
    stats: {} as StepResult["stats"],
  };
}

/** An act of `id` to `to` that ended and was delivered at a tick. */
const act = (id: number, to: number, kind: string): (readonly [string, object])[] => [
  ["speech.uttered", { id, to, act: kind, cell: [0, 0] }],
  ["speech.delivered", { id, to }],
];

/** A world of the T5 scenario, never stepped: it holds the frozen laws and no being. */
const WORLD = scenario2Of(LABELS2.calibration[0] as string).world;

/** An observer of three beings that reads the steps of `steps`, then closes at `last`. */
function observed(steps: readonly StepResult[], last: number) {
  const observer = new MindObserver();
  observer.start(WORLD, [1, 2, 3]);
  for (const result of steps) observer.observe(result);
  return observer.finish(last);
}

const tally = (run: ReturnType<typeof observed>, id: number) => run.tallies.get(id) as MindTally;

describe("the greetings and conversations of a run", () => {
  test("count a greet delivered for its speaker and its hearer, and no act heard but a greet", () => {
    const run = observed(
      [
        stepOf(5, [...act(1, 2, "greet"), ...act(3, 2, "tell")]),
        stepOf(6, [["speech.uttered", { id: 2, to: 3, act: "greet", cell: [0, 0] }]]),
      ],
      10,
    );
    expect([tally(run, 1).greeted, tally(run, 1).wasGreeted]).toEqual([1, 0]);
    expect([tally(run, 2).greeted, tally(run, 2).wasGreeted]).toEqual([0, 1]);
    // A greet uttered but never delivered greets nobody.
    expect([tally(run, 3).greeted, tally(run, 3).wasGreeted]).toEqual([0, 0]);
  });

  test("count a conversation when acts go both ways, each within the gap of the one before", () => {
    // The gap of 120 s is 10 ticks of 12 s.
    const chained = observed(
      [
        stepOf(5, act(1, 2, "greet")),
        stepOf(15, act(2, 1, "greet")),
        stepOf(25, act(1, 2, "tell")),
      ],
      30,
    );
    expect(chained.conversations).toBe(1);
    const broken = observed([stepOf(5, act(1, 2, "greet")), stepOf(16, act(2, 1, "greet"))], 30);
    expect(broken.conversations).toBe(0);
    const oneWay = observed([stepOf(5, act(1, 2, "greet")), stepOf(6, act(1, 2, "tell"))], 30);
    expect(oneWay.conversations).toBe(0);
    const two = observed(
      [
        stepOf(5, act(1, 2, "greet")),
        stepOf(6, act(2, 1, "greet")),
        stepOf(40, act(2, 1, "ask")),
        stepOf(41, act(1, 2, "unknown")),
        stepOf(42, act(3, 1, "greet")),
      ],
      50,
    );
    expect(two.conversations).toBe(2);
  });
});

describe("the acts, sleeps, and ledger of a run", () => {
  test("count the acts started and the ticks asleep, an open sleep up to the last tick", () => {
    const run = observed(
      [
        stepOf(3, [["being.started", { id: 1, activity: "talk" }]]),
        stepOf(10, [["being.started", { id: 1, activity: "sleep" }]]),
        stepOf(40, [["being.finished", { id: 1, activity: "sleep" }]]),
        stepOf(90, [["being.started", { id: 1, activity: "sleep" }]]),
      ],
      100,
    );
    const one = tally(run, 1);
    expect([one.acts, one.sleptTicks]).toEqual([1, 40]);
    // One act of one tick in 60 awake ticks: 16‰.
    expect(talkingShare(one, 100, 1)).toBe(16);
  });

  test("count the records of the ledger whose lineage holds model-prior-suspect", () => {
    const records = [
      { id: 4, tn: 1, ex: 0, ev: [] },
      { id: 5, tn: 6, ex: 1, ev: [4] },
      { id: 6, tn: 7, ex: 0, ev: [] },
    ];
    const run = observed([stepOf(2, [["mind.provenance", { id: 1, records, exposure: 7 }]])], 3);
    expect(run.priorSuspect).toBe(2);
  });
});

describe("the items of the mind", () => {
  test("name each item a being misses, and only those", () => {
    const run = observed([], 1);
    const none = tally(run, 1);
    expect(mindMisses(none)).toEqual([
      "food episode",
      "being episode",
      "3 beliefs seen",
      "relationship at end",
      "greeted",
      "was greeted",
    ]);
    const met = {
      ...none,
      foodEpisodes: 1,
      beingEpisodes: 1,
      seenBeliefs: 3,
      relationsAtEnd: 1,
      greeted: 1,
      wasGreeted: 1,
    };
    expect(mindMisses(met)).toEqual([]);
    expect(mindMisses({ ...met, seenBeliefs: 2 })).toEqual(["3 beliefs seen"]);
  });

  test("find the beings' sets of beliefs diverse only when every two differ", () => {
    const run = observed([], 1);
    const set = (id: number, beliefs: string[]) => {
      Object.assign(tally(run, id), { beliefsAtEnd: beliefs });
    };
    set(1, ["a"]);
    set(2, ["b"]);
    set(3, ["a", "b"]);
    expect(diverse(run)).toBe(true);
    set(3, ["a"]);
    expect(diverse(run)).toBe(false);
  });
});
