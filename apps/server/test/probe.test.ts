/**
 * The terminal probe (apps/server/tools/probe.ts; plan §7 and §11): its sanitizer writes every code
 * point a terminal would act on as `\u{…}`, so a hostile text can neither clear the screen nor
 * reorder a line; its arguments are checked with the protocol's rules; it reconnects with the
 * protocol's backoff, gives up a silent connection, resyncs after an anomaly at most once every 2 s,
 * and sends its camera and followed being again on every connection; and, against a server in this
 * process on a free loopback port, it prints each commit's clock, view, speech, and feed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChunkCoord,
  CLIENT_LIMITS,
  FORBIDDEN_CODE_POINTS,
  initialClientState,
  RECONNECT_BACKOFF,
  reconnectDelayMs,
  STALE_AFTER_MS,
} from "@open-origin/protocol/public";
import {
  errorFrame,
  frameText,
  helloFrame,
  pongFrame,
  statusFrame,
} from "../src/presentation/frames.ts";
import { serveTransport, type Transport } from "../src/transport/transport.ts";
import {
  DEFAULT_URL,
  Probe,
  type ProbeDeps,
  type ProbeOptions,
  parseProbeArgs,
  processDeps,
  refusedAsUnavailable,
  type SocketEvents,
} from "../tools/probe.ts";
import { renderScreen, sanitize } from "../tools/probe-screen.ts";
import {
  being,
  clockAt,
  ModelWorld,
  plain,
  presentationOver,
  WORLD_ID,
} from "./support/presentation.ts";
import { CountingPort, LOOPBACK, until } from "./support/sockets.ts";

describe("the sanitizer", () => {
  test.each([
    { name: "an ANSI sequence that clears the screen", text: "\x1b[2J", shown: "\\u{1B}[2J" },
    { name: "a right-to-left override", text: "abc\u202Edef", shown: "abc\\u{202E}def" },
    { name: "markup, which a terminal shows as text", text: "<script>", shown: "<script>" },
    { name: "a C1 control sequence introducer", text: "\u009b31m", shown: "\\u{9B}31m" },
    { name: "a title set by OSC", text: "\x1b]0;owned\x07", shown: "\\u{1B}]0;owned\\u{7}" },
    { name: "NUL, a line feed, and DEL", text: "a\0b\nc\x7f", shown: "a\\u{0}b\\u{A}c\\u{7F}" },
    {
      name: "a line separator and a zero-width joiner",
      text: "a\u2028b\u200Dc",
      shown: "a\\u{2028}b\\u{200D}c",
    },
    { name: "a lone surrogate", text: "x\ud800y", shown: "x\\u{D800}y" },
    { name: "a tag character", text: "a\u{e0041}", shown: "a\\u{E0041}" },
    { name: "a backslash, doubled", text: "\\u{1B}", shown: "\\\\u{1B}" },
    { name: "visible text, kept", text: "Hola, ¿qué tal? 😀 ñ", shown: "Hola, ¿qué tal? 😀 ñ" },
  ])("$name", ({ text, shown }) => {
    expect(sanitize(text)).toBe(shown);
  });

  test("escapes both ends of every forbidden range and of the surrogates, and keeps their neighbors", () => {
    const escaped = (point: number) => `\\u{${point.toString(16).toUpperCase()}}`;
    const ranges = [...FORBIDDEN_CODE_POINTS, [0xd800, 0xdfff] as const];
    const ends = ranges.flat();
    expect(ends.map((point) => sanitize(String.fromCodePoint(point)))).toEqual(ends.map(escaped));
    const neighbors = ranges
      .flatMap(([first, last]) => [first - 1, last + 1])
      .filter((point) => point >= 0 && unsafePoints(String.fromCodePoint(point)).length === 0);
    expect(neighbors.length).toBeGreaterThan(40);
    expect(neighbors.map((point) => sanitize(String.fromCodePoint(point)))).toEqual(
      neighbors.map((point) => String.fromCodePoint(point)),
    );
  });

  test("a screen shows hostile speech escaped, its markup as text", () => {
    const screen = renderScreen({
      url: DEFAULT_URL,
      link: "open",
      state: initialClientState(),
      speech: [
        {
          at: [0, 0],
          speech: { tick: 1, speaker: 1, to: 2, act: "greet", text: "\x1b[2J<script>" },
        },
        { at: [0, 0], speech: { tick: 2, speaker: 2, to: 1, act: "tell", text: "a\u202Eb" } },
      ],
      feed: [],
      counts: { commits: 0, anomalies: 0, errors: 0, badFrames: 0, resyncs: 0, reconnects: 0 },
      lastError: undefined,
    });
    const lines = screen.split("\n");
    expect(lines).toContain('  t1  #1 to #2  greet  in 0,0  "\\u{1B}[2J<script>"');
    expect(lines).toContain('  t2  #2 to #1  tell  in 0,0  "a\\u{202E}b"');
    expect(unsafePoints(screen.replaceAll("\n", ""))).toEqual([]);
  });
});

/** The code points of `text` that a terminal could act on. */
function unsafePoints(text: string): number[] {
  return [...text]
    .map((character) => character.codePointAt(0) ?? 0)
    .filter(
      (point) =>
        (point >= 0xd800 && point <= 0xdfff) ||
        FORBIDDEN_CODE_POINTS.some(([first, last]) => point >= first && point <= last),
    );
}

