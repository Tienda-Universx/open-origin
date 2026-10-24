/**
 * MurmurHash3 x86_32 and x86_128, ported with 32-bit integer operations only from Austin Appleby's
 * public-domain reference in SMHasher, src/MurmurHash3.cpp at commit 07bb4de
 * (https://github.com/aappleby/smhasher/blob/07bb4de10a63e8cc2e1724865454eba635742383/src/MurmurHash3.cpp). Both read blocks as little-endian words, as the reference does on the x86
 * machines it targets. The state stays in int32 words (see int.ts); results are u32. MurmurHash3
 * is not cryptographic: collisions can be built on purpose.
 */
import { imul, rotl32 } from "../int.ts";

/** The four 32-bit words h1 to h4 of x86_128, in the order the reference writes them. */
export type Hash128 = readonly [number, number, number, number];

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const ADD_32 = 0xe6546b64;

/** The multipliers c1 to c4 of x86_128, one per lane. */
const D1 = 0x239b961b;
const D2 = 0xab0e9789;
const D3 = 0x38b34ae5;
const D4 = 0xa1e38b93;

/** k * first, rotated left by `rotation`, times `second`: how both variants scramble a block. */
function scramble(k: number, first: number, rotation: number, second: number): number {
  return imul(rotl32(imul(k, first), rotation), second);
}

/** h rotated left by `rotation`, plus `next`, times 5, plus `add`: how both mix a block in. */
function fold(h: number, rotation: number, next: number, add: number): number {
  return (imul((rotl32(h, rotation) + next) | 0, 5) + add) | 0;
}

/** The finalization mix, which makes every bit of `h` affect every bit of the result. */
function fmix32(h: number): number {
  let x = h ^ (h >>> 16);
  x = imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = imul(x, 0xc2b2ae35);
  return x ^ (x >>> 16);
}

/** The up to four bytes of `view` from `start`, as a little-endian word padded with zeros. */
function tailWord(view: DataView, start: number): number {
  let word = 0;
  for (let at = start; at < start + 4 && at < view.byteLength; at += 1) {
    word |= view.getUint8(at) << ((at - start) * 8);
  }
  return word;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** One block of x86_32, mixed into the state `h`. */
export function mixWord32(h: number, word: number): number {
  return fold(h ^ scramble(word, C1, 15, C2), 13, 0, ADD_32);
}

/** The end of x86_32: the state `h` after the blocks and the tail, mixed with the byte length. */
export function finish32(h: number, byteLength: number): number {
  return fmix32(h ^ byteLength) >>> 0;
}

/** MurmurHash3_x86_32 of `bytes` with the u32 `seed`. */
export function murmur3x86_32(bytes: Uint8Array, seed: number): number {
  const view = viewOf(bytes);
  const blocksEnd = bytes.length - (bytes.length % 4);
  let h = seed | 0;
  for (let at = 0; at < blocksEnd; at += 4) h = mixWord32(h, view.getInt32(at, true));
  if (blocksEnd < bytes.length) h ^= scramble(tailWord(view, blocksEnd), C1, 15, C2);
  return finish32(h, bytes.length);
}

/**
 * MurmurHash3_x86_32 of the u32 `words` with the u32 `seed`: the same as the byte variant over
 * their little-endian bytes, which have no tail.
 */
export function murmur3x86_32Words(words: readonly number[], seed: number): number {
  let h = seed | 0;
  for (const word of words) h = mixWord32(h, word);
  return finish32(h, words.length * 4);
}

/** The finalization of x86_128: the lanes mix with each other, the length, and fmix32. */
function finish128([a, b, c, d]: Hash128, byteLength: number): Hash128 {
  const h1 = ((a ^ byteLength) + (b ^ byteLength) + (c ^ byteLength) + (d ^ byteLength)) | 0;
  const h2 = fmix32((b ^ byteLength) + h1);
  const h3 = fmix32((c ^ byteLength) + h1);
  const h4 = fmix32((d ^ byteLength) + h1);
  const total = (fmix32(h1) + h2 + h3 + h4) | 0;
  return [total >>> 0, (h2 + total) >>> 0, (h3 + total) >>> 0, (h4 + total) >>> 0];
}

/** The tail of x86_128: the bytes after the last 16-byte block, in up to four lanes. */
function mixTail128(view: DataView, start: number, [a, b, c, d]: Hash128): Hash128 {
  const rest = view.byteLength - start;
  const h1 = rest > 0 ? a ^ scramble(tailWord(view, start), D1, 15, D2) : a;
  const h2 = rest > 4 ? b ^ scramble(tailWord(view, start + 4), D2, 16, D3) : b;
  const h3 = rest > 8 ? c ^ scramble(tailWord(view, start + 8), D3, 17, D4) : c;
  const h4 = rest > 12 ? d ^ scramble(tailWord(view, start + 12), D4, 18, D1) : d;
  return [h1, h2, h3, h4];
}

/** MurmurHash3_x86_128 of `bytes` with the u32 `seed`, as the u32 words h1 to h4. */
export function murmur3x86_128(bytes: Uint8Array, seed: number): Hash128 {
  const view = viewOf(bytes);
  const blocksEnd = bytes.length - (bytes.length % 16);
  let h1 = seed | 0;
  let h2 = h1;
  let h3 = h1;
  let h4 = h1;
  for (let at = 0; at < blocksEnd; at += 16) {
    // Each lane folds in the next one; h4 takes h1 as already updated, as in the reference.
    h1 = fold(h1 ^ scramble(view.getInt32(at, true), D1, 15, D2), 19, h2, 0x561ccd1b);
    h2 = fold(h2 ^ scramble(view.getInt32(at + 4, true), D2, 16, D3), 17, h3, 0x0bcaa747);
    h3 = fold(h3 ^ scramble(view.getInt32(at + 8, true), D3, 17, D4), 15, h4, 0x96cd1c35);
    h4 = fold(h4 ^ scramble(view.getInt32(at + 12, true), D4, 18, D1), 13, h1, 0x32ac3b17);
  }
  return finish128(mixTail128(view, blocksEnd, [h1, h2, h3, h4]), bytes.length);
}
