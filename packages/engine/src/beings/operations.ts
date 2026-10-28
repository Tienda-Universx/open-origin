/**
 * The mental operations an intention of beings@2 may carry (ADR 0024, docs/architecture/mind.md
 * "Beliefs"): `remember`, `recall`, `believe`, `revise`, and `drop`, at most `mind.ops` in all.
 * Brain output is untrusted: before the intention is copied, every list and record of its `mind` is
 * bounded from its length, read once, so that no huge value is iterated; then its canonical copy is
 * read here into typed operations, with exact members, bounds, and grammars, every problem reported
 * with its path. Any problem here is the rejection `mind_malformed`. What the operations refer to,
 * the percepts of the decision and the records of the mind, is judged when they apply (mental.ts).
 * `relate` arrives with relationships (T5-5b); until then it is an unknown member.
 */
import { ownKeyCount, sortedOwnKeys } from "../canonical/order.ts";
import { lengthOf } from "../canonical/value.ts";
import { IssueList } from "../errors.ts";
import {
  type BelieveOperation,
  checkProposition,
  INT31_MAX,
  type LocalId,
  MIND_BOUNDS,
  type Proposition,
  type ReviseOperation,
} from "../mind/index.ts";
import { readMember } from "../world/members.ts";
import type { Cell } from "./being.ts";
import { type IntRange, range, readFields, readId, readInt, readList } from "./schema.ts";

/** A percept of the decision that `remember` copies: a being, a message, a cell, or the outcome. */
export type Percept =
  | { readonly kind: "being"; readonly index: number }
  | { readonly kind: "heard"; readonly index: number }
  | { readonly kind: "food"; readonly cell: Cell }
  | { readonly kind: "outcome" };

/** An episode the brain asks the engine to make from a percept, with its importance. */
export type RememberOperation = { readonly percept: Percept; readonly w: number };

/** The mental operations of one intention, each kind in the order the brain gave them. */
export type MindOperations = {
  readonly remember: readonly RememberOperation[];
  readonly recall: readonly LocalId[];
  readonly believe: readonly BelieveOperation[];
  readonly revise: readonly ReviseOperation[];
  readonly drop: readonly LocalId[];
};

/** No mental operation: the operations of an intention without `mind`. */
export const NO_OPERATIONS: MindOperations = Object.freeze({
  remember: Object.freeze([]),
  recall: Object.freeze([]),
  believe: Object.freeze([]),
  revise: Object.freeze([]),
  drop: Object.freeze([]),
});

/**
 * What the grammar of the operations depends on: the being's `mind.ops`; the namespace of the
 * brain's concepts; and whether an id names an observable of the world's catalog, for a concept of
 * the namespace `obs`.
 */
export type MindGrammar = {
  readonly ops: number;
  readonly concepts: string;
  readonly observable: (id: string) => boolean;
};

/** The members of `mind`, one per kind of operation, in the order the kinds apply. */
const KINDS = Object.freeze(["remember", "recall", "believe", "revise", "drop"] as const);
/** The members of a percept, of which it holds exactly one. */
const PERCEPTS = Object.freeze(["being", "food", "heard", "outcome"] as const);

/** A record's local id: from 1, below `next`, which is at most 2^31 − 1. */
const LOCAL_IDS = range(1, INT31_MAX - 1);
/** An index into the percepts of a decision. */
const INDEXES = range(0, INT31_MAX);

/**
 * The most entries, at every depth, that the `mind` of an intention may hold before it is copied:
 * more than the largest legal operations hold, 165 with `mind.ops` at its largest, 8: the five
 * members of `mind`, eight entries, and eight `believe` of 19 entries each (four members, three
 * citations, and a proposition of four members, two terms, and their two cells).
 */
const SCAN_ENTRIES = 256;
/** The longest string or key the scan allows: a concept id has at most 48 characters. */
const SCAN_TEXT = 64;

/** What the scan of a `mind` still allows, and the objects it already visited. */
type Scan = { budget: number; readonly visited: object[] };

/**
 * Whether `value` holds more than the scan allows: a string or key longer than SCAN_TEXT, or more
 * entries in all than its budget. Each length is read once, through its descriptor, before
 * anything is iterated. A value reached twice is left to the canonical copy, which refuses it.
 */
