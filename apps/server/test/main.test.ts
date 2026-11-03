/**
 * The entry point in process (ADR 0025, "Faults", "Ephemeral mode", and "Configuration"; plan tests
 * 18 and the shutdown's RPO): `start` refuses with every problem of the configuration at once and
 * starts nothing; it logs the warnings, listens on the port it reports, and its `stop`, which
 * SIGTERM and SIGINT call, closes every socket with 1001 and flushes every executed tick before it
 * logs `stopped`; and an unhandled rejection halts the world. The world is the counting world on a
 * fake clock, so the ticks are exact; tests/e2e/server.test.ts runs the real process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Running } from "../src/main.ts";
import { type LogEntry, start } from "../src/main.ts";
import { ScriptedSource } from "../src/world/source.ts";
import { countingWorld } from "./support/counting-world.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import { emptyProjection } from "./support/projections.ts";
import { LOOPBACK, SocketClient } from "./support/sockets.ts";

/** One period at 5 Hz, in microseconds. */
const P = 200_000;

const EPHEMERAL = { OPEN_ORIGIN_DURABILITY: "ephemeral", OPEN_ORIGIN_PORT: "0" } as const;

const runs: Running[] = [];

afterEach(async () => {
  for (const running of runs.splice(0)) await running.stop();
});

/** Starts the counting world under `env` on a fake clock; returns what started, and the log. */
function started(env: Record<string, string>) {
  const logs: LogEntry[] = [];
  const clock = new FakeClock();
  const timer = new FakeTimer(clock);
  const result = start(env, {
    log: (entry) => logs.push(entry),
    clock,
    timer,
    source: new ScriptedSource(countingWorld(Number.MAX_SAFE_INTEGER), []),
    projectionOf: emptyProjection,
  });
  if (!result.ok) throw new Error(`the server did not start: ${result.errors.join("; ")}`);
  runs.push(result.running);
  return { running: result.running, logs, timer };
}

describe("start", () => {
  test("refuses with every problem of the configuration at once, and starts nothing", () => {
    const logs: LogEntry[] = [];
    const result = start(
      { OPEN_ORIGIN_HOST: "0.0.0.0", AI_MODE: "on" },
      { log: (entry) => logs.push(entry) },
    );
    const errors = [
      'OPEN_ORIGIN_DURABILITY must be "ephemeral": no durable journal is available until T7',
      "OPEN_ORIGIN_HOST must be a loopback address (127.0.0.0/8 or ::1): an ephemeral server listens only on this machine",
      'AI_MODE must be "off": other modes refuse to start until T9',
    ];
    expect(result).toEqual({ ok: false, errors });
    expect(logs).toEqual(errors.map((message) => ({ event: "config_error", message })));
  });

  test("warns, listens on the port it reports, and stops with 1001 after flushing every executed tick", async () => {
    const { running, logs, timer } = started({ ...EPHEMERAL, CODESPACES: "true" });
    expect(logs).toEqual([
      {
        event: "config_warning",
        message:
          "CODESPACES=true: keep the forwarded port private; an ephemeral server is a local development server, not a public universe",
      },
      { event: "listening", host: LOOPBACK, port: running.port },
    ]);
    const health = await fetch(`http://${LOOPBACK}:${running.port}/healthz`);
    expect(await health.json()).toEqual({ ok: true });
    const client = await SocketClient.open(running.port);
    // Seven ticks, F = 5: the journal committed the first batch, and two ticks wait in the next.
    await timer.runUntilSettled(6 * P);
    const { executedTick, committedTick, publishedTick } = running.server.status();
    expect([executedTick, committedTick, publishedTick]).toEqual([7, 5, 5]);
    const stopping = running.stop();
    expect(running.stop()).toBe(stopping);
    await stopping;
    expect(await client.closing()).toBe(1001);
    expect(logs.at(-1)).toEqual({
      event: "stopped",
      executedTick: 7,
      committedTick: 7,
      publishedTick: 7,
      state: "paused",
    });
    expect(running.server.presentation.usage().clients).toBe(0);
  });

  test("halts the world on an unhandled rejection, under AI_MODE=off", async () => {
    const { running, logs, timer } = started(EPHEMERAL);
    await timer.runUntilSettled(2 * P);
    running.unhandledRejection(new Error("a planted rejection"));
    expect(running.server.world.state()).toBe("halted");
    const halt = { code: "unhandled_rejection", tick: 4 };
    // Three ticks ran, in a batch the halt flushes after the line is written.
    expect(logs.at(-1)).toEqual({
      event: "unhandled_rejection",
      cause: { message: "a planted rejection" },
      executedTick: 3,
      committedTick: 0,
      publishedTick: 0,
      state: "halted",
      halt,
    });
    // The world runs no more ticks, and what it ran is published.
    await timer.runUntilSettled(10 * P);
    await running.stop();
    expect(logs.at(-1)).toEqual({
      event: "stopped",
      executedTick: 3,
      committedTick: 3,
      publishedTick: 3,
      state: "halted",
      halt,
    });
  });
});
