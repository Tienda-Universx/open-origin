/**
 * The size of a text on the wire: WebSocket text frames carry UTF-8, so every limit in bytes counts
 * the UTF-8 encoding, computed here without a host encoder.
 */

/**
 * How many bytes the UTF-8 encoding of `text` takes. A lone surrogate counts as U+FFFD, three
 * bytes, the replacement every encoder writes for it.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x80) bytes += 1;
    else if (point < 0x800) bytes += 2;
    else if (point < 0x1_0000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
