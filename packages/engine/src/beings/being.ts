/**
 * A being (ADR 0023): its identity, cell, body, what it is doing, and what its brain stored, as it
 * lives in the chunk of its cell. What an observer inside the world could see is C0; the rest is C1
 * (docs/architecture/beings.md). A being of beings@2 also has three more traits and a mind (ADR
 * 0024), whose classes classes.ts records. The validator checks shapes and bounds by the rules of
 * its version; the laws a being follows are checked where they apply, because a chunk's validator
 * cannot see the global value.
 */
import type { IssueSink } from "../canonical/value.ts";
import { type Issue, IssueList } from "../errors.ts";
import type { Mind } from "../mind/index.ts";
import type { Tick } from "../time/tick.ts";
import type { EntityId } from "../world/contracts.ts";
import { MAX_CELL, MIN_CELL } from "../worldgen/index.ts";
import { STAGES } from "./laws.ts";
import { checkMindValue } from "./minds.ts";
import { NEED_MAX } from "./rates.ts";
import {
  type ActivityKind,
  BEINGS_RULES,
  type BeingsRules,
  type BeingsVersion,
  rulesOf,
} from "./rules.ts";
import { type Fields, range, readFields, readId, readInt, readList, TICKS } from "./schema.ts";

/** An absolute cell, `[x, y]`. */
export type Cell = readonly [number, number];

/** What a being is doing; `ms` of a walk holds the cumulative milliseconds of each arrival. */
export type Activity =
  | { readonly kind: "idle"; readonly start: Tick; readonly ms: number }
  | {
      readonly kind: "walk";
      readonly start: Tick;
      readonly dirs: string;
      readonly ms: readonly number[];
      readonly done: number;
    }
  | {
      readonly kind: "eat";
      readonly start: Tick;
      readonly untilNutrition: number;
      readonly bites: number;
    }
  | { readonly kind: "sleep"; readonly untilRest: number; readonly forced: boolean };

/** A step a brain plans: the activities it may ask for. */
export type PlanStep =
  | { readonly kind: "walk"; readonly dirs: string }
  | { readonly kind: "eat"; readonly untilNutrition: number }
  | { readonly kind: "sleep"; readonly untilRest: number }
  | { readonly kind: "idle"; readonly ms: number };

/** Levels at which the brain asked to be woken: at or below, or at or above. */
export type WakeConditions = {
  readonly nutritionBelow?: number;
  readonly restBelow?: number;
  readonly lightBelow?: number;
  readonly lightAbove?: number;
};

/** What the brain stored to find again: its behavior, since when, and its heading. */
export type Behavior = { readonly kind: string; readonly since: Tick; readonly heading: number };

/** How a step can end. */
export const RESULTS: readonly string[] = Object.freeze([
  "done",
  "failed",
  "interrupted",
  "lost",
  "none",
  "rejected",
]);

/**
 * How the last step ended, when, and why; under beings@2, when the step was a meal, also the units
 * it ate in total, 0 when it ate nothing.
 */
export type Outcome = {
  readonly result: string;
  readonly tick: Tick;
  readonly reason: string;
  readonly units?: number;
};

/** A target the brain failed to reach, avoided until `until`. */
export type Cooldown = { readonly cell: Cell; readonly until: Tick };

/**
 * A cooldown a brain adds: the target and how long to avoid it, in simulated milliseconds. The
 * engine stamps the tick it ends at, because the brain does not sense the tick.
 */
export type CooldownRequest = { readonly cell: Cell; readonly ms: number };

/** The traits of a being of T4, in permille. */
export type Traits = {
  readonly appetite: number;
  readonly sleepiness: number;
  readonly curiosity: number;
};

/** The traits of a being of beings@2: retention scales the half-lives of its memories. */
export type Traits2 = Traits & {
  readonly sociability: number;
  readonly credulity: number;
  readonly retention: number;
};

export type Being = {
  readonly id: EntityId;
  readonly species: string;
  readonly stage: string;
  readonly born: Tick;
  readonly cell: Cell;
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly health: number;
  readonly anchor: Tick;
  readonly traits: Traits;
  readonly condition: "ok" | "incapacitated";
  readonly activity: Activity;
  readonly plan: readonly PlanStep[];
  readonly behavior: Behavior;
  readonly wakeWhen: WakeConditions;
  readonly wake: Tick;
  readonly outcome: Outcome;
  readonly cooldowns: readonly Cooldown[];
};

/** A being of beings@2: a being of T4 with six traits and a mind, empty at its spawn. */
export type Being2 = Omit<Being, "traits"> & { readonly traits: Traits2; readonly mind: Mind };

