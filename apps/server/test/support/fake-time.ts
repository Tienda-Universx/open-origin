import type { CancelTimer, Clock, Timer } from "../../src/world/time.ts";

/** A clock that moves only when a test moves it, in whole microseconds. */
export class FakeClock implements Clock {
  time = 0;

  now(): number {
    return this.time;
  }

  advance(micros: number): void {
    this.time += micros;
  }
}

type Pending = { readonly at: number; readonly order: number; readonly callback: () => void };

/** The most callbacks one runUntil fires: far more than any test needs. */
const MAX_FIRES = 100_000;

/**
 * Timers over a FakeClock: they fire only when a test asks, in order of their time and then of
 * their scheduling, each with the clock moved to its time unless the clock is already past it.
 */
export class FakeTimer implements Timer {
  readonly #clock: FakeClock;
  #pending: Pending[] = [];
  #order = 0;
  /** How many callbacks have fired. */
  fired = 0;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  schedule(delayMicros: number, callback: () => void): CancelTimer {
    if (!Number.isSafeInteger(delayMicros) || delayMicros < 0) {
      throw new RangeError(`a delay is a whole number of microseconds, not ${delayMicros}`);
    }
    const timer = { at: this.#clock.time + delayMicros, order: this.#order, callback };
    this.#order += 1;
    this.#pending.push(timer);
    return () => {
      this.#pending = this.#pending.filter((pending) => pending !== timer);
    };
  }

  /** How many timers wait to fire. */
  get pending(): number {
    return this.#pending.length;
  }

  /** The time the next timer fires at, or undefined when none waits. */
  get next(): number | undefined {
    return this.#earliest()?.at;
  }

  /** Fires the earliest timer; false when none waits. */
  fireNext(): boolean {
    const timer = this.#earliest();
    if (timer === undefined) return false;
    this.#pending = this.#pending.filter((pending) => pending !== timer);
    this.#clock.time = Math.max(this.#clock.time, timer.at);
    this.fired += 1;
    timer.callback();
    return true;
  }

  /**
   * Fires every timer due up to `until`, the ones they schedule included, then moves the clock
   * there. Throws after MAX_FIRES callbacks, so a scheduler that never lets time pass fails a
   * test instead of hanging it.
   */
  runUntil(until: number): void {
    let fires = 0;
    for (let next = this.next; next !== undefined && next <= until; next = this.next) {
      fires += 1;
      if (fires > MAX_FIRES) throw new Error(`more than ${MAX_FIRES} timers fired before ${until}`);
      this.fireNext();
    }
    this.#clock.time = Math.max(this.#clock.time, until);
  }

  /**
   * As runUntil, but lets every microtask and immediate run after each callback, as the event loop
   * does between two real timers: the journal's acknowledgements arrive between ticks.
   */
  async runUntilSettled(until: number): Promise<void> {
    let fires = 0;
    for (let next = this.next; next !== undefined && next <= until; next = this.next) {
      fires += 1;
      if (fires > MAX_FIRES) throw new Error(`more than ${MAX_FIRES} timers fired before ${until}`);
      this.fireNext();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.#clock.time = Math.max(this.#clock.time, until);
  }

  #earliest(): Pending | undefined {
    return this.#pending.reduce<Pending | undefined>(
      (best, timer) =>
        best === undefined ||
        timer.at < best.at ||
        (timer.at === best.at && timer.order < best.order)
          ? timer
          : best,
      undefined,
    );
  }
}
