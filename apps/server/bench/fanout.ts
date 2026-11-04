/**
 * The cost of the fan-out per period with N clients in this process (plan §11, "Difusión por
 * período": p99 at most 5 ms with 100 clients, a target of 40 ms with 1,000 to measure; and "Delta
 * por cliente": a median of at most 1 KB and a p99 of at most 8 KB on the default world). Manual,
 * never run by `bun test`, because it measures wall-clock time.
 *
 *   bun apps/server/bench/fanout.ts [same-chunk] [same-followed] [churn] [dense-chunk]
 *     [--clients 1,10,100,1000] [--periods N]
 *
 * The scenarios, all four unless named:
 *
 * - `same-chunk`: every client subscribes to the chunk of the default world that holds the most
 *   beings;
 * - `same-followed`: every client follows the being of the default world whose record changes
 *   most often;
 * - `churn`: every client pans a camera of 3 × 3 chunks one chunk a period, around the default
 *   world's spawn area, each from its own place on the path: a `subscribe` per client and period,
 *   read through `receive`, the transport's way in, with 3 chunks new to it each time;
 * - `dense-chunk`: every client subscribes to the chunk of the beings benchmark's "concentrated
 *   1,000 in 1 × 1" (packages/agents/bench/scale.ts), 1,000 beings in one chunk.
 *
 * The default world runs 500 ticks first, so its beings are awake; the dense one its spawn tick and
 * its first decisions. Then its next ticks are projected once and recorded, and each run replays
 * them to a fresh `Presentation`, one tick a period, with each client's sink counting the bytes and
 * commits it is sent and never lagging. The presentation's clock is the system's, as in the server,
 * moved 200 ms ahead at each period, so its buckets see periods 200 ms apart while the fan-out's
 * 40 ms budget and the duration it records (`recordFanOut`, the status's `fanOutMicros`) are real.
 * Up to 60 periods warm up, until every client committed once; then `--periods` (100 unless given)
 * are measured. The terrain is the world's own, generated within the presentation's budget.
 *
 * Run one scenario at a time on a shared machine, pinned and at low priority:
 * `taskset -c 0 nice -n 19 bun apps/server/bench/fanout.ts same-chunk`.
 */

import type { ChunkCoord } from "@open-origin/protocol/public";
import type { ClientId } from "../src/presentation/interest.ts";
import { type ClientSink, type Ending, Presentation } from "../src/presentation/presentation.ts";
import type { PublishedListener, PublishedTick } from "../src/world/published.ts";
import { header, kib, ms, percentilesOf, positiveArg, table } from "./report.ts";
import type { Stream } from "./worlds.ts";

