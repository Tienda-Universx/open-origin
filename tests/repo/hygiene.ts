/**
 * Invisible, format and bidirectional control characters can hide code from reviewers
 * ("Trojan Source", CVE-2021-42574) or silently change behavior (a literal BOM in a regex).
 * Text files must write them as escapes instead. Covered: soft hyphen, Arabic letter mark,
 * Mongolian vowel separator, zero-width characters and marks, line and paragraph separators, bidi
 * embeddings, overrides and isolates, invisible operators, deprecated format characters, BOM,
 * interlinear annotations, Unicode tags (used to hide text in prompts) and the supplementary
 * variation selectors.
 * Variation selectors U+FE00 to U+FE0F stay allowed: emoji presentation uses U+FE0F (and text
 * presentation U+FE0E). Zero-width joiners are rejected, so emoji sequences built with them must be
 * written as escapes.
 */
// The combining selectors come first: after a base character a linter reads them as one sequence.
const INVISIBLE =
  /[\u{E0100}-\u{E01EF}\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

export type InvisibleChar = { line: number; codePoint: string };

/** Returns every invisible or bidirectional control character, with its 1-based line. */
export function findInvisibleChars(text: string): InvisibleChar[] {
  const found: InvisibleChar[] = [];
  text.split("\n").forEach((line, index) => {
    for (const [match] of line.matchAll(INVISIBLE)) {
      const hex = match.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
      found.push({ line: index + 1, codePoint: `U+${hex}` });
    }
  });
  return found;
}

const UTF8_KEEPING_BOM = new TextDecoder("utf-8", { ignoreBOM: true });

/** Decodes UTF-8 and keeps a leading BOM, which Bun.file().text() silently drops. */
export function decodeKeepingBom(bytes: Uint8Array): string {
  return UTF8_KEEPING_BOM.decode(bytes);
}

/** Git's heuristic: content with a NUL byte in its first 8000 bytes is binary. */
export function isProbablyText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}
