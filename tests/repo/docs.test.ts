import { describe, expect, test } from "bun:test";
import { checkLinks, githubSlug, headingAnchors } from "./docs.ts";
import { repoFiles } from "./files.ts";

const ROOT = Bun.fileURLToPath(new URL("../../", import.meta.url));

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
});

describe("repository documentation", () => {
  test("every relative link in tracked Markdown files resolves", async () => {
    const files = repoFiles(ROOT);
    const docs = new Map<string, string>();
    for (const path of files.filter((file) => file.endsWith(".md"))) {
      const file = Bun.file(`${ROOT}${path}`);
      if (await file.exists()) docs.set(path, await file.text());
    }
    // Guard against a vacuous pass: the scan must see the documents that carry links.
    expect(docs.has("README.md")).toBe(true);
    expect(docs.has("docs/architecture/overview.md")).toBe(true);
    expect(checkLinks(docs, new Set(files))).toEqual([]);
  });

  test.each(Object.entries(VERBATIM))(
    "%s is byte-identical to the approved copy",
    async (path, sha256) => {
      const bytes = await Bun.file(`${ROOT}${path}`).bytes();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sha256);
    },
  );
});
