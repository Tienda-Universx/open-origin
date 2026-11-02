/**
 * The real clock and timer behind the ports (ADR 0025): whole, non-decreasing microseconds, a timer
 * that fires in a task of its own after its delay, and one that can be cancelled. The waits are a
 * few milliseconds.
 */
import { describe, expect, test } from "bun:test";
import { systemClock } from "../src/adapters/clock.ts";
import { systemTimer } from "../src/adapters/timer.ts";

describe("systemClock", () => {
  test("reads whole microseconds that never decrease", () => {
    const times = Array.from({ length: 1000 }, () => systemClock.now());
    expect(times.every((time) => Number.isSafeInteger(time) && time >= 0)).toBe(true);
    expect(times.every((time, index) => index === 0 || time >= (times[index - 1] ?? 0))).toBe(true);
  });
});

describe("systemTimer", () => {
  test("fires after its delay, in a task of its own", async () => {
    const start = systemClock.now();
    let firedAt: number | undefined;
    const fired = new Promise<void>((resolve) => {
      systemTimer.schedule(2000, () => {
        firedAt = systemClock.now();
        resolve();
      });
    });
    // Nothing fires inside the call that schedules it.
    expect(firedAt).toBeUndefined();
    await fired;
    expect((firedAt ?? 0) - start).toBeGreaterThanOrEqual(2000);
  });

  test("does not fire once cancelled", async () => {
    let fired = false;
    const cancel = systemTimer.schedule(0, () => {
      fired = true;
    });
    cancel();
    await new Promise<void>((resolve) => systemTimer.schedule(3000, resolve));
    expect(fired).toBe(false);
  });
});
