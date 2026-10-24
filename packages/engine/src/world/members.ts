/**
 * Reads the host objects that cannot be canonical values because they hold functions: the
 * ruleset, the world definition, the options, and chunk coordinates. As at every boundary (ADR
 * 0020, ownership), each member is read once, through its own descriptor, so a getter never runs
 * and a Proxy's `get` trap never fires. Only own, enumerable data properties are read, as in
 * canonical records. Every inspection of a host object, `Array.isArray` and the prototype
 * included, runs guarded: an object that throws while read, such as a revoked Proxy, is an issue
 * at its path with the thrown value as its cause, never a raw exception. The canonical parts of
 * these objects go through copyCanonicalReported instead.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { ownKeyCount, sortedOwnKeys, symbolKeyCount } from "../canonical/order.ts";
import {
  type CanonicalValue,
  describeThrown,
  type IssueSink,
  lengthOf,
  sparseMessage,
  symbolKeysMessage,
  validateCanonical,
} from "../canonical/value.ts";
import type { IssueList } from "../errors.ts";

const ACCESSOR = "the property is an accessor: only data properties are read";
const NOT_ENUMERABLE = "the property is not enumerable: only enumerable data properties are read";

/**
 * What readMember returns for a member it already reported: an accessor, a property that is not
 * enumerable, or a read that threw. Every caller checks for it before anything else, so that the
 * member is reported once, never a second time as a missing or invalid value. A host cannot
 * forge it: it is a fresh symbol, and index.ts does not export it.
 */
export const UNREAD: unique symbol = Symbol("unread");

/**
 * Whether `value` is a record: an object that is not an array. Only for values the engine owns,
 * such as copies: `Array.isArray` throws on a revoked Proxy, so host values go through
 * expectRecord.
 */
export function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A sink that reports every issue to `sink`, with `prefix` before its path. */
export function under(sink: IssueSink, prefix: string): IssueSink {
  return { report: (path, message, cause) => sink.report(`${prefix}${path}`, message, cause) };
}

/**
 * A canonical copy of `value`, which readMember read, with its issues at `path`; undefined after
 * any, or when readMember already reported the member.
 */
export function copyAt(
  value: unknown,
  path: string,
  issues: IssueList,
): CanonicalValue | undefined {
  if (value === UNREAD) return undefined;
  const before = issues.count;
  const copy = copyCanonicalReported(value, under(issues, path));
  return issues.count === before ? copy : undefined;
}

/** Reports at `path` that an object threw `error` while being read. */
function reportThrown(path: string, error: unknown, sink: IssueSink): void {
  sink.report(path, `the object threw while being read: ${describeThrown(error)}`, error);
}

/** The result of `read`, or undefined after reporting what it threw at `path`. */
function guarded<T>(path: string, sink: IssueSink, read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    reportThrown(path, error, sink);
    return undefined;
  }
}

/**
 * Whether the host value `value` is a record. If not, an issue at `path`: `message`, or what it
 * threw while inspected; none when readMember already reported it.
 */
export function expectRecord(
  value: unknown,
  path: string,
  message: string,
  sink: IssueSink,
): value is object {
  if (value === UNREAD) return false;
  const record = guarded(path, sink, () => isRecord(value));
  if (record === false) sink.report(path, message);
  return record === true;
}

/**
 * `value` and its own string keys, sorted by UTF-16 code units (canonical/order.ts), never in
 * insertion order, if it is a plain record as canonical records are: an object whose prototype is
 * Object.prototype or null, without symbol keys. Undefined after an issue at `path`; `notRecord`
 * is the message for a value that is not such a record.
 */
export function readRecordKeys(
  value: unknown,
  path: string,
  notRecord: string,
  sink: IssueSink,
): { readonly record: object; readonly keys: string[] } | undefined {
  if (!expectRecord(value, path, notRecord, sink)) return undefined;
  return guarded(path, sink, () => {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      sink.report(path, notRecord);
      return undefined;
    }
    const keys = readOwnKeys(value, path, sink);
    return keys === undefined ? undefined : { record: value, keys };
  });
}

/**
 * The own string keys of the host object `value`, enumerable or not, sorted by UTF-16 code units
 * (canonical/order.ts), never in insertion order. Symbol keys are one issue at `path`, since a
 * JSON Pointer cannot name them; undefined after `value` throws while its keys are listed.
 */
export function readOwnKeys(value: object, path: string, sink: IssueSink): string[] | undefined {
  return guarded(path, sink, () => {
    const symbols = symbolKeyCount(value);
    if (symbols > 0) sink.report(path, symbolKeysMessage(symbols));
    return sortedOwnKeys(value);
  });
}

/**
 * The own data property `key` of `object`, read once; undefined when it is missing. An accessor,
 * a property that is not enumerable, or a read that throws is an issue at `path`, and the result
 * is UNREAD.
 */
export function readMember(object: object, key: string, path: string, sink: IssueSink): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (error) {
    reportThrown(path, error, sink);
    return UNREAD;
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    sink.report(path, ACCESSOR);
    return UNREAD;
  }
  if (descriptor.enumerable !== true) {
    sink.report(path, NOT_ENUMERABLE);
    return UNREAD;
  }
  return descriptor.value;
}

/**
 * The elements of the dense array `value`, each read once with readMember, in a fresh array.
 * Undefined after an issue at `path` when `value` is not an array, is sparse (found without
 * walking its length), or throws; `notArray` is the message for a value that is not an array.
 */
export function readElements(
  value: unknown,
  path: string,
  notArray: string,
  sink: IssueSink,
): unknown[] | undefined {
  if (value === UNREAD) return undefined;
  return guarded(path, sink, () => {
    if (!Array.isArray(value)) {
      sink.report(path, notArray);
      return undefined;
    }
    const length = lengthOf(value);
    const others = ownKeyCount(value) - 1;
    if (others < length) {
      sink.report(path, sparseMessage(length, others));
      return undefined;
    }
    const elements: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      elements.push(readMember(value, `${index}`, `${path}/${index}`, sink));
    }
    return elements;
  });
}

/**
 * `value` if it is a non-empty canonical string; otherwise undefined, after an issue at `path`
 * unless readMember already reported it.
 */
export function readText(
  value: unknown,
  path: string,
  what: string,
  sink: IssueSink,
): string | undefined {
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
