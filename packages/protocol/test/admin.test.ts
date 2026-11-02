import { describe, expect, test } from "bun:test";
import { AuditEntry, OperatorCommand, ServerStatus } from "../src/admin/index.ts";
import * as publicEntry from "../src/public/index.ts";

const percentiles = { p50: 120, p95: 900, p99: 4000 };

const STATUS = {
  executedTick: 120,
  committedTick: 118,
  publishedTick: 115,
  tickRateHz: 5,
  simSecondsPerTick: 12,
  durability: "ephemeral",
  state: "running",
  latenessMicros: percentiles,
  stepMicros: percentiles,
  projectionMicros: percentiles,
  fanOutMicros: percentiles,
  shortfallTicks: 0,
  rebases: 0,
  connections: 3,
};

const accepts = (value: unknown) => ServerStatus.safeParse(value).success;

describe("ServerStatus", () => {
  test("accepts the counters, rates, percentiles, and counts", () => {
    expect(accepts(STATUS)).toBe(true);
    expect(accepts({ ...STATUS, executedTick: 115, committedTick: 115 })).toBe(true);
  });

  test("rejects counters out of order: E ≥ C ≥ P", () => {
    expect(accepts({ ...STATUS, committedTick: 121 })).toBe(false);
    expect(accepts({ ...STATUS, publishedTick: 119 })).toBe(false);
  });

  test("rejects percentiles that fall, fractions, negatives, and rates off their bounds", () => {
    const cases = [
      { ...STATUS, stepMicros: { p50: 900, p95: 120, p99: 4000 } },
      { ...STATUS, fanOutMicros: { p50: 1, p95: 2, p99: 1 } },
      { ...STATUS, latenessMicros: { ...percentiles, p50: 1.5 } },
      { ...STATUS, projectionMicros: { ...percentiles, p50: -1 } },
      { ...STATUS, tickRateHz: 0 },
      { ...STATUS, tickRateHz: 1001 },
      { ...STATUS, simSecondsPerTick: 0 },
      { ...STATUS, connections: -1 },
      { ...STATUS, state: "fast" },
      { ...STATUS, extra: 1 },
      { ...STATUS, stepMicros: { ...percentiles, p999: 1 } },
    ];
    expect(cases.map(accepts)).toEqual(cases.map(() => false));
  });

  test("rejects the loss of any one key", () => {
    const without = (key: string) =>
      Object.fromEntries(Object.entries(STATUS).filter(([name]) => name !== key));
    const kept = Object.keys(STATUS).map((key) => accepts(without(key)));
    expect(kept).toEqual(Object.keys(STATUS).map(() => false));
  });
});

describe("OperatorCommand", () => {
  test("is pause with a plain-text reason, or resume", () => {
    expect(OperatorCommand.safeParse({ type: "pause", reason: "Maintenance." }).success).toBe(true);
    expect(OperatorCommand.safeParse({ type: "resume" }).success).toBe(true);
    const rejected = [
      { type: "pause" },
      { type: "pause", reason: "" },
      { type: "pause", reason: `a${String.fromCodePoint(0x202e)}b` },
      { type: "resume", reason: "x" },
      { type: "speed", factor: 2 },
      { type: "step" },
    ];
    const parsed = rejected.map((command) => OperatorCommand.safeParse(command).success);
    expect(parsed).toEqual(rejected.map(() => false));
  });
});

describe("AuditEntry", () => {
  const ENTRY = {
    seq: 0,
    atMs: 1_793_000_000_000,
    actor: "operator",
    command: { type: "pause", reason: "Maintenance." },
    tick: 115,
    outcome: "applied",
  };

  test("records who did what, when, at which tick, and how it ended", () => {
    expect(AuditEntry.safeParse(ENTRY).success).toBe(true);
    const rejected = [
      { ...ENTRY, outcome: "ignored" },
      { ...ENTRY, actor: "Operator One" },
      { ...ENTRY, command: { type: "speed" } },
      { ...ENTRY, token: "secret" },
      { ...ENTRY, atMs: -1 },
    ];
    expect(rejected.map((entry) => AuditEntry.safeParse(entry).success)).toEqual(
      rejected.map(() => false),
    );
  });
});

describe("the public entry", () => {
  test("re-exports nothing of the admin contracts, and no rate of the world", () => {
    const names = Object.keys(publicEntry);
    // A sample of the public entry, so the check below cannot pass on an empty list.
    expect(names).toEqual(
      expect.arrayContaining(["applyMessage", "parseClientMessage", "PROTOCOL_ID"]),
    );
    const admin = ["ServerStatus", "OperatorCommand", "AuditEntry", "Percentiles"];
    expect(names.filter((name) => admin.includes(name))).toEqual([]);
    expect(names.filter((name) => /tick_?rate|hz$|seconds_?per_?tick/i.test(name))).toEqual([]);
    const values: unknown[] = Object.values(publicEntry);
    const schemas: unknown[] = [ServerStatus, OperatorCommand, AuditEntry];
    expect(values.filter((value) => schemas.includes(value))).toEqual([]);
  });
});