const SCENARIOS = ["same-chunk", "same-followed", "churn", "dense-chunk"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type FanOutArguments = {
  readonly scenarios: readonly Scenario[];
  readonly clients: readonly number[];
  readonly periods: number;
};

/** The numbers of clients each scenario runs with unless `--clients` says otherwise. */
const CLIENT_COUNTS = Object.freeze([1, 10, 100, 1_000]);

/** A list of positive integers, written `1,10,100`. */
function clientsArg(text: string | undefined): number[] {
  const counts = (text ?? "").split(",").map((part) => positiveArg("--clients", part));
  if (new Set(counts).size !== counts.length) throw new Error("--clients repeats a number");
  return counts;
}

/** Reads the option `name` and its value into `read`. */
function readOption(
  read: { clients?: number[]; periods?: number },
  name: "--clients" | "--periods",
  value: string | undefined,
): void {
  if (name === "--clients") {
    if (read.clients !== undefined) throw new Error("--clients is given twice");
    read.clients = clientsArg(value);
    return;
  }
  if (read.periods !== undefined) throw new Error("--periods is given twice");
  read.periods = positiveArg("--periods", value);
}

/**
 * The arguments of the benchmark: its scenarios, all four unless named, `--clients`, and
 * `--periods`. Throws an Error naming an unknown argument, a scenario or option given twice, or a
 * value that is not what its option takes.
 */
export function parseArguments(argv: readonly string[]): FanOutArguments {
  const scenarios: Scenario[] = [];
  const read: { clients?: number[]; periods?: number } = {};
  for (let at = 0; at < argv.length; ) {
    const arg = argv[at];
    if (arg === "--clients" || arg === "--periods") {
      readOption(read, arg, argv[at + 1]);
      at += 2;
      continue;
    }
    const scenario = SCENARIOS.find((name) => name === arg);
    if (scenario === undefined || scenarios.includes(scenario))
      throw new Error(
        `unknown argument "${arg}": give ${SCENARIOS.join(", ")}, --clients, or --periods`,
      );
    scenarios.push(scenario);
    at += 1;
  }
  return {
    scenarios: scenarios.length === 0 ? [...SCENARIOS] : scenarios,
    clients: read.clients ?? [...CLIENT_COUNTS],
    periods: read.periods ?? 100,
  };
}

/** The most periods a run warms up for before it measures. */
export const WARM_UP_PERIODS = 60;

/**
 * The ticks of the default world before its recording: its beings sleep from tick 2 until past tick
 * 260, and from about tick 500 they change in public in about a third of the ticks.
 */
const DEFAULT_SKIP = 500;

/** The ticks of the dense world before its recording: its spawns and its first decisions. */
const DENSE_SKIP = 2;

/** The recorded stream of `scenario`'s world, `ticks` ticks long. */
async function streamOf(scenario: Scenario, ticks: number): Promise<Stream> {
  const worlds = await import("./worlds.ts");
  const dense = scenario === "dense-chunk";
  const source = dense ? worlds.concentratedSource() : worlds.defaultSource();
  worlds.skip(source, dense ? DENSE_SKIP : DEFAULT_SKIP);
  return worlds.recordStream(source, ticks);
}

/** The chunk of `boot` that holds the most beings, the first on a tie. */
export function busiestChunk(boot: PublishedTick): ChunkCoord {
  const busiest = boot.chunks.reduce((best, chunk) =>
    chunk.upsert.length > best.upsert.length ? chunk : best,
  );
  return busiest.at;
}

/** The being whose record `ticks` publish most often, the lowest id on a tie. */
export function busiestBeing(ticks: readonly PublishedTick[]): number {
  const counts = new Map<number, number>();
  for (const tick of ticks)
    for (const chunk of tick.chunks)
      for (const being of chunk.upsert) counts.set(being.id, (counts.get(being.id) ?? 0) + 1);
  const ranked = [...counts].toSorted(([a, x], [b, y]) => y - x || a - b);
  const [first] = ranked;
  if (first === undefined) throw new Error("no being changed in the recorded ticks");
  return first[0];
}

/**
 * The centers of a camera that pans around `center` one chunk a period: the ring of chunks 4 away
 * from it, in order, so each step brings 3 chunks new to a 3 × 3 camera.
 */
export function panPath(center: ChunkCoord): ChunkCoord[] {
  const [x, y] = center;
  const side = [-4, -3, -2, -1, 0, 1, 2, 3];
  return [
    ...side.map((d): ChunkCoord => [x + d, y - 4]),
    ...side.map((d): ChunkCoord => [x + 4, y + d]),
    ...side.map((d): ChunkCoord => [x - d, y + 4]),
    ...side.map((d): ChunkCoord => [x - 4, y - d]),
  ];
}

/** The text of a `subscribe` to the 3 × 3 chunks around `center`. */
function squareSubscribe([x, y]: ChunkCoord): string {
  const chunks: ChunkCoord[] = [];
  for (let dy = -1; dy <= 1; dy += 1)
    for (let dx = -1; dx <= 1; dx += 1) chunks.push([x + dx, y + dy]);
  return JSON.stringify({ type: "subscribe", chunks });
}

/** The head of every commit frame the presentation writes: its type comes first. */
const COMMIT_HEAD = '{"type":"commit",';

/** A client's socket that never lags: it counts the bytes and commits of the current period. */
export class CountingSink implements ClientSink {
  bytes = 0;
  commits = 0;
  /** Whether it ever committed. */
  synced = false;
  ended: Ending | undefined;

  send(frame: string): void {
    this.bytes += Buffer.byteLength(frame, "utf8");
    if (!frame.startsWith(COMMIT_HEAD)) return;
    this.commits += 1;
    this.synced = true;
  }

  buffered(): number {
    return 0;
  }

  end(ending: Ending): void {
    this.ended = ending;
  }

  /** The period's counts, which start again from zero. */
  take(): { readonly bytes: number; readonly commits: number } {
    const counts = { bytes: this.bytes, commits: this.commits };
    this.bytes = 0;
    this.commits = 0;
    return counts;
  }
}

/** The microseconds of a period at 5 Hz. */
const PERIOD_MICROS = 200_000;

/**
 * The system's clock in whole microseconds, moved ahead by a period at each `nextPeriod`: time
 * within a period is real, and periods run 200 ms apart as the server's do.
 */
class PeriodsClock {
  #offset = 0;

  now(): number {
    return Math.floor(performance.now() * 1000) + this.#offset;
  }

  nextPeriod(): void {
    this.#offset += PERIOD_MICROS;
  }
}

/** A timer the benchmark never starts: it drives each period itself. */
const NO_TIMER = {
  schedule: (): (() => void) => {
    throw new Error("the benchmark drives the periods itself");
  },
};

/** What one measured period did. */
export type PeriodSample = {
  readonly periodNs: number;
  readonly fanOutMicros: number;
  /** The `subscribe` messages of the churn, read before the period, in nanoseconds. */
  readonly inputNs: number;
  /** Each client's bytes in the period, and the most commits a client got. */
  readonly bytes: readonly number[];
  readonly mostCommits: number;
  /** Clients that committed in the period, and those the fan-out deferred: sent nothing. */
  readonly committed: number;
  readonly deferred: number;
};

/** A presentation over `stream`, its clock, and the fan-out durations it recorded. */
function presentationOf(stream: Stream) {
  const clock = new PeriodsClock();
  const fanOuts: number[] = [];
  let listener: PublishedListener | undefined;
  const presentation = new Presentation({
    subscribeToPublished: (subscriber) => {
      subscriber(stream.boot);
      listener = subscriber;
      return () => undefined;
    },
    readTerrain: stream.readTerrain,
    worldState: () => "running",
    clock,
    timer: NO_TIMER,
    tickRateHz: 5,
    batchTicks: 5,
    world: { id: "0".repeat(32), durability: "ephemeral" },
    recordFanOut: (micros) => fanOuts.push(micros),
  });
  const publish = (tick: PublishedTick) => listener?.(tick);
  return { presentation, clock, fanOuts, publish };
}

/** What a run asks of its clients: their first messages, and, for the churn, each period's. */
export type Asks = {
  readonly first: (client: number) => readonly string[];
  readonly each?: (client: number, period: number) => string;
};

/** What each scenario's clients ask, over `stream`. */
function asksOf(scenario: Scenario, stream: Stream): Asks {
  if (scenario === "same-followed") {
    const follow = JSON.stringify({ type: "follow", being: busiestBeing(stream.ticks) });
    return { first: () => [follow] };
  }
  const chunk = busiestChunk(stream.boot);
  if (scenario !== "churn") {
    const subscribe = JSON.stringify({ type: "subscribe", chunks: [chunk] });
    return { first: () => [subscribe] };
  }
  const texts = panPath(chunk).map(squareSubscribe);
  const at = (step: number) => texts[step % texts.length] ?? "";
  return { first: (client) => [at(client)], each: (client, period) => at(client + period + 1) };
}

/**
 * The result of one run: its measured periods, its warm-up periods, whether every client committed
 * within them, and the clients that were ended.
 */
export type RunResult = {
  readonly clients: number;
  readonly warmUp: readonly PeriodSample[];
  readonly synced: boolean;
  readonly samples: readonly PeriodSample[];
  readonly ended: number;
};

/**
 * Replays `stream` to a fresh presentation with `clients` clients that ask `asks`: up to
 * WARM_UP_PERIODS periods, until every client committed once, then `periods` measured ones. The
 * stream must hold at least WARM_UP_PERIODS + `periods` ticks.
 */
export function runFanOut(stream: Stream, asks: Asks, clients: number, periods: number): RunResult {
  const { presentation, clock, fanOuts, publish } = presentationOf(stream);
  const sinks = Array.from({ length: clients }, () => new CountingSink());
  const ids = sinks.map((sink) => presentation.connect(sink));
  ids.forEach((id, client) => {
    for (const text of asks.first(client)) presentation.receive(id, text);
  });
  let next = 0;
  const period = (): PeriodSample => {
    clock.nextPeriod();
    const tick = stream.ticks[next];
    if (tick === undefined) throw new Error(`the stream holds ${stream.ticks.length} ticks only`);
    publish(tick);
    const sample = measurePeriod(
      presentation,
      sinks,
      () => churn(presentation, ids, asks, next),
      fanOuts,
    );
    next += 1;
    return sample;
  };
  const warmUp: PeriodSample[] = [];
  while (next < WARM_UP_PERIODS && !sinks.every((sink) => sink.synced)) warmUp.push(period());
  const synced = sinks.every((sink) => sink.synced);
  const samples = Array.from({ length: periods }, period);
  return { clients, warmUp, synced, samples, ended: sinks.filter((sink) => sink.ended).length };
}

/** Sends each client's message of `period`, when the scenario has one. */
function churn(presentation: Presentation, ids: readonly ClientId[], asks: Asks, period: number) {
  const { each } = asks;
  if (each === undefined) return;
  ids.forEach((id, client) => {
    presentation.receive(id, each(client, period));
  });
}

/** Runs the input of a period, then the period, each timed, and reads what the sinks got. */
function measurePeriod(
  presentation: Presentation,
  sinks: readonly CountingSink[],
  input: () => void,
  fanOuts: readonly number[],
): PeriodSample {
  const before = Bun.nanoseconds();
  input();
  const start = Bun.nanoseconds();
  presentation.period();
  const periodNs = Bun.nanoseconds() - start;
  const counts = sinks.map((sink) => sink.take());
  return {
    periodNs,
    fanOutMicros: fanOuts.at(-1) ?? 0,
    inputNs: start - before,
    bytes: counts.map((count) => count.bytes),
    mostCommits: Math.max(0, ...counts.map((count) => count.commits)),
    committed: counts.filter((count) => count.commits > 0).length,
    // A client the fan-out served gets a message every period, a status at least: one that got
    // nothing was deferred to the next period by the fan-out's budget of time.
    deferred: counts.filter((count) => count.bytes === 0).length,
  };
}

/** The longest fan-out of `samples`, in microseconds; 0 for none. */
const slowest = (samples: readonly PeriodSample[]) =>
  Math.max(0, ...samples.map((sample) => sample.fanOutMicros));

/** The numbers a row reports of `result`. */
function summarizeRun(result: RunResult) {
  const { samples } = result;
  const of = (read: (sample: PeriodSample) => number) => percentilesOf(samples.map(read));
  const clientPeriods = samples.length * result.clients;
  return {
    period: of((sample) => sample.periodNs),
    fanOut: of((sample) => sample.fanOutMicros),
    input: of((sample) => sample.inputNs),
    bytes: percentilesOf(samples.flatMap((sample) => sample.bytes)),
    mostCommits: Math.max(0, ...samples.map((sample) => sample.mostCommits)),
    commitShare:
      clientPeriods === 0 ? 0 : samples.reduce((n, s) => n + s.committed, 0) / clientPeriods,
    deferred: Math.max(0, ...samples.map((sample) => sample.deferred)),
  };
}

const COLUMNS = [
  "Scenario",
  "Clients",
  "Sync: periods, slowest fan-out ms",
  "Fan-out p50 / p99 ms",
  "Period p50 / p99 ms",
  "Churn input p50 / p99 ms",
  "Bytes per client and period, p50 / p99",
  "Most commits per client and period",
  "Client-periods with a commit",
  "Most clients deferred",
  "Clients ended",
];

/** The row of `scenario`'s run `result`. */
function runRow(scenario: Scenario, result: RunResult): string[] {
  const s = summarizeRun(result);
  return [
    scenario,
    String(result.clients),
    `${result.warmUp.length}${result.synced ? "" : " (not all synced)"}, ${ms(slowest(result.warmUp) * 1000)}`,
    `${ms(s.fanOut.p50 * 1000)} / ${ms(s.fanOut.p99 * 1000)}`,
    `${ms(s.period.p50)} / ${ms(s.period.p99)}`,
    `${ms(s.input.p50)} / ${ms(s.input.p99)}`,
    `${s.bytes.p50} B / ${s.bytes.p99} B (${kib(s.bytes.p99)} KiB)`,
    String(s.mostCommits),
    `${(s.commitShare * 100).toFixed(1)} %`,
    String(s.deferred),
    String(result.ended),
  ];
}

/** Runs the scenarios `argv` names and prints one table. */
async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  console.log(header("The fan-out's cost per period (apps/server/bench/fanout.ts)"));
  const ticks = WARM_UP_PERIODS + options.periods;
  const streams = new Map<boolean, Promise<Stream>>();
  const rows: string[][] = [];
  for (const scenario of options.scenarios) {
    const dense = scenario === "dense-chunk";
    const recorded = streams.get(dense) ?? streamOf(scenario, ticks);
    streams.set(dense, recorded);
    const stream = await recorded;
    const asks = asksOf(scenario, stream);
    for (const clients of options.clients) {
      Bun.gc(true);
      rows.push(runRow(scenario, runFanOut(stream, asks, clients, options.periods)));
      console.error(`${scenario}, ${clients} clients: done`);
    }
  }
  console.log(table(COLUMNS, rows));
}

if (import.meta.main) await main(process.argv.slice(2));
