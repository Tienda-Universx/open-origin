/**
 * The validation of what a brain proposes (ADR 0023): the intention is copied canonically, reading
 * each member once and refusing accessors, then checked for shape and bounds, and its walk checked
 * step by step against the window the brain sensed in the same tick. An invalid intention is a
 * rejection, which becomes the being's experience (plan §K.5); it never faults the world.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { IssueList } from "../errors.ts";
import type { Tick } from "../time/tick.ts";
import {
  type Activity,
  type Behavior,
  type Cell,
  checkBehavior,
  checkPlanStep,
  checkWakeConditions,
  type PlanStep,
  type WakeConditions,
} from "./being.ts";
import { DIRECTIONS, MAX_INTENTION_STEPS, type SensedWindow } from "./contracts.ts";
import { range, readFields, readList } from "./schema.ts";

/** An intention the engine accepted: the activity it starts now, and what follows. */
export type Accepted = {
  readonly kind: "accepted";
  readonly activity: Activity;
  readonly plan: readonly PlanStep[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
};

/** An intention the engine refused, with a short reason for the being's outcome. */
export type Refused = { readonly kind: "rejected"; readonly reason: string };

/** Where and when an intention is judged: the tick, and the window the brain sensed then. */
export type IntentionContext = {
  readonly tick: Tick;
  readonly window: SensedWindow;
  readonly center: Cell;
};

/** The intention's own members, once its copy passed every check. */
type Valid = {
  readonly steps: readonly PlanStep[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
};

/** A canonical copy of `raw` that has the shape and bounds of an intention; undefined otherwise. */
function readIntention(raw: unknown): Valid | undefined {
  const issues = new IssueList();
  const copy = copyCanonicalReported(raw, issues);
  if (issues.count > 0) return undefined;
  const intention = readFields(copy, "", { required: ["behavior", "steps", "wakeWhen"] }, issues);
  if (intention === undefined) return undefined;
  const steps = readList(intention.value("steps"), "/steps", range(1, MAX_INTENTION_STEPS), issues);
  steps?.forEach((step, index) => {
    checkPlanStep(step, `/steps/${index}`, issues);
  });
  checkWakeConditions(intention.value("wakeWhen"), "/wakeWhen", issues);
  checkBehavior(intention.value("behavior"), "/behavior", issues);
  // Every check passed, so the copy is an intention.
  return issues.count === 0 ? (copy as Valid) : undefined;
}

/**
 * The cumulative milliseconds of each arrival of the walk `dirs` from the window's center, or
 * undefined when one of its steps cannot be taken: impassable, or leaving the window.
 */
function route(window: SensedWindow, center: Cell, dirs: string): number[] | undefined {
  const { origin, side, edgeMs } = window;
  let index = (center[1] - origin[1]) * side + (center[0] - origin[0]);
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
 * Judges `raw`, what a brain returned, at `context`: the accepted activity and plan, or a refusal
 * with one of the reasons `malformed` (not an intention of the right shape and bounds),
 * `walk_not_first` (a walk is the first step or none), and `walk_blocked` (a step of the walk
 * cannot be taken). Never throws: an accessor or a Proxy is refused by the canonical copy.
 */
export function acceptIntention(raw: unknown, context: IntentionContext): Accepted | Refused {
  const intention = readIntention(raw);
  if (intention === undefined) return { kind: "rejected", reason: "malformed" };
  const [first, ...rest] = intention.steps;
  if (first === undefined) return { kind: "rejected", reason: "malformed" };
  if (rest.some((step) => step.kind === "walk"))
    return { kind: "rejected", reason: "walk_not_first" };
  const arrivals = first.kind === "walk" ? route(context.window, context.center, first.dirs) : [];
  if (arrivals === undefined) return { kind: "rejected", reason: "walk_blocked" };
  return {
    kind: "accepted",
    activity: activityOf(first, context.tick, arrivals),
    plan: rest,
    wakeWhen: intention.wakeWhen,
    behavior: intention.behavior,
  };
}
