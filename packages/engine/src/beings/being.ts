/**
 * A being (ADR 0023): its identity, cell, body, what it is doing, and what its brain stored, as it
 * lives in the chunk of its cell. What an observer inside the world could see is C0; the rest is C1
 * (docs/architecture/beings.md). The validator checks shapes and bounds; the laws a being follows
 * are checked where they apply, because a chunk's validator cannot see the global value.
 */
import type { IssueSink } from "../canonical/value.ts";
import { type Issue, IssueList } from "../errors.ts";
import type { Tick } from "../time/tick.ts";
import type { EntityId } from "../world/contracts.ts";
import { MAX_CELL, MIN_CELL } from "../worldgen/index.ts";
import { STAGES } from "./laws.ts";
import { NEED_MAX } from "./rates.ts";
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

/** How the last step ended, when, and why. */
export type Outcome = { readonly result: string; readonly tick: Tick; readonly reason: string };

/** A target the brain failed to reach, avoided until `until`. */
export type Cooldown = { readonly cell: Cell; readonly until: Tick };

/**
 * A cooldown a brain adds: the target and how long to avoid it, in simulated milliseconds. The
 * engine stamps the tick it ends at, because the brain does not sense the tick.
 */
export type CooldownRequest = { readonly cell: Cell; readonly ms: number };

export type Being = {
  readonly id: EntityId;
  readonly species: string;
  readonly stage: string;
  readonly born: Tick;
  readonly cell: Cell;
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly health: number;
  readonly anchor: Tick;
  readonly traits: {
    readonly appetite: number;
    readonly sleepiness: number;
    readonly curiosity: number;
  };
  readonly condition: "ok" | "incapacitated";
  readonly activity: Activity;
  readonly plan: readonly PlanStep[];
  readonly behavior: Behavior;
  readonly wakeWhen: WakeConditions;
  readonly wake: Tick;
  readonly outcome: Outcome;
  readonly cooldowns: readonly Cooldown[];
};

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
const ACTIVITY_MEMBERS = Object.freeze({
  eat: Object.freeze(["bites", "kind", "start", "untilNutrition"]),
  idle: Object.freeze(["kind", "ms", "start"]),
  sleep: Object.freeze(["forced", "kind", "untilRest"]),
  walk: Object.freeze(["dirs", "done", "kind", "ms", "start"]),
});
const ACTIVITY_KINDS = Object.freeze(["eat", "idle", "sleep", "walk"] as const);

/** The members of each planned step, by kind. */
const STEP_MEMBERS = Object.freeze({
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

/** Reports every problem of the activity at `value`. */
function checkActivity(value: unknown, path: string, sink: IssueSink): void {
  if (value === undefined) return;
  const kind = kindIn(value, path, ACTIVITY_KINDS, sink);
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

/** Reports every problem of one planned step at `value`. */
export function checkPlanStep(value: unknown, path: string, sink: IssueSink): void {
  const kind = kindIn(value, path, ACTIVITY_KINDS, sink);
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

/** Reports every problem of wake conditions at `value`: each member optional. */
export function checkWakeConditions(value: unknown, path: string, sink: IssueSink): void {
  const optional = ["lightAbove", "lightBelow", "nutritionBelow", "restBelow"];
  const wake = readFields(value, path, { required: [], optional }, sink);
  wake?.int("nutritionBelow", BEING_BOUNDS.level);
  wake?.int("restBelow", BEING_BOUNDS.level);
  wake?.int("lightBelow", BEING_BOUNDS.light);
  wake?.int("lightAbove", BEING_BOUNDS.light);
}

/** Reports every problem of a brain's stored behavior at `value`. */
export function checkBehavior(value: unknown, path: string, sink: IssueSink): void {
  const behavior = readFields(value, path, { required: ["heading", "kind", "since"] }, sink);
  if (behavior === undefined) return;
  readId(behavior.value("kind"), behavior.at("kind"), sink);
  behavior.int("since", TICKS);
  behavior.int("heading", BEING_BOUNDS.heading);
}

/** Reports every problem of an outcome at `value`. */
function checkOutcome(value: unknown, path: string, sink: IssueSink): void {
  const outcome = readFields(value, path, { required: ["reason", "result", "tick"] }, sink);
  if (outcome === undefined) return;
  outcome.choice("result", RESULTS);
  outcome.int("tick", TICKS);
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
  const cooldown = readFields(value, path, { required: ["cell", "until"] }, sink);
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

/** Reports every problem of a being's body: needs, health, traits, and condition. */
function checkBody(being: Fields, sink: IssueSink): void {
  const needs = readFields(
    being.value("needs"),
    being.at("needs"),
    { required: ["nutrition", "rest"] },
    sink,
  );
  needs?.int("nutrition", BEING_BOUNDS.level);
  needs?.int("rest", BEING_BOUNDS.level);
  being.int("health", BEING_BOUNDS.level);
  const traitNames = ["appetite", "curiosity", "sleepiness"];
  const traits = readFields(
    being.value("traits"),
    being.at("traits"),
    { required: traitNames },
    sink,
  );
  for (const name of traitNames) traits?.int(name, BEING_BOUNDS.trait);
  being.choice("condition", ["ok", "incapacitated"]);
}

const BEING_MEMBERS: readonly string[] = Object.freeze([
  "activity",
  "anchor",
  "behavior",
  "born",
  "cell",
  "condition",
  "cooldowns",
  "health",
  "id",
  "needs",
  "outcome",
  "plan",
  "species",
  "stage",
  "traits",
  "wake",
  "wakeWhen",
]);

/** Reports every problem of the being at `value` to `sink`. */
export function checkBeing(value: unknown, path: string, sink: IssueSink): void {
  const being = readFields(value, path, { required: BEING_MEMBERS }, sink);
  if (being === undefined) return;
  being.int("id", BEING_BOUNDS.id);
  readId(being.value("species"), being.at("species"), sink);
  being.choice("stage", STAGES);
  being.int("born", TICKS);
  checkCell(being.value("cell"), being.at("cell"), sink);
  checkBody(being, sink);
  being.int("anchor", TICKS);
  checkActivity(being.value("activity"), being.at("activity"), sink);
  checkEach(
    being.value("plan"),
    being.at("plan"),
    { count: BEING_BOUNDS.plan, entry: checkPlanStep },
    sink,
  );
  checkBehavior(being.value("behavior"), being.at("behavior"), sink);
  checkWakeConditions(being.value("wakeWhen"), being.at("wakeWhen"), sink);
  being.int("wake", TICKS);
  checkOutcome(being.value("outcome"), being.at("outcome"), sink);
  checkEach(
    being.value("cooldowns"),
    being.at("cooldowns"),
    { count: BEING_BOUNDS.cooldowns, entry: checkCooldown },
    sink,
  );
}

/**
 * Every problem of the being at `value`, at paths from `path`. `value` is canonical, as a
 * validator's value is; a host that holds an arbitrary value copies it first with copyCanonical.
 * Never throws for a canonical value.
 */
export function beingIssues(value: unknown, path: string): Issue[] {
  const issues = new IssueList();
  if (value === undefined) {
    issues.report(path, "the being is missing");
    return issues.issues;
  }
  checkBeing(value, path, issues);
  return issues.issues;
}
