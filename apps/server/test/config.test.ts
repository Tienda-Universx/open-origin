/**
 * The server's configuration (ADR 0025, "Configuration" and "Ephemeral mode"; plan test 18: the
 * system runs with `AI_MODE=off`): its defaults, the refusals of ephemeral mode, the bounds of each
 * number, every problem reported at once without its value, and the warning under Codespaces.
 */
import { describe, expect, test } from "bun:test";
import { type Config, type Environment, parseConfig } from "../src/config/config.ts";

/** The smallest environment the server starts with. */
const EPHEMERAL = { OPEN_ORIGIN_DURABILITY: "ephemeral" } as const;

/** The configuration of `env`, which must parse. */
function configOf(env: Environment): Config {
  const result = parseConfig(env);
  if (!result.ok) throw new Error(`expected a configuration, got ${result.errors.join("; ")}`);
  return result.config;
}

/** The errors of `env`, which must not parse. */
function errorsOf(env: Environment): readonly string[] {
  const result = parseConfig(env);
  if (result.ok) throw new Error("expected errors, got a configuration");
  return result.errors;
}

const DURABILITY_ERROR =
  'OPEN_ORIGIN_DURABILITY must be "ephemeral": no durable journal is available until T7';
const AI_MODE_ERROR = 'AI_MODE must be "off": other modes refuse to start until T9';
const HOST_ERROR =
  "OPEN_ORIGIN_HOST must be a loopback address (127.0.0.0/8 or ::1): an ephemeral server listens only on this machine";

