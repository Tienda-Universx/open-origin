/**
 * Capturing a ruleset (ADR 0020, kernel and ruleset; plan §2.2). captureRuleset validates the
 * ruleset the host gives and copies it into structures of the kernel's own: lists and records are
 * copied, functions are kept as references, so changing the ruleset afterwards changes nothing.
 * Command types are enumerated in canonical order, never in insertion order.
 */
import type { CanonicalValue, IssueSink } from "../canonical/value.ts";
import { pointer, validateCanonical } from "../canonical/value.ts";
import { EngineError, IssueList } from "../errors.ts";
import { streamId } from "../rng/mix32.ts";
import type { ChunkKey } from "./chunk.ts";
import type { Command, DeepReadonly, ReadView, RulesetVersions, TickContext } from "./contracts.ts";
import { expectRecord, isRecord, readElements, readKeys, readMember, UNREAD } from "./members.ts";

type Value = CanonicalValue;

/** Stream ids by declared name, in a record without a prototype. */
type StreamIds = { readonly [name: string]: number };

/** A system as the kernel keeps it. Its results are checked where it is called. */
type CapturedSystem = {
  readonly name: string;
  readonly streams: StreamIds;
  readonly run: (ctx: TickContext<Value, Value>) => unknown;
};

/** A command handler as the kernel keeps it. */
type CapturedCommand = {
  readonly type: string;
  readonly streams: StreamIds;
  readonly check: (view: ReadView<Value, Value>, command: Command) => unknown;
  readonly apply: (ctx: TickContext<Value, Value>, command: Command) => unknown;
};

/** A validated ruleset, in structures that only the kernel holds. */
export type CapturedRuleset = {
  readonly versions: RulesetVersions;
  /** The systems, in the order the ruleset declares them, which is the order they run in. */
  readonly systems: readonly CapturedSystem[];
  /** The handlers by command type, in a record without a prototype. */
  readonly commands: { readonly [type: string]: CapturedCommand };
  /** The command types, sorted by UTF-16 code units. */
  readonly commandTypes: readonly string[];
  readonly validateGlobal: (value: DeepReadonly<Value>) => unknown;
  readonly validateChunk: (key: ChunkKey, value: DeepReadonly<Value>) => unknown;
};

/** The streams declared so far, so each has one owner and one id. */
type Claims = {
  readonly issues: IssueList;
  /** The owner of each stream, by name, such as `system "growth"`. */
  readonly owners: { [name: string]: string };
  /** The name of each stream, by id. */
  readonly names: { [id: number]: string };
};

/** A system or a command handler, and the stream ids it has claimed. */
type Owner = { readonly label: string; readonly ids: { [name: string]: number } };

const VERSION_NAMES: readonly (keyof RulesetVersions)[] = ["brain", "generator", "ruleset"];

/**
 * `value` if it is a non-empty canonical string; otherwise undefined, after an issue at `path`
 * unless readMember already reported it.
 */
function readText(value: unknown, path: string, what: string, sink: IssueSink): string | undefined {
  if (value === UNREAD) return undefined;
  if (typeof value !== "string") {
    sink.report(path, `${what} must be a string, not ${typeof value}`);
    return undefined;
  }
  if (value === "") {
    sink.report(path, `${what} must not be empty`);
    return undefined;
  }
  const problems = validateCanonical(value);
  for (const problem of problems) sink.report(`${path}${problem.path}`, problem.message);
  return problems.length === 0 ? value : undefined;
}

/** `name` unless it starts with the prefix the kernel keeps for itself (ADR 0020). */
function unreserved(name: string, path: string, what: string, sink: IssueSink): string | undefined {
  if (!name.startsWith("engine.")) return name;
  sink.report(path, `${what} starts with "engine.", which is reserved for the kernel`);
  return undefined;
}

/**
 * The function `key` of `object`, kept as a reference. After an issue at its path the capture
 * throws, so a value that is not a function never leaves this module.
 */
function readFunction<F>(object: object, key: string, path: string, sink: IssueSink): F {
  const at = `${path}/${key}`;
  const value = readMember(object, key, at, sink);
  if (value !== UNREAD && typeof value !== "function") {
    sink.report(at, `${key} must be a function, not ${typeof value}`);
  }
  // typeof proved a function; the kernel checks what it returns wherever it calls it.
  return value as F;
}

function readVersions(ruleset: object, issues: IssueList): RulesetVersions {
  const value = readMember(ruleset, "versions", "/versions", issues);
  const found: { [name: string]: string } = Object.create(null);
  if (!expectRecord(value, "/versions", "the versions must be a record of strings", issues)) {
    return { ruleset: "", generator: "", brain: "" };
  }
  const keys = readKeys(value, "/versions", issues);
  for (const key of keys) {
    const path = `/versions${pointer([key])}`;
    if (!VERSION_NAMES.some((name) => name === key)) {
      issues.report(path, "not a version: the versions are ruleset, generator, and brain");
      continue;
    }
    const text = readText(readMember(value, key, path, issues), path, "the version", issues);
    if (text !== undefined) found[key] = text;
  }
  for (const name of VERSION_NAMES) {
    if (!keys.includes(name)) issues.report(`/versions/${name}`, "the version is missing");
  }
  return {
    ruleset: found.ruleset ?? "",
    generator: found.generator ?? "",
    brain: found.brain ?? "",
  };
}

