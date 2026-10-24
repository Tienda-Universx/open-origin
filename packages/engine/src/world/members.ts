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
import { ownKeyCount, sortedOwnKeys, symbolKeyCount } from "../canonical/order.ts";
import {
  describeThrown,
  type IssueSink,
  lengthOf,
  sparseMessage,
  symbolKeysMessage,
} from "../canonical/value.ts";

const ACCESSOR = "the property is an accessor: only data properties are read";
const NOT_ENUMERABLE = "the property is not enumerable: only enumerable data properties are read";

/**
 * What readMember returns for a member it already reported, an accessor or one that threw, so
 * that callers do not report it a second time.
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
    const symbols = symbolKeyCount(value);
    if (symbols > 0) sink.report(path, symbolKeysMessage(symbols));
    return { record: value, keys: sortedOwnKeys(value) };
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
