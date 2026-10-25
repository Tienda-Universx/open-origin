/**
 * Readers for the data of the beings layer: the laws of life, beings, and chunks (ADR 0023). They
 * read values that are already canonical (a validator's live value, or a canonical copy), check
 * names, kinds, and bounds, and report every problem to a sink with its JSON Pointer path, as
 * worldgen's readers do. They never throw.
 */
import { sortedOwnKeys } from "../canonical/order.ts";
import { type IssueSink, pointer } from "../canonical/value.ts";
import { describeValue } from "../errors.ts";
import type { Ratio } from "./rates.ts";
import { RATIO_BOUNDS } from "./rates.ts";

/** The integers from `min` to `max`, both included. */
export type IntRange = { readonly min: number; readonly max: number };

/** A frozen range. */
export function range(min: number, max: number): IntRange {
  return Object.freeze({ min, max });
}

/** The ticks: safe integers from 0. */
export const TICKS = range(0, Number.MAX_SAFE_INTEGER);

const MISSING = "the member is missing";

/** How a message names the kind of `value`. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object" && value !== null) return "a record";
  return `a ${typeof value}`;
}

/** The members of a canonical record, after readFields checked their names. */
export class Fields {
  readonly #record: { readonly [name: string]: unknown };
  readonly #keys: readonly string[];
  readonly #path: string;
  readonly #sink: IssueSink;

  constructor(
    record: { readonly [name: string]: unknown },
    keys: readonly string[],
    path: string,
    sink: IssueSink,
  ) {
    this.#record = record;
    this.#keys = keys;
    this.#path = path;
    this.#sink = sink;
  }

  /** The path of the member `name`. */
  at(name: string): string {
    return `${this.#path}/${name}`;
  }

  /**
   * The member `name`, or undefined when it is missing (already reported if it was required). Only
   * own members are read, so a missing name never reaches the prototype.
   */
  value(name: string): unknown {
    return this.#keys.includes(name) ? this.#record[name] : undefined;
  }

  /** The member `name` as an integer within `bounds`. */
  int(name: string, bounds: IntRange): number | undefined {
    return readInt(this.value(name), this.at(name), bounds, this.#sink);
  }

  /** The member `name` as a ratio within RATIO_BOUNDS. */
  ratio(name: string): Ratio | undefined {
    return readRatio(this.value(name), this.at(name), this.#sink);
  }

  /** The member `name` as a boolean. */
  boolean(name: string): boolean | undefined {
    return readBoolean(this.value(name), this.at(name), this.#sink);
  }

  /** The member `name` as one of `choices`. */
  choice<T extends string>(name: string, choices: readonly T[]): T | undefined {
    return readChoice(this.value(name), this.at(name), choices, this.#sink);
  }
}

/** Reports every key not in `names`, then every required name that is missing. */
function checkNames(
  keys: readonly string[],
  names: { readonly required: readonly string[]; readonly optional: readonly string[] },
  path: string,
  sink: IssueSink,
): void {
  const all = [...names.required, ...names.optional];
  for (const key of keys) {
    if (!all.includes(key)) {
      sink.report(
        `${path}${pointer([key])}`,
        `unknown member: the members here are ${all.join(", ")}`,
      );
    }
  }
  for (const name of names.required) {
    if (!keys.includes(name)) sink.report(`${path}/${name}`, MISSING);
  }
}

/**
 * The members of `value` if it is a record whose members are all of `required` and any of
 * `optional`; each unknown or missing member is an issue. Undefined after an issue at `path`.
 */
export function readFields(
  value: unknown,
  path: string,
  names: { readonly required: readonly string[]; readonly optional?: readonly string[] },
  sink: IssueSink,
): Fields | undefined {
  if (value === undefined) return undefined;
  const all = [...names.required, ...(names.optional ?? [])];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sink.report(path, `the value must be a record { ${all.join(", ")} }, not ${kindOf(value)}`);
    return undefined;
  }
  const keys = sortedOwnKeys(value);
  checkNames(keys, { required: names.required, optional: names.optional ?? [] }, path, sink);
  // A canonical record is plain data: its own members are data properties, read by name.
  return new Fields(value as { readonly [name: string]: unknown }, keys, path, sink);
}

/** `value` if it is an integer within `bounds`; undefined after an issue at `path`. */
export function readInt(
  value: unknown,
  path: string,
  bounds: IntRange,
  sink: IssueSink,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    sink.report(path, `the value must be an integer, not ${kindOf(value)}`);
    return undefined;
  }
  if (value >= bounds.min && value <= bounds.max) return value;
  sink.report(path, `${value} is out of bounds: it must be from ${bounds.min} to ${bounds.max}`);
  return undefined;
}

/** `value` if it is a ratio { num, den } within RATIO_BOUNDS; undefined after an issue. */
export function readRatio(value: unknown, path: string, sink: IssueSink): Ratio | undefined {
  const fields = readFields(value, path, { required: ["den", "num"] }, sink);
  if (fields === undefined) return undefined;
  const num = fields.int("num", RATIO_BOUNDS.num);
  const den = fields.int("den", RATIO_BOUNDS.den);
  return num === undefined || den === undefined ? undefined : { num, den };
}

/** `value` if it is a boolean; undefined after an issue at `path`. */
export function readBoolean(value: unknown, path: string, sink: IssueSink): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  sink.report(path, `the value must be a boolean, not ${kindOf(value)}`);
  return undefined;
}

/** `value` if it is one of `choices`; undefined after an issue at `path`. */
export function readChoice<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
  sink: IssueSink,
): T | undefined {
  if (value === undefined) return undefined;
  const found = choices.find((choice) => choice === value);
  if (found !== undefined) return found;
  sink.report(path, `${describeValue(value)} is not one of ${choices.join(", ")}`);
  return undefined;
}

/**
 * `value` if it is an identifier: 1 to 32 characters, a lowercase ASCII letter first, then
 * lowercase letters, digits, `.`, `_`, or `-`. Identifiers are engineering names, never shown to an
 * inhabitant (ADR 0021). Undefined after an issue at `path`.
 */
export function readId(value: unknown, path: string, sink: IssueSink): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^[a-z][a-z0-9._-]{0,31}$/.test(value)) return value;
  sink.report(
    path,
    `${describeValue(value)} is not an identifier: 1 to 32 characters, a lowercase letter first, then lowercase letters, digits, ".", "_", or "-"`,
  );
  return undefined;
}

/**
 * `value` if it is an array whose length is within `count`; undefined after an issue at `path`.
 * Its entries are left to the caller, so that a list of the wrong length still has them checked.
 */
export function readList(
  value: unknown,
  path: string,
  count: IntRange,
  sink: IssueSink,
): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    sink.report(path, `the value must be an array, not ${kindOf(value)}`);
    return undefined;
  }
  const values: readonly unknown[] = value;
  if (values.length < count.min || values.length > count.max) {
    const allowed =
      count.min === count.max ? `exactly ${count.min}` : `from ${count.min} to ${count.max}`;
    sink.report(path, `the array has ${values.length} entries: it must have ${allowed}`);
  }
  return values;
}
