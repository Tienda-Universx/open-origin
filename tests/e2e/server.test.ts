/**
 * The public server as a process (ADR 0019; ADR 0025, "Faults" and "Ephemeral mode"; plan §13, the
 * end-to-end list and test 18): `Bun.spawn` runs apps/server/src/main.ts, the default world of T5,
 * at 50 ticks a second on a port the system chooses. It reports its port on stdout; two clients
 * connect, receive commits, follow the same being, and see the same views; an unhandled rejection
 * halts the world, which every client hears; SIGTERM closes them with 1001 and exits with 0 once
 * every executed tick is published. Started without ephemeral mode, on a host that is not
 * loopback, and with AI_MODE on, it names each problem and exits with 1.
 *
 * The rejection comes from tests/e2e/fixtures/reject-on-input.ts, which `bun --preload` runs in the
 * server's own process: the server's code has no switch for tests. Each test kills its process if
 * it is still running.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SocketClient, until } from "../../apps/server/test/support/sockets.ts";

const MAIN = `${import.meta.dir}/../../apps/server/src/main.ts`;
const REJECT_ON_INPUT = `${import.meta.dir}/fixtures/reject-on-input.ts`;
const REPO = `${import.meta.dir}/../..`;

/** How long a step of a spawned server may take: generous, for a loaded runner. */
const STEP_MS = 10_000;

/** A line of the server's log. */
type LogEntry = { readonly event: string } & Readonly<Record<string, unknown>>;

/** The variables the process gets: only these, so the host's own (CODESPACES) change nothing. */
function environment(variables: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = ["PATH", "HOME", "TMPDIR"].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(inherited), ...variables };
}

/** A spawned server and the JSON lines of its stdout, read as they come. */
class ServerProcess {
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly entries: LogEntry[] = [];
  /** Resolves once stdout ended. */
  readonly read: Promise<void>;

  constructor(variables: Readonly<Record<string, string>>, preload?: string) {
    const preloads = preload === undefined ? [] : ["--preload", preload];
    this.child = Bun.spawn([process.execPath, ...preloads, MAIN], {
      cwd: REPO,
      env: environment(variables),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.read = this.#readLines();
  }

  /** The first line of `event`, once the server wrote it. */
  async entry(event: string): Promise<LogEntry> {
    await until(() => this.entries.some((entry) => entry.event === event), `"${event}"`, STEP_MS);
    const found = this.entries.find((entry) => entry.event === event);
    if (found === undefined) throw new Error(`no "${event}" line`);
    return found;
  }

  async #readLines(): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of this.child.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
        this.entries.push(JSON.parse(rest.slice(0, end)));
        rest = rest.slice(end + 1);
      }
    }
  }
}

const spawned: ServerProcess[] = [];
const clients: SocketClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.socket.close();
  for (const server of spawned.splice(0)) {
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
    await server.child.exited;
  }
});

function spawnServer(variables: Readonly<Record<string, string>>, preload?: string) {
  const server = new ServerProcess(variables, preload);
  spawned.push(server);
  return server;
}

/** A client of the server at `port`, closed after the test. */
async function connect(port: number): Promise<SocketClient> {
  const client = await SocketClient.open(port);
  clients.push(client);
  return client;
}

/** What `client` showed at each commit: its view's chunks and followed being, by tick. */
function recordViews(client: SocketClient): Map<number, string> {
  const views = new Map<number, string>();
  client.view.onCommit = ({ tick }) => {
    const view = client.view.state.view;
    const chunks = [...(view?.chunks ?? [])].map(([key, chunk]) => [
      key,
      chunk.v,
      [...chunk.beings],
    ]);
    views.set(tick, JSON.stringify({ chunks, followed: view?.followed }));
  };
  return views;
}

/** The tick of the last commit of `client`, 0 before its first. */
const lastCommit = (client: SocketClient) => client.view.commits.at(-1)?.tick ?? 0;

/** Whether `client` heard that the world halted. */
const heardHalt = (client: SocketClient) =>
  client.view.messages.some((message) => message.type === "status" && message.state === "halted");

/**
 * Two clients of the server at `port`, which follow being 1 once their views passed tick 1, when
 * the beings arrive; and what each showed at each commit.
 */
