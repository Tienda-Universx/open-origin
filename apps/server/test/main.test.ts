/**
 * The entry point in process (ADR 0025, "Faults", "Ephemeral mode", and "Configuration"; plan test
 * 18 and the shutdown's RPO), over the counting world on a fake clock, so the ticks are exact, and
 * a double of the process, which records the handlers, the lines, and the exits:
 *
 * - `start` refuses with every problem of the configuration at once and starts nothing; a server
 *   whose composition throws, injected, is `start_failed` with the stage `compose`; a port in use
 *   is `listen_failed` with its code, the composed server stopped even when its stop rejects; a
 *   server that cannot start once bound, injected, is `start_failed`, its listener closed and its
 *   error kept as the cause even when its stop rejects; and its `stop` closes the transport before
 *   the world flushes;
 * - `main` binds every handler before it reports `listening`; SIGTERM and SIGINT each stop the
 *   server, closing a client with 1001 and publishing every executed tick, and exit with 0 only
 *   once the `stopped` line was written; a signal within 1 s of the first is ignored, and one at
 *   1 s or later forces exit 1 at once, even when stdout never drains; an unhandled rejection halts
 *   the world; a refused start exits with 1 once written.
 *
 * tests/e2e/server.test.ts runs the real process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { composeServer, type Server } from "../src/compose.ts";
import {
  type EntryDeps,
  FORCE_AFTER_MICROS,
  type Host,
  type LogEntry,
  main,
  type Running,
  type Signal,
  start,
} from "../src/main.ts";
import { EphemeralJournal, type JournalBatch, type TickJournal } from "../src/world/journal.ts";
import { ScriptedSource } from "../src/world/source.ts";
import { countingWorld } from "./support/counting-world.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import { emptyProjection } from "./support/projections.ts";
import { LOOPBACK, SocketClient, until } from "./support/sockets.ts";

/** One period at 5 Hz, in microseconds. */
const P = 200_000;

const EPHEMERAL = { OPEN_ORIGIN_DURABILITY: "ephemeral", OPEN_ORIGIN_PORT: "0" } as const;

const CODESPACES_WARNING =
  "CODESPACES=true: keep the forwarded port private; an ephemeral server is a local development server, not a public universe";

const sockets: SocketClient[] = [];
const blockers: Bun.Server<undefined>[] = [];
/** What stops each server a test started. */
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const client of sockets.splice(0)) client.socket.close();
  for (const stop of stops.splice(0)) await stop();
  for (const blocker of blockers.splice(0)) await blocker.stop(true);
});

/** The counting world on a fake clock. */
function worldDeps() {
  const clock = new FakeClock();
  const fake = new FakeTimer(clock);
  const deps = {
    clock,
    timer: fake,
    source: new ScriptedSource(countingWorld(Number.MAX_SAFE_INTEGER), []),
    projectionOf: emptyProjection,
  };
  return { deps, fake };
}

/** A listener on a free loopback port, stopped after the test. */
function blocker(): Bun.Server<undefined> {
  const server = Bun.serve({ hostname: LOOPBACK, port: 0, fetch: () => new Response("") });
  blockers.push(server);
  return server;
}

/** A double of the process: what was bound, written, and exited, in order. */
class FakeHost implements Host {
  readonly env: Record<string, string>;
  readonly lines: LogEntry[] = [];
  /** The handlers bound and the lines written, in order: `on:<event>` and `write:<event>`. */
  readonly calls: string[] = [];
  readonly exits: number[] = [];
  readonly signals = new Map<Signal, () => void>();
  rejection: ((reason: unknown) => void) | undefined;
  /** Callbacks of writes, which run only when the test says the pipe took them. */
  readonly #written: (() => void)[] = [];

  constructor(env: Record<string, string>) {
    this.env = env;
  }

  write(text: string, written?: () => void): void {
    for (const line of text.split("\n").filter((part) => part !== "")) {
      const entry: LogEntry = JSON.parse(line);
      this.lines.push(entry);
      this.calls.push(`write:${entry.event}`);
    }
    if (written !== undefined) this.#written.push(written);
  }

  onSignal(signal: Signal, handler: () => void): void {
    this.calls.push(`on:${signal}`);
    this.signals.set(signal, handler);
  }

