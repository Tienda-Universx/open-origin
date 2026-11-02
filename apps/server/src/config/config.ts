/**
 * The server's configuration (ADR 0025, "Configuration" and "Ephemeral mode"): read from the
 * environment once, at start, validated with zod, and deep-frozen. Parsing is a pure function of
 * the environment record: it reports every problem at once, names the variable at fault, and never
 * repeats a value, so a secret set by mistake never reaches a log.
 */
import { z } from "zod";

/** The environment, as the process gives it: names to text, or nothing. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The configuration of one server process. */
export type Config = {
  /** Whether the world survives a restart: only `ephemeral` until T7's durable journal. */
  readonly durability: "ephemeral";
  /** The address the public listener binds: a loopback address in ephemeral mode. */
  readonly host: string;
  readonly port: number;
  /** The fixed rate of the public universe, in ticks per real second. */
  readonly tickRateHz: number;
  /** F: the ticks of one journal batch (ADR 0007). */
  readonly publicationBatchTicks: number;
  /** The browser origins the public listener accepts, matched exactly. */
  readonly publicOrigins: readonly string[];
  /** The values of the `Host` header the public listener accepts. */
  readonly allowedHosts: readonly string[];
  /** The open public connections allowed in all, and from one IP address. */
  readonly connections: { readonly global: number; readonly perIp: number };
  /** Whether models may run: only `off` until T9. */
  readonly aiMode: "off";
};

/** A parsed configuration and what the operator should know at start, or every problem found. */
export type ConfigResult =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The rate's bounds: the admin contract's `tickRateHz` (`@open-origin/protocol/admin`). */
const MAX_TICK_RATE_HZ = 1000;
/** A batch never spans more than one checkpoint interval of K = 300 ticks (ADR 0007). */
const MAX_BATCH_TICKS = 300;
const MAX_CONNECTIONS = 65_536;

/** A decimal integer from `min` to `max`, read from text: no sign, no fraction, no exponent. */
function integerIn(min: number, max: number) {
  return z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/)
    .transform(Number)
    .pipe(z.int().min(min).max(max));
}

/** An IPv4 octet, from 0 to 255, without leading zeros. */
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
/** A loopback address: IPv4 127.0.0.0/8 or IPv6 ::1. Names are refused: they resolve elsewhere. */
const LOOPBACK = new RegExp(String.raw`^(?:127(?:\.${OCTET}){3}|::1)$`);

/** A `Host` header value: a name or an IPv4 address, or a bracketed IPv6 address, and a port. */
const HOST_HEADER =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** Whether `text` is exactly an http or https origin: a scheme, a host, a port, and no path. */
function isOrigin(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === text;
}

/** A comma-separated list whose items each pass `item`; empty text is an empty list. */
function listOf(item: z.ZodType<string, string>) {
  return z
    .string()
    .transform((text) => (text.trim() === "" ? [] : text.split(",").map((part) => part.trim())))
    .pipe(z.array(item));
}

/** One variable: its schema, which accepts its text or its absence, and the rule it states. */
type Variable<T> = { readonly schema: z.ZodType<T>; readonly rule: string };

