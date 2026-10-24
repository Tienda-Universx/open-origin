/**
 * ctr-mix32@1 (ADR 0020): a counter-based generator. Draw n of a stream for a key is MurmurHash3
 * x86_32 over the u32 words [s1, stream, key.length, ...key, n] with seed s0, where [s0, s1] is
 * the world seed. A draw depends on nothing else, so adding draws to one stream or key never
 * shifts another's.
 */
import { utf8Encode } from "../canonical/utf8.ts";
import { finish32, mixWord32, murmur3x86_32 } from "../digest/murmur3.ts";
import { describeValue, EngineError, type Issue } from "../errors.ts";
import { int64Words, isU32 } from "../int.ts";
import { tickProblem } from "../time/tick.ts";

/** The world seed: two u32 words, [s0, s1]. */
export type Seed = readonly [number, number];

/** The message for `value` where a u32 belongs. */
export function notU32(value: unknown): string {
  return `${describeValue(value)} is not an integer in [0, 4294967295]`;
}

function wordIssues(words: readonly unknown[], path: string): Issue[] {
  const issues: Issue[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (!isU32(word)) issues.push({ path: `${path}/${index}`, message: notU32(word) });
  }
  return issues;
}

function seedIssues(seed: unknown): Issue[] {
  if (!Array.isArray(seed) || seed.length !== 2) {
    return [{ path: "/seed", message: "the seed must be an array of two words" }];
  }
  return wordIssues(seed, "/seed");
}

/** Whether every element of `words`, holes included, is a u32. */
function allU32(words: readonly unknown[]): boolean {
  for (let index = 0; index < words.length; index += 1) {
    if (!isU32(words[index])) return false;
  }
  return true;
}

/** Whether the inputs of a draw are valid, without building drawIssues' list. */
function isValidDraw(seed: unknown, stream: unknown, key: unknown, n: unknown): boolean {
  const pair = Array.isArray(seed) && seed.length === 2 && allU32(seed);
  return pair && isU32(stream) && Array.isArray(key) && allU32(key) && isU32(n);
}

/** Throws EngineError("invalid_value") with every problem of the inputs of a draw. */
export function checkDraw(seed: unknown, stream: unknown, key: unknown, n: unknown): void {
  if (!isValidDraw(seed, stream, key, n)) {
    throw new EngineError("invalid_value", drawIssues(seed, stream, key, n));
  }
}

/**
 * Every problem with the inputs of a draw, each with its path into `{ seed, stream, key, n }`.
 * Holes in `key` are reported as values that are not u32.
 */
function drawIssues(seed: unknown, stream: unknown, key: unknown, n: unknown): Issue[] {
  const issues = seedIssues(seed);
  if (!isU32(stream)) issues.push({ path: "/stream", message: notU32(stream) });
  if (Array.isArray(key)) issues.push(...wordIssues(key, "/key"));
  else issues.push({ path: "/key", message: "the key must be an array of words" });
  if (!isU32(n)) issues.push({ path: "/n", message: notU32(n) });
  return issues;
}

/** mix32 for inputs that checkDraw already accepted. */
export function mixValidated(
  seed: Seed,
  stream: number,
  key: readonly number[],
  n: number,
): number {
  const [s0, s1] = seed;
  let h = mixWord32(mixWord32(mixWord32(s0, s1), stream), key.length);
  for (const word of key) h = mixWord32(h, word);
  return finish32(mixWord32(h, n), (key.length + 4) * 4);
}

/**
 * Draw `n` of `stream` for `key` under `seed`, a u32. Throws EngineError("invalid_value") with
 * every input that is not what its type says.
 */
export function mix32(seed: Seed, stream: number, key: readonly number[], n: number): number {
  checkDraw(seed, stream, key, n);
  return mixValidated(seed, stream, key, n);
}

/**
 * The id of the stream `name`: MurmurHash3 x86_32 of its UTF-8 bytes with seed 0. Colliding ids
 * are rejected when a ruleset declares its streams (ADR 0020). Throws EngineError("invalid_value")
 * when `name` is not a string or has a lone surrogate.
 */
export function streamId(name: string): number {
  if (typeof name !== "string") {
    throw new EngineError("invalid_value", [
      { path: "", message: `the stream name must be a string, not ${typeof name}` },
    ]);
  }
  return murmur3x86_32(utf8Encode(name), 0);
}

/**
 * The key of the draws of `entity` during `tick`: [tickLo, tickHi, entityLo, entityHi], each
 * integer as the two u32 words of its 64-bit two's complement. Throws
 * EngineError("invalid_value") when `tick` is not a tick or `entity` is not a safe integer.
 */
export function tickKey(tick: number, entity: number): readonly [number, number, number, number] {
  const issues: Issue[] = [];
  const problem = tickProblem(tick);
  if (problem !== undefined) issues.push({ path: "/tick", message: problem });
  if (!Number.isSafeInteger(entity)) {
    issues.push({ path: "/entity", message: `${describeValue(entity)} is not a safe integer` });
  }
  if (issues.length > 0) throw new EngineError("invalid_value", issues);
  const [tickLo, tickHi] = int64Words(tick);
  const [entityLo, entityHi] = int64Words(entity);
  return [tickLo, tickHi, entityLo, entityHi];
}