/** The most steps a walk may have, and the most steps an intention may plan. */
export const MAX_WALK_STEPS = 64;
export const MAX_INTENTION_STEPS = 3;

/** The largest tick: the wake of a being nothing will change, and the due of an empty chunk. */
export const MAX_TICK = Number.MAX_SAFE_INTEGER;

/** The bounds of a being's data. A walk's arrivals stay below MAX_WALK_STEPS steps of 2^32 ms. */
export const BEING_BOUNDS = Object.freeze({
  id: range(1, Number.MAX_SAFE_INTEGER),
  cell: range(MIN_CELL, MAX_CELL),
  level: range(0, NEED_MAX),
  trait: range(1, 10_000),
  light: range(0, 0x10_0000),
  heading: range(0, 7),
  durationMs: range(1, 0x1_0000_0000),
  arrivalMs: range(1, 0x40_0000_0000),
  bites: range(0, 0x10_0000),
  /** The units a meal ate: at most 2^20 bites of 2^20 units. */
  eaten: range(0, 0x100_0000_0000),
  plan: range(0, MAX_INTENTION_STEPS - 1),
  cooldowns: range(0, 4),
  reasonLength: 64,
});

/** Whether `dirs` is a walk: 1 to MAX_WALK_STEPS direction digits, each from 0 to 7. */
function isWalk(dirs: string): boolean {
  if (dirs.length < 1 || dirs.length > MAX_WALK_STEPS) return false;
  for (const digit of dirs) if (digit < "0" || digit > "7") return false;
  return true;
}

/** Reports every problem of the cell at `value`: two integers inside the world. */
function checkCell(value: unknown, path: string, sink: IssueSink): void {
  const cell = readList(value, path, range(2, 2), sink);
  cell?.forEach((axis, index) => {
    readInt(axis, `${path}/${index}`, BEING_BOUNDS.cell, sink);
  });
}

/** Reports every problem of a walk's directions and arrivals. */
function checkWalk(walk: Fields, sink: IssueSink): void {
  walk.int("start", TICKS);
  const dirs = walk.value("dirs");
  const valid = typeof dirs === "string" && isWalk(dirs);
  if (!valid)
    sink.report(walk.at("dirs"), "a walk is 1 to 64 directions, each a digit from 0 to 7");
  const ms = readList(walk.value("ms"), walk.at("ms"), range(0, MAX_WALK_STEPS), sink);
  if (valid && ms !== undefined && ms.length !== dirs.length) {
    sink.report(
      walk.at("ms"),
      `a walk has one arrival per direction: ${dirs.length}, not ${ms.length}`,
    );
  }
  ms?.forEach((arrival, index) => {
    const at = `${walk.at("ms")}/${index}`;
    const previous = index > 0 ? ms[index - 1] : undefined;
    readInt(arrival, at, BEING_BOUNDS.arrivalMs, sink);
    if (typeof arrival === "number" && typeof previous === "number" && arrival <= previous) {
      sink.report(at, `arrivals rise strictly: ${arrival} must exceed ${previous}`);
    }
  });
  walk.int("done", range(0, (valid ? dirs.length : MAX_WALK_STEPS) - 1));
}

/** The members of each activity, by kind. */
export const ACTIVITY_MEMBERS = Object.freeze({
  eat: Object.freeze(["bites", "kind", "start", "untilNutrition"]),
  idle: Object.freeze(["kind", "ms", "start"]),
  sleep: Object.freeze(["forced", "kind", "untilRest"]),
  walk: Object.freeze(["dirs", "done", "kind", "ms", "start"]),
});

/** The members of each planned step, by kind. */
export const STEP_MEMBERS = Object.freeze({
  eat: Object.freeze(["kind", "untilNutrition"]),
  idle: Object.freeze(["kind", "ms"]),
  sleep: Object.freeze(["kind", "untilRest"]),
  walk: Object.freeze(["dirs", "kind"]),
});

/**
 * The kind of the record at `value`, if it is one of `kinds`; undefined after an issue. A canonical
 * record is plain data, so its `kind` is read as a data property.
 */
function kindIn<T extends string>(
  value: unknown,
  path: string,
  kinds: readonly T[],
  sink: IssueSink,
): T | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sink.report(path, `the value must be a record with a kind: ${kinds.join(", ")}`);
    return undefined;
  }
  const kind: unknown = (value as { readonly kind?: unknown }).kind;
  const found = kinds.find((candidate) => candidate === kind);
  if (found === undefined)
    sink.report(`${path}/kind`, `the kind must be one of ${kinds.join(", ")}`);
  return found;
}

