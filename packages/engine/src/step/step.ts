/**
 * step (ADR 0020; plan §2.1, §2.3): advances, in place, the world it owns by one tick.
 *
 * 1. Guards: the world's brand; then a step already running on it (world_busy), which only
 *    ruleset code or a host Proxy among the commands can start, and which during a tick also
 *    faults that tick; then its health (world_faulted).
 * 2. Every command is validated and copied (step/commands.ts), with the world marked busy, so
 *    that a Proxy among the commands cannot use it. An invalid list throws invalid_input with
 *    every problem and changes nothing.
 * 3. The tick advances. Commands run in seq order: an unknown type, or a `check` that returns a
 *    rejection, emits engine.command_rejected; otherwise `apply` runs. Then the systems run, in
 *    the ruleset's order. Handlers and systems must return undefined.
 * 4. The commit hashes what changed and validates it (step/commit.ts); with audit, every digest
 *    is recomputed and compared.
 *
 * Anything that fails after step 2 poisons the world: its events are discarded, step throws the
 * fault, and only worldStatus still answers.
 */
import { copyCanonical, copyCanonicalReported } from "../canonical/copy.ts";
import { sortedOwnKeys } from "../canonical/order.ts";
import { type CanonicalValue, describeThrown } from "../canonical/value.ts";
import { describeValue, EngineError, IssueList } from "../errors.ts";
import { nextTick } from "../time/tick.ts";
import type { Command, CommandOrigin, Rejection, StepResult } from "../world/contracts.ts";
import { isRecord } from "../world/members.ts";
import type { StreamIds } from "../world/ruleset.ts";
import {
  type ActiveStep,
  busyError,
  healthyState,
  poison,
  type World,
  type WorldState,
} from "../world/world.ts";
import { readCommands } from "./commands.ts";
import { audit, commit } from "./commit.ts";
import { openTick, type TickHandles } from "./context.ts";
import { type Owner, TickSession } from "./session.ts";

/** The type of the event the kernel emits for each rejected command. */
const REJECTED_EVENT = "engine.command_rejected";

/** The reason of the rejection of a command whose type has no handler. */
const UNKNOWN_TYPE = "unknown_type";

/** Marks a world whose step is reading its commands: any use of the world meanwhile is refused. */
const READING: ActiveStep = { refuse: busyError };
const NOT_REJECTION =
  "returned a value that is not undefined or a rejection { reason, details? }, reason a non-empty string";

/** The streams of a command type without a handler: none. */
const NO_STREAMS: StreamIds = Object.freeze(Object.create(null));

/** What a rejection event says about its command, taken before any ruleset code sees it. */
type CommandFacts = {
  readonly seq: number;
  readonly type: string;
  readonly origin: CommandOrigin;
};

function factsOf({ seq, type, origin }: Command): CommandFacts {
  const copy: CommandOrigin =
    origin.kind === "admin" ? { kind: "admin" } : { kind: "inhabitant", actor: origin.actor };
  return { seq, type, origin: copy };
}

/** Runs the ruleset function `what`; a throw, or a fault it caught, is the tick's fault. */
function invoke(session: TickSession, what: string, call: () => unknown): unknown {
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    throw session.fail(`${what} threw: ${describeThrown(error)}`, error);
  }
  if (session.fault !== undefined) throw session.fault;
  return result;
}

function expectUndefined(session: TickSession, what: string, result: unknown): void {
  if (result === undefined) return;
  const message = `${what} returned ${describeValue(result)}: systems and handlers must return undefined`;
  throw session.fail(message);
}

/** The rejection `verdict`, copied, or undefined when `check` accepted; a fault otherwise. */
function readRejection(session: TickSession, verdict: unknown): Rejection | undefined {
  if (verdict === undefined) return undefined;
  const issues = new IssueList();
  const copy = copyCanonicalReported(verdict, issues);
  if (issues.count === 0 && isRecord(copy)) {
    // A canonical copy: a plain record of canonical values.
    const { reason, details } = copy as { readonly [key: string]: CanonicalValue };
    const keys = sortedOwnKeys(copy).join();
    const shaped = keys === "reason" || keys === "details,reason";
    if (shaped && typeof reason === "string" && reason !== "") {
      return details === undefined ? { reason } : { reason, details };
    }
  }
  throw session.fail(`check ${NOT_REJECTION}`);
}

/** Records the rejection of `command` and emits its engine.command_rejected event. */
function reject(session: TickSession, command: Command, facts: CommandFacts, rejection: Rejection) {
  session.rejected.push({ command, rejection });
  const { reason, details } = rejection;
  const payload =
    details === undefined
      ? { ...facts, reason }
      : { ...facts, reason, details: copyCanonical(details) };
  const { events } = session;
  const cause = { kind: "command", seq: facts.seq } as const;
  events.push({ tick: session.tick, seq: events.length, type: REJECTED_EVENT, payload, cause });
}

