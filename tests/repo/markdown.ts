/**
 * Markdown helpers shared by the repository checks.
 */

/** Stands in for fenced code: counts as section content, never as a heading or metadata. */
const FENCED_LINE = "[fenced code]";
// CommonMark: a fence marker may be indented at most 3 spaces; 4 or more make an indented code block.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A fence closes only with a bare marker of the same character that is at least as long. */
function closesFence(line: string, fence: string): boolean {
  const closing = FENCE.exec(line)?.[1];
  return (
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length &&
    line.trim() === closing
  );
}

/** The visible text of one line, given whether an HTML comment is open when it starts. */
function stripComments(line: string, inComment: boolean): { visible: string; inComment: boolean } {
  let visible = "";
  let rest = line;
  let open = inComment;
  while (rest !== "") {
    const marker = open ? "-->" : "<!--";
    const at = rest.indexOf(marker);
    if (at === -1) {
      if (!open) visible += rest;
      break;
    }
    if (!open) visible += rest.slice(0, at);
    open = !open;
    rest = rest.slice(at + marker.length);
  }
  return { visible, inComment: open };
}

/**
 * Removes HTML comments and neutralizes fenced code blocks so they never count as structure
 * (CommonMark fences; comments tracked within and across lines, so text before an opening marker
 * and after a closing marker stays visible).
 */
export function visibleLines(lines: readonly string[]): string[] {
  let inComment = false;
  let fence: string | undefined;
  return lines.map((line) => {
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      return FENCED_LINE;
    }
    const opening = inComment ? undefined : FENCE.exec(line)?.[1];
    if (opening !== undefined) {
      fence = opening;
      return FENCED_LINE;
    }
    const stripped = stripComments(line, inComment);
    inComment = stripped.inComment;
    return stripped.visible;
  });
}

/** The visible lines of a Markdown document: no BOM, CRLF or LF line breaks, see visibleLines. */
export function visibleText(markdown: string): string[] {
  return visibleLines(markdown.replace(/^\uFEFF/, "").split(/\r?\n/));
}

/**
 * Whether a document ends inside a fenced code block or an HTML comment. An unclosed block hides
 * every later line from the checks; a comment marker shown in a code span opens one by mistake.
 */
export function endsInsideBlock(markdown: string): boolean {
  const sentinel = "end of document";
  return visibleText(`${markdown}\n${sentinel}`).at(-1) !== sentinel;
}