describe("the probe's arguments", () => {
  test("default to the server's address, no camera, nothing followed, and no end", () => {
    expect(parseProbeArgs([])).toEqual({
      url: DEFAULT_URL,
      chunks: [],
      follow: null,
      commits: undefined,
    });
  });

  test("take chunks, a square around one, a followed being, and a number of commits", () => {
    const options = parseProbeArgs([
      "--url",
      "ws://127.0.0.1:9000/ws",
      "--chunk",
      "5,-6",
      "--around",
      "-1,0",
      "--follow",
      "3",
      "--commits",
      "2",
    ]);
    expect(options).toEqual({
      url: "ws://127.0.0.1:9000/ws",
      chunks: [
        [5, -6],
        [-2, -1],
        [-1, -1],
        [0, -1],
        [-2, 0],
        [-1, 0],
        [0, 0],
        [-2, 1],
        [-1, 1],
        [0, 1],
      ],
      follow: 3,
      commits: 2,
    });
    expect(parseProbeArgs(["--around", "0,0", "--radius", "3"]).chunks).toHaveLength(49);
  });

  test.each([
    { argv: ["--fast"], message: 'unknown argument "--fast"' },
    { argv: ["constructor", "x"], message: 'unknown argument "constructor"' },
    { argv: ["--follow", "1", "--follow", "2"], message: "--follow is given twice" },
    { argv: ["--follow", "0"], message: "--follow takes a being id from 1" },
    { argv: ["--follow", "-1"], message: '--follow must be a whole number, not "-1"' },
    { argv: ["--follow"], message: '--follow must be a whole number, not ""' },
    { argv: ["--commits", "0"], message: "--commits must be at least 1" },
    { argv: ["--chunk", "1;2"], message: 'a chunk is written x,y, not "1;2"' },
    { argv: ["--radius", "1"], message: "--radius needs --around" },
    { argv: ["--around", "0,0", "--radius", "4"], message: "at most 64 chunks" },
    // Refused before the square is built: 200,001 × 200,001 chunks would never fit in memory.
    { argv: ["--around", "0,0", "--radius", "100000"], message: "asks for 200001 × 200001" },
    { argv: ["--chunk", "1,2", "--chunk", "1,2"], message: "each once" },
    { argv: ["--chunk", "99999999,0"], message: "inside the world" },
    { argv: ["--url", "http://127.0.0.1/ws"], message: "--url must be a ws: or wss: URL" },
  ])("refuse $argv", ({ argv, message }) => {
    expect(() => parseProbeArgs(argv)).toThrow(message);
  });
});

