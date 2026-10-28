/**
 * The validation of what a brain proposes (ADR 0023): the intention is copied canonically, reading
 * each member once and refusing accessors, then checked for shape and bounds, and its walk checked
 * step by step against the window the brain sensed in the same tick. An invalid intention is a
 * rejection, which becomes the being's experience (plan §K.5); it never faults the world. Under
 * beings@2 an intention may also carry mental operations (operations.ts), whose shape is judged
 * here and whose references are judged when they apply.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { type CanonicalValue, lengthOf } from "../canonical/value.ts";
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
  type TalkStep,
  type WakeConditions,
} from "./being.ts";
import { DIRECTIONS, MAX_INTENTION_STEPS, type SensedWindow } from "./contracts.ts";
import {
  type MindGrammar,
  type MindOperations,
  mindOversized,
  NO_OPERATIONS,
  readMindOperations,
} from "./operations.ts";
import { type ActivityKind, BEINGS_RULES } from "./rules.ts";
import { range, readFields, readList } from "./schema.ts";

/**
 * An intention the engine accepted: the activity it starts now, what follows, and the cooldowns it
 * adds, present only when the intention has them; under beings@2, also its mental operations, none
 * when it has no `mind`.
 */
export type Accepted = {
  readonly kind: "accepted";
  readonly activity: Activity;
  readonly plan: readonly PlanStep[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
  readonly cooldowns?: readonly CooldownRequest[];
  readonly mind?: MindOperations;
};

/** An intention the engine refused, with a short reason for the being's outcome. */
export type Refused = { readonly kind: "rejected"; readonly reason: string };

/**
 * An intention of beings@2 whose one step is a talk, accepted by its shape: what the talk says, and
 * to whom, is judged against the decision's percepts and mind once its mental operations applied
 * (speech.ts), and then it starts or is refused.
 */
export type Talking = Omit<Accepted, "kind" | "activity" | "plan"> & {
  readonly kind: "talk";
  readonly talk: TalkStep;
};

/**
 * When an intention is judged, the window the brain sensed then, centered on the being; the kinds
 * of activity the ruleset's version knows, those of T4 when it is not given, among which `talk`
 * lets a talk be its only step; and, for a brain of
 * beings@2, the behaviors it declared, which `behavior.kind` must name, and the grammar of its
 * mental operations, without which an intention may carry none.
 */
export type IntentionContext = {
  readonly tick: Tick;
  readonly window: SensedWindow;
  readonly activities?: readonly ActivityKind[];
  readonly behaviors?: readonly string[] | undefined;
  readonly mind?: MindGrammar | undefined;
};

/** The intention's own members, once its copy passed every check. */
type Valid = {
  readonly steps: readonly (PlanStep | TalkStep)[];
  readonly wakeWhen: WakeConditions;
  readonly behavior: Behavior;
  readonly cooldowns?: readonly CooldownRequest[];
  readonly mind?: MindOperations;
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

/** An intention whose shape was checked, with its `mind`, under beings@2, still unread. */
type Body = Omit<Valid, "mind"> & { readonly mind?: CanonicalValue };

/** The members of an intention, and those beings@2 adds: its mental operations. */
const MEMBERS = Object.freeze({
  required: ["behavior", "steps", "wakeWhen"],
  optional: ["cooldowns"],
});
const MEMBERS2 = Object.freeze({ ...MEMBERS, optional: ["cooldowns", "mind"] });

/**
 * The canonical copy of `raw`, if it has the shape and bounds of an intention whose steps are of
 * the kinds the context allows and whose behavior the brain declared; its mental operations are
 * left unread. `malformed` otherwise.
 */
function readBody(raw: unknown, context: IntentionContext): Body | "malformed" {
  const issues = new IssueList();
  const copy = copyCanonicalReported(raw, issues);
  if (issues.count > 0) return "malformed";
  const members = context.mind === undefined ? MEMBERS : MEMBERS2;
  const intention = readFields(copy, "", members, issues);
  if (intention === undefined) return "malformed";
  const steps = readList(intention.value("steps"), "/steps", range(1, MAX_INTENTION_STEPS), issues);
  steps?.forEach((step, index) => {
    checkPlanStep(step, `/steps/${index}`, issues, context.activities ?? BEINGS_RULES.activities);
  });
  checkWakeConditions(intention.value("wakeWhen"), "/wakeWhen", issues);
  checkBehavior(intention.value("behavior"), "/behavior", issues);
  const cooldowns = intention.value("cooldowns");
  if (cooldowns !== undefined) checkCooldownRequests(cooldowns, "/cooldowns", issues);
  if (issues.count > 0) return "malformed";
  // Every check passed, so the copy is an intention.
  const body = copy as Body;
  return declared(body.behavior, context) ? body : "malformed";
}

/**
 * `raw` as an intention whose shape and bounds are valid, with its mental operations read by the
 * grammar of the context; otherwise the reason it is not one. Lengths are bounded before the copy:
 * too many steps is `malformed`, and a `mind` too large for any legal operations `mind_malformed`.
 * Then a value that is not canonical, or a body of the wrong shape, is `malformed`, and operations
 * of the wrong shape `mind_malformed`.
 */
function readIntention(raw: unknown, context: IntentionContext): Valid | string {
  if (tooManySteps(raw)) return "malformed";
  const grammar = context.mind;
  if (grammar !== undefined && mindOversized(raw)) return "mind_malformed";
  const body = readBody(raw, context);
  if (body === "malformed") return body;
  // Without a grammar, `mind` is an unknown member, which readBody refused.
  const { mind, ...intention } = body;
  if (grammar === undefined) return intention;
  const operations =
    mind === undefined ? NO_OPERATIONS : readMindOperations(mind, grammar, new IssueList());
  return operations === undefined ? "mind_malformed" : { ...intention, mind: operations };
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

/** `intention` as a talk, when its talk is its only step, `first`; `malformed` otherwise. */
function talking(intention: Valid, first: PlanStep | TalkStep): Talking | Refused {
  if (intention.steps.length > 1 || first.kind !== "talk")
    return { kind: "rejected", reason: "malformed" };
  const { wakeWhen, behavior, cooldowns, mind } = intention;
  return {
    kind: "talk",
    talk: first,
    wakeWhen,
    behavior,
    ...(cooldowns === undefined ? {} : { cooldowns }),
    ...(mind === undefined ? {} : { mind }),
  };
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
 * Judges `raw`, what a brain returned, at `context`: the accepted activity, plan, cooldowns to
 * add, and mental operations, or a talk to judge further, or a refusal with one of the reasons
 * `malformed` (not an intention of the right shape and bounds, a behavior the brain did not
 * declare, or a talk that is not the only step), `mind_malformed` (mental operations of the wrong
 * shape, count, bounds, or grammar), `walk_not_first` (a walk is the first step or none), and
 * `walk_blocked` (a step of the walk cannot be taken), in that order. Never throws: the canonical
 * copy reads each member once through its own descriptor, so an accessor, or a Proxy whose traps
 * throw, is refused.
 */
export function acceptIntention(
  raw: unknown,
  context: IntentionContext,
): Accepted | Talking | Refused {
  const intention = readIntention(raw, context);
  if (typeof intention === "string") return { kind: "rejected", reason: intention };
  const [first, ...rest] = intention.steps;
  if (first === undefined) return { kind: "rejected", reason: "malformed" };
  if (first.kind === "talk" || rest.some((step) => step.kind === "talk"))
    return talking(intention, first);
  if (rest.some((step) => step.kind === "walk"))
    return { kind: "rejected", reason: "walk_not_first" };
  const arrivals = first.kind === "walk" ? route(context.window, first.dirs) : [];
  if (arrivals === undefined) return { kind: "rejected", reason: "walk_blocked" };
  const accepted: Accepted = {
    kind: "accepted",
    activity: activityOf(first, context.tick, arrivals),
    // No step after the first is a talk, which would have been the only one.
    plan: rest.filter((step): step is PlanStep => step.kind !== "talk"),
    wakeWhen: intention.wakeWhen,
    behavior: intention.behavior,
    ...(intention.mind === undefined ? {} : { mind: intention.mind }),
  };
  return intention.cooldowns === undefined
    ? accepted
    : { ...accepted, cooldowns: intention.cooldowns };
}