  onRejection(handler: (reason: unknown) => void): void {
    this.calls.push("on:unhandledRejection");
    this.rejection = handler;
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  /** Sends `signal`, which must have a handler. */
  signal(signal: Signal): void {
    const handler = this.signals.get(signal);
    if (handler === undefined) throw new Error(`no handler for ${signal}`);
    handler();
  }

  /** The pipe took every write so far: their callbacks run. */
  flush(): void {
    for (const written of this.#written.splice(0)) written();
  }

  /** The line of `event`, once written. */
  async line(event: string): Promise<LogEntry> {
    await until(() => this.lines.some((line) => line.event === event), `the "${event}" line`);
    const found = this.lines.find((line) => line.event === event);
    if (found === undefined) throw new Error(`no "${event}" line`);
    return found;
  }
}

/**
 * Runs `main` over a FakeHost of `env` and the counting world; a server it started is stopped
 * after the test, through SIGTERM when nothing sent a signal yet.
 */
async function mainOf(env: Record<string, string>, replaced: EntryDeps = {}) {
  const host = new FakeHost(env);
  const { deps, fake } = worldDeps();
  await main(host, { ...deps, ...replaced });
  if (host.signals.size > 0) {
    stops.push(async () => {
      if (!host.lines.some(({ event }) => event === "signal")) host.signal("SIGTERM");
      await host.line("stopped");
    });
  }
  return { host, fake, clock: deps.clock };
}

/** A start fault, and a server whose start throws it and whose stop, done, then rejects. */
function failingServer() {
  const fault = new Error("a planted start fault");
  const serverOf: EntryDeps["serverOf"] = (config, deps): Server => {
    const real = composeServer(config, deps);
    return {
      ...real,
      start: () => {
        throw fault;
      },
      stop: async () => {
        await real.stop();
        throw new Error("a planted stop fault");
      },
    };
  };
  return { fault, serverOf };
}

/** Whether a connection to `port` on loopback is refused: nothing listens there. */
const refused = (port: number) =>
  fetch(`http://${LOOPBACK}:${port}/healthz`).then(
    () => false,
    () => true,
  );

/** A client of the port that `host`'s `listening` line reports, closed after the test. */
async function clientOf(host: FakeHost): Promise<SocketClient> {
  const listening = await host.line("listening");
  const client = await SocketClient.open(Number(listening.port));
  sockets.push(client);
  return client;
}

describe("start", () => {
  test("refuses with every problem of the configuration at once, and starts nothing", async () => {
    const logs: LogEntry[] = [];
    const result = await start({ OPEN_ORIGIN_HOST: "0.0.0.0", AI_MODE: "on" }, (entry) => {
      logs.push(entry);
    });
    const errors = [
      'OPEN_ORIGIN_DURABILITY must be "ephemeral": no durable journal is available until T7',
      "OPEN_ORIGIN_HOST must be a loopback address (127.0.0.0/8 or ::1): an ephemeral server listens only on this machine",
      'AI_MODE must be "off": other modes refuse to start until T9',
    ];
    expect(result).toEqual({ ok: false, reason: "config", errors });
    expect(logs).toEqual(errors.map((message) => ({ event: "config_error", message })));
  });

  test("reports a port in use as listen_failed with its code, and no message", async () => {
    const logs: LogEntry[] = [];
    const env = { ...EPHEMERAL, OPEN_ORIGIN_PORT: String(blocker().port) };
    const result = await start(env, (entry) => logs.push(entry), worldDeps().deps);
    expect(result).toEqual({ ok: false, reason: "listen", code: "EADDRINUSE" });
    expect(logs).toEqual([{ event: "listen_failed", code: "EADDRINUSE" }]);
  });

  test("logs a server that cannot be composed as start_failed with its stage, and binds nothing", async () => {
    const logs: LogEntry[] = [];
    const fault = new Error("a planted compose fault");
    const result = await start(EPHEMERAL, (entry) => logs.push(entry), {
      ...worldDeps().deps,
      serverOf: () => {
        throw fault;
      },
    });
    expect(result).toEqual({ ok: false, reason: "compose", cause: fault });
    expect(logs).toEqual([
      {
        event: "start_failed",
        stage: "compose",
        error: "Error",
        message: "a planted compose fault",
      },
    ]);
  });

  test("stops the composed server when the port cannot be bound, though its stop rejects", async () => {
    const env = { ...EPHEMERAL, OPEN_ORIGIN_PORT: String(blocker().port) };
    let composed: Server | undefined;
    const logs: LogEntry[] = [];
    const result = await start(env, (entry) => logs.push(entry), {
      ...worldDeps().deps,
      serverOf: (config, deps) => {
        composed = composeServer(config, deps);
        return composed;
      },
    });
    expect([result, logs]).toEqual([
      { ok: false, reason: "listen", code: "EADDRINUSE" },
      [{ event: "listen_failed", code: "EADDRINUSE" }],
    ]);
    // A stopped presentation is detached from the world for good.
    expect(() => composed?.presentation.start()).toThrow(
      "a stopped presentation cannot start again",
    );
    const rejecting: LogEntry[] = [];
    const failed = await start(env, (entry) => rejecting.push(entry), {
      ...worldDeps().deps,
      serverOf: failingServer().serverOf,
    });
    expect([failed, rejecting]).toEqual([
      { ok: false, reason: "listen", code: "EADDRINUSE" },
      [
        { event: "listen_failed", code: "EADDRINUSE" },
        { event: "stop_failed", part: "server", error: "Error" },
      ],
    ]);
  });

  test("closes the listener when the server cannot start once bound, and keeps its error as the cause though a stop rejects", async () => {
    const logs: LogEntry[] = [];
    const { fault, serverOf } = failingServer();
    const result = await start(EPHEMERAL, (entry) => logs.push(entry), {
      ...worldDeps().deps,
      serverOf,
    });
    expect(result).toEqual({ ok: false, reason: "start", cause: fault });
    const port = Number(logs[0]?.port);
    expect(logs).toEqual([
      { event: "start_failed", error: "Error", port },
      { event: "stop_failed", part: "server", error: "Error" },
    ]);
    expect(await refused(port)).toBe(true);
  });

  test("stops the transport, closing its sockets, before the world flushes", async () => {
    // A journal that records how many sockets the transport holds at each append.
    let running: Running | undefined;
    const held: number[] = [];
    const inner = new EphemeralJournal();
    const journal: TickJournal = {
      level: "none",
      append: (batch: JournalBatch) => {
        held.push(running?.transport.connections() ?? -1);
        return inner.append(batch);
      },
    };
    const { deps, fake } = worldDeps();
    const result = await start(EPHEMERAL, () => undefined, { ...deps, journal });
    if (!result.ok) throw new Error("the server did not start");
    running = result.running;
    stops.push(result.running.stop);
    const client = await SocketClient.open(running.port);
    sockets.push(client);
    // Seven ticks, F = 5: the first batch went with the socket open; two ticks wait.
    await fake.runUntilSettled(6 * P);
    await running.stop();
    expect(held).toEqual([1, 0]);
    expect(await client.closing()).toBe(1001);
  });
});

describe("main", () => {
  test("binds every handler before it reports listening", async () => {
    const { host } = await mainOf({ ...EPHEMERAL, CODESPACES: "true" });
    expect(host.calls).toEqual([
      "write:config_warning",
      "on:unhandledRejection",
      "on:SIGTERM",
      "on:SIGINT",
      "write:listening",
    ]);
    const listening = await host.line("listening");
    expect(listening).toEqual({ event: "listening", host: LOOPBACK, port: listening.port });
    expect(host.lines[0]).toEqual({ event: "config_warning", message: CODESPACES_WARNING });
    const health = await fetch(`http://${LOOPBACK}:${listening.port}/healthz`);
    expect(await health.json()).toEqual({ ok: true });
  });

  test.each(["SIGTERM", "SIGINT"] as const)(
    "%s stops the server, closing its clients with 1001 and publishing every executed tick, and exits with 0 once that is written",
    async (signal) => {
      const { host, fake } = await mainOf(EPHEMERAL);
      const client = await clientOf(host);
      await fake.runUntilSettled(6 * P);
      host.signal(signal);
      expect(await client.closing()).toBe(1001);
      expect(await host.line("stopped")).toEqual({
        event: "stopped",
        executedTick: 7,
        committedTick: 7,
        publishedTick: 7,
        state: "paused",
      });
      // The transport's close of the client comes before the world's `stopped`.
      expect(host.lines.map(({ event }) => event)).toEqual([
        "listening",
        "open",
        "signal",
        "close",
        "stopped",
      ]);
      expect(host.lines[2]).toEqual({ event: "signal", signal });
      expect(host.lines[3]).toEqual({ event: "close", code: 1001, connections: 0 });
      // The exit waits until the pipe took the last line.
      await Bun.sleep(1);
      expect(host.exits).toEqual([]);
      host.flush();
      expect(host.exits).toEqual([0]);
    },
  );

  test("ignores a signal within 1 s of the first, and forces exit 1 at one 1 s after it, though stdout never drains", async () => {
    const { host, clock } = await mainOf(EPHEMERAL);
    // Nothing here runs the callbacks of the writes: stdout is a stalled pipe.
    host.signal("SIGTERM");
    clock.advance(FORCE_AFTER_MICROS - 1);
    host.signal("SIGINT");
    expect(host.exits).toEqual([]);
    clock.advance(1);
    host.signal("SIGINT");
    expect(host.exits).toEqual([1]);
    expect(host.lines.slice(1, 4)).toEqual([
      { event: "signal", signal: "SIGTERM" },
      { event: "signal_ignored", signal: "SIGINT" },
      { event: "forced_exit", signal: "SIGINT" },
    ]);
    await host.line("stopped");
  });

  test("halts the world on an unhandled rejection, under AI_MODE=off", async () => {
    const { host, fake } = await mainOf(EPHEMERAL);
    await fake.runUntilSettled(2 * P);
    host.rejection?.(new Error("a planted rejection"));
    const halt = { code: "unhandled_rejection", tick: 4 };
    // Three ticks ran, in a batch the halt flushes after the line is written.
    expect(host.lines.at(-1)).toEqual({
      event: "unhandled_rejection",
      cause: { message: "a planted rejection" },
      executedTick: 3,
      committedTick: 0,
      publishedTick: 0,
      state: "halted",
      halt,
    });
    // The world runs no more ticks, and what it ran is published.
    await fake.runUntilSettled(10 * P);
    host.signal("SIGTERM");
    expect(await host.line("stopped")).toEqual({
      event: "stopped",
      executedTick: 3,
      committedTick: 3,
      publishedTick: 3,
      state: "halted",
      halt,
    });
  });

  test("exits with 1 once written when the configuration is refused, the port is in use, the start throws, or the server cannot be composed", async () => {
    const refused = await mainOf({ AI_MODE: "on" });
    expect(refused.host.calls).toEqual(["write:config_error", "write:config_error"]);
    expect(refused.host.exits).toEqual([]);
    refused.host.flush();
    expect(refused.host.exits).toEqual([1]);
    const taken = await mainOf({ ...EPHEMERAL, OPEN_ORIGIN_PORT: String(blocker().port) });
    taken.host.flush();
    expect([taken.host.lines, taken.host.exits]).toEqual([
      [{ event: "listen_failed", code: "EADDRINUSE" }],
      [1],
    ]);
    // A start that throws exits the same way, with no crash.
    const failed = await mainOf(EPHEMERAL, { serverOf: failingServer().serverOf });
    expect(failed.host.lines.map(({ event }) => event)).toEqual(["start_failed", "stop_failed"]);
    expect(failed.host.exits).toEqual([]);
    failed.host.flush();
    expect(failed.host.exits).toEqual([1]);
    // And so does a server that cannot be composed.
    const unbuilt = await mainOf(EPHEMERAL, {
      serverOf: () => {
        throw new Error("a planted compose fault");
      },
    });
    expect([unbuilt.host.lines, unbuilt.host.exits]).toEqual([
      [
        {
          event: "start_failed",
          stage: "compose",
          error: "Error",
          message: "a planted compose fault",
        },
      ],
      [],
    ]);
    unbuilt.host.flush();
    expect(unbuilt.host.exits).toEqual([1]);
  });
});
