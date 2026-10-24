/**
 * Format rules for Architecture Decision Records in docs/decisions.
 * See docs/decisions/0000-adr-template.md for the canonical shape.
 */

import { visibleText } from "./markdown.ts";

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

type MetadataKey = "Status" | "Date";

function metadataValues(header: readonly string[], key: MetadataKey): string[] {
  const prefix = `- ${key}: `;
  return header
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}

/** An ADR read once: visible lines (no BOM, comments or fenced code) and its header. */
type ParsedAdr = { file: AdrFile; lines: readonly string[]; header: readonly string[] };

function parseAdr(file: AdrFile): ParsedAdr {
  const lines = visibleText(file.content);
  return { file, lines, header: headerOf(lines) };
}

type Report = (message: string) => void;

function checkNameAndTitle({ file, lines }: ParsedAdr, report: Report): void {
  const number = FILE_NAME.exec(file.name)?.[1];
  if (number === undefined) {
    report("file name must match NNNN-kebab-case-title.md");
    return;
  }
  if (!new RegExp(`^# ${number}\\. \\S`).test(lines[0] ?? ""))
    report(`first line must be '# ${number}. <Title>'`);
}

function checkMetadata(header: readonly string[], report: Report): void {
  for (const key of ["Status", "Date"] as const) {
    if (metadataValues(header, key).length > 1) report(`metadata '${key}' must appear once`);
  }
  const [status] = metadataValues(header, "Status");
  if (status === undefined || !STATUS.test(status)) {
    report(
      "status must be one of: Proposed, Accepted, Rejected, Deprecated, or 'Superseded by NNNN'",
    );
  }
  const [date] = metadataValues(header, "Date");
  if (date === undefined || !isCalendarDate(date)) report("date must be a valid YYYY-MM-DD");
}

function checkSections(lines: readonly string[], report: Report): void {
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
}

function issuesOf(adr: ParsedAdr): AdrIssue[] {
  const issues: AdrIssue[] = [];
  const report: Report = (message) => issues.push({ file: adr.file.name, message });
  checkNameAndTitle(adr, report);
  checkMetadata(adr.header, report);
  checkSections(adr.lines, report);
  return issues;
}

export function validateAdr(file: AdrFile): AdrIssue[] {
  return issuesOf(parseAdr(file));
}

const pad = (n: number): string => String(n).padStart(4, "0");

/** ADR numbers mapped to the file names that use them. */
function numberIndex(files: readonly AdrFile[]): Map<number, string[]> {
  const byNumber = new Map<number, string[]>();
  for (const file of files) {
    const number = FILE_NAME.exec(file.name)?.[1];
    if (number === undefined) continue;
    byNumber.set(Number(number), [...(byNumber.get(Number(number)) ?? []), file.name]);
  }
  return byNumber;
}

function duplicateNumbers(byNumber: ReadonlyMap<number, string[]>): AdrIssue[] {
  return [...byNumber]
    .filter(([, names]) => names.length > 1)
    .map(([number, names]) => ({
      file: names.join(", "),
      message: `number ${pad(number)} is used by more than one ADR`,
    }));
}

/** A "Superseded by NNNN" status must name another existing ADR, never itself or the template. */
function supersessionIssues(
  adrs: readonly ParsedAdr[],
  byNumber: ReadonlyMap<number, string[]>,
): AdrIssue[] {
  return adrs.flatMap(({ file, header }) => {
    const [status = ""] = metadataValues(header, "Status");
    const target = SUPERSEDED.exec(status)?.[1];
    if (target === undefined) return [];
    if (target === FILE_NAME.exec(file.name)?.[1] || Number(target) === 0) {
      return [
        {
          file: file.name,
          message: `an ADR cannot be superseded by itself or by the template (${target})`,
        },
      ];
    }
    if (byNumber.has(Number(target))) return [];
    return [{ file: file.name, message: `status names ADR ${target}, which does not exist` }];
  });
}

/** Runs of missing numbers from 0000 to the highest one, so one typo yields one issue. */
function missingRanges(present: ReadonlySet<number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let n = 0; n <= Math.max(-1, ...present); n++) {
    if (present.has(n)) continue;
    const last = ranges.at(-1);
    if (last !== undefined && last[1] === n - 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

export function validateAdrSet(files: readonly AdrFile[]): AdrIssue[] {
  const adrs = files.map(parseAdr);
  const byNumber = numberIndex(files);
  const gaps = missingRanges(new Set(byNumber.keys())).map(([start, end]) => ({
    file: "docs/decisions",
    message: `numbering must be contiguous from 0000; missing ${
      start === end ? pad(start) : `${pad(start)} to ${pad(end)}`
    }`,
  }));
  return [
    ...adrs.flatMap(issuesOf),
    ...duplicateNumbers(byNumber),
    ...supersessionIssues(adrs, byNumber),
    ...gaps,
  ];
}
