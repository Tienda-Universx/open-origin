/**
 * Propositions `prop@1` (ADR 0024): what a belief or a message claims, `{ p, a, v?, neg? }`: a
 * concept id, one or two terms, an optional integer value, and `neg: true` for its negation. The
 * engine checks their structure, never their meaning (docs/architecture/mind.md, "Propositions").
 * Values reach this module already copied canonically by the beings layer, so they hold only plain
 * records, arrays, safe integers, booleans, and strings.
 */
import { canonicalize } from "../canonical/encode.ts";
import { sortedOwnKeys } from "../canonical/order.ts";
import { utf8Length } from "../canonical/utf8.ts";
import { type IssueSink, pointer } from "../canonical/value.ts";
import { type IntRange, MIND_BOUNDS, within } from "./bounds.ts";

/** The version of the propositions: their structure and bounds. */
export const PROP_VERSION = "prop@1";

/** A term: an entity, a cell, or an integer. */
export type Term =
  | { readonly e: number }
  | { readonly c: readonly [number, number] }
  | { readonly n: number };

export type Proposition = {
  readonly p: string;
  readonly a: readonly [Term] | readonly [Term, Term];
  readonly v?: number;
  readonly neg?: true;
};

/** The bounds of a proposition: its canonical text, its concept id, and its terms. */
export const PROP_BOUNDS = Object.freeze({ bytes: 96, concept: 48, terms: 2 });

/** A proposition's members, in canonical order. */
const MEMBERS: readonly string[] = Object.freeze(["a", "neg", "p", "v"]);
const REQUIRED: readonly string[] = Object.freeze(["a", "p"]);

type Members = { readonly [key: string]: unknown };

/** Whether `value` is a record: an object that is neither null nor an array. */
function isRecord(value: unknown): value is Members {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `id` is a concept id: a namespace and at least one more segment, as
 * `^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$`, with at most 48 characters.
 */
export function isConceptId(id: string): boolean {
  return id.length <= PROP_BOUNDS.concept && /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/.test(id);
}

/** Reports `value` at `path` unless it is a safe integer within `bounds`. */
function checkInt(value: unknown, path: string, bounds: IntRange, sink: IssueSink): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && within(value, bounds)) return;
  sink.report(path, `must be an integer from ${bounds.min} to ${bounds.max}`);
}

/** Reports a cell that is not two coordinates within the world. */
function checkCell(value: unknown, path: string, sink: IssueSink): void {
  if (!Array.isArray(value) || value.length !== 2) {
    sink.report(path, "a cell is a list of two coordinates, [x, y]");
    return;
  }
  value.forEach((axis: unknown, index) => {
    checkInt(axis, `${path}/${index}`, MIND_BOUNDS.cell, sink);
  });
}

/** Reports a term that is not `{ e }`, `{ c }`, or `{ n }` with a valid content. */
function checkTerm(value: unknown, path: string, sink: IssueSink): void {
  const keys = isRecord(value) ? sortedOwnKeys(value) : [];
  const [kind] = keys;
  if (!isRecord(value) || keys.length !== 1 || (kind !== "e" && kind !== "c" && kind !== "n")) {
    sink.report(
      path,
      "a term is a record with one member: e (an entity), c (a cell), or n (an integer)",
    );
    return;
  }
  if (kind === "e") checkInt(value.e, `${path}/e`, MIND_BOUNDS.entity, sink);
  else if (kind === "c") checkCell(value.c, `${path}/c`, sink);
  else checkInt(value.n, `${path}/n`, MIND_BOUNDS.integer, sink);
}

/** Reports terms that are not a list of one or two valid terms. */
function checkTerms(value: unknown, path: string, sink: IssueSink): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROP_BOUNDS.terms) {
    sink.report(path, `the terms are a list of 1 to ${PROP_BOUNDS.terms} terms`);
    return;
  }
  value.forEach((term: unknown, index) => {
    checkTerm(term, `${path}/${index}`, sink);
  });
}

/** Reports each unknown member, then each missing one. */
function checkNames(keys: readonly string[], path: string, sink: IssueSink): void {
  for (const key of keys) {
    if (!MEMBERS.includes(key)) {
      sink.report(`${path}${pointer([key])}`, "unknown member: a proposition has p, a, v, and neg");
    }
  }
  for (const name of REQUIRED) {
    if (!keys.includes(name)) sink.report(`${path}/${name}`, "the member is missing");
  }
}

/** Reports every problem of the members of the record `value`. */
function checkMembers(value: Members, path: string, sink: IssueSink): void {
  const keys = sortedOwnKeys(value);
  checkNames(keys, path, sink);
  if (keys.includes("p") && !(typeof value.p === "string" && isConceptId(value.p))) {
    sink.report(
      `${path}/p`,
      `a concept id matches ^[a-z][a-z0-9]*(\\.[a-z0-9][a-z0-9-]*)+$ with at most ${PROP_BOUNDS.concept} characters`,
    );
  }
  if (keys.includes("a")) checkTerms(value.a, `${path}/a`, sink);
  if (keys.includes("v")) checkInt(value.v, `${path}/v`, MIND_BOUNDS.integer, sink);
  if (keys.includes("neg") && value.neg !== true) {
    sink.report(`${path}/neg`, "neg is true, for a negation, or absent");
  }
}

/**
 * Reports to `sink` every problem of `value` as a proposition of prop@1, at paths from `path`, and
 * whether it is one. `value` must be canonical, as a copy is; the size of its canonical text is
 * checked only once its structure is valid.
 */
export function checkProposition(
  value: unknown,
  path: string,
  sink: IssueSink,
): value is Proposition {
  let count = 0;
  const counted: IssueSink = {
    report: (at, message, cause) => {
      count += 1;
      sink.report(at, message, cause);
    },
  };
  if (isRecord(value)) checkMembers(value, path, counted);
  else counted.report(path, "a proposition is a record { p, a, v?, neg? }");
  if (count > 0) return false;
  const bytes = utf8Length(canonicalize(value));
  if (bytes <= PROP_BOUNDS.bytes) return true;
  sink.report(
    path,
    `the proposition takes ${bytes} bytes of canonical text: at most ${PROP_BOUNDS.bytes}`,
  );
  return false;
}

/** Whether `a` and `b` are the same proposition: their canonical texts are equal. */
export function sameProposition(a: Proposition, b: Proposition): boolean {
  return canonicalize(a) === canonicalize(b);
}

/** A copy of `term` that shares no object with it. */
function copyTerm(term: Term): Term {
  if ("c" in term) return { c: [term.c[0], term.c[1]] };
  return "e" in term ? { e: term.e } : { n: term.n };
}

/** A copy of `proposition` that shares no object with it, for a view a brain may keep. */
export function copyProposition(proposition: Proposition): Proposition {
  const [first, second] = proposition.a;
  const a: Proposition["a"] =
    second === undefined ? [copyTerm(first)] : [copyTerm(first), copyTerm(second)];
  const value = proposition.v === undefined ? {} : { v: proposition.v };
  const neg = proposition.neg === undefined ? {} : { neg: proposition.neg };
  return { p: proposition.p, a, ...value, ...neg };
}