function oversized(value: unknown, scan: Scan): boolean {
  if (typeof value === "string") return value.length > SCAN_TEXT;
  if (typeof value !== "object" || value === null || scan.visited.includes(value)) return false;
  scan.visited.push(value);
  return Array.isArray(value) ? oversizedList(value, scan) : oversizedRecord(value, scan);
}

/** Whether the array `list` holds more than the scan allows, its length read before its entries. */
function oversizedList(list: object, scan: Scan): boolean {
  const length = lengthOf(list);
  scan.budget -= length;
  if (scan.budget < 0) return true;
  for (let index = 0; index < length; index += 1)
    if (oversized(Object.getOwnPropertyDescriptor(list, index)?.value, scan)) return true;
  return false;
}

/** Whether the record `record` holds more than the scan allows, its keys counted before sorted. */
function oversizedRecord(record: object, scan: Scan): boolean {
  scan.budget -= ownKeyCount(record);
  if (scan.budget < 0) return true;
  return sortedOwnKeys(record).some(
    (key) =>
      key.length > SCAN_TEXT ||
      oversized(Object.getOwnPropertyDescriptor(record, key)?.value, scan),
  );
}

/**
 * Whether the member `mind` of `raw`, what a brain returned, holds more than any legal operations
 * could, found before anything is copied: the intention is then `mind_malformed`. What cannot be
 * read here, an accessor or an object that throws, is left to the canonical copy, which refuses it
 * as `malformed`.
 */
export function mindOversized(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  try {
    const mind = readMember(raw, "mind", "/mind", new IssueList());
    return oversized(mind, { budget: SCAN_ENTRIES, visited: [] });
  } catch {
    // A Proxy whose traps throw, revoked or not: the canonical copy refuses it.
    return false;
  }
}

/** The entries of `list` at `path`, each read by `read`; those it could not read are left out. */
function entries<T>(
  list: readonly unknown[] | undefined,
  path: string,
  read: (entry: unknown, at: string) => T | undefined,
): T[] {
  const values: T[] = [];
  (list ?? []).forEach((entry, index) => {
    const value = read(entry, `${path}/${index}`);
    if (value !== undefined) values.push(value);
  });
  return values;
}

/** The local ids of `list` at `path`. */
function localIds(list: readonly unknown[] | undefined, path: string, sink: IssueList): LocalId[] {
  return entries(list, path, (entry, at) => readInt(entry, at, LOCAL_IDS, sink));
}

/** The list of at most `count.max` local ids at `path`. */
function readIds(value: unknown, path: string, count: IntRange, sink: IssueList): LocalId[] {
  return localIds(readList(value, path, count, sink), path, sink);
}

/** A cell of the world: two coordinates within its bounds. */
function readCell(value: unknown, path: string, sink: IssueList): Cell | undefined {
  const axes = readList(value, path, range(2, 2), sink);
  if (axes === undefined || axes.length !== 2) return undefined;
  const x = readInt(axes[0], `${path}/0`, MIND_BOUNDS.cell, sink);
  const y = readInt(axes[1], `${path}/1`, MIND_BOUNDS.cell, sink);
  return x === undefined || y === undefined ? undefined : [x, y];
}

/** The percept at `path`: exactly one of `{ being }`, `{ heard }`, `{ food }`, `{ outcome }`. */
function readPercept(value: unknown, path: string, sink: IssueList): Percept | undefined {
  const fields = readFields(value, path, { required: [], optional: PERCEPTS }, sink);
  if (fields === undefined) return undefined;
  const named = PERCEPTS.filter((name) => fields.value(name) !== undefined);
  const [kind] = named;
  if (kind === undefined || named.length > 1) {
    sink.report(path, "a percept is one of { being }, { heard }, { food }, or { outcome: true }");
    return undefined;
  }
  if (kind === "food") {
    const cell = readCell(fields.value("food"), fields.at("food"), sink);
    return cell === undefined ? undefined : { kind, cell };
  }
  if (kind === "outcome") {
    if (fields.boolean("outcome") === true) return { kind };
    sink.report(fields.at("outcome"), "the percept of the outcome is { outcome: true }");
    return undefined;
  }
  const index = fields.int(kind, INDEXES);
  return index === undefined ? undefined : { kind, index };
}

