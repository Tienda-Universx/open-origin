/**
 * Format rules for Architecture Decision Records in docs/decisions.
 * See docs/decisions/0000-adr-template.md for the canonical shape.
 */

export type AdrFile = { name: string; content: string };
export type AdrIssue = { file: string; message: string };

const FILE_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUS = /^(?:Proposed|Accepted|Rejected|Deprecated|Superseded by \d{4})$/;
const SECTIONS = ["Context", "Decision", "Consequences"] as const;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Stands in for fenced code: counts as section content, never as a heading or metadata. */
const FENCED_LINE = "[fenced code]";
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Removes HTML comments and neutralizes fenced code blocks so they never count as structure.
 * A fence closes only with a marker of the same character that is at least as long (CommonMark).
 */
function visibleLines(lines: readonly string[]): string[] {
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

type Section = { index: number; body: string; count: number };

function sectionBodies(lines: readonly string[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (current && current.body === "") current.body = buffer.join("\n").trim();
  };
  lines.forEach((line, index) => {
    const heading = /^## (.+?)\s*$/.exec(line)?.[1];
    if (heading === undefined) {
      buffer.push(line);
      return;
    }
    flush();
    buffer = [];
    const existing = sections.get(heading);
    if (existing) {
      existing.count += 1;
      current = existing;
    } else {
      current = { index, body: "", count: 1 };
      sections.set(heading, current);
    }
  });
  flush();
  return sections;
}

export function validateAdr(file: AdrFile): AdrIssue[] {
  const issues: AdrIssue[] = [];
  const report = (message: string) => issues.push({ file: file.name, message });
  const raw = file.content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const lines = visibleLines(raw);
  // Status and Date belong to the header: everything before the first "## " section.
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  const header = firstSection === -1 ? lines : lines.slice(0, firstSection);

  const number = FILE_NAME.exec(file.name)?.[1];
  if (number === undefined) {
    report("file name must match NNNN-kebab-case-title.md");
  } else if (!new RegExp(`^# ${number}\\. \\S`).test(lines[0] ?? "")) {
    report(`first line must be '# ${number}. <Title>'`);
  }

  const status = header.find((line) => line.startsWith("- Status: "))?.slice("- Status: ".length);
  if (status === undefined || !STATUS.test(status.trim())) {
    report(
      "status must be one of: Proposed, Accepted, Rejected, Deprecated, or 'Superseded by NNNN'",
    );
  }

  const date = header.find((line) => line.startsWith("- Date: "))?.slice("- Date: ".length);
  if (date === undefined || !isCalendarDate(date.trim())) {
    report("date must be a valid YYYY-MM-DD");
  }

  const sections = sectionBodies(lines);
  const positions: number[] = [];
  for (const name of SECTIONS) {
    const section = sections.get(name);
    if (!section) {
      report(`missing section '## ${name}'`);
      continue;
    }
    positions.push(section.index);
    if (section.count > 1) report(`section '## ${name}' appears more than once`);
    if (section.body === "") report(`section '## ${name}' must not be empty`);
  }
  if (positions.some((position, i) => i > 0 && position < (positions[i - 1] ?? 0))) {
    report(`sections must appear in order: ${SECTIONS.join(", ")}`);
  }

  return issues;
}

export function validateAdrSet(files: readonly AdrFile[]): AdrIssue[] {
  const issues = files.flatMap(validateAdr);
  const byNumber = new Map<number, string[]>();
  for (const file of files) {
    const number = FILE_NAME.exec(file.name)?.[1];
    if (number === undefined) continue;
    const names = byNumber.get(Number(number)) ?? [];
    names.push(file.name);
    byNumber.set(Number(number), names);
  }

  const pad = (n: number) => String(n).padStart(4, "0");
  for (const [number, names] of byNumber) {
    if (names.length > 1) {
      issues.push({
        file: names.join(", "),
        message: `number ${pad(number)} is used by more than one ADR`,
      });
    }
  }
  const highest = Math.max(-1, ...byNumber.keys());
  for (let n = 0; n <= highest; n++) {
    if (!byNumber.has(n)) {
      issues.push({
        file: "docs/decisions",
        message: `numbering must be contiguous from 0000; missing ${pad(n)}`,
      });
    }
  }
  return issues;
}
