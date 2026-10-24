/**
 * UTF-8 encoding inside the core, since `TextEncoder` is a host API and not ECMAScript (plan
 * §5.2). Digests hash these bytes; adapters decode them with a fatal `TextDecoder`.
 */
import { EngineError } from "../errors.ts";

/** Whether the UTF-16 code unit `unit` is a high (leading) surrogate, U+D800 to U+DBFF. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Whether `unit` is a low (trailing) surrogate, U+DC00 to U+DFFF. NaN, which `charCodeAt` returns
 * past the end of a string, is not.
 */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The UTF-16 offset of the first lone surrogate in `text`, which must have one: a high surrogate
 * that no low surrogate follows, or a low surrogate that does not complete a pair. A pair is
 * skipped whole, so its low surrogate is never taken for a lone one.
 */
function loneSurrogateOffset(text: string): number {
  for (let offset = 0; offset < text.length; offset += 1) {
    const unit = text.charCodeAt(offset);
    if (isLowSurrogate(unit)) return offset;
    if (isHighSurrogate(unit)) {
      if (!isLowSurrogate(text.charCodeAt(offset + 1))) return offset;
      offset += 1;
    }
  }
  return text.length;
}

/**
 * How many bytes the UTF-8 form of `text` takes, without encoding it. `text` must be well formed,
 * as canonical strings are: a lone surrogate has no UTF-8 form, and its count means nothing.
 */
export function utf8Length(text: string): number {
  let length = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    const unit = text.charCodeAt(offset);
    if (unit < 0x80) length += 1;
    else if (unit < 0x800) length += 2;
    else if (isHighSurrogate(unit)) {
      // A pair: one code point of 4 bytes, and its low surrogate adds nothing.
      length += 4;
      offset += 1;
    } else length += 3;
  }
  return length;
}

/** Writes `point`, from U+0080, at `at` and returns the offset after it. */
function writeMultibyte(bytes: Uint8Array, at: number, point: number): number {
  if (point < 0x800) {
    bytes[at] = 0xc0 | (point >> 6);
    bytes[at + 1] = 0x80 | (point & 0x3f);
    return at + 2;
  }
  if (point < 0x10000) {
    bytes[at] = 0xe0 | (point >> 12);
    bytes[at + 1] = 0x80 | ((point >> 6) & 0x3f);
    bytes[at + 2] = 0x80 | (point & 0x3f);
    return at + 3;
  }
  bytes[at] = 0xf0 | (point >> 18);
  bytes[at + 1] = 0x80 | ((point >> 12) & 0x3f);
  bytes[at + 2] = 0x80 | ((point >> 6) & 0x3f);
  bytes[at + 3] = 0x80 | (point & 0x3f);
  return at + 4;
}

/**
 * The UTF-8 bytes of `text`, in an array of exactly their length. Throws
 * EngineError("invalid_value") when `text` has a lone surrogate, which has no UTF-8 form.
 */
export function utf8Encode(text: string): Uint8Array {
  if (!text.isWellFormed()) {
    const offset = loneSurrogateOffset(text);
    const message = `the text has a lone surrogate at UTF-16 offset ${offset}: strings must be well-formed UTF-16`;
    throw new EngineError("invalid_value", [{ path: "", message }]);
  }
  const bytes = new Uint8Array(utf8Length(text));
  let at = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    const unit = text.charCodeAt(offset);
    if (unit < 0x80) {
      bytes[at] = unit;
      at += 1;
    } else if (isHighSurrogate(unit)) {
      const point = 0x10000 + (unit - 0xd800) * 0x400 + (text.charCodeAt(offset + 1) - 0xdc00);
      at = writeMultibyte(bytes, at, point);
      offset += 1;
    } else at = writeMultibyte(bytes, at, unit);
  }
  return bytes;
}
