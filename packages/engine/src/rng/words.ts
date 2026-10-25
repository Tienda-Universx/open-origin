/**
 * Reading u32 words from host arrays (ADR 0020, ownership): each element once, by index, with every
 * problem reported at its path. Shared by the generators in this directory, so ctr-mix32@1 and
 * ChaCha20 reject the same inputs with the same messages.
 */
import { describeValue, type Issue } from "../errors.ts";
import { isU32, MAX_U32 } from "../int.ts";

const HOLE = "the element is a hole: the array must be dense";

/**
 * The message for `value` where a u32 belongs. A value that is not a number is described by its
 * type alone (describeValue), so a hostile word's valueOf or toString never runs.
 */
function notU32(value: unknown): string {
  return `${describeValue(value)} is not an integer in [0, ${MAX_U32}]`;
}

/** `value` if it is a u32; otherwise an issue at `path`, and 0 in its place. */
export function readU32(value: unknown, path: string, issues: Issue[]): number {
  if (isU32(value)) return value;
  issues.push({ path, message: notU32(value) });
  return 0;
}

/**
 * Element `index` of `array`, read once, if it is an own u32; otherwise an issue at
 * `${prefix}/${index}`, and 0 in its place. A hole is an issue even when the prototype chain has
 * a value at its index, which reading the element alone would return.
 */
export function readWord(
  array: readonly unknown[],
  index: number,
  prefix: string,
  issues: Issue[],
): number {
  // The path is built only for an issue: draws read keys on the hot path.
  if (!Object.hasOwn(array, index)) {
    issues.push({ path: `${prefix}/${index}`, message: HOLE });
    return 0;
  }
  const word = array[index];
  return isU32(word) ? word : readU32(word, `${prefix}/${index}`, issues);
}
