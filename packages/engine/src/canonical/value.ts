import { describePath, type Issue, IssueList } from "../errors.ts";
import { ownKeyCount, sortedOwnKeys, symbolKeyCount } from "./order.ts";

/**
 * A value the engine can hash, store, and compare (ADR 0020): a boolean, a safe integer other
 * than -0, a well-formed string in NFC, a dense array, or a plain record whose keys are such
 * strings, nested at most MAX_DEPTH deep, counted from the value's own root: the arrays and
 * records of an engine envelope around it (a digest tag, the events list, the snapshot document)
 * never count. It is a tree: no array or record appears in it twice. There is no null.
 */
export type CanonicalValue =
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** The deepest nesting of arrays and records of one value; it also bounds the walk's recursion. */
const MAX_DEPTH = 64;

/**
 * The arrays and records that the engine's own documents put above the deepest value they hold:
 * an event payload sits at `/1/<i>/payload` in the events digest, and a chunk at
 * `/world/chunks/<key>` in the snapshot document. A walk of such a document uses ENVELOPE_LIMIT,
 * so that each value keeps its whole MAX_DEPTH; a value that sits higher is checked on its own.
 */
const ENVELOPE_DEPTH = 3;

/** The walk limit of a document whose values sit up to ENVELOPE_DEPTH levels below its root. */
export const ENVELOPE_LIMIT = MAX_DEPTH + ENVELOPE_DEPTH;

/**
 * Builds a walk's result bottom-up from the parts it validated. `invalid` stands in for a value
 * that has an issue; a caller discards the result of any walk that reported one.
 */
export interface Builder<T> {
  readonly invalid: T;
  leaf(value: boolean | number | string): T;
  /** `items` is a fresh array the builder may keep. */
  array(items: T[]): T;
  /** `entries` are in canonical key order. */
  record(entries: readonly (readonly [string, T])[]): T;
}

/** Receives each issue a walk finds, with what was thrown when an object threw while read. */
export interface IssueSink {
  report(path: string, message: string, cause?: unknown): void;
}

/** An array or record the walk entered. */
type Visit = {
  /** The visit of the array or record that holds this one; undefined for the root. */
  readonly parent: Visit | undefined;
  /** Its key or index in that array or record; undefined for the root. */
  readonly segment: string | number | undefined;
  /** Whether the walk is still inside it, so that reaching it again is a cycle. */
  inside: boolean;
};

type Walk<T> = {
  readonly builder: Builder<T>;
  readonly sink: IssueSink;
  /** An array or record at this depth or deeper is rejected. */
  readonly limit: number;
  /** Keys and indexes from the root to the current value; its length is the current depth. */
  readonly path: (string | number)[];
  /**
   * Every array and record entered so far, so that a second occurrence is found at once and the
   * walk stays linear in the objects of a value that is not a tree. Only looked up, never
   * iterated: biome.json allows `Map` in this file alone.
   */
  readonly visits: Map<object, Visit>;
  /** The innermost array or record the walk is inside; undefined before it enters one. */
  current: Visit | undefined;
  /** What the sink threw to stop the walk. Every other thrown value becomes an issue. */
  halt: { readonly error: unknown } | undefined;
};

const NOT_PLAIN =
  "the object is not a plain array or record: a record's prototype must be Object.prototype or null";

/** The JSON Pointer (RFC 6901) of `path`: "~" and "/" in keys become "~0" and "~1". */
export function pointer(path: readonly (string | number)[]): string {
  let text = "";
  for (const segment of path) {
    const token =
      typeof segment === "number"
        ? `${segment}`
        : segment.replaceAll("~", "~0").replaceAll("/", "~1");
    text += `/${token}`;
  }
  return text;
}

function report<T>(walk: Walk<T>, message: string, cause?: unknown): void {
  try {
    walk.sink.report(pointer(walk.path), message, cause);
  } catch (error) {
    // A fail-fast sink throws to stop the walk: walkObject rethrows exactly this value.
    walk.halt = { error };
    throw error;
  }
}

function reject<T>(walk: Walk<T>, message: string, cause?: unknown): T {
  report(walk, message, cause);
  return walk.builder.invalid;
}

/** Describes a thrown value while reading as little of it as possible; it never throws. */
export function describeThrown(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : `a thrown ${typeof error}`;
  } catch {
    // A thrown Proxy, or a name or message getter, threw in turn.
    return "an exception that cannot be described";
  }
}

/** Whether `text` has a UTF-16 code unit at or above U+0300. */
function reachesCombiningMarks(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) >= 0x300) return true;
  }
  return false;
}

