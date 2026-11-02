/**
 * The fixed-rate scheduler of the public universe (ADR 0025, "Time and the scheduler"). The tick
 * `n` has the deadline `d_n = t0 + n·P`, with `P = 1,000,000 / tickRateHz` microseconds. Each
 * deadline gets a one-shot timer, never an interval, and each callback runs one tick at most, so
 * the event loop runs between any two ticks. Lateness is handled like this:
 *
 * - late by one period or less (`now − d_n ≤ P`): the schedule holds, and the next tick runs at
 *   `max(d_{n+1}, now)`, back to back only to recover less than one period;
 * - late by more (`now − d_n > P`): first `shortfall += ⌊(now − d_n) / P⌋`, then the schedule is
 *   rebased with `t0 ← now − n·P`.
 *
 * The tick always advances by exactly one: under overload the world runs slower for everyone.
 * Stops (a journal stall, an internal pause, a halt) are counted apart from shortfall, and
 * resuming resets `t0`, so a stop is never shortfall. A tick that throws halts the scheduler, which
 * records what it threw: it never stays running without a timer.
 *
 * `t0` is kept as an anchor, the pair (time, tick) with `d_anchorTick = anchorTime`, so that every
 * deadline is a whole number of microseconds even when P is not: `d_n = anchorTime +
 * ⌊(n − anchorTick) · 1,000,000 / tickRateHz⌋`. Here `n` counts the ticks this scheduler ran.
 */
import { causeOf, type FaultCause } from "./fault.ts";
import { type Percentiles, SampleWindow } from "./samples.ts";
import type { CancelTimer, Clock, Timer } from "./time.ts";

/** Why the world may not run a tick now: the journal lags too far behind, or the world halted. */
export type Hold = "journalStall" | "halted";

/** The scheduler's state: running, or one of the stops of ADR 0025. */
export type SchedulerState = "running" | "paused" | Hold;

/** The scheduler's C3 metrics for the admin contract, and the fault that halted it, if any. */
export type SchedulerMetrics = {
  readonly state: SchedulerState;
  /** The ticks run since the scheduler was made. */
  readonly ticks: number;
  /** The ticks the world fell behind its schedule, counted at each rebase. */
  readonly shortfallTicks: number;
  readonly rebases: number;
  /** How many times each stop began. */
  readonly stops: {
    readonly journalStall: number;
    readonly paused: number;
    readonly halted: number;
  };
  /** How late each of the last ticks started, in microseconds. */
  readonly latenessMicros: Percentiles;
  /** How long each of the last ticks ran, in microseconds. */
  readonly stepMicros: Percentiles;
  /** The rate achieved over the last ticks' starts, in ticks per 1,000 seconds; 0 before two. */
  readonly achievedMilliHz: number;
  /** What a tick threw when it halted the scheduler; undefined while no tick threw. */
  readonly fault: FaultCause | undefined;
};

export type SchedulerOptions = {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly tickRateHz: number;
  /** Runs one tick of the world. When it throws, the scheduler halts and records what it threw. */
  readonly runTick: () => void;
  /** Why no tick may run now, or undefined when one may: asked before each tick and after it. */
  readonly hold: () => Hold | undefined;
};

const MICROS_PER_SECOND = 1_000_000;
/** The samples the lateness and step percentiles read. */
const WINDOW = 1024;
/** The tick starts the achieved rate reads. */
const RATE_WINDOW = 64;

/** Runs a world's ticks at a fixed rate over an injected clock and timer. */
export class FixedRateScheduler {
  readonly #clock: Clock;
  readonly #timer: Timer;
  readonly #hz: number;
  readonly #runTick: () => void;
  readonly #hold: () => Hold | undefined;
  #state: SchedulerState = "paused";
  #pending: CancelTimer | undefined;
  /** n: the index of the next tick. */
  #next = 0;
  #anchorTime = 0;
  #anchorTick = 0;
  #shortfall = 0;
  #rebases = 0;
  #fault: FaultCause | undefined;
  readonly #stops = { journalStall: 0, paused: 0, halted: 0 };
  readonly #lateness = new SampleWindow(WINDOW);
  readonly #steps = new SampleWindow(WINDOW);
  readonly #starts = new SampleWindow(RATE_WINDOW);

  constructor({ clock, timer, tickRateHz, runTick, hold }: SchedulerOptions) {
    if (!Number.isSafeInteger(tickRateHz) || tickRateHz < 1 || tickRateHz > 1000) {
      throw new RangeError(`the tick rate is an integer from 1 to 1000 Hz, not ${tickRateHz}`);
    }
    this.#clock = clock;
    this.#timer = timer;
    this.#hz = tickRateHz;
    this.#runTick = runTick;
    this.#hold = hold;
  }

