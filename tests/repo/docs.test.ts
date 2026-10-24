import { describe, expect, test } from "bun:test";
import { checkLinks, githubSlug, headingAnchors, type LinkIssue, relativeTargets } from "./docs.ts";
import { REPO_ROOT, repoFiles } from "./files.ts";
import { endsInsideBlock } from "./markdown.ts";

/**
 * SHA-256 of the verbatim copies approved by the maintainer. They are records, not living
 * documents: corrections go to ADRs or the tracker. Change a hash only when the maintainer
 * approves a new version of the document itself.
 */
const VERBATIM = {
  "docs/vision/master-vision.es.md":
    "32a9c332dc77d24811352795e7d6c9cf2d8b9b63aee0024bc9e0d9b334af0e46",
  "docs/roadmap/v0.1-plan.es.md":
    "c557c71d26e937b881bc5bc5b553e70cb32411fc162795a1239f737123ec9cc3",
} as const;

function docsOf(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("githubSlug", () => {
  test("lowercases, drops punctuation, keeps accents, and hyphenates spaces", () => {
    expect(githubSlug("Alternatives considered")).toBe("alternatives-considered");
    expect(githubSlug("Qué cambió respecto de la revisión 1")).toBe(
      "qué-cambió-respecto-de-la-revisión-1",
    );
    expect(githubSlug("E.6 Interfaces: pública y `admin`")).toBe("e6-interfaces-pública-y-admin");
  });
});

describe("headingAnchors", () => {
  test("reads the first heading of a file that starts with a byte order mark", () => {
    const markdown = `${String.fromCodePoint(0xfeff)}# Title\r\n## Part two`;
    expect([...headingAnchors(markdown)]).toEqual(["title", "part-two"]);
  });

  test("numbers repeated headings and ignores headings inside code blocks", () => {
    const markdown = ["# Title", "## Notes", "```", "## Fake", "```", "## Notes"].join("\n");
    expect([...headingAnchors(markdown)]).toEqual(["title", "notes", "notes-1"]);
  });
});

describe("checkLinks", () => {
  const files = new Set(["README.md", "docs/a.md", "docs/sub/b.md", "LICENSE"]);

  test("accepts files, directories, anchors, and external links", () => {
    const docs = docsOf({
      "README.md": "[a](docs/a.md) [dir](docs/sub/) [license](LICENSE) [web](https://example.com)",
      "docs/a.md": "# A\n## Part two\n[b](sub/b.md#b) [self](#part-two) [up](../README.md)",
      "docs/sub/b.md": "# B",
    });
    expect(checkLinks(docs, files)).toEqual([]);
  });

  test("reports a link to a missing file", () => {
    const docs = docsOf({ "docs/a.md": "see [gone](missing.md) and [dir](../nowhere/)" });
    expect(checkLinks(docs, files)).toEqual([
      { file: "docs/a.md", target: "missing.md", reason: "missing file" },
      { file: "docs/a.md", target: "../nowhere/", reason: "missing file" },
    ]);
  });

  test("reports a link to a missing anchor, in another file or the same one", () => {
    const docs = docsOf({
      "docs/a.md": "# A\n[b](sub/b.md#nope) [self](#also-nope)",
      "docs/sub/b.md": "# B",
    });
    expect(checkLinks(docs, files)).toEqual([
      { file: "docs/a.md", target: "sub/b.md#nope", reason: "missing anchor" },
      { file: "docs/a.md", target: "#also-nope", reason: "missing anchor" },
    ]);
  });

  test("ignores links inside code blocks and code spans", () => {
    const docs = docsOf({ "docs/a.md": "`[x](missing.md)`\n```\n[y](missing.md)\n```" });
    expect(checkLinks(docs, files)).toEqual([]);
  });

  const missing = (target: string): LinkIssue => ({
    file: "docs/a.md",
    target,
    reason: "missing file",
  });

  test("checks link text that wraps onto the next line", () => {
    const docs = docsOf({ "docs/a.md": "see [the missing\ndocument](missing.md) here" });
    expect(checkLinks(docs, files)).toEqual([missing("missing.md")]);
  });

  test("checks links with any title form, brackets in their text, or parentheses in the path", () => {
    const docs = docsOf({
      "docs/a.md": [
        "[a](single.md 'title') [b](paren.md (title)) [c](double.md \"title\")",
        "[see [ADR] text](nested.md) [d](<spaced name.md>) [e](draft(1).md)",
      ].join("\n"),
    });
    expect(checkLinks(docs, files)).toEqual(
      ["single.md", "paren.md", "double.md", "nested.md", "spaced name.md", "draft(1).md"].map(
        missing,
      ),
    );
  });

  test("checks the targets of reference-style link definitions", () => {
    const docs = docsOf({
      "docs/a.md": '[x][r] and [y][s]\n\n[r]: missing.md "title"\n[s]: <sub/b.md>',
    });
    expect(checkLinks(docs, files)).toEqual([missing("missing.md")]);
  });

  test("does not let a code span hide links beyond the end of its paragraph", () => {
    const docs = docsOf({
      "docs/a.md": "an unclosed `tick\n\n[x](missing.md) and a `closed` span",
    });
    expect(checkLinks(docs, files)).toEqual([missing("missing.md")]);
  });

  test("does not mistake footnotes or prose for link definitions", () => {
    const docs = docsOf({
      "docs/a.md": [
        "Text.[^1]",
        "",
        "[^1]: Pending.",
        "[^2]: See ADR 0003 for details.",
        "",
        "[Nota]: revisar esto después",
        "",
        "A definition cannot interrupt a paragraph:",
        "[r]: lazy.md",
      ].join("\n"),
    });
    expect(checkLinks(docs, files)).toEqual([]);
  });

  test("does not pair backticks across list items", () => {
    const docs = docsOf({
      "docs/a.md": "- type a ` to start\n- see [a](missing.md)\n- run `bun test`",
    });
    expect(checkLinks(docs, files)).toEqual([missing("missing.md")]);
  });

  test("checks both an image and the link around it", () => {
    const docs = docsOf({ "docs/a.md": "[![CI](badge.svg)](missing.md)" });
    expect(checkLinks(docs, files)).toEqual([missing("missing.md"), missing("badge.svg")]);
  });

  test("reports a link that climbs above the repository root", () => {
    const docs = docsOf({ "README.md": "[up](../)", "docs/a.md": "[up](../../docs/a.md)" });
    expect(checkLinks(docs, files)).toEqual([
      { file: "README.md", target: "../", reason: "missing file" },
      missing("../../docs/a.md"),
    ]);
  });

  test("reports a link that climbs above the root with percent-encoded dots", () => {
    // URL resolution reads %2e as a dot and stops at the root, so the link would look valid.
    const docs = docsOf({ "README.md": "[a](%2e%2e/README.md) [b](.%2E/README.md)" });
    expect(checkLinks(docs, files)).toEqual([
      { file: "README.md", target: "%2e%2e/README.md", reason: "missing file" },
      { file: "README.md", target: ".%2E/README.md", reason: "missing file" },
    ]);
  });

  test("treats protocol-relative URLs as external", () => {
    expect(checkLinks(docsOf({ "docs/a.md": "[x](//example.com/page)" }), files)).toEqual([]);
  });

  test("reports a malformed link instead of failing without context", () => {
    const docs = docsOf({ "docs/a.md": "[x](100%.md) [y](%E0%A4%A.md)" });
    expect(checkLinks(docs, files)).toEqual([
      { file: "docs/a.md", target: "100%.md", reason: "invalid link" },
      { file: "docs/a.md", target: "%E0%A4%A.md", reason: "invalid link" },
    ]);
  });

  test("accepts links to the repository root and paths with parentheses", () => {
    const withParens = new Set([...files, "docs/a (1).md", "docs/b(2).md"]);
    const docs = docsOf({
      "README.md": "[root](./) [p](<docs/a (1).md>) [q](docs/b(2).md)",
      "docs/a.md": "[root](..) [also root](../)",
    });
    expect(checkLinks(docs, withParens)).toEqual([]);
  });
});

describe("repository documentation", () => {
  test("every relative link in tracked Markdown files resolves", async () => {
    // git still lists a tracked file deleted from the working tree; a link to it must not resolve.
    const files: string[] = [];
    for (const path of repoFiles(REPO_ROOT)) {
      if (await Bun.file(`${REPO_ROOT}${path}`).exists()) files.push(path);
    }
    const docs = new Map<string, string>();
    for (const path of files.filter((file) => file.endsWith(".md"))) {
      docs.set(path, await Bun.file(`${REPO_ROOT}${path}`).text());
    }
    // Guard against a vacuous pass: the scan must find the links of the documents that carry them,
    // and no document may end inside a block that hides its later lines.
    expect(relativeTargets(docs.get("README.md") ?? "")).not.toEqual([]);
    expect(relativeTargets(docs.get("docs/architecture/overview.md") ?? "")).not.toEqual([]);
    expect([...docs.keys()].filter((path) => endsInsideBlock(docs.get(path) ?? ""))).toEqual([]);
    expect(checkLinks(docs, new Set(files))).toEqual([]);
  });

  test.each(Object.entries(VERBATIM))(
    "%s is byte-identical to the approved copy",
    async (path, sha256) => {
      const bytes = await Bun.file(`${REPO_ROOT}${path}`).bytes();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sha256);
    },
  );
});
