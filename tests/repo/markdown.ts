/**
 * Markdown helpers shared by the repository checks.
 */

/** Stands in for fenced code: counts as section content, never as a heading or metadata. */
const FENCED_LINE = "[fenced code]";
// CommonMark: a fence marker may be indented at most 3 spaces; 4 or more make an indented code block.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Removes HTML comments and neutralizes fenced code blocks so they never count as structure.
 * A fence closes only with a bare marker of the same character that is at least as long
 * (CommonMark). Comments are tracked across and within lines, so text before an opening marker
 * and after a closing marker stays visible.
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
    const opening = inComment ? undefined : FENCE.exec(line)?.[1];
    if (opening !== undefined) {
      fence = opening;
      return FENCED_LINE;
    }
    let visible = "";
    let rest = line;
    while (rest !== "") {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end === -1) break;
        inComment = false;
        rest = rest.slice(end + "-->".length);
      } else {
        const start = rest.indexOf("<!--");
        if (start === -1) {
          visible += rest;
          break;
        }
        visible += rest.slice(0, start);
        inComment = true;
        rest = rest.slice(start + "<!--".length);
      }
    }
    return visible;
  });
}
