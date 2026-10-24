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

/** What a draw hashes besides its counter: copies that belong to the engine alone. */
export type DrawSource = {
  readonly seed: Seed;
  readonly stream: number;
  readonly key: readonly number[];
};

/** The message for `value` where a u32 belongs. */
export function notU32(value: unknown): string {
  return `${describeValue(value)} is not an integer in [0, 4294967295]`;
}

/** `value` if it is a u32; otherwise an issue at `path`, and 0 in its place. */
function readU32(value: unknown, path: string, issues: Issue[]): number {
  if (isU32(value)) return value;
  issues.push({ path, message: notU32(value) });
  return 0;
}

/** The two words of `seed`, each read once by index; issues for anything else. */
function readSeed(seed: unknown, issues: Issue[]): Seed {
  if (!Array.isArray(seed) || seed.length !== 2) {
    issues.push({ path: "/seed", message: "the seed must be an array of two words" });
    return [0, 0];
  }
  const words: readonly unknown[] = seed;
  return [readU32(words[0], "/seed/0", issues), readU32(words[1], "/seed/1", issues)];
}

/**
 * The words of `key` in a fresh array: its length and each element are read once, by index, so
 * neither a getter nor a custom iterator can show the hash other words than validation saw. A
 * hole reads as undefined, which is not a u32.
 */
function readKey(key: unknown, issues: Issue[]): number[] {
  if (!Array.isArray(key)) {
    issues.push({ path: "/key", message: "the key must be an array of words" });
    return [];
  }
  const words: readonly unknown[] = key;
  const length = words.length;
  const copy: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const word = words[index];
    // The path is built only for an issue: draws read keys on the hot path.
    copy.push(isU32(word) ? word : readU32(word, `/key/${index}`, issues));
  }
  return copy;
}

/**
 * Reads the inputs of a draw once, into fresh values. Throws EngineError("invalid_value") with
 * every problem, each at its path into `{ seed, stream, key, n }`.
 */
export function readDraw(
  seed: unknown,
  stream: unknown,
  key: unknown,
  n: unknown,
): DrawSource & { readonly n: number } {
  const issues: Issue[] = [];
  // Properties are evaluated in order, so the issues come in the order of the arguments.
  const draw = {
    seed: readSeed(seed, issues),
    stream: readU32(stream, "/stream", issues),
    key: readKey(key, issues),
    n: readU32(n, "/n", issues),
  };
  if (issues.length > 0) throw new EngineError("invalid_value", issues);
  return draw;
}

/** Draw `n` of `source`, which readDraw made: it hashes the copies, by index. */
export function mixDraw({ seed, stream, key }: DrawSource, n: number): number {
  let h = mixWord32(mixWord32(mixWord32(seed[0], seed[1]), stream), key.length);
  for (let index = 0; index < key.length; index += 1) {
    // index < key.length, and readDraw made the key dense.
    h = mixWord32(h, key[index] as number);
  }
  return finish32(mixWord32(h, n), (key.length + 4) * 4);
}

/**
 * Draw `n` of `stream` for `key` under `seed`, a u32. Each input is read once. Throws
 * EngineError("invalid_value") with every input that is not what its type says.
 */
export function mix32(seed: Seed, stream: number, key: readonly number[], n: number): number {
  const draw = readDraw(seed, stream, key, n);
  return mixDraw(draw, draw.n);
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
