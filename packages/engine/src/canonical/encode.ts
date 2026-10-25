/**
 * Canonical text (ADR 0020): the subset of RFC 8785 that canonical values need. Keys are sorted
 * by UTF-16 code units, integers are written in decimal, strings are escaped as JSON.stringify
 * does, and there is no whitespace. This is the one module where biome.json allows `JSON`.
 */
import { EngineError, IssueList } from "../errors.ts";
import {
  type Builder,
  type CanonicalValue,
  ENVELOPE_LIMIT,
  type IssueSink,
  walkCanonical,
} from "./value.ts";

/**
 * Whether JSON.stringify would only wrap `text` in quotes: it has no quote, backslash, or C0
 * control. Canonical strings are well formed, so no lone surrogate, which it would escape, gets
 * here. A loop over code units measured faster than a regular expression.
 */
function needsNoEscape(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x22 || unit === 0x5c) return false;
  }
  return true;
}

/** `text` as JSON.stringify writes it, skipping the call when there is nothing to escape. */
function quote(text: string): string {
  return needsNoEscape(text) ? `"${text}"` : JSON.stringify(text);
}

/** The canonical text of an array whose items have the canonical texts `items`. */
export function arrayText(items: readonly string[]): string {
  return `[${items.join(",")}]`;
}

/**
 * The canonical text of a record from its entries: each key, and the canonical text of its value.
 * The entries must be in canonical key order (canonical/order.ts), as canonicalize writes them.
 */
export function recordText(entries: readonly (readonly [string, string])[]): string {
  return `{${entries.map(([key, value]) => `${quote(key)}:${value}`).join(",")}}`;
}

const ENCODER: Builder<string> = {
  invalid: "",
  leaf: (value) => (typeof value === "string" ? quote(value) : `${value}`),
  array: arrayText,
  record: recordText,
};

/** Stops a walk at its first issue, reported at its path under `prefix`. */
function failFastAt(prefix: string): IssueSink {
  return {
    report(path, message, cause) {
      const options = cause === undefined ? {} : { cause };
      throw new EngineError("invalid_value", [{ path: `${prefix}${path}`, message }], options);
    },
  };
}

const FAIL_FAST = failFastAt("");

function invalidText(message: string, cause?: unknown): EngineError {
  const options = cause === undefined ? {} : { cause };
  return new EngineError("invalid_value", [{ path: "", message: `the text ${message}` }], options);
}

/** The UTF-16 offset of the first code unit where `a` and `b` differ, given that they do. */
function firstDifference(a: string, b: string): number {
  let offset = 0;
  while (offset < a.length && a.charCodeAt(offset) === b.charCodeAt(offset)) offset += 1;
  return offset;
}

/**
 * The canonical text of `value`. Fails fast: throws EngineError("invalid_value") with the path
 * of the first invalid value, in canonical order.
 */
export function canonicalize(value: unknown): string {
  return walkCanonical(value, ENCODER, FAIL_FAST);
}

/**
 * The canonical text of a document that holds values inside an envelope, such as the events
 * digest's `["events", events]`: canonicalize with the nesting budget of ENVELOPE_LIMIT, so that
 * each value inside keeps the whole depth a value has. Only the engine's own documents use it.
 */
export function canonicalizeEnvelope(document: unknown): string {
  return walkCanonical(document, ENCODER, FAIL_FAST, ENVELOPE_LIMIT);
}

/**
 * canonicalize(value) for a value that lives at the JSON Pointer `path` inside a larger one, such
 * as `/chunks/0,0` in a world: the issue's path is its path in `value` under `path`.
 */
export function canonicalizeAt(value: unknown, path: string): string {
  return walkCanonical(value, ENCODER, failFastAt(path));
}

/**
 * The value of a canonical text. Accepts exactly the texts canonicalize writes: it parses,
 * validates, re-serializes, and requires the same text. Anything else, including text that
 * JSON.parse rejects, throws EngineError("invalid_value"): with the issues of the parsed value,
 * or with the first offset where the text differs from its canonical form.
 */
export function parseCanonical(text: string): CanonicalValue {
  return parseWithin(text, undefined);
}

/**
 * parseCanonical for a document that holds values inside an envelope, such as a snapshot: the
 * nesting budget is ENVELOPE_LIMIT, and the caller checks each value's own depth.
 */
export function parseCanonicalEnvelope(text: string): CanonicalValue {
  return parseWithin(text, ENVELOPE_LIMIT);
}

/** parseCanonical with the walk limit `limit`; undefined is the limit of a value. */
function parseWithin(text: string, limit: number | undefined): CanonicalValue {
  if (typeof text !== "string") {
    throw new EngineError("invalid_value", [
      { path: "", message: `the canonical text must be a string, not ${typeof text}` },
    ]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // A SyntaxError, or a RangeError on engines that run out of stack on deep nesting.
    throw invalidText(
      `is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  const issues = new IssueList();
  const canonical = walkCanonical(value, ENCODER, issues, limit);
  issues.throwIfAny("invalid_value");
  if (canonical !== text) {
    const offset = firstDifference(text, canonical);
    throw invalidText(
      `is not canonical: it first differs from its canonical form at offset ${offset}`,
    );
  }
  // Validated without an issue, and built by JSON.parse, so nothing else refers to it.
  return value as CanonicalValue;
}
