/**
 * Canonical text (ADR 0020): the subset of RFC 8785 that canonical values need. Keys are sorted
 * by UTF-16 code units, integers are written in decimal, strings are escaped as JSON.stringify
 * does, and there is no whitespace. This is the one module where biome.json allows `JSON`.
 */
import { EngineError, IssueList } from "../errors.ts";
import { type Builder, type CanonicalValue, type IssueSink, walkCanonical } from "./value.ts";

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

const ENCODER: Builder<string> = {
  invalid: "",
  leaf: (value) => (typeof value === "string" ? quote(value) : `${value}`),
  array: (items) => `[${items.join(",")}]`,
  record: (entries) => `{${entries.map(([key, value]) => `${quote(key)}:${value}`).join(",")}}`,
};

/** Stops a walk at its first issue. */
const FAIL_FAST: IssueSink = {
  report(path, message, cause) {
    const options = cause === undefined ? {} : { cause };
    throw new EngineError("invalid_value", [{ path, message }], options);
  },
};

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
 * The value of a canonical text. Accepts exactly the texts canonicalize writes: it parses,
 * validates, re-serializes, and requires the same text. Anything else, including text that
 * JSON.parse rejects, throws EngineError("invalid_value"): with the issues of the parsed value,
 * or with the first offset where the text differs from its canonical form.
 */
export function parseCanonical(text: string): CanonicalValue {
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
  const canonical = walkCanonical(value, ENCODER, issues);
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
