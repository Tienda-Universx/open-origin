/**
 * The load benchmark (plan §11): the real server in a process of its own and its WebSocket clients
 * in another, on loopback. Manual, never run by `bun test`.
 *
 *   bun apps/server/bench/load.ts --clients N [--seconds S] [--ramp R]
 *   bun apps/server/bench/load.ts --sync
 *
 * With `--clients N`, the server (load-server.ts: `start` of src/main.ts, ephemeral, on a free
 * port, its cap per address raised to N by configuration, as plan §11 says) boots for 2 s; then the
 * clients process (load-clients.ts) opens N clients, R a second (100 unless given), each subscribed
 * to the 3 × 3 chunks of the default world's spawn area. Once every client committed, it measures
 * for S seconds (20 unless given):
 *
 * - the tick's time from the server's own C3 status: `stepMicros` (the step, the projection, and
 *   the journal's append) over the last 1,024 ticks, boot included, with `projectionMicros`,
 *   `latenessMicros`, and `fanOutMicros`;
 * - the latency from playout to receipt: for each commit a client got, the wall-clock time it
 *   arrived less the time the period that played its tick out began, which the server marks out of
 *   band (load-server.ts), never in the protocol;
 * - each client's rate: its commits over the periods of the window, and its commits that came less
 *   than half a period after the one before;
 * - the server's resident and heap memory per client: after a full collection with the clients
 *   synced, less the same before any connected, over N.
 *
 * With `--sync`, a fresh server, whose terrain is all uncached, gets one client of the reducer,
 * which, once it committed, subscribes to the 64 chunks of 8 × 8 around the spawn area: the time
 * and the bytes from that `subscribe` to the commit that shows all 64 (plan §11: at most 1 s).
 *
 * The children inherit this process's CPUs and priority, which it prints for each. It refuses to
 * start while the load average is 2 or more, and stops a run when it stays above 2 for 15 s. Run
 * one at a time, pinned and at low priority: `taskset -c 0 nice -n 19 bun apps/server/bench/load.ts
 * --clients 100`. Every process it starts is stopped, or killed, before it exits.
 */
import { ServerStatus } from "@open-origin/protocol/admin";
import type { ChunkCoord } from "@open-origin/protocol/public";
import { z } from "zod";
import type { LoadPlan } from "./load-clients.ts";
import {
  header,
  kib,
  loadAverage,
  ms,
  percentilesOf,
  pinningOf,
  positiveArg,
  table,
} from "./report.ts";

/** What a run measures: N clients for S seconds, opened R a second; or the sync of 64 chunks. */
export type LoadArguments =
  | {
      readonly mode: "clients";
      readonly clients: number;
      readonly seconds: number;
      readonly ramp: number;
    }
  | { readonly mode: "sync" };

/** The options of `argv`, by name, each once. */
function optionsOf(argv: readonly string[]): Map<string, string | undefined> {
  const options = new Map<string, string | undefined>();
  for (let at = 0; at < argv.length; ) {
    const name = argv[at] ?? "";
    if (!["--clients", "--seconds", "--ramp", "--sync"].includes(name))
      throw new Error(
        `unknown argument "${name}": give --clients N [--seconds S] [--ramp R], or --sync`,
      );
    if (options.has(name)) throw new Error(`${name} is given twice`);
    const value = name === "--sync" ? undefined : argv[at + 1];
    options.set(name, value);
    at += name === "--sync" ? 1 : 2;
  }
  return options;
}

/**
 * The arguments of the benchmark: `--clients N` with `--seconds` and `--ramp`, or `--sync` alone.
 * Throws an Error naming an unknown argument, one given twice, a value that is not a positive
 * integer, `--sync` with another option, or neither mode.
 */
export function parseArguments(argv: readonly string[]): LoadArguments {
  const options = optionsOf(argv);
  if (options.has("--sync")) {
    if (options.size > 1) throw new Error("--sync takes no other option");
    return { mode: "sync" };
  }
  if (!options.has("--clients")) throw new Error("give --clients N, or --sync");
  const read = (name: string, fallback: number) =>
    options.has(name) ? positiveArg(name, options.get(name)) : fallback;
  return {
    mode: "clients",
    clients: read("--clients", 0),
    seconds: read("--seconds", 20),
    ramp: read("--ramp", 100),
  };
}