/** A `remember` operation: a percept and an importance. */
function readRemember(
  value: unknown,
  path: string,
  sink: IssueList,
): RememberOperation | undefined {
  const fields = readFields(value, path, { required: ["percept", "w"] }, sink);
  if (fields === undefined) return undefined;
  const percept = readPercept(fields.value("percept"), fields.at("percept"), sink);
  const w = fields.int("w", MIND_BOUNDS.permille);
  return percept === undefined || w === undefined ? undefined : { percept, w };
}

/**
 * The proposition at `path`, if it is one of prop@1 whose concept the brain may form: one of its
 * own namespace, or `obs.` followed by an observable of the world's catalog.
 */
function readConcept(
  value: unknown,
  path: string,
  grammar: MindGrammar,
  sink: IssueList,
): Proposition | undefined {
  if (value === undefined || !checkProposition(value, path, sink)) return undefined;
  const dot = value.p.indexOf(".");
  const namespace = value.p.slice(0, dot);
  if (namespace === grammar.concepts) return value;
  if (namespace === "obs" && grammar.observable(value.p.slice(dot + 1))) return value;
  sink.report(
    `${path}/p`,
    `a brain forms concepts of its namespace "${grammar.concepts}", or obs. followed by an observable of the catalog`,
  );
  return undefined;
}

/** A `believe` operation: a proposition, a confidence, its citations, and the brain's rule. */
function readBelieve(
  value: unknown,
  path: string,
  grammar: MindGrammar,
  sink: IssueList,
): BelieveOperation | undefined {
  const fields = readFields(value, path, { required: ["cr", "ev", "p", "rule"] }, sink);
  if (fields === undefined) return undefined;
  const p = readConcept(fields.value("p"), fields.at("p"), grammar, sink);
  const cr = fields.int("cr", MIND_BOUNDS.permille);
  const ev = readIds(fields.value("ev"), fields.at("ev"), MIND_BOUNDS.citations, sink);
  const rule = readId(fields.value("rule"), fields.at("rule"), sink);
  if (p === undefined || cr === undefined || rule === undefined) return undefined;
  return { p, cr, ev, rule };
}

/** A `revise` operation: the belief, its new confidence, and the evidence it adds. */
function readRevise(value: unknown, path: string, sink: IssueList): ReviseOperation | undefined {
  const fields = readFields(value, path, { required: ["cr", "ev", "id"] }, sink);
  if (fields === undefined) return undefined;
  const id = fields.int("id", LOCAL_IDS);
  const cr = fields.int("cr", MIND_BOUNDS.permille);
  const ev = readIds(fields.value("ev"), fields.at("ev"), MIND_BOUNDS.citations, sink);
  return id === undefined || cr === undefined ? undefined : { id, cr, ev };
}

/**
 * The operations of `value`, the canonical copy of an intention's `mind`, read by `grammar`;
 * undefined after any problem, each reported to `issues` with its path under `/mind`.
 */
export function readMindOperations(
  value: unknown,
  grammar: MindGrammar,
  issues: IssueList,
): MindOperations | undefined {
  const before = issues.count;
  const fields = readFields(value, "/mind", { required: [], optional: KINDS }, issues);
  if (fields === undefined) return undefined;
  const lists = KINDS.map((kind) =>
    readList(fields.value(kind), fields.at(kind), range(0, grammar.ops), issues),
  );
  const count = lists.reduce((sum, list) => sum + (list?.length ?? 0), 0);
  if (count > grammar.ops)
    issues.report("/mind", `${count} operations: a decision makes at most ${grammar.ops}`);
  const [remember, recall, believe, revise, drop] = lists;
  const operations: MindOperations = {
    remember: entries(remember, fields.at("remember"), (e, at) => readRemember(e, at, issues)),
    recall: localIds(recall, fields.at("recall"), issues),
    believe: entries(believe, fields.at("believe"), (e, at) => readBelieve(e, at, grammar, issues)),
    revise: entries(revise, fields.at("revise"), (e, at) => readRevise(e, at, issues)),
    drop: localIds(drop, fields.at("drop"), issues),
  };
  return issues.count === before ? operations : undefined;
}