function commandOwner(command: Command, index: number, streams: StreamIds): Owner {
  const { seq, type } = command;
  return {
    path: `/commands/${index}`,
    label: `command ${seq} ("${type}")`,
    cause: { kind: "command", seq },
    streams,
  };
}

function runCommand(session: TickSession, handles: TickHandles, command: Command, index: number) {
  const { commands } = session.state.ruleset;
  const handler = Object.hasOwn(commands, command.type) ? commands[command.type] : undefined;
  session.owner = commandOwner(command, index, handler?.streams ?? NO_STREAMS);
  const facts = factsOf(command);
  if (handler === undefined) {
    reject(session, command, facts, { reason: UNKNOWN_TYPE });
    return;
  }
  // Called without a receiver, so ruleset code cannot reach the captured ruleset through `this`.
  const { check, apply } = handler;
  const verdict = invoke(session, "check", () => check(handles.view, command));
  const rejection = readRejection(session, verdict);
  if (rejection !== undefined) {
    reject(session, command, facts, rejection);
    return;
  }
  expectUndefined(
    session,
    "apply",
    invoke(session, "apply", () => apply(handles.ctx, command)),
  );
}

function runSystems(session: TickSession, { ctx }: TickHandles): void {
  session.state.ruleset.systems.forEach(({ name, streams, run }, index) => {
    const cause = { kind: "system", name } as const;
    session.owner = { path: `/systems/${index}`, label: `system "${name}"`, cause, streams };
    expectUndefined(
      session,
      "run",
      invoke(session, "run", () => run(ctx)),
    );
  });
}

/** Runs the tick of `session` and commits it. */
function computeTick(session: TickSession, commands: readonly Command[]): StepResult {
  const handles = openTick(session);
  commands.forEach((command, index) => {
    runCommand(session, handles, command, index);
  });
  runSystems(session, handles);
  session.owner = undefined;
  const { checksum, changedChunks, hashedBytes } = commit(session);
  if (session.state.audit) audit(session);
  const { tick, events, rejected, dirtyKeys, createdKeys } = session;
  const stats = {
    commands: commands.length,
    rejected: rejected.length,
    events: events.length,
    dirtyChunks: dirtyKeys.length,
    createdChunks: createdKeys.length,
    hashedBytes,
  };
  return { tick, checksum, events, changedChunks, stats };
}

/** What a failure becomes when it is not the tick's recorded fault: the kernel's own error. */
function asFault(error: unknown): EngineError {
  if (EngineError.isEngineError(error)) return error;
  const message = `the tick failed: ${describeThrown(error)}`;
  return new EngineError("system_fault", [{ path: "", message }], { cause: error });
}

/** Advances `state` by one tick with `commands`, which are valid; poisons it on any failure. */
function advance(state: WorldState, commands: readonly Command[]): StepResult {
  let session: TickSession | undefined;
  try {
    state.kernel.tick = nextTick(state.kernel.tick);
    session = new TickSession(state);
    state.active = session;
    return computeTick(session, commands);
  } catch (error) {
    const fault = session?.fault ?? asFault(error);
    poison(state, fault);
    throw fault;
  } finally {
    session?.expire();
  }
}

/**
 * Throws when the world is not where it was before step read the commands. Nothing can change
 * it meanwhile, since every use of the world is refused, so this only guards that rule.
 */
function expectUnchanged(state: WorldState, tick: number): void {
  if (state.status.kind === "ok" && state.kernel.tick === tick) return;
  const message = "the world changed while step read its commands: nothing may use it meanwhile";
  throw new EngineError("world_busy", [{ path: "", message }]);
}

/**
 * Advances `world` by one tick, applying `commands` (ADR 0020; plan §4), and returns what the tick
 * did, in fresh values the world keeps no reference to.
 *
 * Throws, and changes nothing: EngineError("invalid_input") when `world` is not a world or a
 * command is invalid (step/commands.ts); EngineError("world_busy") when a step already runs on the
 * world; EngineError("world_faulted") when an earlier tick failed.
 * Throws after poisoning the world: system_fault for ruleset code that throws, returns a value,
 * or misuses the tick context, and for data that is not canonical or that the ruleset's validators
 * reject; id_exhausted and tick_overflow when the ids or the ticks run out; integrity_violation
 * when audit finds a write that bypassed the barrier. Each fault's issues name the command
 * (`/commands/<index>`), the system (`/systems/<index>`), or the data (`/chunks/<key>/...`,
 * `/global/...`) at fault, and its cause is what the ruleset threw.
 */
export function step<G extends CanonicalValue, C extends CanonicalValue>(
  world: World<G, C>,
  commands: readonly Command[],
): StepResult {
  const state = healthyState(world, "step");
  const { tick } = state.kernel;
  // Busy from the first read of a command, so that a host Proxy cannot use the world meanwhile.
  state.active = READING;
  try {
    const accepted = readCommands(commands, tick + 1);
    expectUnchanged(state, tick);
    return advance(state, accepted);
  } finally {
    state.active = undefined;
  }
}
