import { IssueList } from "../errors.ts";
import { type Builder, type CanonicalValue, type IssueSink, walkCanonical } from "./value.ts";

/** Builds fresh arrays and records, so the copy shares no object with its source. */
const COPIER: Builder<unknown> = {
  invalid: undefined,
  leaf: (value) => value,
  array: (items) => items,
  // fromEntries defines own data properties, in canonical order, and never runs a setter.
  record: (entries) => Object.fromEntries(entries),
};

/**
 * Validates `value` and deep-copies it in one pass (ADR 0020, ownership): every property is read
 * once, through its own descriptor, so a getter or a Proxy cannot show validation one value and
 * the copy another. The copy shares no object with `value`, and its records have the prototype
 * Object.prototype. Throws EngineError("invalid_value") with the issues walkCanonical reaches.
 */
export function copyCanonical(value: unknown): CanonicalValue {
  const issues = new IssueList();
  const copy = copyCanonicalReported(value, issues);
  issues.throwIfAny("invalid_value");
  return copy;
}

/**
 * Validates and copies `value` as copyCanonical does, but reports each issue to `sink` instead of
 * throwing, so a caller can gather the issues of several values in one error. The copy is a
 * canonical value only when nothing was reported; callers discard it otherwise.
 */
export function copyCanonicalReported(value: unknown, sink: IssueSink): CanonicalValue {
  // When nothing was reported, the walk validated every value it copied.
  return walkCanonical(value, COPIER, sink) as CanonicalValue;
}