/** A tick and the wall-clock time, in milliseconds, at which it was played out or received. */
export type Stamp = readonly [tick: number, at: number];

/** A period's mark: the tick it played out, when it began, and the ticks executed beyond it. */
export type Mark = readonly [tick: number, at: number, ahead: number];

/**
 * The latency of each receipt: its time less the mark of its tick, in milliseconds; a receipt
 * whose tick has no mark is counted apart.
 */
export function latencies(
  marks: readonly (Stamp | Mark)[],
  clients: readonly (readonly Stamp[])[],
): { readonly ms: number[]; readonly unmarked: number } {
  const playedOut = new Map(marks.map(([tick, at]) => [tick, at]));
  const found: number[] = [];
  let unmarked = 0;
  for (const receipts of clients) {
    for (const [tick, at] of receipts) {
      const mark = playedOut.get(tick);
      if (mark === undefined) unmarked += 1;
      else found.push(at - mark);
    }
  }
  return { ms: found, unmarked };
}

/** The commits of one client that came less than `periodMs / 2` after the one before. */
export function bursts(receipts: readonly Stamp[], periodMs: number): number {
  let count = 0;
  for (let at = 1; at < receipts.length; at += 1) {
    const gap = (receipts[at]?.[1] ?? 0) - (receipts[at - 1]?.[1] ?? 0);
    if (gap < periodMs / 2) count += 1;
  }
  return count;
}

/** The chunks `from` to `to` away from `center` on each axis, by row then column. */
export function block(center: ChunkCoord, from: number, to: number): ChunkCoord[] {
  const chunks: ChunkCoord[] = [];
  for (let dy = from; dy <= to; dy += 1)
    for (let dx = from; dx <= to; dx += 1) chunks.push([center[0] + dx, center[1] + dy]);
  return chunks;
}

/** One JSON line a child printed. */
type Entry = { readonly event: string } & Readonly<Record<string, unknown>>;

/** The variables a child gets: only these and `variables`, so the host's own change nothing. */
function environment(variables: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = ["PATH", "HOME", "TMPDIR"].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(inherited), ...variables };
}

/** A child process whose stdout is JSON lines and whose stdin takes commands, one per line. */
class Child {
  readonly process: Bun.Subprocess<"pipe", "pipe", "inherit">;
  readonly entries: Entry[] = [];
  /** The command that makes it exit. */
  readonly #exit: string;

  constructor(argv: readonly string[], variables: Readonly<Record<string, string>>, exit: string) {
    this.#exit = exit;
    this.process = Bun.spawn([process.execPath, ...argv], {
      env: environment(variables),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    void this.#read();
  }

  send(command: string): void {
    this.process.stdin.write(`${command}\n`);
    void this.process.stdin.flush();
  }

  /** The first entry of `event` after the first `after` entries; throws after `deadlineMs`. */
  async next(event: string, after = 0, deadlineMs = 30_000): Promise<Entry> {
    const deadline = performance.now() + deadlineMs;
    for (;;) {
      const entry = this.entries.slice(after).find((candidate) => candidate.event === event);
      if (entry !== undefined) return entry;
      if (this.process.exitCode !== null) throw new Error(`the child exited before "${event}"`);
      if (performance.now() > deadline) throw new Error(`no "${event}" in ${deadlineMs} ms`);
      await Bun.sleep(5);
    }
  }

  /** Sends `command` and waits for the next entry of `event`. */
  request(command: string, event: string, deadlineMs?: number): Promise<Entry> {
    const after = this.entries.length;
    this.send(command);
    return this.next(event, after, deadlineMs);
  }

  /** Asks the child to exit, and kills it when it has not within 5 s. */
  async end(): Promise<void> {
    if (this.process.exitCode === null) this.send(this.#exit);
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 5_000);
    await this.process.exited;
    clearTimeout(timer);
  }

  async #read(): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of this.process.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
        const line = rest.slice(0, end);
        rest = rest.slice(end + 1);
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          this.entries.push({ event: "unparsed", line });
        }
      }
    }
  }
}

const SERVER = `${import.meta.dir}/load-server.ts`;
const CLIENTS = `${import.meta.dir}/load-clients.ts`;

/** The spawn area of the default world: the chunks within 1 of (0, 0). */
const SPAWN_AREA = block([0, 0], -1, 1);