/** A socket the fake deps opened: its events, what was sent, and whether it was closed. */
type FakeSocket = { readonly events: SocketEvents; readonly sent: string[]; closed: boolean };

/** Sockets, timers, and time the test moves by hand. */
class FakeLink {
  readonly sockets: FakeSocket[] = [];
  readonly screens: string[] = [];
  timers: { at: number; callback: () => void }[] = [];
  time = 0;

  readonly deps: ProbeDeps = {
    connect: (_url, events) => {
      const socket: FakeSocket = { events, sent: [], closed: false };
      this.sockets.push(socket);
      return { send: (text) => socket.sent.push(text), close: () => (socket.closed = true) };
    },
    schedule: (ms, callback) => {
      const timer = { at: this.time + ms, callback };
      this.timers.push(timer);
      return () => {
        this.timers = this.timers.filter((pending) => pending !== timer);
      };
    },
    now: () => this.time,
    random: () => 0.5,
    show: (screen) => this.screens.push(screen),
  };

  /** The socket opened last. */
  get socket(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error("no socket was opened");
    return socket;
  }

  /** The delay of the one pending timer. */
  get delay(): number {
    expect(this.timers).toHaveLength(1);
    return (this.timers[0]?.at ?? 0) - this.time;
  }

  /** Fires the earliest timer, the clock moved to its time. */
  fire(): void {
    const timer = this.timers.toSorted((a, b) => a.at - b.at)[0];
    if (timer === undefined) throw new Error("no timer is pending");
    this.timers = this.timers.filter((pending) => pending !== timer);
    this.time = timer.at;
    timer.callback();
  }
}

const OPTIONS: ProbeOptions = { url: DEFAULT_URL, chunks: [[1, 2]], follow: 7, commits: undefined };
const ASKED = ['{"type":"subscribe","chunks":[[1,2]]}', '{"type":"follow","being":7}'];

/** The text of hello at `tick`, message 0 of a connection. */
function helloText(tick: number): string {
  const limits = { ...CLIENT_LIMITS };
  const world = { id: WORLD_ID, durability: "ephemeral" as const };
  return frameText(helloFrame(world, clockAt(tick), "running", limits), 0);
}