  /** Starts, or resumes after a pause, with a schedule whose next deadline is now. */
  start(): void {
    if (this.#state !== "paused") return;
    this.#resume();
  }

  /** Stops the ticks until `start`: an internal pause, for tests and for shutdown. */
  pause(): void {
    if (this.#state !== "running" && this.#state !== "journalStall") return;
    this.#stop("paused");
  }

  /**
   * Asks the hold again between ticks: called when the journal acknowledges a batch or fails, and
   * when the world halts. A halt stops the scheduler at once; a stalled world whose journal caught
   * up resumes; a running world keeps its schedule, and a new stall stops it at its next deadline.
   */
  wake(): void {
    if (this.#state !== "running" && this.#state !== "journalStall") return;
    const hold = this.#hold();
    if (hold === "halted") this.#stop("halted");
    else if (hold === undefined && this.#state === "journalStall") this.#resume();
  }

  metrics(): SchedulerMetrics {
    return {
      state: this.#state,
      ticks: this.#next,
      shortfallTicks: this.#shortfall,
      rebases: this.#rebases,
      stops: { ...this.#stops },
      latenessMicros: this.#lateness.percentiles(),
      stepMicros: this.#steps.percentiles(),
      achievedMilliHz: this.#achievedMilliHz(),
      fault: this.#fault,
    };
  }

  /** The deadline of the tick `n`. */
  #deadline(n: number): number {
    return this.#anchorTime + Math.floor(((n - this.#anchorTick) * MICROS_PER_SECOND) / this.#hz);
  }

  /** Resets the schedule so that the next tick's deadline is `now`. */
  #anchorAt(now: number): void {
    this.#anchorTime = now;
    this.#anchorTick = this.#next;
  }

  #resume(): void {
    this.#state = "running";
    this.#anchorAt(this.#clock.now());
    this.#arm();
  }

  #stop(stop: "paused" | Hold): void {
    this.#pending?.();
    this.#pending = undefined;
    this.#state = stop;
    this.#stops[stop] += 1;
  }

  /** Sets the timer of the next tick, at `max(d_n, now)`, unless the world is held. */
  #arm(): void {
    // A tick that paused and started the scheduler again armed a timer already: one chain runs.
    this.#pending?.();
    this.#pending = undefined;
    const hold = this.#hold();
    if (hold !== undefined) {
      this.#stop(hold);
      return;
    }
    const delay = Math.max(0, this.#deadline(this.#next) - this.#clock.now());
    this.#pending = this.#timer.schedule(delay, () => this.#fire());
  }

  /** A timer's callback: one tick at most, then the next timer. */
  #fire(): void {
    this.#pending = undefined;
    if (this.#state !== "running") return;
    const now = this.#clock.now();
    const deadline = this.#deadline(this.#next);
    // A timer that fires early waits again: no tick runs before its deadline.
    if (now < deadline) {
      this.#pending = this.#timer.schedule(deadline - now, () => this.#fire());
      return;
    }
    const hold = this.#hold();
    if (hold !== undefined) {
      this.#stop(hold);
      return;
    }
    this.#keepSchedule(now - deadline, now);
    this.#run(now);
    if (this.#state === "running") this.#arm();
  }

  /** Records how late the tick is, and past one period counts the shortfall and rebases. */
  #keepSchedule(lateness: number, now: number): void {
    this.#lateness.add(lateness);
    if (lateness * this.#hz <= MICROS_PER_SECOND) return;
    this.#shortfall += Math.floor((lateness * this.#hz) / MICROS_PER_SECOND);
    this.#rebases += 1;
    this.#anchorAt(now);
  }

  /** Runs the tick `n`. One that throws halts the scheduler, once, and leaves what it threw. */
  #run(now: number): void {
    this.#starts.add(now);
    try {
      this.#runTick();
    } catch (error) {
      this.#fault = causeOf(error);
      if (this.#state !== "halted") this.#stop("halted");
    }
    this.#steps.add(this.#clock.now() - now);
    this.#next += 1;
  }

  #achievedMilliHz(): number {
    const starts = this.#starts.values();
    const first = starts[0];
    const last = starts.at(-1);
    if (first === undefined || last === undefined || last === first) return 0;
    return Math.floor(((starts.length - 1) * MICROS_PER_SECOND * 1000) / (last - first));
  }
}
