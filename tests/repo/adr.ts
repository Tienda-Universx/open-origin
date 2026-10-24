/**
 * Format rules for Architecture Decision Records in docs/decisions.
 * See docs/decisions/0000-adr-template.md for the canonical shape.
 */

export type AdrFile = { name: string; content: string };
export type AdrIssue = { file: string; message: string };

const FILE_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUSES = ["Proposed", "Accepted", "Rejected", "Deprecated", "Superseded"] as const;
const SECTIONS = ["Context", "Decision", "Consequences"] as const;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sectionBodies(lines: readonly string[]): Map<string, { index: number; body: string }> {
  const sections = new Map<string, { index: number; body: string }>();
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    const entry = current === undefined ? undefined : sections.get(current);
    if (entry) entry.body = buffer.join("\n").trim();
  };
  lines.forEach((line, index) => {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (!heading?.[1]) {
      buffer.push(line);
      return;
    }
    flush();
    current = heading[1];
    buffer = [];
    if (!sections.has(current)) sections.set(current, { index, body: "" });
  });
  flush();
  return sections;
}

export function validateAdr(file: AdrFile): AdrIssue[] {
  const issues: AdrIssue[] = [];
  const report = (message: string) => issues.push({ file: file.name, message });
  const lines = file.content.split(/\r?\n/);

  const number = FILE_NAME.exec(file.name)?.[1];
  if (number === undefined) {
    report("file name must match NNNN-kebab-case-title.md");
  } else if (!new RegExp(`^# ${number}\\. \\S`).test(lines[0] ?? "")) {
    report(`first line must be '# ${number}. <Title>'`);
  }

  const status = lines.find((line) => line.startsWith("- Status: "))?.slice("- Status: ".length);
  if (!STATUSES.some((allowed) => status?.startsWith(allowed))) {
    report(`status must start with one of: ${STATUSES.join(", ")}`);
  }

  const date = lines.find((line) => line.startsWith("- Date: "))?.slice("- Date: ".length);
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