/** Reports every problem of the activity at `value`, one of the kinds `kinds`. */
function checkActivity(
  value: unknown,
  path: string,
  kinds: readonly ActivityKind[],
  sink: IssueSink,
): void {
  if (value === undefined) return;
  const kind = kindIn(value, path, kinds, sink);
  const activity =
    kind === undefined
      ? undefined
      : readFields(value, path, { required: ACTIVITY_MEMBERS[kind] }, sink);
  if (activity === undefined) return;
  if (kind === "walk") {
    checkWalk(activity, sink);
    return;
  }
  if (kind === "sleep") {
    activity.int("untilRest", BEING_BOUNDS.level);
    activity.boolean("forced");
    return;
  }
  activity.int("start", TICKS);
  if (kind === "idle") activity.int("ms", BEING_BOUNDS.durationMs);
  if (kind === "eat") {
    activity.int("untilNutrition", BEING_BOUNDS.level);
    activity.int("bites", BEING_BOUNDS.bites);
  }
}

/** Reports every problem of one planned step at `value`, of one of the kinds `kinds`. */
export function checkPlanStep(
  value: unknown,
  path: string,
  sink: IssueSink,
  kinds: readonly ActivityKind[],
): void {
  const kind = kindIn(value, path, kinds, sink);
  const step =
    kind === undefined
      ? undefined
      : readFields(value, path, { required: STEP_MEMBERS[kind] }, sink);
  if (step === undefined) return;
  if (kind === "walk") {
    const dirs = step.value("dirs");
    if (typeof dirs !== "string" || !isWalk(dirs)) {
      sink.report(step.at("dirs"), "a walk is 1 to 64 directions, each a digit from 0 to 7");
    }
  }
  if (kind === "eat") step.int("untilNutrition", BEING_BOUNDS.level);
  if (kind === "sleep") step.int("untilRest", BEING_BOUNDS.level);
  if (kind === "idle") step.int("ms", BEING_BOUNDS.durationMs);
}

/** The members of wake conditions, each optional. */
export const WAKE_MEMBERS = Object.freeze({
  required: Object.freeze([] as string[]),
  optional: Object.freeze(["lightAbove", "lightBelow", "nutritionBelow", "restBelow"]),
});

/** The members of a brain's stored behavior, of a cooldown, and of a being's needs. */
export const BEHAVIOR_MEMBERS: readonly string[] = Object.freeze(["heading", "kind", "since"]);
export const COOLDOWN_MEMBERS: readonly string[] = Object.freeze(["cell", "until"]);
export const NEEDS_MEMBERS: readonly string[] = Object.freeze(["nutrition", "rest"]);

/** Reports every problem of wake conditions at `value`: each member optional. */
export function checkWakeConditions(value: unknown, path: string, sink: IssueSink): void {
  const wake = readFields(value, path, WAKE_MEMBERS, sink);
  wake?.int("nutritionBelow", BEING_BOUNDS.level);
  wake?.int("restBelow", BEING_BOUNDS.level);
  wake?.int("lightBelow", BEING_BOUNDS.light);
  wake?.int("lightAbove", BEING_BOUNDS.light);
}

/** Reports every problem of a brain's stored behavior at `value`. */
export function checkBehavior(value: unknown, path: string, sink: IssueSink): void {
  const behavior = readFields(value, path, { required: BEHAVIOR_MEMBERS }, sink);
  if (behavior === undefined) return;
  readId(behavior.value("kind"), behavior.at("kind"), sink);
  behavior.int("since", TICKS);
  behavior.int("heading", BEING_BOUNDS.heading);
}

/** The members of an outcome; under beings@2, a meal's also holds the optional `units`. */
export const OUTCOME_MEMBERS = Object.freeze({
  required: Object.freeze(["reason", "result", "tick"]),
  optional: Object.freeze(["units"]),
});

/** Reports every problem of an outcome at `value`; one of beings@2 may hold a meal's units. */
function checkOutcome(value: unknown, path: string, rules: BeingsRules, sink: IssueSink): void {
  const { required } = OUTCOME_MEMBERS;
  const optional = rules.minds ? OUTCOME_MEMBERS.optional : [];
  const outcome = readFields(value, path, { required, optional }, sink);
  if (outcome === undefined) return;
  outcome.choice("result", RESULTS);
  outcome.int("tick", TICKS);
  // Read only where it is a member: under beings@1, it is reported as unknown, and only that.
  if (rules.minds) outcome.int("units", BEING_BOUNDS.eaten);
  const reason = outcome.value("reason");
  if (typeof reason !== "string") {
    if (reason !== undefined) sink.report(outcome.at("reason"), "the reason must be a string");
  } else if (reason.length > BEING_BOUNDS.reasonLength) {
    sink.report(
      outcome.at("reason"),
      `a reason has at most ${BEING_BOUNDS.reasonLength} characters, not ${reason.length}`,
    );
  }
}

