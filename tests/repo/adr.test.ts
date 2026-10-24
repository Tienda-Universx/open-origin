import { describe, expect, test } from "bun:test";
import { type AdrFile, validateAdr, validateAdrSet } from "./adr.ts";

const DECISIONS_DIR = new URL("../../docs/decisions/", import.meta.url);

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
    ["## Context", "Why.", "", "## Decision", "What.", "", "## Consequences", "Effects."].join(
      "\n",
    );
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
    ].join("\n");
    expect(messages(adr({ body }))).toContain("section '## Decision' appears more than once");
  });

  test("rejects a date that is not a real ISO calendar date", () => {
    expect(messages(adr({ date: "2026-02-30" }))).toContain("date must be a valid YYYY-MM-DD");
  });

  test("rejects a missing required section", () => {
    const body = ["## Context", "Why.", "", "## Consequences", "Effects."].join("\n");
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
    ].join("\n");
    expect(messages(adr({ body }))).toContain(
      "sections must appear in order: Context, Decision, Consequences",
    );
  });

  test("rejects an empty required section", () => {
    const body = ["## Context", "", "## Decision", "What.", "", "## Consequences", "Effects."].join(
      "\n",
    );
    expect(messages(adr({ body }))).toContain("section '## Context' must not be empty");
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
});

describe("repository ADRs", () => {
  test("every ADR in docs/decisions is valid and numbered contiguously", async () => {
    const files: AdrFile[] = [];
    for await (const name of new Bun.Glob("*.md").scan({ cwd: Bun.fileURLToPath(DECISIONS_DIR) })) {
      files.push({ name, content: await Bun.file(new URL(name, DECISIONS_DIR)).text() });
    }
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(validateAdrSet(files)).toEqual([]);
  });
});