const DURABILITY: Variable<"ephemeral"> = {
  schema: z.literal("ephemeral"),
  rule: 'must be "ephemeral": no durable journal is available until T7',
};
const HOST: Variable<string> = {
  schema: z.string().regex(LOOPBACK).default("127.0.0.1"),
  rule: "must be a loopback address (127.0.0.0/8 or ::1): an ephemeral server listens only on this machine",
};
const PORT: Variable<number> = {
  schema: integerIn(1, 65_535).default(8080),
  rule: "must be an integer from 1 to 65535",
};
const TICK_RATE: Variable<number> = {
  schema: integerIn(1, MAX_TICK_RATE_HZ).default(5),
  rule: `must be an integer from 1 to ${MAX_TICK_RATE_HZ}`,
};
const BATCH_TICKS: Variable<number> = {
  schema: integerIn(1, MAX_BATCH_TICKS).default(5),
  rule: `must be an integer from 1 to ${MAX_BATCH_TICKS}`,
};
const ORIGINS: Variable<string[]> = {
  schema: listOf(z.string().refine(isOrigin)).default(() => []),
  rule: "must be a comma-separated list of http or https origins, such as http://localhost:5173",
};
const HOSTS: Variable<string[] | undefined> = {
  schema: listOf(z.string().regex(HOST_HEADER)).optional(),
  rule: "must be a comma-separated list of Host header values, such as localhost:8080",
};
const GLOBAL_CAP: Variable<number> = {
  schema: integerIn(1, MAX_CONNECTIONS).default(1024),
  rule: `must be an integer from 1 to ${MAX_CONNECTIONS}`,
};
const PER_IP_CAP: Variable<number> = {
  schema: integerIn(1, MAX_CONNECTIONS).default(16),
  rule: `must be an integer from 1 to ${MAX_CONNECTIONS}`,
};
const AI_MODE: Variable<"off"> = {
  schema: z.literal("off").default("off"),
  rule: 'must be "off": other modes refuse to start until T9',
};

/** Reads the variables of an environment, collecting a message for each one that fails. */
class Reader {
  readonly errors: string[] = [];
  readonly #env: Environment;

  constructor(env: Environment) {
    this.#env = env;
  }

  /** The value of `name`, or `fallback` after recording that it breaks its rule. */
  read<T>(name: string, { schema, rule }: Variable<T>, fallback: T): T {
    const result = schema.safeParse(this.#env[name]);
    if (result.success) return result.data;
    this.errors.push(`${name} ${rule}`);
    return fallback;
  }
}

/** The `Host` header values a listener at `host:port` answers to when ALLOWED_HOSTS is unset. */
function defaultAllowedHosts(host: string, port: number): string[] {
  const address = host.includes(":") ? `[${host}]` : host;
  return [`localhost:${port}`, `${address}:${port}`];
}

/** What the operator must know at start, from the environment. */
function warningsOf(env: Environment): string[] {
  if (env.CODESPACES !== "true") return [];
  return [
    "CODESPACES=true: keep the forwarded port private; an ephemeral server is a local development server, not a public universe",
  ];
}

/**
 * The configuration of `env`, deep-frozen, with the warnings to show at start; or every problem,
 * one message per variable at fault, naming it and its rule, never its value.
 */
export function parseConfig(env: Environment): ConfigResult {
  const reader = new Reader(env);
  const durability = reader.read("OPEN_ORIGIN_DURABILITY", DURABILITY, "ephemeral");
  const host = reader.read("OPEN_ORIGIN_HOST", HOST, "127.0.0.1");
  const port = reader.read("OPEN_ORIGIN_PORT", PORT, 1);
  const tickRateHz = reader.read("TICK_RATE_HZ", TICK_RATE, 1);
  const publicationBatchTicks = reader.read("PUBLICATION_BATCH_TICKS", BATCH_TICKS, 1);
  const publicOrigins = reader.read("PUBLIC_ORIGINS", ORIGINS, []);
  const allowedHosts = reader.read("ALLOWED_HOSTS", HOSTS, []);
  const global = reader.read("MAX_CONNECTIONS", GLOBAL_CAP, 1);
  const perIp = reader.read("MAX_CONNECTIONS_PER_IP", PER_IP_CAP, 1);
  const aiMode = reader.read("AI_MODE", AI_MODE, "off");
  if (perIp > global) reader.errors.push("MAX_CONNECTIONS_PER_IP must not exceed MAX_CONNECTIONS");
  if (reader.errors.length > 0) return { ok: false, errors: Object.freeze(reader.errors) };
  const config: Config = Object.freeze({
    durability,
    host,
    port,
    tickRateHz,
    publicationBatchTicks,
    publicOrigins: Object.freeze(publicOrigins),
    allowedHosts: Object.freeze(allowedHosts ?? defaultAllowedHosts(host, port)),
    connections: Object.freeze({ global, perIp }),
    aiMode,
  });
  return { ok: true, config, warnings: Object.freeze(warningsOf(env)) };
}