async function followers(port: number) {
  const pair = [await connect(port), await connect(port)];
  const views = pair.map(recordViews);
  await until(() => pair.every((client) => lastCommit(client) >= 1), "tick 1", STEP_MS);
  for (const client of pair) client.send(JSON.stringify({ type: "follow", being: 1 }));
  await until(
    () => pair.every(({ view }) => view.state.view?.followed?.id === 1),
    "the followed being",
    STEP_MS,
  );
  return { pair, views };
}

/** Both clients heard the same ephemeral world. */
function expectSameWorld(pair: readonly SocketClient[]): void {
  const hellos = pair.map(({ view }) =>
    view.messages.flatMap((message) => (message.type === "hello" ? [message] : [])),
  );
  const [first, second] = hellos.map((hello) => hello[0]);
  expect(hellos.map((hello) => hello.length)).toEqual([1, 1]);
  expect([first?.durability, second?.durability]).toEqual(["ephemeral", "ephemeral"]);
  expect(first?.world.id).toBe(second?.world.id ?? "");
}

/** The two views agree at every tick both committed, the followed being shown at some. */
function expectSameViews(views: readonly ReadonlyMap<number, string>[]): void {
  const [one = new Map(), other = new Map()] = views;
  const common = [...one.keys()].filter((tick) => other.has(tick));
  expect(common.length).toBeGreaterThan(0);
  expect(common.map((tick) => one.get(tick))).toEqual(common.map((tick) => other.get(tick)));
  expect(common.some((tick) => one.get(tick)?.includes('"followed":{"id":1'))).toBe(true);
}

/** The server's last line says it stopped, halted, with every executed tick published. */
function expectStopped(server: ServerProcess): void {
  const stopped = server.entries.at(-1);
  expect(stopped).toMatchObject({ event: "stopped", state: "halted" });
  const executed = stopped?.executedTick;
  expect([stopped?.committedTick, stopped?.publishedTick]).toEqual([executed, executed]);
}

describe("the server process", () => {
  test("reports its port, serves two clients the same world, halts on an unhandled rejection, and exits with 0 on SIGTERM", async () => {
    const server = spawnServer(
      { OPEN_ORIGIN_DURABILITY: "ephemeral", OPEN_ORIGIN_PORT: "0", TICK_RATE_HZ: "50" },
      REJECT_ON_INPUT,
    );
    const listening = await server.entry("listening");
    const port = Number(listening.port);
    expect(listening).toEqual({ event: "listening", host: "127.0.0.1", port });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await health.json()).toEqual({ ok: true });
    const { pair, views } = await followers(port);
    expectSameWorld(pair);
    server.child.stdin.write("reject\n");
    server.child.stdin.flush();
    await until(() => pair.every(heardHalt), "the halt", STEP_MS);
    expect(await server.entry("unhandled_rejection")).toMatchObject({
      cause: { message: "a rejection the end-to-end test planted" },
      state: "halted",
      halt: { code: "unhandled_rejection" },
    });
    server.child.kill("SIGTERM");
    expect(await server.child.exited).toBe(0);
    await server.read;
    expect(await Promise.all(pair.map((client) => client.closing()))).toEqual([1001, 1001]);
    expectStopped(server);
    expectSameViews(views);
    for (const client of pair) expect([client.errors, client.view.anomalies]).toEqual([[], []]);
  }, 30_000);

  test("refuses to start without ephemeral mode, on a host that is not loopback, or with AI_MODE on, naming each", async () => {
    const server = spawnServer({ OPEN_ORIGIN_HOST: "0.0.0.0", AI_MODE: "on" });
    expect(await server.child.exited).toBe(1);
    await server.read;
    expect(server.entries).toEqual([
      {
        event: "config_error",
        message:
          'OPEN_ORIGIN_DURABILITY must be "ephemeral": no durable journal is available until T7',
      },
      {
        event: "config_error",
        message:
          "OPEN_ORIGIN_HOST must be a loopback address (127.0.0.0/8 or ::1): an ephemeral server listens only on this machine",
      },
      {
        event: "config_error",
        message: 'AI_MODE must be "off": other modes refuse to start until T9',
      },
    ]);
  }, 30_000);
});
