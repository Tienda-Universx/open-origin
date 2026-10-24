/**
 * Format rules for Architecture Decision Records in docs/decisions.
 * See docs/decisions/0000-adr-template.md for the canonical shape.
 */

import { visibleLines } from "./markdown.ts";

export type AdrFile = { name: string; content: string };
export type AdrIssue = { file: string; message: string };

const FILE_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const STATUS = /^(?:Proposed|Accepted|Rejected|Deprecated|Superseded by \d{4})$/;
const SECTIONS = ["Context", "Decision", "Consequences", "Alternatives considered"] as const;
/** A second-level heading with text; a bare "## " line is not a heading. */
const SECTION_HEADING = /^## (.+?)\s*$/;
const SUPERSEDED = /^Superseded by (\d{4})$/;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

type Section = { index: number; body: string; count: number };

function sectionBodies(lines: readonly string[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  let buffer: string[] = [];
  // A repeated heading keeps the first non-empty body; the repetition itself is reported.
  const flush = () => {
    if (current && current.body === "") current.body = buffer.join("\n").trim();
  };
  lines.forEach((line, index) => {
    const heading = SECTION_HEADING.exec(line)?.[1];
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

/** Status and Date belong to the header: every visible line before the first section heading. */
function headerOf(lines: readonly string[]): readonly string[] {
  const firstSection = lines.findIndex((line) => SECTION_HEADING.test(line));
  return firstSection === -1 ? lines : lines.slice(0, firstSection);
}

function metadata(header: readonly string[], key: "Status" | "Date"): string | undefined {
  const prefix = `- ${key}: `;
  return header
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

export function validateAdr(file: AdrFile): AdrIssue[] {
  const issues: AdrIssue[] = [];
  const report = (message: string) => issues.push({ file: file.name, message });
  const lines = visibleLines(file.content.replace(/^\uFEFF/, "").split(/\r?\n/));
  const header = headerOf(lines);

  const number = FILE_NAME.exec(file.name)?.[1];
  if (number === undefined) {
    report("file name must match NNNN-kebab-case-title.md");
  } else if (!new RegExp(`^# ${number}\\. \\S`).test(lines[0] ?? "")) {
    report(`first line must be '# ${number}. <Title>'`);
  }

  const status = metadata(header, "Status");
  if (status === undefined || !STATUS.test(status)) {
    report(
      "status must be one of: Proposed, Accepted, Rejected, Deprecated, or 'Superseded by NNNN'",
    );
  }

  const date = metadata(header, "Date");
  if (date === undefined || !isCalendarDate(date)) {
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
  for (const file of files) {
    const lines = visibleLines(file.content.replace(/^\uFEFF/, "").split(/\r?\n/));
    const target = SUPERSEDED.exec(metadata(headerOf(lines), "Status") ?? "")?.[1];
    if (target !== undefined && !byNumber.has(Number(target))) {
      issues.push({ file: file.name, message: `status names ADR ${target}, which does not exist` });
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
