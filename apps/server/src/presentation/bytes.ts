/**
 * The size of a text on the wire, in UTF-8 bytes (ADR 0026: every limit in bytes counts the UTF-8 a
 * WebSocket text frame carries). Nearly everything the presentation encodes is ASCII JSON, whose
 * size is its length; a text with any other character is measured by the protocol's utf8Length.
 */
import { utf8Length } from "@open-origin/protocol/public";

/** The highest UTF-16 code unit of ASCII, which UTF-8 encodes in one byte. */
const ASCII_MAX = 0x7f;

/** How many bytes the UTF-8 encoding of `text` takes. */
export function byteLength(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > ASCII_MAX) return utf8Length(text);
  }
  return text.length;
}
