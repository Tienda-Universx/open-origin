/**
 * Base64 (RFC 4648, section 4: the standard alphabet, with padding), written out because
 * ECMAScript 2024 has none and the package must run in any JavaScript engine. The decoder accepts
 * only the canonical encoding of some bytes: the exact length, the alphabet, padding only at the
 * end, and zero bits after the last byte, so every byte string has exactly one accepted text.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD = "=";

/** The value of each character code below 128 in ALPHABET, or −1 when it is not in it. */
const VALUES = Object.freeze(
  Array.from({ length: 128 }, (_, code) => ALPHABET.indexOf(String.fromCharCode(code))),
);

/** How many characters the encoding of `byteCount` bytes takes. */
export function base64Length(byteCount: number): number {
  return 4 * Math.ceil(byteCount / 3);
}

/** The character of the 6-bit value at bit `shift` of `group`. */
function sextet(group: number, shift: number): string {
  return ALPHABET.charAt((group >>> shift) & 0x3f);
}

/** The canonical Base64 text of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += 3) {
    const left = bytes.length - at;
    const group = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
    parts.push(
      sextet(group, 18) +
        sextet(group, 12) +
        (left > 1 ? sextet(group, 6) : PAD) +
        (left > 2 ? sextet(group, 0) : PAD),
    );
  }
  return parts.join("");
}

/** The value of the character at `index` of `text`, or −1 when it is not in ALPHABET. */
function valueAt(text: string, index: number): number {
  return VALUES[text.charCodeAt(index)] ?? -1;
}

/** How many padding characters end `text`: 0, 1, or 2; 3 for a text that cannot be canonical. */
function padding(text: string): number {
  if (!text.endsWith(PAD)) return 0;
  return text.endsWith(PAD + PAD) ? 2 : 1;
}

/** The 24 bits of the 4 characters at `at`, the last `pad` of them padding; −1 for a bad one. */
function groupAt(text: string, at: number, pad: number): number {
  let group = 0;
  for (let index = 0; index < 4; index += 1) {
    const value = index < 4 - pad ? valueAt(text, at + index) : 0;
    if (value < 0) return -1;
    group = (group << 6) | value;
  }
  return group;
}

/**
 * The bytes whose canonical Base64 text is `text`, or undefined when `text` is not one: a length
 * that is not a multiple of 4, a character outside the alphabet, padding before the end, or bits
 * set after the last byte.
 */
export function decodeBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0) return undefined;
  const pad = padding(text);
  const bytes = new Uint8Array((text.length / 4) * 3 - pad);
  for (let at = 0, out = 0; at < text.length; at += 4, out += 3) {
    const last = at + 4 === text.length;
    const group = groupAt(text, at, last ? pad : 0);
    if (group < 0) return undefined;
    // The bits below the last byte of a padded group must be zero, so the text is canonical.
    if (last && (group & ((1 << (8 * pad)) - 1)) !== 0) return undefined;
    bytes[out] = group >>> 16;
    if (out + 1 < bytes.length) bytes[out + 1] = (group >>> 8) & 0xff;
    if (out + 2 < bytes.length) bytes[out + 2] = group & 0xff;
  }
  return bytes;
}
