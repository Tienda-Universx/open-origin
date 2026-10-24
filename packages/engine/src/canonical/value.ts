import { describePath, type Issue, IssueList } from "../errors.ts";
import { ownKeyCount, sortedOwnKeys, symbolKeyCount } from "./order.ts";

/**
 * A value the engine can hash, store, and compare (ADR 0020): a boolean, a safe integer other
 * than -0, a well-formed string in NFC, a dense array, or a plain record whose keys are such
 * strings, nested at most MAX_DEPTH deep. There is no null.
 */
export type CanonicalValue =
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** The deepest nesting of arrays and records; it also bounds the walk's recursion. */
const MAX_DEPTH = 64;

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

/** Receives each issue a walk finds. */
export interface IssueSink {
  report(path: string, message: string): void;
}

type Walk<T> = {
  readonly builder: Builder<T>;
  readonly sink: IssueSink;
  /** Keys and indexes from the root to the current value. */
  readonly path: (string | number)[];
  /** The arrays and records that enclose the current value, outermost first. */
  readonly ancestors: object[];
};

const NOT_PLAIN =
  "the object is not a plain array or record: a record's prototype must be Object.prototype or null";

/** The JSON Pointer (RFC 6901) of `path`: "~" and "/" in keys become "~0" and "~1". */
function pointer(path: readonly (string | number)[]): string {
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

function report<T>(walk: Walk<T>, message: string): void {
  walk.sink.report(pointer(walk.path), message);
}

function reject<T>(walk: Walk<T>, message: string): T {
  report(walk, message);
  return walk.builder.invalid;
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

function numberProblem(value: number): string | undefined {
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

function walkObject<T>(value: object, walk: Walk<T>): T {
  const ancestor = walk.ancestors.indexOf(value);
  if (ancestor !== -1) {
    const where = describePath(pointer(walk.path.slice(0, ancestor)));
    return reject(
      walk,
      `the value contains itself: it is the same object as the value at ${where}`,
    );
  }
  if (walk.ancestors.length >= MAX_DEPTH) {
    return reject(walk, `the value nests deeper than ${MAX_DEPTH} arrays and records`);
  }
  walk.ancestors.push(value);
  const result = Array.isArray(value) ? walkArray(value, walk) : walkRecord(value, walk);
  walk.ancestors.pop();
  return result;
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

/** An array's length, read through its descriptor so that a Proxy's get trap never runs. */
function lengthOf(array: object): number {
  const length: unknown = Object.getOwnPropertyDescriptor(array, "length")?.value;
  // A Proxy must report the non-configurable length of its target array as it is.
  return typeof length === "number" ? length : 0;
}

function walkArray<T>(array: readonly unknown[], walk: Walk<T>): T {
  if (Object.getPrototypeOf(array) !== Array.prototype) return reject(walk, NOT_PLAIN);
  const length = lengthOf(array);
  const others = ownKeyCount(array) - 1;
  // Fewer own properties than elements means holes: report them without walking a length that
  // can reach 2^32 - 1.
  if (others < length) {
    return reject(
      walk,
      `the array is sparse: its length is ${length}, but it has only ${others} other own properties`,
    );
  }
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

function reportSymbolKeys<T>(object: object, walk: Walk<T>): void {
  const symbols = symbolKeyCount(object);
  if (symbols > 0) report(walk, `the object has symbol keys (${symbols}): keys must be strings`);
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
 * Walks `value` once, depth first in canonical key order, and reports every issue to `sink`.
 * Each property is read once, through its own descriptor. The result is meaningful only when
 * nothing was reported.
 */
export function walkCanonical<T>(value: unknown, builder: Builder<T>, sink: IssueSink): T {
  return walkValue(value, { builder, sink, path: [], ancestors: [] });
}

const VALIDATOR: Builder<undefined> = {
  invalid: undefined,
  leaf: () => undefined,
  array: () => undefined,
  record: () => undefined,
};

/**
 * Every issue that keeps `value` from being canonical, with its JSON Pointer, in canonical
 * order; at most MAX_ISSUES of them. An empty list means `value` is canonical.
 */
export function validateCanonical(value: unknown): Issue[] {
  const issues = new IssueList();
  walkCanonical(value, VALIDATOR, issues);
  return issues.issues;
}
