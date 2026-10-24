/**
 * Checks for the Markdown documentation: relative links must point to existing files and anchors.
 */

import { visibleText } from "./markdown.ts";

export type LinkIssue = {
  file: string;
  target: string;
  reason: "missing file" | "missing anchor" | "invalid link";
};

// Inline links: text with at most one level of nested brackets, a destination in angle brackets
// (which may hold spaces) or bare (which may hold one level of balanced parentheses), and an
// optional title in double quotes, single quotes, or parentheses. The pattern sits in a lookahead
// so that a link nested in another one's text, such as an image inside a link, is found too.
const TEXT = String.raw`\[(?:[^\[\]]|\[[^\[\]]*\])*\]`;
const DESTINATION = String.raw`<([^<>\n]*)>|([^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)`;
const TITLE = String.raw`"[^"]*"|'[^']*'|\([^()]*\)`;
const LINK = new RegExp(`(?=${TEXT}\\(\\s*(?:${DESTINATION})(?:\\s+(?:${TITLE}))?\\s*\\))`, "g");
/**
 * A reference-style link definition on one line: `[label]: destination "optional title"`, with
 * nothing else after it. Footnotes (`[^1]: ...`) are not link definitions.
 */
const DEFINITION = new RegExp(
  String.raw`^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(?:${DESTINATION})(?:[ \t]+(?:${TITLE}))?[ \t]*$`,
);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
/** A code span; it may wrap onto several lines, but never past its block. */
const CODE_SPAN = /`[^`]*`/g;
/** Where a block ends: a blank line, or a line that starts a list item or a heading. */
const BLOCK_BREAK = /\n[ \t]*\n|\n(?=[ \t]{0,3}(?:[-*+]|\d{1,9}[.)]|#{1,6})[ \t])/;

/** GitHub's heading anchor: lowercase, punctuation removed, each space becomes a hyphen. */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Anchors GitHub generates for the headings of a Markdown file (duplicates get -1, -2, ...). */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of visibleText(markdown)) {
    const text = HEADING.exec(line)?.[1];
    if (text === undefined) continue;
    const slug = githubSlug(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/** The destination a link or definition match captured, in angle brackets or bare. */
function destination([, angled, bare]: RegExpMatchArray): string {
  return angled ?? bare ?? "";
}

/** Reference-style definitions open a block: they cannot interrupt a paragraph. */
function definitionTargets(block: string): string[] {
  const targets: string[] = [];
  for (const line of block.split("\n")) {
    const match = DEFINITION.exec(line);
    if (match === null) break;
    targets.push(destination(match));
  }
  return targets;
}

/** A target with a URL scheme, or protocol-relative (`//host/path`), points outside the repository. */
function isExternal(target: string): boolean {
  return SCHEME.test(target) || target.startsWith("//");
}

/**
 * Relative link targets of a Markdown document, in order: inline links (whose text may wrap onto
 * the next line) and reference-style definitions. Code blocks, code spans, and external URLs are
 * ignored. This approximates CommonMark; the documentation uses none of the cases it misses:
 * HTML `href` attributes, anchors of headings with inline formatting, definitions directly under a
 * heading or code block, backslashes in paths, escaped backticks, and a stray backtick in a table.
 */
export function relativeTargets(markdown: string): string[] {
  return visibleText(markdown)
    .join("\n")
    .split(BLOCK_BREAK)
    .flatMap((block) => {
      const text = block.replace(CODE_SPAN, "");
      return [...[...text.matchAll(LINK)].map(destination), ...definitionTargets(text)];
    })
    .filter((target) => target !== "" && !isExternal(target));
}

/** A path exists when it is the repository root, a listed file, or a directory that holds one. */
function exists(files: ReadonlySet<string>, path: string): boolean {
  if (path === "") return true;
  const dir = `${path.replace(/\/$/, "")}/`;
  return files.has(path) || [...files].some((candidate) => candidate.startsWith(dir));
}

/** Percent-decodes a link component, or returns undefined when its encoding is malformed. */
function decode(component: string): string | undefined {
  try {
    return decodeURIComponent(component);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

type LinkContext = {
  docs: ReadonlyMap<string, string>;
  files: ReadonlySet<string>;
  anchors: Map<string, Set<string>>;
};

function anchorsOf(context: LinkContext, path: string, markdown: string): Set<string> {
  const anchors = context.anchors.get(path) ?? headingAnchors(markdown);
  context.anchors.set(path, anchors);
  return anchors;
}

/** The repository path and anchor a link points to, or undefined when it is malformed. */
function resolve(file: string, target: string): { path: string; fragment: string } | undefined {
  // Resolving against the linking file also handles "../", "./" and same-file "#anchor" links.
  const url = URL.parse(target, `file:///${file}`);
  if (url === null) return undefined;
  const path = decode(url.pathname.slice(1));
  const fragment = decode(url.hash.slice(1));
  if (path === undefined || fragment === undefined) return undefined;
  return { path, fragment };
}

/** Whether a relative link climbs above the repository root, which URL resolution hides. */
function leavesRepository(file: string, target: string): boolean {
  let depth = file.split("/").length - 1;
  for (const raw of (target.split(/[?#]/)[0] ?? "").split("/")) {
    // URL resolution reads a percent-encoded dot (%2e or %2E) as a dot in `.` and `..` segments.
    const segment = raw.replace(/%2e/gi, ".");
    if (segment === "..") depth -= 1;
    else if (segment !== "." && segment !== "") depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

function checkLink(context: LinkContext, file: string, target: string): LinkIssue | undefined {
  const link = resolve(file, target);
  if (link === undefined) return { file, target, reason: "invalid link" };
  if (leavesRepository(file, target) || !exists(context.files, link.path)) {
    return { file, target, reason: "missing file" };
  }
  const linked = context.docs.get(link.path);
  if (link.fragment === "" || linked === undefined) return undefined;
  if (anchorsOf(context, link.path, linked).has(link.fragment)) return undefined;
  return { file, target, reason: "missing anchor" };
}

/**
 * Returns every relative link (and same-file anchor) in `docs` that does not resolve.
 * `docs` maps repository-relative Markdown paths to their content; `files` holds every
 * repository-relative file path, so a link to a directory resolves when a file lives under it.
 */
export function checkLinks(
  docs: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
): LinkIssue[] {
  const context: LinkContext = { docs, files, anchors: new Map() };
  return [...docs].flatMap(([file, content]) =>
    relativeTargets(content).flatMap((target) => {
      const issue = checkLink(context, file, target);
      return issue === undefined ? [] : [issue];
    }),
  );
}