/** What makes `text` non-canonical, as the end of a sentence; undefined when it is canonical. */
function textProblem(text: string): string | undefined {
  if (!text.isWellFormed()) return "has a lone surrogate: strings must be well-formed UTF-16";
  // Below U+0300 every character is in NFC and composes with nothing (ICU's NFC quick check
  // starts there too), so the fast path skips normalize, about 30% of the cost (ADR 0020).
  if (!reachesCombiningMarks(text) || text.normalize("NFC") === text) return undefined;
  return "is not in Unicode Normalization Form C (NFC)";
}

function keyProblem(key: string): string | undefined {
  if (key === "__proto__") return "the key __proto__ is not allowed";
  const problem = textProblem(key);
  return problem === undefined ? undefined : `the key ${problem}`;
}

/** What makes `value` a non-canonical number, as a sentence; undefined when it is canonical. */
export function numberProblem(value: number): string | undefined {
  if (Object.is(value, -0)) return "-0 is not canonical: use 0";
  return Number.isSafeInteger(value) ? undefined : `${value} is not a safe integer`;
}

function walkLeaf<T>(value: number | string, problem: string | undefined, walk: Walk<T>): T {
  return problem === undefined ? walk.builder.leaf(value) : reject(walk, problem);
}

function walkValue<T>(value: unknown, walk: Walk<T>): T {
  switch (typeof value) {
    case "boolean":
      return walk.builder.leaf(value);
    case "number":
      return walkLeaf(value, numberProblem(value), walk);
    case "string": {
      const problem = textProblem(value);
      return walkLeaf(value, problem === undefined ? undefined : `the string ${problem}`, walk);
    }
    case "object":
      return value === null
        ? reject(walk, "null is not a canonical value")
        : walkObject(value, walk);
    default:
      return reject(walk, `${typeof value} is not a canonical type`);
  }
}

/** The path at which the walk first reached the object of `visit`. */
function pathOf(visit: Visit): (string | number)[] {
  const path: (string | number)[] = [];
  for (let at: Visit | undefined = visit; at !== undefined; at = at.parent) {
    if (at.segment !== undefined) path.push(at.segment);
  }
  return path.reverse();
}

/** Rejects an object the walk reached before: a cycle while inside it, a shared object after. */
function rejectRepeat<T>(earlier: Visit, walk: Walk<T>): T {
  const where = describePath(pointer(pathOf(earlier)));
  if (earlier.inside) {
    return reject(
      walk,
      `the value contains itself: it is the same object as the value at ${where}`,
    );
  }
  return reject(
    walk,
    `the value is the same object as the value at ${where}: canonical values are trees`,
  );
}

function walkObject<T>(value: object, walk: Walk<T>): T {
  const earlier = walk.visits.get(value);
  if (earlier !== undefined) return rejectRepeat(earlier, walk);
  const depth = walk.path.length;
  if (depth >= walk.limit) {
    return reject(walk, `the value nests deeper than ${MAX_DEPTH} arrays and records`);
  }
  const parent = walk.current;
  const visit: Visit = { parent, segment: walk.path.at(-1), inside: true };
  walk.visits.set(value, visit);
  walk.current = visit;
  try {
    return Array.isArray(value) ? walkArray(value, walk) : walkRecord(value, walk);
  } catch (error) {
    // Only the sink's own throw stops the whole walk. Anything else came from reading this object
    // (a revoked Proxy, or a trap that threw, even an EngineError, or broke an invariant): its
    // children catch their own, and the issues already reported for them stay before this one.
    if (walk.halt !== undefined && walk.halt.error === error) throw error;
    walk.path.length = depth;
    return reject(walk, `the object threw while being read: ${describeThrown(error)}`, error);
  } finally {
    visit.inside = false;
    walk.current = parent;
  }
}

/**
 * Walks the value of a property through its own descriptor, read once: a getter is never called,
 * and a Proxy's `get` trap never runs, so validation and the result see the same value.
 */
function walkDescriptor<T>(descriptor: PropertyDescriptor, walk: Walk<T>): T {
  if (!("value" in descriptor)) {
    return reject(walk, "the property is an accessor: only data properties are canonical");
  }
  if (descriptor.enumerable !== true) {
    return reject(walk, "the property is not enumerable: only enumerable properties are canonical");
  }
  return walkValue(descriptor.value, walk);
}

/**
 * An array's length, read once through its descriptor so that a Proxy's get trap never runs. A
 * Proxy may still report any length, since an array's length is writable; the walk then requires
 * the own keys to be exactly the indexes below it, so keys beyond a shorter length are reported
 * as not elements and a longer length as sparse.
 */
export function lengthOf(array: object): number {
  const length: unknown = Object.getOwnPropertyDescriptor(array, "length")?.value;
  return typeof length === "number" ? length : 0;
}

