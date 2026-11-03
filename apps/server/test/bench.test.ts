/**
 * The server's benchmarks (apps/server/bench/): what they read of the machine, their statistics and
 * tables, the budgets they judge, their arguments, which they refuse rather than ignore, and the
 * core of each run with tiny parameters. The benchmarks themselves measure wall-clock time and are
 * run by hand.
 */
import { describe, expect, test } from "bun:test";
import {
  type Asks,
  busiestBeing,
  busiestChunk,
  CountingSink,
  panPath,
  parseArguments as parseFanOut,
  runFanOut,
  WARM_UP_PERIODS,
} from "../bench/fanout.ts";
import { aheadOf, block, bursts, latencies, parseArguments as parseLoad } from "../bench/load.ts";
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
import type { Stream } from "../bench/worlds.ts";
import { being, ModelWorld, terrainAt } from "./support/presentation.ts";

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

describe("the fan-out benchmark", () => {
  test("run every scenario with 1, 10, 100, and 1,000 clients for 100 periods by default", () => {
    expect(parseFanOut([])).toEqual({
      scenarios: ["same-chunk", "same-followed", "churn", "dense-chunk"],
      clients: [1, 10, 100, 1_000],
      periods: 100,
    });
    expect(parseFanOut(["churn", "--clients", "3,7", "--periods", "5"])).toEqual({
      scenarios: ["churn"],
      clients: [3, 7],
      periods: 5,
    });
  });

  test.each([
    { argv: ["all"], message: 'unknown argument "all"' },
    { argv: ["churn", "churn"], message: 'unknown argument "churn"' },
    { argv: ["--clients", "1,1"], message: "--clients repeats a number" },
    { argv: ["--clients", "1,,2"], message: '--clients must be a positive integer, not ""' },
    { argv: ["--clients", "1", "--clients", "2"], message: "--clients is given twice" },
    { argv: ["--periods", "0"], message: '--periods must be a positive integer, not "0"' },
    { argv: ["--periods", "1", "--periods", "2"], message: "--periods is given twice" },
  ])("refuse $argv", ({ argv, message }) => {
    expect(() => parseFanOut(argv)).toThrow(message);
  });

  test("find the busiest chunk at boot and the being published most often, the first on a tie", () => {
    const model = new ModelWorld(0, [being(1, [3, 3]), being(2, [40, 3]), being(3, [41, 3])]);
    expect(busiestChunk(model.boot())).toEqual([1, 0]);
    const ticks = [
      model.step({ set: [being(3, [42, 3]), being(2, [43, 3])] }),
      model.step({ set: [being(2, [44, 3])] }),
      model.step({ set: [being(3, [45, 3])] }),
    ];
    expect(busiestBeing(ticks)).toBe(2);
    expect(() => busiestBeing([])).toThrow("no being changed in the recorded ticks");
  });

  test("pan a camera one chunk a period around a ring of chunks 4 away, and back to its start", () => {
    const path = panPath([10, -5]);
    expect(path).toHaveLength(32);
    expect(new Set(path.map(String)).size).toBe(32);
    path.forEach(([x, y], index) => {
      const [nx, ny] = path[(index + 1) % path.length] ?? [x, y];
      expect(Math.max(Math.abs(x - 10), Math.abs(y + 5))).toBe(4);
      expect(Math.abs(nx - x) + Math.abs(ny - y)).toBe(1);
    });
  });

  test("count each period's UTF-8 bytes and commits at a sink that never lags", () => {
    const sink = new CountingSink();
    sink.send('{"type":"commit","seq":1,"tick":2}');
    sink.send('{"type":"status","seq":2,"tick":2,"state":"running","é":1}');
    expect(sink.buffered()).toBe(0);
    expect(sink.synced).toBe(true);
    expect(sink.take()).toEqual({ bytes: 35 + 58, commits: 1 });
    expect(sink.take()).toEqual({ bytes: 0, commits: 0 });
  });

  test("replay a stream to a presentation: every client syncs, then commits once a period", () => {
    const model = new ModelWorld(0, [being(1, [3, 3]), being(2, [40, 3])]);
    const boot = model.boot();
    const ticks = Array.from({ length: WARM_UP_PERIODS + 3 }, (_, tick) =>
      model.step({ set: [being(1, [3 + (tick % 9), 3])] }),
    );
    const stream: Stream = { boot, ticks, readTerrain: terrainAt };
    const subscribe = JSON.stringify({ type: "subscribe", chunks: [[0, 0]] });
    const asks: Asks = { first: () => [subscribe] };
    const result = runFanOut(stream, asks, 3, 3);
    expect(result).toMatchObject({ clients: 3, synced: true, ended: 0 });
    expect(result.warmUp).toHaveLength(1);
    expect(result.samples).toHaveLength(3);
    for (const sample of result.samples) {
      expect(sample).toMatchObject({ mostCommits: 1, committed: 3, deferred: 0 });
      expect(sample.bytes).toHaveLength(3);
      expect(sample.bytes.every((bytes) => bytes > 0)).toBe(true);
    }
  });
});

