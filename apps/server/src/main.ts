/**
 * The process entry point of the public server (ADR 0025, "Faults", "Ephemeral mode", and
 * "Configuration").
 *
 * `start` reads the configuration and refuses to start with every problem at once; logs the
 * warnings; wires `composeServer` with the real clock and timer and the transport; and starts both.
 * A port it cannot bind is logged as `listen_failed` with the error's code. A server that cannot
 * start after the listener bound is logged as `start_failed`, and the listener and the server are
 * stopped before the error goes on.
 *
 * `main` binds a started server to its process before it reports `listening` with the port, so a
 * supervisor that signals on that line always finds the handlers in place:
 *
 * - SIGTERM and SIGINT stop the transport first, closing every socket with 1001, then the server,
 *   which flushes every executed tick, and exit with 0 once the `stopped` line reached stdout;
 * - a second signal while stopping forces exit 1, since a durable journal can hang a stop: the
 *   server sets no deadline of its own, and a supervisor brings its grace period;
 * - an unhandled rejection halts the world, as AI_MODE's policy says (`rejectionPolicy`).
 *
 * The log is JSON lines on stdout: events with codes, ticks, counts, and sizes, never a payload or
 * an address (C2).
 */
import { systemClock } from "./adapters/clock.ts";
import { systemTimer } from "./adapters/timer.ts";
import { composeServer, type Server, type ServerDeps } from "./compose.ts";
import { type Config, type Environment, parseConfig } from "./config/config.ts";
import { serveTransport, type Transport } from "./transport/transport.ts";
import { causeOf } from "./world/fault.ts";

/** One line of the log: an event, with what it needs; never a payload or an address. */
export type LogEntry = { readonly event: string } & Readonly<Record<string, unknown>>;

export type Log = (entry: LogEntry) => void;

/** What tests may replace of the server: its time, its source and projection, and its journal. */
export type EntryDeps = Partial<
  Pick<ServerDeps, "clock" | "timer" | "source" | "projectionOf" | "journal">
>;

/** The signals that stop the server. */
export const SIGNALS = Object.freeze(["SIGTERM", "SIGINT"] as const);
export type Signal = (typeof SIGNALS)[number];

/** What the entry point needs of its process: the real process, or a test's double. */
export type Host = {
  readonly env: Environment;
  /** Writes `text` to stdout; `written` runs once it, and everything before it, was written. */
  write(text: string, written?: () => void): void;
  onSignal(signal: Signal, handler: () => void): void;
  onRejection(handler: (reason: unknown) => void): void;
  exit(code: number): void;
};

/** A server that started. */
export type Running = {
  /** The address and the port it listens on: the configured port, or the one chosen for 0. */
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  readonly transport: Transport;
  /**
   * Stops the transport, closing every socket with 1001, then the server, which flushes every
   * executed tick, and logs `stopped`; every call returns the same promise.
   */
  stop(): Promise<void>;
  /** Halts the world for an unhandled rejection, as AI_MODE's policy says, and logs it. */
  unhandledRejection(reason: unknown): void;
};

/** A server that started, or why none did: every problem of the configuration, or the bind's code. */
export type Started =
  | { readonly ok: true; readonly running: Running }
  | { readonly ok: false; readonly reason: "config"; readonly errors: readonly string[] }
  | { readonly ok: false; readonly reason: "listen"; readonly code: string };

/** The dependencies of `composeServer`: the real clock and timer unless tests replace them. */
function serverDeps({ clock, timer, source, projectionOf, journal }: EntryDeps): ServerDeps {
  return {
    clock: clock ?? systemClock,
    timer: timer ?? systemTimer,
    ...(source === undefined ? {} : { source }),
    ...(projectionOf === undefined ? {} : { projectionOf }),
    ...(journal === undefined ? {} : { journal }),
  };
}

/** The public listener of `config`, over the presentation of `server`. */
function listen(config: Config, server: Server, log: Log): Transport {
  return serveTransport({
    presentation: server.presentation,
    hostname: config.host,
    port: config.port,
    publicOrigins: config.publicOrigins,
    allowedHosts: config.allowedHosts,
    connections: config.connections,
    log,
  });
}

/** The name of a thrown value, never its message, which could quote what a client sent. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The string code a thrown value carries, such as EADDRINUSE, or "unknown". */
function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "string" ? code : "unknown";
}

/** Stops the transport, then the server, even when the transport fails to stop. */
async function stopBoth(transport: Transport, server: Server): Promise<void> {
  try {
    await transport.stop();
  } finally {
    await server.stop();
  }
}

