/**
 * Checks for the Markdown documentation: relative links must point to existing files and anchors.
 */

import { visibleText } from "./markdown.ts";

export type LinkIssue = { file: string; target: string; reason: "missing file" | "missing anchor" };

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const INLINE_CODE = /`[^`]*`/g;

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

/** Relative link targets of a Markdown document, ignoring code blocks, code spans and URLs. */
function relativeTargets(markdown: string): string[] {
  return visibleText(markdown).flatMap((line) =>
    [...line.replace(INLINE_CODE, "").matchAll(LINK)]
      .map(([, target = ""]) => target)
      .filter((target) => !SCHEME.test(target)),
  );
}

/** A path exists when it is a listed file or a directory that holds one. */
function exists(files: ReadonlySet<string>, path: string): boolean {
  const dir = `${path.replace(/\/$/, "")}/`;
  return files.has(path) || [...files].some((candidate) => candidate.startsWith(dir));
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

function checkLink(context: LinkContext, file: string, target: string): LinkIssue | undefined {
  // Resolving against the linking file also handles "../", "./" and same-file "#anchor" links.
  const url = new URL(target, `file:///${file}`);
  const resolved = decodeURIComponent(url.pathname.slice(1));
  if (!exists(context.files, resolved)) return { file, target, reason: "missing file" };
  const linked = context.docs.get(resolved);
  const fragment = decodeURIComponent(url.hash.slice(1));
  if (fragment === "" || linked === undefined) return undefined;
  if (anchorsOf(context, resolved, linked).has(fragment)) return undefined;
  return { file, target, reason: "missing anchor" };
}

/**
 * Returns every relative link (and same-file anchor) in `docs` that does not resolve.
 * `docs` maps repository-relative Markdown paths to their content; `files` holds every
 * repository-relative file path, so a link to a directory resolves when a file lives under it.
 * External links (any URL scheme) are skipped; links in code blocks and code spans are ignored.
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
