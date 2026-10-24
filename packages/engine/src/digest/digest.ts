/**
 * Digests for divergence detection (ADR 0020): MurmurHash3 x86_128 over canonical text, inside
 * the core. They detect accidental divergence, not tampering; integrity against tampering is
 * SHA-256's job, in the adapter.
 */
import { canonicalize } from "../canonical/encode.ts";
import { utf8Encode } from "../canonical/utf8.ts";
import type { CanonicalValue } from "../canonical/value.ts";
import { type Hash128, murmur3x86_128 } from "./murmur3.ts";

/** 32 lowercase hexadecimal digits: the words h1, h2, h3, and h4, in 8 digits each. */
export type Digest = string;

function hex8(word: number): string {
  return word.toString(16).padStart(8, "0");
}

/**
 * The digest that writes the 128-bit integer [h1, h2, h3, h4], four u32 words, most significant
 * first: each word in 8 lowercase hexadecimal digits, padded with zeros. The words must be u32
 * values, as murmur3x86_128 and the lane arithmetic return them; an int32 word below 0 would
 * write a minus sign.
 */
export function hexOf([h1, h2, h3, h4]: Hash128): Digest {
  return `${hex8(h1)}${hex8(h2)}${hex8(h3)}${hex8(h4)}`;
}

/**
 * The words h1 to h4 of the digest of `value`, as u32 values: the 128-bit integer the digest
 * writes, as four lanes, most significant first (digest/lanes.ts). The state root sums them.
 */
export function digestWords(value: CanonicalValue): Hash128 {
  return murmur3x86_128(utf8Encode(canonicalize(value)), 0);
}

/**
 * The digest of `value`: MurmurHash3 x86_128 with seed 0 over the UTF-8 bytes of its canonical
 * text. Callers that hash different kinds of data put a domain tag first, as in
 * `digest(["chunk", key, chunk])`. Throws EngineError("invalid_value"), as canonicalize does, when
 * `value` is not canonical.
 */
export function digest(value: CanonicalValue): Digest {
  return hexOf(digestWords(value));
}
