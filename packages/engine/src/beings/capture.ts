/**
 * The capture of the brains of a ruleset (ADR 0023, ADR 0024): the host gives one brain per
 * species, and the ruleset reads each once, when it is made, so that none can change later. Each
 * member is read through its own descriptor (world/members.ts), and every problem of every brain
 * is reported at once with invalid_ruleset. A brain of beings@1 is called on itself, as in T4. A
 * brain of beings@2 also declares its behaviors and the namespace of its concepts; it is called
 * without `this`, and a result that is not a plain record is a code error that poisons the world.
 */
import { EngineError, IssueList } from "../errors.ts";
import { copyAt, readMember, readRecordKeys, UNREAD } from "../world/members.ts";
import type { BeingsRules } from "./rules.ts";
import { range, readId, readList } from "./schema.ts";

/**
 * A brain as the ruleset captured it: its version, the behaviors a brain of beings@2 declared,
 * and its decision, which returns what the brain proposed, for the engine to judge.
 */
export type Brain = {
  readonly brain: string;
  readonly behaviors: readonly string[] | undefined;
  readonly decide: (senses: object) => unknown;
};

/** The brains of a ruleset, by species id, captured when the ruleset was made. */
export type Controllers = { readonly [species: string]: Brain };

/** What a brain of beings@2 declares besides its version and its decision. */
type Declared = { readonly behaviors: readonly string[]; readonly concepts: string };

/** The behaviors a brain of beings@2 may declare: 1 to 16 identifiers. */
const BEHAVIORS = range(1, 16);

/**
 * The longest namespace of concepts: a concept id has at most 48 characters, and holds its
 * namespace, a dot, and at least one more character.
 */
const NAMESPACE_LENGTH = 46;

/** The brain of one species, read once: its version, its decide function, and what it declares. */
function captureOne(
  controller: unknown,
  path: string,
  rules: BeingsRules,
  issues: IssueList,
): Brain | undefined {
  // A member readMember could not read was already reported there.
  if (controller === UNREAD) return undefined;
  if (typeof controller !== "object" || controller === null) {
    issues.report(path, "a brain must be an object with a brain version and a decide function");
    return undefined;
  }
  const brain = readVersion(readMember(controller, "brain", `${path}/brain`, issues), path, issues);
  const decide = readDecide(controller, path, issues);
  const declared = rules.minds ? readDeclared(controller, path, issues) : undefined;
  if (brain === undefined || decide === undefined) return undefined;
  if (rules.minds)
    return declared === undefined ? undefined : mindful(brain, decide, declared, path);
  return Object.freeze({
    brain,
    behaviors: undefined,
    decide: (senses: object) => decide.call(controller, senses),
  });
}

/** A brain's decide function, as the host gave it: it takes the senses, and returns anything. */
type Decide = (this: unknown, senses: object) => unknown;

/**
 * The decide function of the brain at `path`, if it is an ordinary function; undefined otherwise.
 */
function readDecide(controller: object, path: string, issues: IssueList): Decide | undefined {
  const decide = readMember(controller, "decide", `${path}/decide`, issues);
  if (decide !== UNREAD && typeof decide !== "function")
    issues.report(`${path}/decide`, "a brain must have a decide function");
  if (typeof decide !== "function") return undefined;
  // A function of the host's: the engine passes it the senses and judges whatever it returns.
  return isOrdinary(decide, `${path}/decide`, issues) ? (decide as Decide) : undefined;
}

/**
 * The brain of beings@2 whose version is `brain`: `decide` is called as a plain function, so that
 * it receives no `this`, and its result must be a plain record.
 */
function mindful(brain: string, decide: Decide, declared: Declared, path: string): Brain {
  return Object.freeze({
    brain,
    behaviors: declared.behaviors,
    decide: (senses: object) => {
      // A plain call passes no receiver, so the brain cannot reach its controller through `this`.
      const result = decide(senses);
      if (isPlainRecord(result) === false) throw notPlain(path, result);
      return result;
    },
  });
}

/**
 * Whether `value` is a plain record, whose prototype is Object.prototype or null; undefined when
 * it cannot be inspected, as a revoked Proxy, which the canonical copy then refuses as malformed.
 */
function isPlainRecord(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    // A revoked Proxy, or a trap that threw: not a code error of the brain's own result type.
    return undefined;
  }
}

/** The code error of a brain at `path` that returned `result`, which is not a plain record. */
function notPlain(path: string, result: unknown): EngineError {
  const species = path.slice(path.lastIndexOf("/") + 1);
  const kind = typeof result === "object" && result !== null ? "an object" : typeof result;
  return new EngineError("system_fault", [
    {
      path: `${path}/decide`,
      message: `the brain of the species ${species} returned a value that is not a plain record (${kind}), such as a promise: a code error, not an intention (ADR 0024)`,
    },
  ]);
}

