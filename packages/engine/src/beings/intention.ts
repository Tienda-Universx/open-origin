/**
 * The validation of what a brain proposes (ADR 0023): the intention is copied canonically, reading
 * each member once and refusing accessors, then checked for shape and bounds, and its walk checked
 * step by step against the window the brain sensed in the same tick. An invalid intention is a
 * rejection, which becomes the being's experience (plan §K.5); it never faults the world.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { lengthOf } from "../canonical/value.ts";
import { IssueList } from "../errors.ts";
import type { Tick } from "../time/tick.ts";
import { readMember } from "../world/members.ts";
import {
  type Activity,
  type Behavior,
  type CooldownRequest,
  checkBehavior,
  checkCooldownRequests,
  checkPlanStep,
  checkWakeConditions,
  type PlanStep,
  type WakeConditions,
} from "./being.ts";
import { DIRECTIONS, MAX_INTENTION_STEPS, type SensedWindow } from "./contracts.ts";
import { type ActivityKind, BEINGS_RULES } from "./rules.ts";
import { range, readFields, readList } from "./schema.ts";

/**
 * An intention the engine accepted: the activity it starts now, what follows, and the cooldowns it
 * adds, present only when the intention has them.
 */
export type Accepted = {
  readonly kind: "accepted";
  readonly activity: Activity;
  readonly plan: readonly PlanStep[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
  readonly cooldowns?: readonly CooldownRequest[];
};

/** An intention the engine refused, with a short reason for the being's outcome. */
export type Refused = { readonly kind: "rejected"; readonly reason: string };

/**
 * When an intention is judged, the window the brain sensed then, centered on the being; the kinds
 * of activity the ruleset's version knows, those of T4 when it is not given; and, for a brain of
 * beings@2, the behaviors it declared, which `behavior.kind` must name.
 */
export type IntentionContext = {
  readonly tick: Tick;
  readonly window: SensedWindow;
  readonly activities?: readonly ActivityKind[];
  readonly behaviors?: readonly string[] | undefined;
};

/** The intention's own members, once its copy passed every check. */
type Valid = {
  readonly steps: readonly PlanStep[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
  readonly cooldowns?: readonly CooldownRequest[];
};

/**
 * Whether `raw` has a list of steps longer than an intention may, read from its own length without
 * reading its entries. Only a shortcut for a huge list: what cannot be read here is left to the
 * canonical copy, which reads it again and reports it.
 */
function tooManySteps(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const steps = readMember(raw, "steps", "/steps", new IssueList());
  if (typeof steps !== "object" || steps === null) return false;
  try {
    return lengthOf(steps) > MAX_INTENTION_STEPS;
  } catch {
    // A Proxy whose traps throw, revoked or not: the canonical copy refuses it.
    return false;
  }
}

/**
 * A canonical copy of `raw` that has the shape and bounds of an intention whose steps are of the
 * kinds `activities`; undefined otherwise.
 */
function readIntention(raw: unknown, activities: readonly ActivityKind[]): Valid | undefined {
  if (tooManySteps(raw)) return undefined;
  const issues = new IssueList();
  const copy = copyCanonicalReported(raw, issues);
  if (issues.count > 0) return undefined;
  const members = { required: ["behavior", "steps", "wakeWhen"], optional: ["cooldowns"] };
  const intention = readFields(copy, "", members, issues);
  if (intention === undefined) return undefined;
  const steps = readList(intention.value("steps"), "/steps", range(1, MAX_INTENTION_STEPS), issues);
  steps?.forEach((step, index) => {
    checkPlanStep(step, `/steps/${index}`, issues, activities);
  });
  checkWakeConditions(intention.value("wakeWhen"), "/wakeWhen", issues);
  checkBehavior(intention.value("behavior"), "/behavior", issues);
  const cooldowns = intention.value("cooldowns");
  if (cooldowns !== undefined) checkCooldownRequests(cooldowns, "/cooldowns", issues);
  // Every check passed, so the copy is an intention.
  return issues.count === 0 ? (copy as Valid) : undefined;
}

/** Whether `behavior` names a behavior the brain declared, when it declared any (beings@2). */
function declared(behavior: Behavior, context: IntentionContext): boolean {
  return context.behaviors === undefined || context.behaviors.includes(behavior.kind);
}

/**
 * The cumulative milliseconds of each arrival of the walk `dirs` from the window's center, where
 * the being stands, or undefined when one of its steps cannot be taken: impassable, or leaving the
 * window.
 */
function route(window: SensedWindow, dirs: string): number[] | undefined {
  const { side, edgeMs } = window;
  const radius = (side - 1) / 2;
  let index = radius * side + radius;
  let total = 0;
  const arrivals: number[] = [];
  for (const digit of dirs) {
    const d = digit.charCodeAt(0) - 48;
    const ms = edgeMs[index * 8 + d] as number;
    // A step out of the window is −1 in edgeMs, so a passable step stays inside it.
    if (ms < 0) return undefined;
    const [dx, dy] = DIRECTIONS[d] as readonly [number, number];
    index += dy * side + dx;
    total += ms;
    arrivals.push(total);
  }
  return arrivals;
}

/** The activity the first step of an accepted intention starts at `tick`. */
function activityOf(step: PlanStep, tick: Tick, arrivals: number[]): Activity {
  if (step.kind === "walk")
    return { kind: "walk", start: tick, dirs: step.dirs, ms: arrivals, done: 0 };
  if (step.kind === "eat")
    return { kind: "eat", start: tick, untilNutrition: step.untilNutrition, bites: 0 };
  if (step.kind === "sleep") return { kind: "sleep", untilRest: step.untilRest, forced: false };
  return { kind: "idle", start: tick, ms: step.ms };
}

/**
 * Judges `raw`, what a brain returned, at `context`: the accepted activity, plan, and cooldowns to
 * add, or a refusal with one of the reasons `malformed` (not an intention of the right shape and
 * bounds, or a behavior the brain did not declare), `walk_not_first` (a walk is the first step or
 * none), and `walk_blocked` (a step of the walk cannot be taken). Never throws: the canonical copy
 * reads each member once through its own descriptor, so an accessor, or a Proxy whose traps throw,
 * is refused.
 */
export function acceptIntention(raw: unknown, context: IntentionContext): Accepted | Refused {
  const intention = readIntention(raw, context.activities ?? BEINGS_RULES.activities);
  if (intention === undefined || !declared(intention.behavior, context))
    return { kind: "rejected", reason: "malformed" };
  const [first, ...rest] = intention.steps;
  if (first === undefined) return { kind: "rejected", reason: "malformed" };
  if (rest.some((step) => step.kind === "walk"))
    return { kind: "rejected", reason: "walk_not_first" };
  const arrivals = first.kind === "walk" ? route(context.window, first.dirs) : [];
  if (arrivals === undefined) return { kind: "rejected", reason: "walk_blocked" };
  const accepted: Accepted = {
    kind: "accepted",
    activity: activityOf(first, context.tick, arrivals),
    plan: rest,
    wakeWhen: intention.wakeWhen,
    behavior: intention.behavior,
  };
  return intention.cooldowns === undefined
    ? accepted
    : { ...accepted, cooldowns: intention.cooldowns };
}
