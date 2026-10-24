import { IssueList } from "../errors.ts";
import { type Builder, type CanonicalValue, walkCanonical } from "./value.ts";

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
 * Object.prototype. Throws EngineError("invalid_value") with every issue.
 */
export function copyCanonical(value: unknown): CanonicalValue {
  const issues = new IssueList();
  const copy = walkCanonical(value, COPIER, issues);
  issues.throwIfAny("invalid_value");
  // No issue was reported, so the walk validated every value it copied.
  return copy as CanonicalValue;
}
