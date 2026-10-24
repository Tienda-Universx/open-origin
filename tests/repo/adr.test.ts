import { describe, expect, test } from "bun:test";
import { type AdrFile, validateAdr, validateAdrSet } from "./adr.ts";
import { repoFiles } from "./files.ts";

const ROOT = Bun.fileURLToPath(new URL("../../", import.meta.url));
const DECISIONS = "docs/decisions/";

function adr(
  overrides: Partial<{
    name: string;
    title: string;
    status: string;
    date: string;
    body: string;
  }> = {},
): AdrFile {
  const name = overrides.name ?? "0007-use-sample-decision.md";
  const title = overrides.title ?? "# 0007. Use sample decision";
  const status = overrides.status ?? "Accepted";
  const date = overrides.date ?? "2026-10-24";
  const body =
    overrides.body ??
    [
      "## Context",
      "Why.",
      "",
      "## Decision",
      "What.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
  return {
    name,
    content: [title, "", `- Status: ${status}`, `- Date: ${date}`, "", body, ""].join("\n"),
  };
}

function messages(file: AdrFile): string[] {
  return validateAdr(file).map((issue) => issue.message);
}

describe("validateAdr", () => {
  test("accepts a well-formed ADR", () => {
    expect(validateAdr(adr())).toEqual([]);
  });

  test("rejects a file name without a four-digit number and kebab-case slug", () => {
    expect(messages(adr({ name: "7-Sample Decision.md" }))).toContain(
      "file name must match NNNN-kebab-case-title.md",
    );
  });

  test("rejects a title whose number differs from the file name", () => {
    expect(messages(adr({ title: "# 0008. Use sample decision" }))).toContain(
      "first line must be '# 0007. <Title>'",
    );
  });

  const STATUS_RULE =
    "status must be one of: Proposed, Accepted, Rejected, Deprecated, or 'Superseded by NNNN'";

  test("rejects an unknown status", () => {
    expect(messages(adr({ status: "Maybe" }))).toContain(STATUS_RULE);
  });

  test("rejects a status that only starts with an allowed value", () => {
    expect(messages(adr({ status: "Acceptedish nonsense" }))).toContain(STATUS_RULE);
  });

  test("accepts a superseded status that names the replacing ADR", () => {
    expect(validateAdr(adr({ status: "Superseded by 0012" }))).toEqual([]);
  });

  test("ignores metadata that only appears inside an HTML comment", () => {
    const file = adr();
    const commented = file.content.replace("- Status: Accepted", "<!--\n- Status: Accepted\n-->");
    expect(messages({ ...file, content: commented })).toContain(STATUS_RULE);
  });

  test("ignores headings inside fenced code blocks", () => {
    const body = [
      "## Context",
      "Why.",
      "",
      "## Decisionz",
      "```md",
      "## Decision",
      "```",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain("missing section '## Decision'");
  });

  test("rejects a required section that appears more than once", () => {
    const body = [
      "## Context",
      "Why.",
      "",
      "## Decision",
      "",
      "## Decision",
      "What.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain("section '## Decision' appears more than once");
  });

  test("rejects a date that is not a real ISO calendar date", () => {
    expect(messages(adr({ date: "2026-02-30" }))).toContain("date must be a valid YYYY-MM-DD");
  });

  test("rejects a missing required section", () => {
    const body = [
      "## Context",
      "Why.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain("missing section '## Decision'");
  });

  test("rejects required sections out of order", () => {
    const body = [
      "## Decision",
      "What.",
      "",
      "## Context",
      "Why.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain(
      "sections must appear in order: Context, Decision, Consequences, Alternatives considered",
    );
  });

  test("rejects an empty required section", () => {
    const body = [
      "## Context",
      "",
      "## Decision",
      "What.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain("section '## Context' must not be empty");
  });

  test("rejects a kebab-case slug with uppercase letters", () => {
    expect(messages(adr({ name: "0007-Use-Sample-Decision.md" }))).toContain(
      "file name must match NNNN-kebab-case-title.md",
    );
  });

  test("accepts an ADR saved with a UTF-8 byte order mark", () => {
    const file = adr();
    expect(validateAdr({ ...file, content: `\uFEFF${file.content}` })).toEqual([]);
  });

  test("accepts an ADR with CRLF line endings", () => {
    const file = adr();
    expect(validateAdr({ ...file, content: file.content.replaceAll("\n", "\r\n") })).toEqual([]);
  });

  test("strips inline HTML comments from metadata lines", () => {
    expect(validateAdr(adr({ status: "Accepted <!-- confirmed in review -->" }))).toEqual([]);
  });

  test("reads Status and Date only from the header, before the first section", () => {
    const content = [
      "# 0007. Use sample decision",
      "",
      "- Date: 2026-10-24",
      "",
      "## Context",
      "- Status: Accepted",
      "",
      "## Decision",
      "What.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
      "",
    ].join("\n");
    expect(messages({ name: "0007-use-sample-decision.md", content })).toContain(STATUS_RULE);
  });

  test("accepts a required section whose only content is a fenced code block", () => {
    const body = [
      "## Context",
      "Why.",
      "",
      "## Decision",
      "```text",
      "engine -> commands -> state",
      "```",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(validateAdr(adr({ body }))).toEqual([]);
  });

  test("keeps a fence open until a closing marker of the same kind", () => {
    const body = [
      "## Context",
      "Why.",
      "",
      "## Decisionz",
      "```md",
      "~~~",
      "## Decision",
      "```",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain("missing section '## Decision'");
  });
});

describe("validateAdr, required alternatives and header boundary", () => {
  test("rejects an ADR without an Alternatives considered section", () => {
    const body = [
      "## Context",
      "Why.",
      "",
      "## Decision",
      "What.",
      "",
      "## Consequences",
      "Effects.",
    ].join("\n");
    expect(messages(adr({ body }))).toContain("missing section '## Alternatives considered'");
  });

  test("reads metadata after a bare '## ' line, which is not a section heading", () => {
    const content = [
      "# 0007. Use sample decision",
      "## ",
      "- Status: Accepted",
      "- Date: 2026-10-24",
      "",
      "## Context",
      "Why.",
      "",
      "## Decision",
      "What.",
      "",
      "## Consequences",
      "Effects.",
      "",
      "## Alternatives considered",
      "Options.",
    ].join("\n");
    expect(validateAdr({ name: "0007-use-sample-decision.md", content })).toEqual([]);
  });
});

describe("validateAdr, metadata written once", () => {
  test.each(["Status", "Date"])("rejects a header with two %s lines", (key) => {
    const file = adr();
    const line = key === "Status" ? "- Status: Accepted" : "- Date: 2026-10-24";
    const content = file.content.replace(line, `${line}\n${line}`);
    expect(messages({ ...file, content })).toContain(`metadata '${key}' must appear once`);
  });
});

describe("validateAdrSet", () => {
  test("accepts contiguous numbering starting at 0000", () => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0001-record-decisions.md", title: "# 0001. Record decisions" }),
    ];
    expect(validateAdrSet(files)).toEqual([]);
  });

  test("rejects duplicated numbers", () => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0001-first.md", title: "# 0001. First" }),
      adr({ name: "0001-second.md", title: "# 0001. Second" }),
    ];
    expect(validateAdrSet(files).map((issue) => issue.message)).toContain(
      "number 0001 is used by more than one ADR",
    );
  });

  test("rejects gaps in the numbering", () => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0002-skipped.md", title: "# 0002. Skipped" }),
    ];
    expect(validateAdrSet(files).map((issue) => issue.message)).toContain(
      "numbering must be contiguous from 0000; missing 0001",
    );
  });

  test("rejects a superseded status that names an ADR that does not exist", () => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0001-first.md", title: "# 0001. First", status: "Superseded by 0009" }),
    ];
    expect(validateAdrSet(files).map((issue) => issue.message)).toContain(
      "status names ADR 0009, which does not exist",
    );
  });

  test.each([
    ["itself", "0001"],
    ["the template", "0000"],
  ])("rejects an ADR superseded by %s", (_name, target) => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0001-first.md", title: "# 0001. First", status: `Superseded by ${target}` }),
    ];
    expect(validateAdrSet(files).map((issue) => issue.message)).toContain(
      `an ADR cannot be superseded by itself or by the template (${target})`,
    );
  });

  test("reports a run of missing numbers as one range", () => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0005-fifth.md", title: "# 0005. Fifth" }),
    ];
    expect(validateAdrSet(files).map((issue) => issue.message)).toEqual([
      "numbering must be contiguous from 0000; missing 0001 to 0004",
    ]);
  });

  test("accepts a superseded status that names an existing ADR", () => {
    const files = [
      adr({ name: "0000-adr-template.md", title: "# 0000. ADR template" }),
      adr({ name: "0001-first.md", title: "# 0001. First", status: "Superseded by 0002" }),
      adr({ name: "0002-second.md", title: "# 0002. Second" }),
    ];
    expect(validateAdrSet(files)).toEqual([]);
  });
});

describe("repository ADRs", () => {
  test("every file in docs/decisions is a valid ADR and numbering is contiguous", async () => {
    const files: AdrFile[] = [];
    // Every file git tracks or would track there, whatever its name (dotfiles, .MD, .markdown),
    // so a misnamed ADR cannot be skipped and local-only files cannot fail the check.
    for (const path of repoFiles(ROOT)) {
      if (!path.startsWith(DECISIONS)) continue;
      const file = Bun.file(`${ROOT}${path}`);
      if (await file.exists())
        files.push({ name: path.slice(DECISIONS.length), content: await file.text() });
    }
    // ADRs are superseded, never deleted: the count only grows (0000-0015 so far).
    expect(files.length).toBeGreaterThanOrEqual(16);
    expect(validateAdrSet(files)).toEqual([]);
  });
});
