/**
 * The process entry point of the public server (ADR 0025, "Faults", "Ephemeral mode", and
 * "Configuration"). `start` reads the configuration and refuses to start with every problem at
 * once, logs the warnings, wires `composeServer` with the real clock and timer and the transport,
 * starts both, and reports the port it listens on, so a test can ask for port 0. `main` binds that
 * to the process: SIGTERM and SIGINT stop the transport first, closing every socket with 1001, then
 * the server, which flushes every executed tick, and exit with 0; an unhandled rejection halts the
 * world, as AI_MODE's policy says (`rejectionPolicy`).
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

/** What `start` needs: the log and, for tests, the world's time and source. */
export type EntryDeps = { readonly log: Log } & Partial<
  Pick<ServerDeps, "clock" | "timer" | "source" | "projectionOf">
>;

/** A server that started. */
export type Running = {
  /** The port it listens on: the configured one, or the one the system chose for 0. */
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

/** A server that started, or every problem of the configuration that kept it from starting. */
export type Started =
  | { readonly ok: true; readonly running: Running }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The dependencies of `composeServer`: the real clock and timer unless tests replace them. */
function serverDeps({ clock, timer, source, projectionOf }: EntryDeps): ServerDeps {
  return {
    clock: clock ?? systemClock,
    timer: timer ?? systemTimer,
    ...(source === undefined ? {} : { source }),
    ...(projectionOf === undefined ? {} : { projectionOf }),
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

/** The running server of `server` and `transport`. */
function runningOf(server: Server, transport: Transport, log: Log): Running {
  let stopping: Promise<void> | undefined;
  const stop = async () => {
    try {
      await transport.stop();
    } finally {
      // The world flushes even when the listener failed to stop.
      await server.stop();
    }
    log({ event: "stopped", ...ticksOf(server) });
  };
  return Object.freeze({
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
 * Starts the server of `env`: its configuration, or every problem of it, each logged as
 * `config_error` and none started; then its warnings, the server, and the transport, and the
 * `listening` line with the port.
 */
export function start(env: Environment, deps: EntryDeps): Started {
  const { log } = deps;
  const parsed = parseConfig(env);
  if (!parsed.ok) {
    for (const message of parsed.errors) log({ event: "config_error", message });
    return { ok: false, errors: parsed.errors };
  }
  for (const message of parsed.warnings) log({ event: "config_warning", message });
  const { config } = parsed;
  const server = composeServer(config, serverDeps(deps));
  const transport = listen(config, server, log);
  server.start();
  log({ event: "listening", host: config.host, port: transport.port });
  return { ok: true, running: runningOf(server, transport, log) };
}

/** The name of a thrown value, never its message. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One line of JSON on stdout. */
function logLine(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Runs the server of the process's environment: exit code 1 when the configuration is refused;
 * otherwise it runs until SIGTERM or SIGINT, then stops and exits with 0, or with 1 if stopping
 * failed.
 */
export function main(): void {
  const started = start(process.env, { log: logLine });
  if (!started.ok) {
    process.exitCode = 1;
    return;
  }
  const { running } = started;
  process.on("unhandledRejection", (reason) => running.unhandledRejection(reason));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      logLine({ event: "signal", signal });
      running.stop().then(
        () => process.exit(0),
        (error: unknown) => {
          logLine({ event: "stop_failed", error: nameOf(error) });
          process.exit(1);
        },
      );
    });
  }
}

if (import.meta.main) main();