/** How a list is checked: how many entries it may have, and how each entry is checked. */
type ListCheck = {
  readonly count: { readonly min: number; readonly max: number };
  readonly entry: (entry: unknown, at: string, sink: IssueSink) => void;
};

/** Reports every problem of the list at `value`, each entry checked by `spec.entry`. */
function checkEach(value: unknown, path: string, spec: ListCheck, sink: IssueSink): void {
  readList(value, path, spec.count, sink)?.forEach((entry, index) => {
    spec.entry(entry, `${path}/${index}`, sink);
  });
}

/** Reports every problem of a cooldown at `value`. */
function checkCooldown(value: unknown, path: string, sink: IssueSink): void {
  const cooldown = readFields(value, path, { required: COOLDOWN_MEMBERS }, sink);
  if (cooldown === undefined) return;
  checkCell(cooldown.value("cell"), cooldown.at("cell"), sink);
  cooldown.int("until", TICKS);
}

/** Reports every problem of the cooldowns an intention adds at `value`: up to four, each bounded. */
export function checkCooldownRequests(value: unknown, path: string, sink: IssueSink): void {
  checkEach(value, path, { count: BEING_BOUNDS.cooldowns, entry: checkCooldownRequest }, sink);
}

/** Reports every problem of one cooldown an intention adds at `value`. */
function checkCooldownRequest(value: unknown, path: string, sink: IssueSink): void {
  const request = readFields(value, path, { required: ["cell", "ms"] }, sink);
  if (request === undefined) return;
  checkCell(request.value("cell"), request.at("cell"), sink);
  request.int("ms", BEING_BOUNDS.durationMs);
}

/** Reports every problem of a being's body: needs, health, the traits of `rules`, and condition. */
function checkBody(being: Fields, rules: BeingsRules, sink: IssueSink): void {
  const needs = readFields(
    being.value("needs"),
    being.at("needs"),
    { required: NEEDS_MEMBERS },
    sink,
  );
  needs?.int("nutrition", BEING_BOUNDS.level);
  needs?.int("rest", BEING_BOUNDS.level);
  being.int("health", BEING_BOUNDS.level);
  const names = rules.traitMembers;
  const traits = readFields(being.value("traits"), being.at("traits"), { required: names }, sink);
  for (const name of names) traits?.int(name, BEING_BOUNDS.trait);
  being.choice("condition", ["ok", "incapacitated"]);
}

/** Reports every problem of the being at `value` to `sink`, by the rules of its version. */
export function checkBeing(
  value: unknown,
  path: string,
  sink: IssueSink,
  rules: BeingsRules = BEINGS_RULES,
): void {
  const being = readFields(value, path, { required: rules.members }, sink);
  if (being === undefined) return;
  being.int("id", BEING_BOUNDS.id);
  readId(being.value("species"), being.at("species"), sink);
  being.choice("stage", STAGES);
  being.int("born", TICKS);
  checkCell(being.value("cell"), being.at("cell"), sink);
  checkBody(being, rules, sink);
  being.int("anchor", TICKS);
  checkActivity(being.value("activity"), being.at("activity"), rules.activities, sink);
  const step = (entry: unknown, at: string, inner: IssueSink) =>
    checkPlanStep(entry, at, inner, rules.activities);
  checkEach(being.value("plan"), being.at("plan"), { count: BEING_BOUNDS.plan, entry: step }, sink);
  checkBehavior(being.value("behavior"), being.at("behavior"), sink);
  checkWakeConditions(being.value("wakeWhen"), being.at("wakeWhen"), sink);
  being.int("wake", TICKS);
  checkOutcome(being.value("outcome"), being.at("outcome"), rules, sink);
  checkEach(
    being.value("cooldowns"),
    being.at("cooldowns"),
    { count: BEING_BOUNDS.cooldowns, entry: checkCooldown },
    sink,
  );
  if (rules.minds) checkMindValue(being.value("mind"), being.at("mind"), sink);
}

/**
 * Every problem of the being at `value` as a being of the ruleset `version`, at paths from `path`.
 * `value` is canonical, as a validator's value is; a host that holds an arbitrary value copies it
 * first with copyCanonical. Never throws for a canonical value.
 */
export function beingIssues(
  value: unknown,
  path: string,
  version: BeingsVersion = "beings@1",
): Issue[] {
  const issues = new IssueList();
  if (value === undefined) {
    issues.report(path, "the being is missing");
    return issues.issues;
  }
  checkBeing(value, path, issues, rulesOf(version));
  return issues.issues;
}
