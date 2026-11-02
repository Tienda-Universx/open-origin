/**
 * The fixed-rate scheduler (ADR 0025, "Time and the scheduler"; plan test 17: behavior under
 * overload is measurable and never advances time incoherently), driven by a fake clock and timer,
 * with the cost of each step injected: one tick per callback, each in a callback of its own; the
 * schedule held under a period of lateness and rebased beyond it, with exact shortfall; stops
 * counted apart from shortfall; and resuming that resets the schedule.
 */
import { describe, expect, test } from "bun:test";
import { SampleWindow } from "../src/world/samples.ts";
import { FixedRateScheduler, type Hold } from "../src/world/scheduler.ts";
import type { Timer } from "../src/world/time.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";

/** One period at 5 Hz, in microseconds. */
const P = 200_000;

type Options = {
  /** The cost of each tick, in microseconds, by its index from 0; 0 when absent. */
  readonly costs?: Readonly<Record<number, number>>;
  readonly tickRateHz?: number;
  /** The timer the scheduler uses, given the fake one. */
  readonly timer?: (fake: FakeTimer) => Timer;
};

/** A scheduler over a fake clock whose ticks record when they start and take their cost. */
function harness({ costs = {}, tickRateHz = 5, timer = (fake) => fake }: Options = {}) {
  const clock = new FakeClock();
  const fake = new FakeTimer(clock);
  const ran: number[] = [];
  /** How many ticks each timer callback ran. */
  const perCallback: number[] = [];
  let hold: Hold | undefined;
  const scheduler = new FixedRateScheduler({
    clock,
    timer: timer(fake),
    tickRateHz,
    runTick: () => {
      ran.push(clock.now());
      perCallback[fake.fired - 1] = (perCallback[fake.fired - 1] ?? 0) + 1;
      clock.advance(costs[ran.length - 1] ?? 0);
    },
    hold: () => hold,
  });
  const setHold = (next: Hold | undefined) => {
    hold = next;
  };
  return { clock, timer: fake, ran, perCallback, scheduler, setHold };
}

