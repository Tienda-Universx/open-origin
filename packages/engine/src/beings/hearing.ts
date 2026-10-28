/**
 * The inbox of a being of beings@2 (ADR 0024, docs/architecture/mind.md "Speech", "Provenance and
 * taints", and "Commands and faults"): how a message reaches it, how hearing wakes it, and how a
 * decision hears it. A message that reaches the inbox makes the being's exposure grow at once with
 * its taints. Messages that reach it at tick t wake it at t + 1 when it is idle and hearing has
 * woken it fewer than `speech.wakesPerDay` times in the day: it is due at t + 1, and its idle is
 * interrupted there so that it decides. A being that walks, eats, or sleeps keeps the messages for
 * its next decision. The decision consumes the inbox at step 1 (mental.ts), and the brain hears
 * each message by allowlist: never its taints, nor the tick.
 */
import { floorDiv } from "../int.ts";
import { exposureAfterMessage, type InboxMessage, type Mind } from "../mind/index.ts";
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

/** What decides whether hearing wakes a being: when the messages arrived, the day, and the law. */
export type Hearing = {
  /** The tick the messages reached the inbox. */
  readonly at: number;
  /** The simulated day, for the quota's count of wakes. */
  readonly day: number;
  readonly wakesPerDay: number;
};

/**
 * Whether messages that reached the inbox of `mind`, of a being doing `activity`, at `hearing.at`
 * wake it at the next tick: it is idle, a message arrived then, and its quota counts fewer than
 * `wakesPerDay` wakes by hearing in the day. A research injection wakes it without counting.
 */
export function hearingWakes(mind: Mind, activity: Activity, hearing: Hearing): boolean {
  if (activity.kind !== "idle") return false;
  if (!mind.inbox.some((message) => message.t === hearing.at)) return false;
  const woken = mind.quota.day === hearing.day ? mind.quota.woken : 0;
  return woken < hearing.wakesPerDay;
}

/**
 * `message` as a brain hears it, by the allowlist of the classification registry (classes.ts): its
 * C1 members but the tick, copied; never its taints.
 */
export function heardMessage(message: InboxMessage): HeardMessage {
  // copyHeard keeps only members of an inbox message, which the engine built.
  return copyHeard(message) as HeardMessage;
}
