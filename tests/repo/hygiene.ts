/**
 * Invisible and bidirectional control characters can hide code from reviewers
 * ("Trojan Source", CVE-2021-42574) or silently change behavior (a literal BOM in a regex).
 * Text files must write them as escapes instead.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

export type InvisibleChar = { line: number; codePoint: string };

/** Returns the first invisible or bidirectional control character of each line (1-based lines). */
export function findInvisibleChars(text: string): InvisibleChar[] {
  const found: InvisibleChar[] = [];
  text.split("\n").forEach((line, index) => {
    const match = INVISIBLE.exec(line)?.[0];
    if (match !== undefined) {
      const hex = match.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
      found.push({ line: index + 1, codePoint: `U+${hex}` });
    }
  });
  return found;
}