/** Gives the stream `name` to `owner`, unless it already has an owner or its id is taken. */
function claim(name: string, path: string, owner: Owner, claims: Claims): void {
  const previous = claims.owners[name];
  if (previous === owner.label) {
    claims.issues.report(path, `${owner.label} declares the stream "${name}" twice`);
    return;
  }
  if (previous !== undefined) {
    const message = `the stream "${name}" already belongs to ${previous}: a stream has one owner`;
    claims.issues.report(path, message);
    return;
  }
  const id = streamId(name);
  const other = claims.names[id];
  if (other !== undefined) {
    const message = `the stream "${name}" has the id ${id} of the stream "${other}": rename one`;
    claims.issues.report(path, message);
    return;
  }
  claims.owners[name] = owner.label;
  claims.names[id] = name;
  owner.ids[name] = id;
}

function readStreams(value: unknown, path: string, owner: Owner, claims: Claims): void {
  const { issues } = claims;
  const notArray = "the streams must be an array of names";
  const elements = readElements(value, path, notArray, issues) ?? [];
  elements.forEach((element, index) => {
    const at = `${path}/${index}`;
    const text = readText(element, at, "the stream name", issues);
    const name = text === undefined ? undefined : unreserved(text, at, "the stream name", issues);
    if (name !== undefined) claim(name, at, owner, claims);
  });
}

function readSystem(
  value: unknown,
  path: string,
  claims: Claims,
  names: { [name: string]: true },
): CapturedSystem | undefined {
  const { issues } = claims;
  if (!expectRecord(value, path, "a system must be a record", issues)) return undefined;
  const at = `${path}/name`;
  const name = readText(readMember(value, "name", at, issues), at, "the system name", issues);
  if (name !== undefined && Object.hasOwn(names, name)) {
    issues.report(at, `the system "${name}" is declared twice: system names must be unique`);
  } else if (name !== undefined) names[name] = true;
  const label = name === undefined ? `the system at ${path}` : `system "${name}"`;
  const owner: Owner = { label, ids: Object.create(null) };
  readStreams(
    readMember(value, "streams", `${path}/streams`, issues),
    `${path}/streams`,
    owner,
    claims,
  );
  const run = readFunction<CapturedSystem["run"]>(value, "run", path, issues);
  return { name: name ?? "", streams: owner.ids, run };
}

function readSystems(ruleset: object, claims: Claims): CapturedSystem[] {
  const { issues } = claims;
  const value = readMember(ruleset, "systems", "/systems", issues);
  const elements = readElements(value, "/systems", "the systems must be an array", issues) ?? [];
  const names: { [name: string]: true } = Object.create(null);
  const systems: CapturedSystem[] = [];
  elements.forEach((element, index) => {
    const system = readSystem(element, `/systems/${index}`, claims, names);
    if (system !== undefined) systems.push(system);
  });
  return systems;
}

function readHandler(
  value: unknown,
  path: string,
  type: string,
  claims: Claims,
): CapturedCommand | undefined {
  const { issues } = claims;
  if (!expectRecord(value, path, "a command handler must be a record", issues)) return undefined;
  const owner: Owner = { label: `command "${type}"`, ids: Object.create(null) };
  const streams = readMember(value, "streams", `${path}/streams`, issues);
  if (streams !== undefined) readStreams(streams, `${path}/streams`, owner, claims);
  const check = readFunction<CapturedCommand["check"]>(value, "check", path, issues);
  const apply = readFunction<CapturedCommand["apply"]>(value, "apply", path, issues);
  return { type, streams: owner.ids, check, apply };
}

function readCommands(
  ruleset: object,
  claims: Claims,
): Pick<CapturedRuleset, "commands" | "commandTypes"> {
  const { issues } = claims;
  const commands: { [type: string]: CapturedCommand } = Object.create(null);
  const commandTypes: string[] = [];
  const value = readMember(ruleset, "commands", "/commands", issues);
  if (!expectRecord(value, "/commands", "the commands must be a record of handlers", issues)) {
    return { commands, commandTypes };
  }
  for (const key of readKeys(value, "/commands", issues)) {
    const path = `/commands${pointer([key])}`;
    const handlerValue = readMember(value, key, path, issues);
    const text = readText(key, path, "the command type", issues);
    const type =
      text === undefined ? undefined : unreserved(text, path, "the command type", issues);
    const handler = readHandler(handlerValue, path, key, claims);
    if (type !== undefined && handler !== undefined) {
      commands[type] = handler;
      commandTypes.push(type);
    }
  }
  return { commands, commandTypes };
}

/**
 * The ruleset `ruleset`, validated and copied. Reports every problem at once, with its path into
 * the ruleset, as EngineError("invalid_ruleset"):
 *
 * - the versions are ruleset, generator, and brain, each a non-empty canonical string;
 * - system names are non-empty canonical strings, unique, and `run` is a function;
 * - command types are non-empty canonical strings without the prefix "engine.", and `check` and
 *   `apply` are functions;
 * - stream names are non-empty canonical strings without the prefix "engine.", each declared by
 *   exactly one system or command, and no two have the same streamId;
 * - validateGlobal and validateChunk are functions.
 *
 * Each member is read once, through its own descriptor, and accessors are rejected.
 */
export function captureRuleset(ruleset: unknown): CapturedRuleset {
  if (!isRecord(ruleset)) {
    throw new EngineError("invalid_ruleset", [
      { path: "", message: "the ruleset must be a record" },
    ]);
  }
  const source: object = ruleset;
  const issues = new IssueList();
  const claims: Claims = { issues, owners: Object.create(null), names: Object.create(null) };
  const captured: CapturedRuleset = {
    versions: readVersions(source, issues),
    systems: readSystems(source, claims),
    ...readCommands(source, claims),
    validateGlobal: readFunction<CapturedRuleset["validateGlobal"]>(
      source,
      "validateGlobal",
      "",
      issues,
    ),
    validateChunk: readFunction<CapturedRuleset["validateChunk"]>(
      source,
      "validateChunk",
      "",
      issues,
    ),
  };
  issues.throwIfAny("invalid_ruleset");
  return captured;
}