/** What the brain at `path` declares besides its version; undefined after an issue. */
function readDeclared(controller: object, path: string, issues: IssueList): Declared | undefined {
  const behaviors = readBehaviors(
    readMember(controller, "behaviors", `${path}/behaviors`, issues),
    path,
    issues,
  );
  const concepts = readConcepts(
    readMember(controller, "concepts", `${path}/concepts`, issues),
    path,
    issues,
  );
  return behaviors === undefined || concepts === undefined ? undefined : { behaviors, concepts };
}

/** The behaviors the brain at `path` declared, copied and frozen; undefined after an issue. */
function readBehaviors(
  value: unknown,
  path: string,
  issues: IssueList,
): readonly string[] | undefined {
  const at = `${path}/behaviors`;
  if (value === UNREAD) return undefined;
  if (value === undefined) {
    issues.report(at, "a brain of beings@2 declares its behaviors: 1 to 16 identifiers");
    return undefined;
  }
  const before = issues.count;
  const list = readList(copyAt(value, at, issues), at, BEHAVIORS, issues);
  const ids = (list ?? []).map((id, index) => readId(id, `${at}/${index}`, issues));
  ids.forEach((id, index) => {
    if (id !== undefined && ids.indexOf(id) < index)
      issues.report(`${at}/${index}`, `"${id}" is declared twice: each behavior is declared once`);
  });
  if (list === undefined || issues.count > before) return undefined;
  // Every entry is an identifier, since none was reported.
  return Object.freeze(ids as string[]);
}

/** The namespace of the concepts of the brain at `path`; undefined after an issue. */
function readConcepts(value: unknown, path: string, issues: IssueList): string | undefined {
  const at = `${path}/concepts`;
  if (value === UNREAD) return undefined;
  if (value === undefined) {
    issues.report(at, "a brain of beings@2 declares the namespace of its concepts");
    return undefined;
  }
  if (
    typeof value === "string" &&
    value.length <= NAMESPACE_LENGTH &&
    /^[a-z][a-z0-9]*$/.test(value)
  )
    return value;
  issues.report(
    at,
    `a namespace of concepts is a lowercase letter, then lowercase letters and digits, at most ${NAMESPACE_LENGTH} characters: the first segment of a concept id`,
  );
  return undefined;
}

/**
 * Whether `decide` is an ordinary function, whose prototype is that of every function declared in
 * this module; an async function or a generator, whose prototypes differ, returns a promise or an
 * iterator, never an intention (tracker L53). An issue at `path` otherwise. Under beings@1, a sync
 * function that returns a promise is still a malformed intention when it decides, and a promise it
 * leaves rejected is the host's to handle: the engine may not name `Promise`.
 */
function isOrdinary(decide: unknown, path: string, issues: IssueList): boolean {
  try {
    if (Object.getPrototypeOf(decide) === Object.getPrototypeOf(readVersion)) return true;
  } catch (error) {
    issues.report(path, "the decide function threw while being inspected", error);
    return false;
  }
  issues.report(
    path,
    "a brain's decide must be an ordinary function: an async function or a generator returns a promise or an iterator, never an intention",
  );
  return false;
}

/** `value` as the version of the brain at `path`; undefined after an issue, or when unread. */
function readVersion(value: unknown, path: string, issues: IssueList): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== UNREAD)
    issues.report(`${path}/brain`, "a brain's version must be a non-empty string");
  return undefined;
}

/**
 * A frozen copy of the brains by species, each read once by the rules of its version; throws
 * invalid_ruleset with every problem.
 */
export function captureControllers(value: unknown, rules: BeingsRules): Controllers {
  const issues = new IssueList();
  const captured: { [species: string]: Brain } = Object.create(null);
  const read = readRecordKeys(
    value,
    "/controllers",
    "the brains must be a plain record by species id",
    issues,
  );
  for (const species of read?.keys ?? []) {
    const path = `/controllers/${species}`;
    readId(species, path, issues);
    const controller = captureOne(
      readMember(read?.record ?? {}, species, path, issues),
      path,
      rules,
      issues,
    );
    if (controller !== undefined) captured[species] = controller;
  }
  if (read !== undefined && read.keys.length === 0)
    issues.report("/controllers", "the ruleset needs a brain for at least one species");
  issues.throwIfAny("invalid_ruleset");
  return Object.freeze(captured);
}

/** The ruleset's brain version: each species and its brain, in the order of species ids. */
export function brainVersion(controllers: Controllers, species: readonly string[]): string {
  return species.map((id) => `${id}:${(controllers[id] as Brain).brain}`).join(",");
}