describe("the probe's connection", () => {
  test("reconnects with the protocol's backoff, at least 5 s after a 503, asking again each time", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    link.socket.events.open();
    expect(link.socket.sent).toEqual(ASKED);
    link.socket.events.close(true);
    expect(link.delay).toBe(reconnectDelayMs(0, 0.5, true));
    expect(link.delay).toBe(7500);
    link.fire();
    link.socket.events.open();
    expect(link.sockets).toHaveLength(2);
    expect(link.socket.sent).toEqual(ASKED);
    link.socket.events.close(false);
    expect(link.delay).toBe(reconnectDelayMs(1, 0.5));
    link.fire();
    link.socket.events.open();
    link.socket.events.message(helloText(3));
    // A hello starts the backoff over.
    link.socket.events.close(false);
    expect(link.delay).toBe(reconnectDelayMs(0, 0.5));
    expect(probe.counts.reconnects).toBe(3);
  });

  test("ignores the events of a socket it replaced", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    const first = link.socket;
    first.events.close(false);
    link.fire();
    first.events.open();
    first.events.message(helloText(3));
    first.events.close(true);
    expect(first.sent).toEqual([]);
    expect(probe.state.connection).toBeUndefined();
    expect(probe.counts.reconnects).toBe(1);
  });

  test("gives up a connection that hears nothing for 3 s, or that does not open in 3 s", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    expect(link.delay).toBe(3000);
    link.socket.events.open();
    link.time = 2999;
    link.socket.events.message(helloText(3));
    expect(link.delay).toBe(3000);
    link.fire();
    expect(link.sockets[0]?.closed).toBe(true);
    expect(link.delay).toBe(reconnectDelayMs(0, 0.5));
    link.fire();
    expect(link.sockets).toHaveLength(2);
    link.fire();
    expect(link.sockets[1]?.closed).toBe(true);
    expect(probe.counts.reconnects).toBe(2);
  });

  test("resyncs after an anomaly, at most once every 2 s", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    link.socket.events.open();
    link.socket.events.message(helloText(3));
    link.time = 10_000;
    // seq 2 after hello's 0: one message was lost.
    link.socket.events.message(frameText(statusFrame(3, "running"), 2));
    link.time = 11_999;
    link.socket.events.message(frameText(statusFrame(3, "running"), 4));
    const resyncs = () => link.socket.sent.filter((text) => text === '{"type":"resync"}').length;
    expect(resyncs()).toBe(1);
    link.time = 12_000;
    link.socket.events.message(frameText(statusFrame(3, "running"), 5));
    expect(resyncs()).toBe(2);
    expect(probe.counts).toMatchObject({ anomalies: 2, resyncs: 2 });
  });

  test("shows at once the code of the last error the server sent", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    link.socket.events.open();
    link.socket.events.message(helloText(3));
    link.socket.events.message(frameText(errorFrame(3, "unknown_being"), 1));
    expect(probe.counts.errors).toBe(1);
    expect(link.screens.at(-1)?.split("\n")).toContain(
      "errors from the server: 1, the last unknown_being",
    );
  });

  test("shows at once a status of the world, and a view an anomaly made stale", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    link.socket.events.open();
    link.socket.events.message(helloText(3));
    const shown = link.screens.length;
    link.socket.events.message(frameText(statusFrame(3, "halted"), 1));
    expect(link.screens).toHaveLength(shown + 1);
    expect(link.screens.at(-1)).toContain("ephemeral  halted");
    // A pong, which alone redraws nothing, at seq 3 after 1: a message was lost, and the screen
    // says the view is stale at once.
    const before = link.screens.length;
    link.socket.events.message(frameText(pongFrame(3, 7), 3));
    expect(probe.counts.anomalies).toBe(1);
    expect(link.screens).toHaveLength(before + 1);
    expect(link.screens.at(-1)?.split("\n")[0]).toContain("(view stale)");
  });

  test("counts a frame the schema refuses and applies nothing of it", () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    link.socket.events.open();
    link.socket.events.message('{"type":"hello"}');
    link.socket.events.message(new Uint8Array([123, 125]));
    expect(probe.counts.badFrames).toBe(2);
    expect(probe.state).toEqual(initialClientState());
  });

  test("stops: the socket closes, no timer is left, and nothing reconnects", async () => {
    const link = new FakeLink();
    const probe = new Probe(OPTIONS, link.deps);
    probe.start();
    link.socket.events.open();
    probe.stop();
    await probe.done;
    expect(link.socket.closed).toBe(true);
    expect(link.timers).toEqual([]);
    link.socket.events.close(false);
    expect(link.timers).toEqual([]);
    expect(link.sockets).toHaveLength(1);
  });

  test("reads a refused upgrade as unavailable only when Bun reports 503", () => {
    const error = (message: string) => new ErrorEvent("error", { message });
    expect(refusedAsUnavailable(error("Expected 101 status code: 503"))).toBe(true);
    expect(refusedAsUnavailable(error("Expected 101 status code: 502"))).toBe(false);
    expect(refusedAsUnavailable(new Event("error"))).toBe(false);
  });
});

const transports: Transport[] = [];
const probes: Probe[] = [];

afterEach(async () => {
  for (const probe of probes.splice(0)) probe.stop();
  for (const transport of transports.splice(0)) await transport.stop();
});

