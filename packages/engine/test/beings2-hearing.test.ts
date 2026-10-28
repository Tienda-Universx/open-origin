/**
 * The rule of a hearer of beings@2 (ADR 0024, docs/architecture/mind.md "Speech" and "Commands and
 * faults"): messages that reach the inbox at tick t wake an idle being at t + 1 while hearing has
 * woken it fewer than `speech.wakesPerDay` times in the day; each wake by a speaker's message counts
 * in `mind.quota.woken`, an injection's in nothing; and the day is the day of the delivery, both
 * when the delivery is judged and when the wake is, even when t + 1 begins another day.
 */
import { describe, expect, test } from "bun:test";
import { beings, type mind, readView } from "../src/index.ts";
import { beingOf, runTo, SHORT_DAY } from "./support/beings-world.ts";
import { type Cell, eventsAt, idling, standable, standingPair } from "./support/beings2-mind.ts";
import { eventsOfType, mindIn, scripted, talk } from "./support/beings2-speech.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  life2With,
  type Senses2,
} from "./support/beings2-world.ts";
import { mindOf } from "./support/mind-records.ts";

const LONG = 6_000_000;
/** A cell where a being may stand, with room for a speaker beside it. */
const [A] = standingPair([-128, -128], [1, 0], () => true);
/** The cell beside A, where a speaker may stand. */
const SPEAKER: Cell = [(A as Cell)[0] + 1, (A as Cell)[1]];
/** The ticks of one day of the test genesis, 12 s each: the last tick of day 0 is 99. */
const DAY_TICKS = SHORT_DAY.length / 12;

/** A greeting from being 41, which is not in the world, delivered to being 1 at `tick`. */
const greeting = (tick: number): mind.InboxMessage => ({
  who: 41,
  t: tick,
  cell: [(A as Cell)[0] + 1, (A as Cell)[1]],
  act: "greet",
  tn: 0,
  ex: 0,
});

/**
 * A world where being 1, idle until long after, holds `message` in its inbox as a delivery at its
 * tick leaves it, with `quota`, and is due at the next tick; its decisions are recorded.
 */
function delivered(message: mind.InboxMessage, quota: mind.Quota) {
  const sensed: Senses2[] = [];
  const held = { ...mindOf({ inbox: [message] }), quota };
  const hearer = {
    ...being2(1, A as Cell, { mind: held }),
    activity: { kind: "idle" as const, start: 0, ms: LONG },
    wake: message.t + 1,
  };
  const world = beings2World({
    controllers: {
      s1: brain2((senses) => {
        sensed.push(senses);
        return idling(LONG);
      }),
    },
    chunks: chunksOf([hearer]),
  });
  runTo(world, message.t);
  return { world, sensed };
}

const mindOf1 = (world: Parameters<typeof beingOf>[0]) => (beingOf(world, 1) as beings.Being2).mind;

describe("a wake by hearing", () => {
  test("counts in quota.woken when a speaker's message woke the being", () => {
    const { world, sensed } = delivered(greeting(5), { day: 0, said: 2, woken: 0 });
    const events = runTo(world, 6);
    expect(eventsAt(events, 6)[0]).toEqual([
      "being.finished",
      { id: 1, activity: "idle", result: "interrupted", reason: "heard" },
    ]);
    expect(sensed.map((senses) => senses.perceived.heard)).toEqual([
      [{ who: 41, cell: [(A as Cell)[0] + 1, (A as Cell)[1]], act: "greet" }],
    ]);
    expect(mindOf1(world).quota).toEqual({ day: 0, said: 2, woken: 1 });
  });

  test("is judged by the day of the delivery: a full quota on the last tick of a day wakes no one", () => {
    const last = DAY_TICKS - 1;
    expect(standable(A as Cell)).toBe(true);
    const { world, sensed } = delivered(greeting(last), { day: 0, said: 3, woken: 8 });
    const events = runTo(world, last + 1);
    // Processed at the first tick of day 1, the being is not woken, and keeps the message.
    expect(readView(world).tick).toBe(DAY_TICKS);
    expect(eventsAt(events, last + 1)).toEqual([]);
    expect(sensed).toEqual([]);
    expect(mindOf1(world)).toMatchObject({
      inbox: [greeting(last)],
      quota: { day: 0, said: 3, woken: 8 },
    });
  });

  test("counts in the day of the delivery, even when the being wakes on the next day", () => {
    const last = DAY_TICKS - 1;
    const { world, sensed } = delivered(greeting(last), { day: 0, said: 3, woken: 7 });
    const events = runTo(world, last + 1);
    expect(eventsAt(events, last + 1)[0]).toEqual([
      "being.finished",
      { id: 1, activity: "idle", result: "interrupted", reason: "heard" },
    ]);
    expect(sensed).toHaveLength(1);
    expect(mindOf1(world).quota).toEqual({ day: 0, said: 3, woken: 8 });
  });
});

describe("a wake where a wake condition holds too", () => {
  test("counts nothing in quota.woken: the condition would have woken the being anyway", () => {
    // Being 2 idles from tick 1 with nutritionBelow set 350 under its full nutrition, which it
    // crosses at 53 s and reaches at its wake at tick 5; being 1's greeting, an act of 36 s from
    // tick 1, is delivered at tick 4, so hearing would wake it at tick 5 too.
    const watcher = (_senses: Senses2, decision: number): beings.Intention2 =>
      decision === 0
        ? {
            steps: [{ kind: "idle", ms: LONG }],
            wakeWhen: { nutritionBelow: beings.NEED_MAX - 350 },
            behavior: { kind: "x", since: 0, heading: 0 },
          }
        : idling(LONG);
    const life = life2With((species) => ({
      ...species,
      speech: { ...species.speech, actMs: 36_000 },
    }));
    const { world, sensed } = scripted(
      [being2(1, SPEAKER), being2(2, A as Cell)],
      { 1: (_senses, decision) => (decision === 0 ? talk(2, "greet") : idling(LONG)), 2: watcher },
      { life },
    );
    const events = runTo(world, 5);
    expect(eventsOfType(events, "speech.delivered")).toEqual([
      { tick: 4, payload: { id: 1, to: 2 } },
    ]);
    expect(eventsAt(events, 5)[0]).toEqual([
      "being.finished",
      { id: 2, activity: "idle", result: "interrupted", reason: "wake_condition" },
    ]);
    expect(sensed.get(2)?.at(-1)?.perceived.heard).toEqual([
      { who: 1, cell: [...SPEAKER], act: "greet" },
    ]);
    expect(mindIn(world, 2).quota).toEqual({ day: 0, said: 0, woken: 0 });
  });
});
