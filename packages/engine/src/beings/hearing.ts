/**
 * The inbox of a being of beings@2 (ADR 0024, docs/architecture/mind.md "Speech", "Provenance and
 * taints", and "Commands and faults"): how a message reaches it, how hearing wakes it, and how a
 * decision hears it. A message that reaches the inbox makes the being's exposure grow at once with
 * its taints. Messages that reach it at tick t wake it at t + 1 when it is idle and hearing has
 * woken it fewer than `speech.wakesPerDay` times in the day of t: it is due at t + 1, and its idle
 * is interrupted there so that it decides. That wake counts in `quota.woken`, in the day of t, when
 * a speaker's message woke it; a research injection's wakes it without counting. A being that
 * walks, eats, or sleeps keeps the messages for its next decision. The decision consumes the inbox
 * at step 1 (mental.ts), and the brain hears each message by allowlist: never its taints, nor the
 * tick.
 */
import { floorDiv } from "../int.ts";
import { exposureAfterMessage, type InboxMessage, type Mind, type Quota } from "../mind/index.ts";
import { simSeconds, type Tick } from "../time/tick.ts";
import type { Activity } from "./being.ts";
import { copyHeard } from "./classes.ts";
import type { HeardMessage } from "./contracts.ts";

/** `mind` with `message` at the end of its inbox and its exposure grown by the message's taints. */
export function delivered(mind: Mind, message: InboxMessage): Mind {
  return {
    ...mind,
    inbox: [...mind.inbox, message],
    exposure: exposureAfterMessage(mind.exposure, message),
  };
}

/** The simulated day of the second `seconds`, as the daily prune and `quota.day` count days. */
export function dayOf(seconds: number, dayLength: number): number {
  return floorDiv(seconds, dayLength);
}

/** The simulated day of the tick `tick`, in a world of `secondsPerTick` and days of `dayLength`. */
export function dayOfTick(tick: Tick, secondsPerTick: number, dayLength: number): number {
  return dayOf(simSeconds(tick, secondsPerTick), dayLength);
}

/** `quota` as it counts the day `day`: itself when it counts that day, and nothing yet otherwise. */
export function quotaOf(quota: Quota, day: number): Quota {
  return quota.day === day ? quota : { day, said: 0, woken: 0 };
}

/** What decides whether hearing wakes a being: when the messages arrived, its day, and the law. */
export type Hearing = {
  /** The tick the messages reached the inbox. */
  readonly at: number;
  /** The simulated day of that tick, whose quota counts the wake. */
  readonly day: number;
  readonly wakesPerDay: number;
};

/**
 * Whether messages that reached the inbox of `mind`, of a being doing `activity`, at `hearing.at`
 * wake it at the next tick: it is idle, a message arrived then, and its quota counts fewer than
 * `wakesPerDay` wakes by hearing in the day of `hearing.at`.
 */
export function hearingWakes(mind: Mind, activity: Activity, hearing: Hearing): boolean {
  if (activity.kind !== "idle") return false;
  if (!mind.inbox.some((message) => message.t === hearing.at)) return false;
  return quotaOf(mind.quota, hearing.day).woken < hearing.wakesPerDay;
}

/**
 * `mind` once hearing woke its being: one more wake in the day of `hearing.at` when a speaker's
 * message reached the inbox then; the same mind when only research injections did, whose wakes
 * count nothing.
 */
export function wokenBy(mind: Mind, hearing: Hearing): Mind {
  const spoken = mind.inbox.some(
    (message) => message.t === hearing.at && message.who !== undefined,
  );
  if (!spoken) return mind;
  const quota = quotaOf(mind.quota, hearing.day);
  return { ...mind, quota: { ...quota, woken: quota.woken + 1 } };
}

/**
 * `message` as a brain hears it, by the allowlist of the classification registry (classes.ts): its
 * C1 members but the tick, copied; never its taints.
 */
export function heardMessage(message: InboxMessage): HeardMessage {
  // copyHeard keeps only members of an inbox message, which the engine built.
  return copyHeard(message) as HeardMessage;
}
