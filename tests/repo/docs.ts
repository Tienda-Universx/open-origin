/**
 * Checks for the Markdown documentation: relative links must point to existing files and anchors.
 */

import { visibleLines } from "./markdown.ts";

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
  for (const line of visibleLines(markdown.split(/\r?\n/))) {
    const text = HEADING.exec(line)?.[1];
    if (text === undefined) continue;
    const slug = githubSlug(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/** Repository-relative path of `target` as seen from `file` (both POSIX, no leading slash). */
function resolve(file: string, target: string): string {
  return decodeURIComponent(new URL(target, `file:///${file}`).pathname.slice(1));
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
  const issues: LinkIssue[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const exists = (path: string): boolean => {
    const dir = `${path.replace(/\/$/, "")}/`;
    return files.has(path) || [...files].some((candidate) => candidate.startsWith(dir));
  };
  for (const [file, content] of docs) {
    for (const line of visibleLines(content.split(/\r?\n/))) {
      for (const [, target = ""] of line.replace(INLINE_CODE, "").matchAll(LINK)) {
        if (SCHEME.test(target)) continue;
        const hash = target.indexOf("#");
        const pathPart = hash === -1 ? target : target.slice(0, hash);
        const fragment = hash === -1 ? "" : target.slice(hash + 1);
        const resolved = pathPart === "" ? file : resolve(file, pathPart);
        if (!exists(resolved)) {
          issues.push({ file, target, reason: "missing file" });
          continue;
        }
        const linked = docs.get(resolved);
        if (fragment === "" || linked === undefined) continue;
        let anchors = anchorCache.get(resolved);
        if (anchors === undefined) {
          anchors = headingAnchors(linked);
          anchorCache.set(resolved, anchors);
        }
        if (!anchors.has(decodeURIComponent(fragment))) {
          issues.push({ file, target, reason: "missing anchor" });
        }
      }
    }
  }
  return issues;
}
