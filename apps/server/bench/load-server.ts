/**
 * The server process of the load benchmark (load.ts): the server as `main.ts` starts it, through
 * `start` with the real clock, timer, and transport, over the environment the driver gives it,
 * with two additions out of band, on this process's own stdin and stdout and never in the
 * protocol:
 *
 * - **marks**: the presentation's `period` is wrapped on this instance only, so each period that
 *   plays out a new tick records the tick, the wall-clock time the period began, in milliseconds
 *   (`performance.timeOrigin + performance.now()`, which another process on the same machine reads
 *   the same way), and how many ticks the world had executed beyond it;
 * - **ticks**: the server is composed as `composeServer` composes it, through `start`'s `serverOf`,
 *   with a `FixedRateScheduler` whose `runTick` is timed on the server's clock, the span the
 *   status's `stepMicros` covers, so a window of ticks can be read apart from the boot;
 * - **commands**, one per stdin line: `status` prints the server's C3 status (`server.status()`)
 *   with this process's resident and heap memory, and `status gc` takes them after a full
 *   collection; `marks` and `ticks` print what was recorded since the last such command and forget
 *   it; `stop` stops the server as SIGTERM does.
 *
 * Every line it prints is JSON. The server's own log lines come first as `start` writes them; the
 * benchmark's carry an event that starts with `bench_`. It exits with 0 once stopped, and with 1
 * when the server does not start.
 */
import { composeServer, type ServerDeps } from "../src/compose.ts";
import type { Config } from "../src/config/config.ts";
import { type Running, start } from "../src/main.ts";
import { FixedRateScheduler, type SchedulerOptions } from "../src/world/scheduler.ts";
import { wallMs } from "./report.ts";

/** Writes one JSON line to stdout. */
const print = (entry: object) => process.stdout.write(`${JSON.stringify(entry)}\n`);

/**
 * What the wrappers record: a mark of each period that played out a new tick, [the tick, the
 * wall-clock time the period began, the executed tick less the played-out one]; the microseconds
 * of each tick; and the ticks executed, which is E since the default world boots at tick 0.
 */
type Recorder = { marks: [number, number, number][]; ticks: number[]; executed: number };

/** Wraps the presentation's `period` so each one that plays out a new tick is marked. */
function markPeriods(running: Running, recorder: Recorder): void {
  const { presentation } = running.server;
  const period = presentation.period.bind(presentation);
  presentation.period = () => {
    const before = presentation.tick;
    const at = wallMs();
    period();
    const { tick } = presentation;
    if (tick !== before) recorder.marks.push([tick, at, recorder.executed - tick]);
  };
}

/** The server `composeServer` composes, its scheduler's ticks timed and counted into `recorder`. */
function timedServer(recorder: Recorder) {
  return (config: Config, deps: ServerDeps) => {
    const schedulerOf = (options: SchedulerOptions) =>
      new FixedRateScheduler({
        ...options,
        runTick: () => {
          const start = deps.clock.now();
          try {
            options.runTick();
            recorder.executed += 1;
          } finally {
            recorder.ticks.push(deps.clock.now() - start);
          }
        },
      });
    return composeServer(config, { ...deps, schedulerOf });
  };
}

/** The server's status and this process's memory, after a full collection when `gc`. */
function statusLine(running: Running, gc: boolean) {
  if (gc) Bun.gc(true);
  const { rss, heapUsed } = process.memoryUsage();
  return { event: "bench_status", status: running.server.status(), rss, heapUsed };
}

/** Stops the server and exits with 0 once its last line was written. */
async function stop(running: Running): Promise<never> {
  await running.stop();
  process.stdout.write("", () => process.exit(0));
  return new Promise(() => undefined);
}

/** Answers the driver's commands, one per line, until stdin ends or `stop`. */
async function serve(running: Running, recorder: Recorder): Promise<void> {
  for await (const line of console) {
    const command = line.trim();
    if (command === "status" || command === "status gc")
      print(statusLine(running, command === "status gc"));
    else if (command === "marks") print({ event: "bench_marks", marks: recorder.marks.splice(0) });
    else if (command === "ticks") print({ event: "bench_ticks", micros: recorder.ticks.splice(0) });
    else if (command === "stop") await stop(running);
    else print({ event: "bench_unknown_command" });
  }
}

/** Starts the server of this process's environment and serves the driver until it stops. */
async function main(): Promise<void> {
  const recorder: Recorder = { marks: [], ticks: [], executed: 0 };
  const started = await start(process.env, print, { serverOf: timedServer(recorder) });
  if (!started.ok) process.exit(1);
  const { running } = started;
  markPeriods(running, recorder);
  process.on("SIGTERM", () => void stop(running));
  print({ event: "bench_listening", port: running.port, pid: process.pid });
  await serve(running, recorder);
  await stop(running);
}

if (import.meta.main) await main();
