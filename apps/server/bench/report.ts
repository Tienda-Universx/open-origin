/**
 * What every benchmark of the server prints and how it summarizes (plan §11): the machine class and
 * the pinning a run used, read from /proc, so a number is never read without the machine it came
 * from; percentiles by nearest rank, the same as the server's own status (`SampleWindow`); and
 * Markdown tables.
 */
import { readFileSync } from "node:fs";
import { type Percentiles, SampleWindow } from "../src/world/samples.ts";

/** The text of `file`, or undefined where it cannot be read (no /proc). */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // Not Linux, or no /proc: the callers print "unknown".
    return undefined;
  }
}

/** The lines of `text` that read `name`, blanks or tabs, a colon, and a value: their values, trimmed. */
export function fields(text: string | undefined, name: string): string[] {
  return (text ?? "").split("\n").flatMap((line) => {
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).trimEnd() !== name) return [];
    return [line.slice(colon + 1).trim()];
  });
}

/** The value of the first line of `text` that reads `name: value` (fields). */
export const field = (text: string | undefined, name: string) => fields(text, name)[0];

/** The nice value in /proc/<pid>/stat: the 19th field, the 17th after the command's parentheses. */
export function niceOf(stat: string | undefined): string | undefined {
  const after = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
  return after?.[16];
}

/**
 * The machine class: CPU model, the machine's logical cores (not only those this process may use),
 * memory, and Bun's version.
 */
export function machineClass(): string {
  const cpuinfo = readText("/proc/cpuinfo");
  const model = field(cpuinfo, "model name") ?? "unknown CPU";
  const cores = fields(cpuinfo, "processor").length || "unknown";
  const totalKb = Number(field(readText("/proc/meminfo"), "MemTotal")?.split(" ")[0]);
  const memory = Number.isFinite(totalKb) ? `${(totalKb / 1024 / 1024).toFixed(1)} GiB` : "unknown";
  return `${model}; ${cores} logical cores; ${memory} of memory; Bun ${Bun.version}`;
}

/** The CPUs process `pid` may run on and its nice value, as /proc reports them. */
export function pinningOf(pid: number | "self" = "self"): string {
  const cpus = field(readText(`/proc/${pid}/status`), "Cpus_allowed_list") ?? "unknown";
  const nice = niceOf(readText(`/proc/${pid}/stat`)) ?? "unknown";
  return `CPUs ${cpus}, nice ${nice}`;
}

/** The two header lines every server benchmark prints. */
export function header(title: string): string {
  return `${title}\n\nMachine: ${machineClass()}\nPinning: ${pinningOf()}\n`;
}

/** The 1-minute load average, or undefined where /proc/loadavg cannot be read. */
export function loadAverage(): number | undefined {
  const load = Number(readText("/proc/loadavg")?.split(" ")[0]);
  return Number.isFinite(load) ? load : undefined;
}

/** The p50, p95, and p99 of `values` by nearest rank; 0 for none. */
export function percentilesOf(values: readonly number[]): Percentiles {
  const window = new SampleWindow(Math.max(1, values.length));
  for (const value of values) window.add(value);
  return window.percentiles();
}

/** A Markdown table of `rows` under `columns`. */
export function table(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(columns), line(columns.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The wall-clock time in milliseconds, which the processes of one machine read alike. */
export const wallMs = () => performance.timeOrigin + performance.now();

/** Nanoseconds as milliseconds with three decimals. */
export const ms = (nanoseconds: number) => (nanoseconds / 1e6).toFixed(3);

/** Bytes as KiB with one decimal. */
export const kib = (bytes: number) => (bytes / 1024).toFixed(1);

/**
 * A positive safe integer written in plain decimal, the value of the option `name`; throws an Error
 * naming the option otherwise.
 */
export function positiveArg(name: string, text: string | undefined): number {
  const value = Number(text);
  if (text === undefined || !/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer, not "${text ?? ""}"`);
  return value;
}
