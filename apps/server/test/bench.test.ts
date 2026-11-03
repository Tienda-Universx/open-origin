/**
 * The server's benchmarks (apps/server/bench/): what they read of the machine, their statistics and
 * tables, the budgets they judge, their arguments, which they refuse rather than ignore, and the
 * core of each run with tiny parameters. The benchmarks themselves measure wall-clock time and are
 * run by hand.
 */
import { describe, expect, test } from "bun:test";
import {
  parseArguments as parseProjection,
  row,
  type Summary,
  summarize,
  type TickSample,
  verdicts,
  type WorldName,
} from "../bench/projection.ts";
import { field, fields, niceOf, percentilesOf, positiveArg, table } from "../bench/report.ts";

describe("what the benchmarks read of the machine", () => {
  const cpuinfo = "processor\t: 0\nmodel name\t: A CPU\nprocessor\t: 1\nmodel name\t: A CPU\n";

  test("read /proc's name: value lines, blanks and tabs before the colon included", () => {
    expect(fields(cpuinfo, "processor")).toEqual(["0", "1"]);
    expect(field(cpuinfo, "model name")).toBe("A CPU");
    expect(field("MemTotal:        8123456 kB\n", "MemTotal")).toBe("8123456 kB");
    expect(field(cpuinfo, "model")).toBeUndefined();
    expect(field(undefined, "processor")).toBeUndefined();
  });

  test("read the nice value, the 19th field of /proc/<pid>/stat, past a name with parentheses", () => {
    const fifteen = Array.from({ length: 15 }, (_, index) => index + 4).join(" ");
    expect(niceOf(`42 (a) b) S ${fifteen} 19 1 0`)).toBe("19");
    expect(niceOf(undefined)).toBeUndefined();
  });
});

describe("the benchmarks' statistics and tables", () => {
  test("take percentiles by nearest rank, as the server's status does", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(percentilesOf(hundred)).toEqual({ p50: 50, p95: 95, p99: 99 });
    expect(percentilesOf([7])).toEqual({ p50: 7, p95: 7, p99: 7 });
    expect(percentilesOf([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  test("print Markdown tables", () => {
    expect(table(["a", "b"], [["1", "2"]])).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  test.each(["0", "-1", "1.5", "x", "", undefined])("refuse %p as a positive integer", (text) => {
    expect(() => positiveArg("--n", text)).toThrow(
      `--n must be a positive integer, not "${text ?? ""}"`,
    );
  });
});

describe("the projection benchmark", () => {
  test("run both worlds by default and take --ticks", () => {
    expect(parseProjection([])).toEqual({ worlds: ["default", "dense"], ticks: undefined });
    expect(parseProjection(["dense", "--ticks", "9"])).toEqual({ worlds: ["dense"], ticks: 9 });
  });

  test.each([
    { argv: ["sparse"], message: 'unknown argument "sparse"' },
    { argv: ["dense", "dense"], message: 'unknown argument "dense"' },
    { argv: ["--ticks", "1", "--ticks", "2"], message: "--ticks is given twice" },
    { argv: ["--ticks", "0"], message: '--ticks must be a positive integer, not "0"' },
    { argv: ["--ticks"], message: '--ticks must be a positive integer, not ""' },
  ])("refuse $argv", ({ argv, message }) => {
    expect(() => parseProjection(argv)).toThrow(message);
  });

  const sample = (stepNs: number, projectNs: number, records: number): TickSample => ({
    stepNs,
    projectNs,
    changed: records + 1,
    chunks: records,
    records,
    bytes: 90 + 100 * records,
  });

  test("summarize the timed ticks: percentiles, the share of the step, and what was published", () => {
    const summary = summarize([
      sample(1_000_000, 100_000, 0),
      sample(3_000_000, 200_000, 2),
      sample(2_000_000, 300_000, 1),
      sample(4_000_000, 400_000, 0),
    ]);
    expect(summary).toEqual({
      ticks: 4,
      step: { p50: 2_000_000, p95: 4_000_000, p99: 4_000_000 },
      project: { p50: 200_000, p95: 400_000, p99: 400_000 },
      share: 0.1,
      changed: { p50: 1, max: 3 },
      records: { p50: 0, max: 2 },
      bytes: { p50: 90, p99: 290 },
    });
    expect(row("default", summary)).toEqual([
      "default",
      "4",
      "2.000 / 4.000 / 4.000",
      "0.200 / 0.400 / 0.400",
      "10.00 %",
      "1 / 3",
      "0 / 2",
      "90 / 290",
    ]);
  });

  test("judge the budgets at their bounds: a p99 of 2 ms and a share of 10 % are met", () => {
    const with_ = (p99: number, share: number): Summary => ({
      ...summarize([sample(1, 1, 0)]),
      project: { p50: 0, p95: 0, p99 },
      share,
    });
    const judged = (summaries: [WorldName, Summary][]) => verdicts(new Map(summaries));
    expect(judged([["default", with_(2_000_000, 0)]])).toEqual([
      "default world, projection p99 ≤ 2 ms: 2.000 ms, met",
    ]);
    expect(judged([["default", with_(2_001_000, 0)]])).toEqual([
      "default world, projection p99 ≤ 2 ms: 2.001 ms, missed",
    ]);
    expect(judged([["dense", with_(0, 0.1)]])).toEqual([
      "dispersed 1,000, projection ≤ 10 % of the step: 10.00 %, met",
    ]);
    expect(judged([["dense", with_(0, 0.1001)]])).toEqual([
      "dispersed 1,000, projection ≤ 10 % of the step: 10.01 %, missed",
    ]);
  });
});