/** The issue of an array of `length` with only `others` own properties besides its length. */
export function sparseMessage(length: number, others: number): string {
  return `the array is sparse: its length is ${length}, but it has only ${others} other own properties`;
}

function walkArray<T>(array: readonly unknown[], walk: Walk<T>): T {
  if (Object.getPrototypeOf(array) !== Array.prototype) return reject(walk, NOT_PLAIN);
  const length = lengthOf(array);
  const others = ownKeyCount(array) - 1;
  // Fewer own properties than elements means holes: report them without walking a length that
  // can reach 2^32 - 1.
  if (others < length) return reject(walk, sparseMessage(length, others));
  reportSymbolKeys(array, walk);
  const items: T[] = [];
  let elements = 0;
  for (let index = 0; index < length; index += 1) {
    walk.path.push(index);
    const descriptor = Object.getOwnPropertyDescriptor(array, index);
    if (descriptor === undefined) {
      report(walk, "the array has a hole here: arrays must be dense");
    } else {
      elements += 1;
      items.push(walkDescriptor(descriptor, walk));
    }
    walk.path.pop();
  }
  if (others > elements) reportExtraKeys(array, length, walk);
  return walk.builder.array(items);
}

/** Reports every own property of `array` that is not one of its elements. */
function reportExtraKeys<T>(array: object, length: number, walk: Walk<T>): void {
  for (const key of sortedOwnKeys(array)) {
    if (key === "length" || isIndexBelow(key, length)) continue;
    walk.path.push(key);
    report(
      walk,
      "the array has a property that is not an element: arrays hold only their elements",
    );
    walk.path.pop();
  }
}

/** Whether `key` is the canonical decimal form of an integer in [0, length). */
function isIndexBelow(key: string, length: number): boolean {
  const index = Number(key);
  return String(index) === key && Number.isSafeInteger(index) && index >= 0 && index < length;
}

/** The issue of an object with `count` symbol keys. */
export function symbolKeysMessage(count: number): string {
  return `the object has symbol keys (${count}): keys must be strings`;
}

function reportSymbolKeys<T>(object: object, walk: Walk<T>): void {
  const symbols = symbolKeyCount(object);
  if (symbols > 0) report(walk, symbolKeysMessage(symbols));
}

/** The entry for `key`, or undefined when the key is not canonical or the property is missing. */
function walkEntry<T>(record: object, key: string, walk: Walk<T>): [string, T] | undefined {
  const problem = keyProblem(key);
  if (problem !== undefined) report(walk, problem);
  // Undefined only for a key that a Proxy lists but does not have, which Object.keys skips too.
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return undefined;
  const value = walkDescriptor(descriptor, walk);
  return problem === undefined ? [key, value] : undefined;
}

function walkRecord<T>(record: object, walk: Walk<T>): T {
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) return reject(walk, NOT_PLAIN);
  reportSymbolKeys(record, walk);
  const entries: [string, T][] = [];
  for (const key of sortedOwnKeys(record)) {
    walk.path.push(key);
    const entry = walkEntry(record, key, walk);
    walk.path.pop();
    if (entry !== undefined) entries.push(entry);
  }
  return walk.builder.record(entries);
}

/**
 * Walks `value` once, depth first in canonical key order, and reports every issue it reaches to
 * `sink`. A value rejected as a whole (an object that is not a plain array or record, a sparse
 * array, an accessor, a cycle, an object reached a second time, or nesting beyond `limit`) is
 * one issue, and its contents are not walked. An object that throws while read is one issue at
 * its path, after the issues already reported for the contents read before the throw; the rest of
 * its contents is not walked. Each property is read once, through its own descriptor. The result
 * is meaningful only when nothing was reported. A sink may throw to stop the walk: that value, and
 * only that value, propagates. `limit` is MAX_DEPTH for a value, and ENVELOPE_LIMIT for a document
 * that holds values inside an envelope; the issue always names MAX_DEPTH, the limit of a value.
 */
export function walkCanonical<T>(
  value: unknown,
  builder: Builder<T>,
  sink: IssueSink,
  limit: number = MAX_DEPTH,
): T {
  const visits = new Map<object, Visit>();
  const walk = { builder, sink, limit, path: [], visits, current: undefined, halt: undefined };
  return walkValue(value, walk);
}

const VALIDATOR: Builder<undefined> = {
  invalid: undefined,
  leaf: () => undefined,
  array: () => undefined,
  record: () => undefined,
};

/**
 * The issues that keep `value` from being canonical, as walkCanonical reaches them, with their
 * JSON Pointers in canonical order; at most MAX_ISSUES of them. An empty list means `value` is
 * canonical.
 */
export function validateCanonical(value: unknown): Issue[] {
  const issues = new IssueList();
  walkCanonical(value, VALIDATOR, issues);
  return issues.issues;
}
