/**
 * Markdown helpers shared by the repository checks.
 */

/** Stands in for fenced code: counts as section content, never as a heading or metadata. */
const FENCED_LINE = "[fenced code]";
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Removes HTML comments and neutralizes fenced code blocks so they never count as structure.
 * A fence closes only with a marker of the same character that is at least as long (CommonMark).
 */
export function visibleLines(lines: readonly string[]): string[] {
  let inComment = false;
  let fence: string | undefined;
  return lines.map((line) => {
    if (fence !== undefined) {
      const closing = FENCE.exec(line)?.[1];
      const closes =
        closing !== undefined &&
        closing[0] === fence[0] &&
        closing.length >= fence.length &&
        line.trim() === closing;
      if (closes) fence = undefined;
      return FENCED_LINE;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return "";
    }
    const opening = FENCE.exec(line)?.[1];
    if (opening !== undefined) {
      fence = opening;
      return FENCED_LINE;
    }
    if (line.includes("<!--") && !line.includes("-->")) {
      inComment = true;
      return "";
    }
    return line.replace(/<!--.*?-->/g, "");
  });
}