describe("parseConfig", () => {
  test("gives the defaults of ADR 0025, deep-frozen, with no warning", () => {
    const result = parseConfig(EPHEMERAL);
    expect(result).toEqual({
      ok: true,
      config: {
        durability: "ephemeral",
        host: "127.0.0.1",
        port: 8080,
        tickRateHz: 5,
        publicationBatchTicks: 5,
        publicOrigins: [],
        allowedHosts: ["localhost:8080", "127.0.0.1:8080"],
        connections: { global: 1024, perIp: 16 },
        aiMode: "off",
      },
      warnings: [],
    });
    const config = configOf(EPHEMERAL);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.publicOrigins)).toBe(true);
    expect(Object.isFrozen(config.allowedHosts)).toBe(true);
    expect(Object.isFrozen(config.connections)).toBe(true);
  });

  test("runs with AI_MODE off by default and refuses every other mode until T9", () => {
    expect(configOf(EPHEMERAL).aiMode).toBe("off");
    expect(configOf({ ...EPHEMERAL, AI_MODE: "off" }).aiMode).toBe("off");
    for (const mode of ["on", "paid", "free", "OFF", " off", "off ", ""]) {
      expect(errorsOf({ ...EPHEMERAL, AI_MODE: mode })).toEqual([AI_MODE_ERROR]);
    }
  });

  test("refuses to start without ephemeral durability, with the exact message", () => {
    expect(errorsOf({})).toEqual([DURABILITY_ERROR]);
    for (const durability of ["durable", "EPHEMERAL", "", "none"]) {
      expect(errorsOf({ OPEN_ORIGIN_DURABILITY: durability })).toEqual([DURABILITY_ERROR]);
    }
    expect(DURABILITY_ERROR).toContain("no durable journal is available until T7");
  });

  test("accepts only loopback hosts, and allows their Host header by default", () => {
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.20",
      "localhost",
      "example.org",
      "127.0.0.256",
    ]) {
      expect(errorsOf({ ...EPHEMERAL, OPEN_ORIGIN_HOST: host })).toEqual([HOST_ERROR]);
    }
    expect(errorsOf({ ...EPHEMERAL, OPEN_ORIGIN_HOST: "127.0.0.01" })).toEqual([HOST_ERROR]);
    expect(configOf({ ...EPHEMERAL, OPEN_ORIGIN_HOST: "127.4.5.6" }).host).toBe("127.4.5.6");
    const ipv6 = configOf({ ...EPHEMERAL, OPEN_ORIGIN_HOST: "::1", OPEN_ORIGIN_PORT: "9000" });
    expect(ipv6.allowedHosts).toEqual(["localhost:9000", "[::1]:9000"]);
  });

  test("bounds every number, and accepts each bound itself", () => {
    // The caps are read with both at their bound, so the cap per IP never exceeds the global one.
    const caps = { MAX_CONNECTIONS: "65536", MAX_CONNECTIONS_PER_IP: "1" };
    const bounds: [string, number, number][] = [
      ["OPEN_ORIGIN_PORT", 1, 65_535],
      ["TICK_RATE_HZ", 1, 1000],
      ["PUBLICATION_BATCH_TICKS", 1, 300],
      ["MAX_CONNECTIONS", 1, 65_536],
      ["MAX_CONNECTIONS_PER_IP", 1, 65_536],
    ];
    for (const [name, low, high] of bounds) {
      const env = (text: string) =>
        name === "MAX_CONNECTIONS"
          ? { ...EPHEMERAL, MAX_CONNECTIONS_PER_IP: "1", [name]: text }
          : { ...EPHEMERAL, ...caps, [name]: text };
      expect(configOf(env(String(low)))).toBeDefined();
      expect(configOf(env(String(high)))).toBeDefined();
      const rule = `${name} must be an integer from ${low} to ${high}`;
      const outside = [String(low - 1), String(high + 1)];
      for (const text of [...outside, "5.5", "-1", "1e3", "05", "+5", "five", ""]) {
        expect(errorsOf(env(text))).toEqual([rule]);
      }
    }
    expect(configOf({ ...EPHEMERAL, TICK_RATE_HZ: "20" }).tickRateHz).toBe(20);
    expect(configOf({ ...EPHEMERAL, PUBLICATION_BATCH_TICKS: "7" }).publicationBatchTicks).toBe(7);
  });

  test("reads both connection caps and keeps the cap per IP within the global one", () => {
    const caps = { ...EPHEMERAL, MAX_CONNECTIONS: "64", MAX_CONNECTIONS_PER_IP: "64" };
    expect(configOf(caps).connections).toEqual({ global: 64, perIp: 64 });
    expect(errorsOf({ ...caps, MAX_CONNECTIONS_PER_IP: "65" })).toEqual([
      "MAX_CONNECTIONS_PER_IP must not exceed MAX_CONNECTIONS",
    ]);
    expect(errorsOf({ ...EPHEMERAL, MAX_CONNECTIONS_PER_IP: "0" })).toEqual([
      "MAX_CONNECTIONS_PER_IP must be an integer from 1 to 65536",
    ]);
  });

  test("reads exact origins and Host header values, and refuses anything else", () => {
    const lists = configOf({
      ...EPHEMERAL,
      PUBLIC_ORIGINS: "http://localhost:5173, https://example.org",
      ALLOWED_HOSTS: "localhost:8080,[::1]:8080,example.org",
    });
    expect(lists.publicOrigins).toEqual(["http://localhost:5173", "https://example.org"]);
    expect(lists.allowedHosts).toEqual(["localhost:8080", "[::1]:8080", "example.org"]);
    expect(configOf({ ...EPHEMERAL, PUBLIC_ORIGINS: "" }).publicOrigins).toEqual([]);
    const originRule =
      "PUBLIC_ORIGINS must be a comma-separated list of http or https origins, such as http://localhost:5173";
    for (const origins of ["http://x.org/path", "ftp://x.org", "x.org", "https://x.org/", "a,,b"]) {
      expect(errorsOf({ ...EPHEMERAL, PUBLIC_ORIGINS: origins })).toEqual([originRule]);
    }
    const hostRule =
      "ALLOWED_HOSTS must be a comma-separated list of Host header values, such as localhost:8080";
    for (const hosts of ["http://x.org", "x.org/a", "a b", "-x.org", "x.org:"]) {
      expect(errorsOf({ ...EPHEMERAL, ALLOWED_HOSTS: hosts })).toEqual([hostRule]);
    }
  });

  test("reports every variable at fault at once and never repeats a value", () => {
    const secret = "sk-live-0123456789abcdef";
    const errors = errorsOf({
      OPEN_ORIGIN_DURABILITY: secret,
      OPEN_ORIGIN_HOST: secret,
      OPEN_ORIGIN_PORT: secret,
      TICK_RATE_HZ: secret,
      PUBLICATION_BATCH_TICKS: secret,
      PUBLIC_ORIGINS: secret,
      ALLOWED_HOSTS: `${secret}/`,
      MAX_CONNECTIONS: secret,
      MAX_CONNECTIONS_PER_IP: secret,
      AI_MODE: secret,
    });
    expect(errors.map((error) => error.split(" ")[0])).toEqual([
      "OPEN_ORIGIN_DURABILITY",
      "OPEN_ORIGIN_HOST",
      "OPEN_ORIGIN_PORT",
      "TICK_RATE_HZ",
      "PUBLICATION_BATCH_TICKS",
      "PUBLIC_ORIGINS",
      "ALLOWED_HOSTS",
      "MAX_CONNECTIONS",
      "MAX_CONNECTIONS_PER_IP",
      "AI_MODE",
    ]);
    expect(errors.filter((error) => error.includes("sk-live"))).toEqual([]);
    expect(Object.isFrozen(errors)).toBe(true);
  });

  test("warns under Codespaces that the forwarded port must stay private", () => {
    const result = parseConfig({ ...EPHEMERAL, CODESPACES: "true" });
    expect(result.ok && result.warnings).toEqual([
      "CODESPACES=true: keep the forwarded port private; an ephemeral server is a local development server, not a public universe",
    ]);
    for (const value of ["false", "1", "TRUE"]) {
      const quiet = parseConfig({ ...EPHEMERAL, CODESPACES: value });
      expect(quiet.ok && quiet.warnings).toEqual([]);
    }
  });
});