describe("the load benchmark", () => {
  test("take --clients with --seconds and --ramp, or --sync alone", () => {
    expect(parseLoad(["--clients", "100"])).toEqual({
      mode: "clients",
      clients: 100,
      seconds: 20,
      ramp: 100,
    });
    expect(parseLoad(["--ramp", "50", "--clients", "7", "--seconds", "3"])).toEqual({
      mode: "clients",
      clients: 7,
      seconds: 3,
      ramp: 50,
    });
    expect(parseLoad(["--sync"])).toEqual({ mode: "sync" });
  });

  test.each([
    { argv: [], message: "give --clients N, or --sync" },
    { argv: ["--seconds", "5"], message: "give --clients N, or --sync" },
    { argv: ["--clients", "0"], message: '--clients must be a positive integer, not "0"' },
    { argv: ["--clients", "1", "--clients", "2"], message: "--clients is given twice" },
    { argv: ["--sync", "--clients", "1"], message: "--sync takes no other option" },
    { argv: ["--fast"], message: 'unknown argument "--fast"' },
  ])("refuse $argv", ({ argv, message }) => {
    expect(() => parseLoad(argv)).toThrow(message);
  });

  test("measure each receipt from the playout of its tick, and count those with no mark", () => {
    const marks = [
      [10, 1_000, 2],
      [11, 1_200, 1],
    ] as const;
    const clients = [
      [
        [10, 1_002.5],
        [11, 1_201],
      ],
      [
        [11, 1_250],
        [12, 1_400],
      ],
    ] as const;
    expect(latencies(marks, clients)).toEqual({ ms: [2.5, 1, 50], unmarked: 1 });
  });

  test("say how far the executed tick ran ahead of the played-out one", () => {
    const marks = [
      [1, 0, 2],
      [2, 200, 3],
      [3, 400, 7],
    ] as const;
    expect(aheadOf(marks)).toBe("3 / 7 / 7");
    expect(aheadOf([])).toBe("0 / 0 / 0");
  });

  test("count the commits that came less than half a period after the one before", () => {
    const receipts = [
      [1, 0],
      [2, 200],
      [3, 299.9],
      [4, 400],
      [5, 500],
      [6, 599.9],
    ] as const;
    // Gaps of 200, 99.9, 100.1, 100 (exactly half a period: no burst), and 99.9.
    expect(bursts(receipts, 200)).toBe(2);
    expect(bursts([], 200)).toBe(0);
  });

  test("list a block of chunks by row, then column", () => {
    expect(block([0, 0], -1, 1)).toHaveLength(9);
    expect(block([0, 0], -4, 3)).toHaveLength(64);
    expect(block([5, 5], 0, 1)).toEqual([
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
    ]);
  });
});