/** The server of a run whose clients number `clients`, its caps raised to hold them. */
async function startServer(clients: number): Promise<{ server: Child; port: number }> {
  const cap = String(Math.max(16, clients));
  const server = new Child(
    [SERVER],
    {
      OPEN_ORIGIN_DURABILITY: "ephemeral",
      OPEN_ORIGIN_PORT: "0",
      MAX_CONNECTIONS: String(Math.max(1024, clients)),
      MAX_CONNECTIONS_PER_IP: cap,
    },
    "stop",
  );
  const listening = await server.next("bench_listening");
  console.log(`Server pinning: ${pinningOf(server.process.pid)}`);
  return { server, port: Number(listening.port) };
}

/** The clients process of `plan`. */
function startClients(plan: LoadPlan): Child {
  const clients = new Child([CLIENTS, JSON.stringify(plan)], {}, "exit");
  console.log(`Clients pinning: ${pinningOf(clients.process.pid)}`);
  return clients;
}

/**
 * Waits `seconds`, sampling the 1-minute load average each second; returns its maximum, and throws
 * once it stayed above 2 for 15 s.
 */
async function guardedWait(seconds: number): Promise<number> {
  let most = 0;
  let over = 0;
  for (let second = 0; second < seconds; second += 1) {
    await Bun.sleep(1_000);
    const load = loadAverage() ?? 0;
    most = Math.max(most, load);
    over = load > 2 ? over + 1 : 0;
    if (over >= 15) throw new Error(`the load average stayed above 2 for 15 s (${load})`);
  }
  return most;
}

/** A tick and a time, as the clients print them, and a mark, as the server prints it. */
const StampSchema = z.tuple([z.number(), z.number()]);
const MarkSchema = z.tuple([z.number(), z.number(), z.number()]);

/** A status line of the server process: its C3 status, checked by the admin contract. */
const StatusLine = z.object({ status: ServerStatus, rss: z.number(), heapUsed: z.number() });
type StatusLine = z.output<typeof StatusLine>;
type Percentiles = ServerStatus["stepMicros"];

/** What the clients process reports of each client. */
const ClientReport = z.object({
  bytes: z.number(),
  receipts: z.array(StampSchema),
  code: z.number().optional(),
});
type ClientReport = z.output<typeof ClientReport>;

/** What a load run measured. */
type LoadRun = {
  readonly clients: number;
  readonly failed: number;
  readonly syncMs: number;
  readonly before: StatusLine;
  readonly rested: StatusLine;
  readonly after: StatusLine;
  readonly marks: readonly Mark[];
  /** The microseconds of each tick of the window. */
  readonly ticks: readonly number[];
  readonly reports: readonly ClientReport[];
  readonly mostLoad: number;
};

/** Runs N clients against a fresh server and measures them; stops both processes. */
async function loadRun(clients: number, seconds: number, ramp: number): Promise<LoadRun> {
  const { server, port } = await startServer(clients);
  let children: Child[] = [server];
  try {
    await Bun.sleep(2_000);
    const before = StatusLine.parse(await server.request("status gc", "bench_status"));
    const started = performance.now();
    const load = startClients({ port, clients, ramp, chunks: SPAWN_AREA, sync: false });
    children = [load, server];
    const opened = await load.next("clients_open", 0, 60_000);
    await load.next("clients_synced", 0, 60_000);
    const syncMs = performance.now() - started;
    const rested = StatusLine.parse(await server.request("status gc", "bench_status"));
    await server.request("marks", "bench_marks");
    await server.request("ticks", "bench_ticks");
    load.send("measure");
    const mostLoad = await guardedWait(seconds);
    const report = await load.request("report", "clients_report");
    const marks = z.array(MarkSchema).parse((await server.request("marks", "bench_marks")).marks);
    const ticks = z.array(z.number()).parse((await server.request("ticks", "bench_ticks")).micros);
    const after = StatusLine.parse(await server.request("status", "bench_status"));
    const reports = z.array(ClientReport).parse(report.clients);
    const failed = Number(opened.failed);
    const measured = { before, rested, after, marks, ticks, reports };
    return { clients, failed, syncMs, mostLoad, ...measured };
  } finally {
    await stopAll(children);
  }
}

/** Ends `children` in order, the clients before the server, killing what does not exit. */
async function stopAll(children: readonly Child[]): Promise<void> {
  for (const child of children) await child.end();
}