describe("the probe against a server in this process", () => {
  test("prints each commit's clock, view, followed being, speech, and feed", async () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model);
    const port = new CountingPort(presentation);
    const transport = serveTransport({
      presentation: port,
      hostname: LOOPBACK,
      port: 0,
      publicOrigins: [],
      allowedHosts: undefined,
      connections: { global: 4, perIp: 4 },
      log: () => undefined,
    });
    transports.push(transport);
    const screens: string[] = [];
    const url = `ws://${LOOPBACK}:${transport.port}/ws`;
    const probe = new Probe(
      { url, chunks: [[0, 0]], follow: 1, commits: 2 },
      { ...processDeps(), show: (screen) => screens.push(screen) },
    );
    probes.push(probe);
    probe.start();
    const asked = () => port.last !== undefined && port.received(port.last) === 2;
    await until(asked, "the probe's subscribe and follow");
    advance({ feed: [{ kind: "greeting", tick: 1, from: 1, to: 1, chunk: [0, 0] }] });
    await until(() => probe.counts.commits === 1, "the first commit");
    // The first transaction is a reset: speech reaches the chunks that stay in view, from the next.
    const text = plain("<script>hi</script>");
    advance({
      speech: [{ at: [0, 0], speech: { tick: 2, speaker: 1, to: 1, act: "greet", text } }],
    });
    let stopped = false;
    void probe.done.then(() => {
      stopped = true;
    });
    await until(() => stopped, "the probe to stop after its second commit");
    const lines = screens.at(-1)?.split("\n") ?? [];
    expect(lines.slice(0, 4)).toEqual([
      `open-origin probe  ${url}  open`,
      `world ${WORLD_ID}  ephemeral  running`,
      "tick 2  day 0  20/1000 of the day",
      "following: #1  s1  adult  born 0  cell 3,3  idle",
    ]);
    expect(lines).toContain("chunks (9):");
    expect(lines).toContain("  0,0  v0  1 beings");
    expect(lines).toContain('  t2  #1 to #1  greet  in 0,0  "<script>hi</script>"');
    expect(lines).toContain("  t1  greeting  #1 to #1 in 0,0");
    expect(lines.slice(-2)).toEqual([
      "errors from the server: 0",
      "commits 2  anomalies 0  bad frames 0  resyncs 0  reconnects 0",
    ]);
  });

  test("waits the protocol's floor after a real 503: Bun's error text carries the status", async () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation } = presentationOver(model);
    const transport = serveTransport({
      presentation: new CountingPort(presentation),
      hostname: LOOPBACK,
      port: 0,
      publicOrigins: [],
      allowedHosts: undefined,
      connections: { global: 1, perIp: 1 },
      log: () => undefined,
    });
    transports.push(transport);
    const url = `ws://${LOOPBACK}:${transport.port}/ws`;
    const options = {
      url,
      chunks: [[0, 0]] as ChunkCoord[],
      follow: null,
      commits: undefined,
    };
    let held = false;
    const holder = new Probe(options, { ...processDeps(), show: () => (held = true) });
    probes.push(holder);
    holder.start();
    // The holder's hello shows its first screen: it holds the only slot.
    await until(() => held, "the first probe's hello");
    const delays: number[] = [];
    const refused = new Probe(options, {
      ...processDeps(),
      show: () => undefined,
      // No jitter: an ordinary retry would wait 0 ms, so only the 503 floor gives more.
      random: () => 0,
      schedule: (ms) => {
        delays.push(ms);
        return () => undefined;
      },
    });
    probes.push(refused);
    refused.start();
    // The silence timer is armed as the socket opens; the retry's delay comes after it.
    const retries = () => delays.filter((ms) => ms !== STALE_AFTER_MS);
    await until(() => retries().length > 0, "the refused probe's retry");
    expect(retries()).toEqual([RECONNECT_BACKOFF.afterUnavailableMs]);
  });
});
