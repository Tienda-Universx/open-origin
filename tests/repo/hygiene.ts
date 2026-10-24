/**
 * Invisible, format and bidirectional control characters can hide code from reviewers
 * ("Trojan Source", CVE-2021-42574, and identifiers made of the invisible Hangul filler U+3164) or
 * silently change behavior (a literal BOM in a regex). Text files must write them as escapes.
 * Covered: every Unicode default-ignorable code point (zero-width characters and joiners, bidi
 * marks, embeddings, overrides and isolates, soft hyphen, Hangul fillers, variation selectors,
 * Unicode tags, BOM, and the reserved code points Unicode keeps invisible), plus the line and
 * paragraph separators and the interlinear annotation characters.
 * Variation selectors U+FE00 to U+FE0F stay allowed: emoji presentation uses U+FE0F (and text
 * presentation U+FE0E). Zero-width joiners are rejected, so emoji sequences built with them must be
 * written as escapes.
 */
const INVISIBLE =
  /(?![\uFE00-\uFE0F])[\p{Default_Ignorable_Code_Point}\u2028\u2029\uFFF9-\uFFFB]/gu;

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

const STRICT_UTF8 = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

/**
 * Decodes UTF-8 and keeps a leading BOM, which Bun.file().text() silently drops, so the scan can
 * report it. Returns undefined for bytes that are not valid UTF-8 (for example a file saved as
 * Latin-1), which would otherwise decode silently to replacement characters.
 */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Git's heuristic: content with a NUL byte in its first 8000 bytes is binary. */
export function isProbablyText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}