/** The microseconds of `percentiles` as milliseconds: p50 / p95 / p99. */
const micros = ({ p50, p95, p99 }: Percentiles) =>
  `${(p50 / 1000).toFixed(3)} / ${(p95 / 1000).toFixed(3)} / ${(p99 / 1000).toFixed(3)}`;

const LOAD_COLUMNS = [
  "Clients",
  "Failed",
  "Ramp and sync s",
  "Tick, status (stepMicros, since boot) p50 / p95 / p99 ms",
  "Tick, window p50 / p95 / p99 ms",
  "Projection p50 / p95 / p99 ms",
  "Lateness p50 / p95 / p99 ms",
  "Fan-out p50 / p95 / p99 ms",
  "Playout to receipt p50 / p95 / p99 ms",
  "Executed beyond playout, ticks: p50 / p99 / max",
  "Commits per client and period",
  "Commits in a burst",
  "RSS per client KiB",
  "Heap per client KiB",
  "Lagging, slow closes, aborts, faults",
  "Most load average",
];

/** How far the executed tick ran ahead of the played-out one at each mark: p50 / p99 / max. */
export function aheadOf(marks: readonly Mark[]): string {
  const ahead = marks.map((mark) => mark[2]);
  const { p50, p99 } = percentilesOf(ahead);
  return `${p50} / ${p99} / ${Math.max(0, ...ahead)}`;
}

/** The row of a load run. */
function loadRow(run: LoadRun): string[] {
  const { status } = run.after;
  const delays = latencies(
    run.marks,
    run.reports.map((report) => report.receipts),
  );
  const late = percentilesOf(delays.ms);
  const receipts = run.reports.reduce((total, report) => total + report.receipts.length, 0);
  const burst = run.reports.reduce((total, report) => total + bursts(report.receipts, 200), 0);
  const rss = (run.rested.rss - run.before.rss) / run.clients;
  const heap = (run.rested.heapUsed - run.before.heapUsed) / run.clients;
  return [
    String(run.clients),
    String(run.failed),
    (run.syncMs / 1000).toFixed(1),
    micros(status.stepMicros),
    micros(percentilesOf(run.ticks)),
    micros(status.projectionMicros),
    micros(status.latenessMicros),
    micros(status.fanOutMicros),
    `${ms(late.p50 * 1e6)} / ${ms(late.p95 * 1e6)} / ${ms(late.p99 * 1e6)}${delays.unmarked > 0 ? ` (${delays.unmarked} unmarked)` : ""}`,
    aheadOf(run.marks),
    (receipts / (run.clients * run.marks.length)).toFixed(3),
    String(burst),
    kib(rss),
    kib(heap),
    `${status.laggingClients}, ${status.slowCloses}, ${status.aborts}, ${status.faults}`,
    run.mostLoad.toFixed(2),
  ];
}

/** A fresh server and one client of the reducer that subscribes to 8 × 8 chunks once it committed. */
async function syncRun(): Promise<Entry> {
  const { server, port } = await startServer(1);
  let children: Child[] = [server];
  try {
    await Bun.sleep(2_000);
    const plan = { port, clients: 0, ramp: 1, chunks: block([0, 0], -4, 3), sync: true };
    const client = startClients(plan);
    children = [client, server];
    return await client.next("sync_done", 0, 20_000);
  } finally {
    await stopAll(children);
  }
}

/** Runs the benchmark `argv` asks for and prints its table. */
async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  console.log(header("The load benchmark (apps/server/bench/load.ts)"));
  const load = loadAverage();
  if (load === undefined || load >= 2) {
    console.error(`the load average is ${load ?? "unknown"}: run only below 2`);
    process.exit(3);
  }
  if (options.mode === "sync") {
    const done = await syncRun();
    console.log(
      table(
        ["Chunks", "Subscribe to commit ms", "Bytes", "Commits"],
        [
          [
            String(done.chunks),
            Number(done.ms).toFixed(1),
            String(done.bytes),
            String(done.commits),
          ],
        ],
      ),
    );
    return;
  }
  const run = await loadRun(options.clients, options.seconds, options.ramp);
  console.log(table(LOAD_COLUMNS, [loadRow(run)]));
}

if (import.meta.main) await main(process.argv.slice(2));