/** The ticks of the server's status, its state, and why it halted, if it did: for the log. */
function ticksOf(server: Server) {
  const { executedTick, committedTick, publishedTick, state } = server.status();
  const halt = server.world.halted();
  return {
    executedTick,
    committedTick,
    publishedTick,
    state,
    ...(halt === undefined ? {} : { halt }),
  };
}

/** The running server of `server` and `transport`, listening on `config`'s host. */
function runningOf(config: Config, server: Server, transport: Transport, log: Log): Running {
  let stopping: Promise<void> | undefined;
  const stop = async () => {
    await stopBoth(transport, server);
    log({ event: "stopped", ...ticksOf(server) });
  };
  return Object.freeze({
    host: config.host,
    port: transport.port,
    server,
    transport,
    stop: () => {
      stopping ??= stop();
      return stopping;
    },
    unhandledRejection: (reason: unknown) => {
      server.world.unhandledRejection();
      log({ event: "unhandled_rejection", cause: causeOf(reason), ...ticksOf(server) });
    },
  });
}

/**
 * Starts the server of `env`, logging to `log`: its configuration, or every problem of it, each
 * logged as `config_error` and none started; then its warnings, the server, and the transport. A
 * port it cannot bind is logged as `listen_failed`, with the error's code and no message. A throw
 * of the server's start, after the bind, is logged as `start_failed`, by the error's name; the
 * transport and the server are stopped, and the throw goes on.
 */
export async function start(env: Environment, log: Log, deps: EntryDeps = {}): Promise<Started> {
  const parsed = parseConfig(env);
  if (!parsed.ok) {
    for (const message of parsed.errors) log({ event: "config_error", message });
    return { ok: false, reason: "config", errors: parsed.errors };
  }
  for (const message of parsed.warnings) log({ event: "config_warning", message });
  const { config } = parsed;
  const server = composeServer(config, serverDeps(deps));
  let transport: Transport;
  try {
    transport = listen(config, server, log);
  } catch (error) {
    const code = codeOf(error);
    log({ event: "listen_failed", code });
    return { ok: false, reason: "listen", code };
  }
  try {
    server.start();
  } catch (error) {
    log({ event: "start_failed", error: nameOf(error) });
    await stopBoth(transport, server);
    throw error;
  }
  return { ok: true, running: runningOf(config, server, transport, log) };
}

/**
 * Binds `running` to `host`: an unhandled rejection halts the world; the first SIGTERM or SIGINT
 * stops the server and exits with 0, or with 1 when stopping failed; another signal while it stops
 * exits with 1 at once. `exit` exits once what was logged reached stdout.
 */
function bind(host: Host, running: Running, log: Log, exit: (code: number) => void): void {
  host.onRejection((reason) => running.unhandledRejection(reason));
  let stopping = false;
  const onSignal = (signal: Signal) => {
    if (stopping) {
      log({ event: "forced_exit", signal });
      exit(1);
      return;
    }
    stopping = true;
    log({ event: "signal", signal });
    running.stop().then(
      () => exit(0),
      (error: unknown) => {
        log({ event: "stop_failed", error: nameOf(error) });
        exit(1);
      },
    );
  };
  for (const signal of SIGNALS) host.onSignal(signal, () => onSignal(signal));
}

/** The process this module runs in. */
const PROCESS: Host = Object.freeze({
  env: process.env,
  write: (text: string, written?: () => void) => {
    process.stdout.write(text, written);
  },
  onSignal: (signal: Signal, handler: () => void) => {
    process.on(signal, handler);
  },
  onRejection: (handler: (reason: unknown) => void) => {
    process.on("unhandledRejection", handler);
  },
  exit: (code: number) => process.exit(code),
});

/**
 * Runs the server of `host`'s environment: it exits with 1 when the configuration is refused or
 * the port cannot be bound; otherwise it binds its handlers, reports `listening`, and runs until a
 * signal stops it. Tests give a double of the process and replace the server's dependencies.
 */
export async function main(host: Host = PROCESS, deps: EntryDeps = {}): Promise<void> {
  const log: Log = (entry) => host.write(`${JSON.stringify(entry)}\n`);
  // An empty write goes after every line before it: its callback runs once they were written.
  const exit = (code: number) => host.write("", () => host.exit(code));
  const started = await start(host.env, log, deps);
  if (!started.ok) {
    exit(1);
    return;
  }
  const { running } = started;
  bind(host, running, log, exit);
  log({ event: "listening", host: running.host, port: running.port });
}

if (import.meta.main) await main();