describe("FixedRateScheduler", () => {
  test("runs one tick per period, each in a timer callback of its own", () => {
    const { timer, ran, perCallback, scheduler } = harness();
    expect(scheduler.metrics().state).toBe("paused");
    scheduler.start();
    // Start only arms a timer: the first tick runs in its callback, never inside start.
    expect(ran).toEqual([]);
    expect(timer.pending).toBe(1);
    for (let fired = 0; fired < 11; fired += 1) {
      timer.fireNext();
      expect(timer.pending).toBe(1);
    }
    expect(ran).toEqual(Array.from({ length: 11 }, (_, n) => n * P));
    expect(perCallback).toEqual(Array(11).fill(1));
    expect(scheduler.metrics()).toMatchObject({
      state: "running",
      ticks: 11,
      shortfallTicks: 0,
      rebases: 0,
      latenessMicros: { p50: 0, p95: 0, p99: 0 },
      stepMicros: { p50: 0, p95: 0, p99: 0 },
    });
  });

  test("keeps exact deadlines for a rate whose period is not whole microseconds", () => {
    const { timer, ran, scheduler } = harness({ tickRateHz: 3 });
    scheduler.start();
    timer.runUntil(2_000_000);
    expect(ran).toEqual([0, 333_333, 666_666, 1_000_000, 1_333_333, 1_666_666, 2_000_000]);
  });

  test("holds the schedule within one period of lateness, catching up back to back", () => {
    const { timer, ran, scheduler } = harness({ costs: { 1: 250_000 } });
    scheduler.start();
    timer.runUntil(4 * P);
    // Tick 1 ends at 450,000, so tick 2 runs late by 50,000 and tick 3 is on time again.
    expect(ran).toEqual([0, P, 450_000, 3 * P, 4 * P]);
    expect(scheduler.metrics()).toMatchObject({
      shortfallTicks: 0,
      rebases: 0,
      latenessMicros: { p50: 0, p95: 50_000, p99: 50_000 },
      stepMicros: { p50: 0, p95: 250_000, p99: 250_000 },
    });
  });

  test("counts the exact shortfall and rebases of a scripted lateness profile", () => {
    const costs = {
      1: 150_000, // ends before the next deadline: on time
      3: 300_000, // the next tick is late by 100,000
      6: 400_000, // the next tick is late by exactly one period: the schedule holds
      9: 400_001, // late by 200,001: 1 tick of shortfall, then a rebase
      12: 1_000_000, // late by 800,000: 4 ticks
      15: 1_099_999, // late by 899,999: 4 ticks
    };
    const { timer, ran, perCallback, scheduler } = harness({ costs });
    scheduler.start();
    timer.runUntil(5_300_000);
    expect(ran).toEqual([
      0, 200_000, 400_000, 600_000, 900_000, 1_000_000, 1_200_000, 1_600_000, 1_600_000, 1_800_000,
      2_200_001, 2_400_001, 2_600_001, 3_600_001, 3_800_001, 4_000_001, 5_100_000, 5_300_000,
    ]);
    expect(perCallback).toEqual(Array(18).fill(1));
    expect(scheduler.metrics()).toMatchObject({
      ticks: 18,
      shortfallTicks: 9,
      rebases: 3,
      latenessMicros: { p50: 0, p95: 899_999, p99: 899_999 },
    });
  });

  test("advances one tick per callback after a long step: no burst, no skipped tick", () => {
    const { timer, ran, perCallback, scheduler } = harness({ costs: { 2: 10_000_000 } });
    scheduler.start();
    timer.runUntil(10_600_000);
    expect(ran).toEqual([0, P, 2 * P, 10_400_000, 10_600_000]);
    expect(perCallback).toEqual([1, 1, 1, 1, 1]);
    expect(scheduler.metrics()).toMatchObject({ shortfallTicks: 49, rebases: 1 });
  });

  test("never runs a tick before its deadline when the timer fires early", () => {
    // Fires 1,000 microseconds early whenever the delay allows it.
    const early = (fake: FakeTimer): Timer => ({
      schedule: (delay, callback) => fake.schedule(delay > 1000 ? delay - 1000 : delay, callback),
    });
    const { timer, ran, scheduler } = harness({ timer: early });
    scheduler.start();
    timer.runUntil(5 * P);
    expect(ran).toEqual([0, P, 2 * P, 3 * P, 4 * P, 5 * P]);
    expect(scheduler.metrics()).toMatchObject({ shortfallTicks: 0, rebases: 0 });
  });

  test("holds through a journal stall, counted apart, and resumes with a reset schedule", () => {
    const { clock, timer, ran, scheduler, setHold } = harness();
    scheduler.start();
    timer.runUntil(2 * P);
    setHold("journalStall");
    timer.runUntil(3 * P + 5_000_000);
    expect(ran).toEqual([0, P, 2 * P]);
    expect(scheduler.metrics().state).toBe("journalStall");
    expect(timer.pending).toBe(0);
    // Waking while the stall lasts changes nothing.
    scheduler.wake();
    expect(timer.pending).toBe(0);
    setHold(undefined);
    scheduler.wake();
    const resumed = clock.now();
    timer.runUntil(resumed + 2 * P);
    expect(ran.slice(3)).toEqual([resumed, resumed + P, resumed + 2 * P]);
    expect(scheduler.metrics()).toMatchObject({
      state: "running",
      shortfallTicks: 0,
      rebases: 0,
      latenessMicros: { p99: 0 },
      stops: { journalStall: 1, paused: 0, halted: 0 },
    });
  });

  test("pauses without shortfall and resumes with a reset schedule", () => {
    const { timer, ran, scheduler } = harness();
    scheduler.start();
    timer.runUntil(P);
    scheduler.pause();
    expect(timer.pending).toBe(0);
    timer.runUntil(P + 3_000_000);
    expect(ran).toEqual([0, P]);
    scheduler.start();
    timer.runUntil(3_400_000);
    expect(ran).toEqual([0, P, 3_200_000, 3_400_000]);
    expect(scheduler.metrics()).toMatchObject({
      state: "running",
      shortfallTicks: 0,
      rebases: 0,
      stops: { journalStall: 0, paused: 1, halted: 0 },
    });
  });

  test("stops for good when the world halts", () => {
    const { timer, ran, scheduler, setHold } = harness();
    scheduler.start();
    timer.runUntil(P);
    setHold("halted");
    timer.runUntil(10 * P);
    scheduler.start();
    scheduler.wake();
    setHold(undefined);
    scheduler.start();
    scheduler.wake();
    timer.runUntil(20 * P);
    expect(ran).toEqual([0, P]);
    expect(timer.pending).toBe(0);
    expect(scheduler.metrics()).toMatchObject({
      state: "halted",
      stops: { journalStall: 0, paused: 0, halted: 1 },
    });
  });

  test("halts at once when woken between ticks by a halt, cancelling the next timer", () => {
    const { timer, ran, scheduler, setHold } = harness();
    scheduler.start();
    timer.runUntil(P);
    expect(timer.pending).toBe(1);
    // A running world that is woken without a hold keeps its schedule.
    scheduler.wake();
    expect(timer.pending).toBe(1);
    setHold("halted");
    scheduler.wake();
    expect(timer.pending).toBe(0);
    timer.runUntil(5 * P);
    expect(ran).toEqual([0, P]);
    expect(scheduler.metrics()).toMatchObject({
      state: "halted",
      stops: { journalStall: 0, paused: 0, halted: 1 },
    });
  });

  test("a stall found when woken between ticks waits for the next deadline", () => {
    const { timer, ran, scheduler, setHold } = harness();
    scheduler.start();
    timer.runUntil(P);
    setHold("journalStall");
    scheduler.wake();
    expect(scheduler.metrics().state).toBe("running");
    timer.runUntil(5 * P);
    expect(ran).toEqual([0, P]);
    expect(scheduler.metrics().state).toBe("journalStall");
  });

  test("stops at once when a tick leaves the world held, without arming another timer", () => {
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    let hold: Hold | undefined;
    let ticks = 0;
    const scheduler = new FixedRateScheduler({
      clock,
      timer,
      tickRateHz: 5,
      runTick: () => {
        ticks += 1;
        if (ticks === 2) hold = "journalStall";
      },
      hold: () => hold,
    });
    scheduler.start();
    timer.fireNext();
    timer.fireNext();
    expect(ticks).toBe(2);
    expect(timer.pending).toBe(0);
    expect(scheduler.metrics().state).toBe("journalStall");
  });

  test("halts when a tick throws, records what it threw, and arms no timer", () => {
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    let ticks = 0;
    const scheduler = new FixedRateScheduler({
      clock,
      timer,
      tickRateHz: 5,
      runTick: () => {
        ticks += 1;
        if (ticks === 3) throw Object.assign(new Error("a broken tick"), { code: "EBROKEN" });
      },
      hold: () => undefined,
    });
    expect(scheduler.metrics().fault).toBeUndefined();
    scheduler.start();
    timer.runUntil(10 * P);
    expect(ticks).toBe(3);
    expect(timer.pending).toBe(0);
    expect(scheduler.metrics()).toMatchObject({
      state: "halted",
      ticks: 3,
      stops: { journalStall: 0, paused: 0, halted: 1 },
      fault: { code: "EBROKEN", message: "a broken tick" },
    });
    // Nothing resumes a scheduler that halted.
    scheduler.start();
    scheduler.wake();
    timer.runUntil(20 * P);
    expect(ticks).toBe(3);
    expect(timer.pending).toBe(0);
  });

  test("a tick that halts the world and then throws counts one halt and cancels its timer", () => {
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    let hold: Hold | undefined;
    const scheduler = new FixedRateScheduler({
      clock,
      timer,
      tickRateHz: 5,
      runTick: () => {
        // A re-entrant start arms a timer, a wake then halts, and the tick throws.
        scheduler.pause();
        scheduler.start();
        hold = "halted";
        scheduler.wake();
        throw "not an Error";
      },
      hold: () => hold,
    });
    scheduler.start();
    timer.fireNext();
    expect(timer.pending).toBe(0);
    expect(scheduler.metrics()).toMatchObject({
      state: "halted",
      ticks: 1,
      stops: { journalStall: 0, paused: 1, halted: 1 },
      fault: { message: "not an Error" },
    });
  });

  test("keeps one timer chain when a tick pauses and starts the scheduler again", () => {
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    const ran: number[] = [];
    const scheduler = new FixedRateScheduler({
      clock,
      timer,
      tickRateHz: 5,
      runTick: () => {
        ran.push(clock.now());
        if (ran.length === 2) {
          scheduler.pause();
          scheduler.start();
        }
      },
      hold: () => undefined,
    });
    scheduler.start();
    const pending: number[] = [];
    for (let fired = 0; fired < 6; fired += 1) {
      timer.fireNext();
      pending.push(timer.pending);
    }
    expect(pending).toEqual(Array(6).fill(1));
    // The restart within tick 1 anchors the schedule at it: tick 2 keeps its deadline.
    expect(ran).toEqual([0, P, 2 * P, 3 * P, 4 * P, 5 * P]);
    expect(scheduler.metrics()).toMatchObject({
      state: "running",
      shortfallTicks: 0,
      stops: { journalStall: 0, paused: 1, halted: 0 },
    });
  });

  test("reports the achieved rate over its last ticks, in millihertz", () => {
    const five = harness();
    five.scheduler.start();
    expect(five.scheduler.metrics().achievedMilliHz).toBe(0);
    five.timer.runUntil(63 * P);
    expect(five.scheduler.metrics().achievedMilliHz).toBe(5000);
    const twenty = harness({ tickRateHz: 20 });
    twenty.scheduler.start();
    twenty.timer.runUntil(200 * 50_000);
    expect(twenty.scheduler.metrics().achievedMilliHz).toBe(20_000);
    // A stall of 10 periods within the window of 64 ticks lowers the rate it achieved.
    const slow = harness({ costs: { 10: 10 * P } });
    slow.scheduler.start();
    slow.timer.runUntil(80 * P);
    expect(slow.scheduler.metrics().achievedMilliHz).toBe(Math.floor((63 * 1e9) / (72 * P)));
  });

  test("refuses a rate outside 1 to 1000 ticks per second", () => {
    for (const tickRateHz of [0, 1001, 2.5, Number.NaN]) {
      expect(() => harness({ tickRateHz })).toThrow(RangeError);
    }
  });
});

describe("SampleWindow", () => {
  test("keeps the last values, oldest first, and ranks them", () => {
    const window = new SampleWindow(4);
    expect(window.percentiles()).toEqual({ p50: 0, p95: 0, p99: 0 });
    for (const value of [9, 1, 7, 3, 5, 8]) window.add(value);
    expect(window.size).toBe(4);
    expect(window.values()).toEqual([7, 3, 5, 8]);
    expect(window.percentiles()).toEqual({ p50: 5, p95: 8, p99: 8 });
    const hundred = new SampleWindow(100);
    for (let value = 100; value >= 1; value -= 1) hundred.add(value);
    expect(hundred.percentiles()).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  test("refuses a capacity below one", () => {
    expect(() => new SampleWindow(0)).toThrow(RangeError);
  });
});
