/**
 * The world through real sockets on loopback (plan tests 1, 2, 10, 11, and 12, and the WebSocket
 * variant of P9; ADR 0025, "Verification"; ADR 0026). The mind@1 subject world runs as production
 * composes it, on a fake clock, behind the real transport, for 40 ticks. Ten clients of Bun's
 * WebSocket act between periods, and after each the test waits until every frame, each way, arrived:
 *
 * - two calm clients of the subject's chunks, which see the same ticks and the same views, each
 *   the published world at its commit's tick (tests 1 and 2);
 * - a client of a distant region, which floods the bucket of new chunks once and then hears the same
 *   feed as the calm ones (test 10);
 * - a follower that follows a being the world does not hold, then churns camera and followed
 *   being at random, pings, and resyncs;
 * - a client that stops reading for ten periods, and one that leaves and comes back;
 * - the hostile battery (test 12): a binary frame (1003), a frame over 4 KiB (1009), bad JSON,
 *   `__proto__`, and a type that would pause the world (1008 on the third strike), and 25 pings at
 *   once, past the bucket (1008).
 *
 * For every tick the fake-clock time, the commands, the checksum, and the published bytes, and at
 * the end the snapshot, equal a run with no clients (support/invariance.ts). Every frame of every
 * client parses with the strict schemas and holds no taint, seal, checksum, or state root (test
 * 11). The canary world runs through the same transport, and no frame holds its canaries or seeds.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stateRoot } from "@open-origin/engine";
import { type ChunkCoord, chunkKey, type FeedItem } from "@open-origin/protocol/public";
import { Random } from "../../../packages/protocol/test/support/random.ts";
import { composeServer, type Server } from "../src/compose.ts";
import type { ClientId } from "../src/presentation/interest.ts";
import { serveTransport, type TransportEvent } from "../src/transport/transport.ts";
import { ScriptedSource } from "../src/world/source.ts";
import {
  CANARY_NUMBERS,
  CANARY_TEXTS,
  CANARY_TRAITS,
  canaryScript,
  canaryWorld,
  SITTER,
} from "./support/canary-world.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import {
  config,
  divergence,
  P,
  PublicHistory,
  type SubjectRun,
  subjectRun,
  type Timeline,
} from "./support/invariance.ts";
import { FORBIDDEN_NAMES, found, sealsOf, seedTexts, stateText } from "./support/leak.ts";
import { type ChunkState, shown, WORLD_ID } from "./support/presentation.ts";
import { CountingPort, LOOPBACK, SocketClient, until } from "./support/sockets.ts";

/** The ticks of each run. */
const TICKS = 40;

/** The chunks of the subject's beings: the camera of the calm clients. */
const CAMERA: readonly ChunkCoord[] = [
  [2, -1],
  [3, -1],
];

/** A chunk far from every being, and 64 chunks from it east, then 64 more beyond. */
const DISTANT: ChunkCoord = [40, 40];
const grid = (west: number): ChunkCoord[] =>
  Array.from({ length: 64 }, (_, index) => [west + (index % 8), 40 + Math.floor(index / 8)]);

/** Chunks around the subject's beings, for the follower's camera. */
const AROUND: readonly ChunkCoord[] = [
  [1, -1],
  [2, -1],
  [3, -1],
  [4, -1],
  [2, -2],
  [3, -2],
];

const subscribe = (chunks: readonly ChunkCoord[]) => JSON.stringify({ type: "subscribe", chunks });
const follow = (being: number | null) => JSON.stringify({ type: "follow", being });

/** What the server sent `client` in `error` messages, by code. */
const errorsOf = (client: SocketClient) =>
  client.view.messages.flatMap((message) => (message.type === "error" ? [message.code] : []));

/** The roles of the ten clients. */
const ROLES = [
  "calmA",
  "calmB",
  "distant",
  "follower",
  "sleeper",
  "leaver",
  "binary",
  "oversized",
  "striker",
  "flooder",
] as const;
type Role = (typeof ROLES)[number];

/** One move of the crowd: a step and what a client does then. */
type Move = readonly [number, (crowd: Crowd) => void | Promise<void>];

/** The scripted moves; the follower also churns at random from step 10 on. */
const MOVES: readonly Move[] = [
  [
    0,
    ({ clients }) => {
      for (const role of ["calmA", "calmB", "sleeper", "leaver"] as const) {
        clients[role].send(subscribe(CAMERA));
      }
      clients.distant.send(subscribe(grid(40)));
      // A being the world does not hold: a correct client may meet unknown_being, with no strike.
      clients.follower.send(follow(99));
    },
  ],
  [1, ({ clients }) => clients.distant.send(subscribe(grid(48)))],
  [
    2,
    ({ clients }) => {
      clients.distant.send(subscribe([DISTANT]));
      clients.striker.send("{");
    },
  ],
  [
    3,
    ({ clients }) => {
      clients.striker.send('{"type":"subscribe","chunks":[],"__proto__":{"chunks":[[0,0]]}}');
      clients.binary.send(new Uint8Array([1, 2, 3]));
    },
  ],
  [
    4,
    ({ clients }) => {
      clients.striker.send('{"type":"pause"}');
      clients.oversized.send(`"${"x".repeat(4095)}"`);
    },
  ],
  [
    5,
    ({ clients }) => {
      for (let nonce = 0; nonce < 25; nonce += 1) {
        clients.flooder.send(JSON.stringify({ type: "ping", nonce }));
      }
    },
  ],
  [6, ({ clients }) => clients.sleeper.socket.pause()],
  [8, ({ clients }) => clients.follower.send(follow(1))],
  [12, ({ clients }) => clients.leaver.socket.close()],
  [16, ({ clients }) => clients.sleeper.socket.resume()],
  [20, (crowd) => crowd.rejoin()],
];

/** What a client showed at each commit. */
type Shown = { readonly tick: number; readonly chunks: Map<string, ChunkState> };

/** Records what `client` shows at each of its commits from now on. */
function recordCommits(client: SocketClient): Shown[] {
  const commits: Shown[] = [];
  client.view.onCommit = ({ tick }) => commits.push({ tick, chunks: shown(client.view.state) });
  return commits;
}

/** Ten clients of the transport at `port`, whose frames `counting` counts on the server's side. */
class Crowd {
  readonly #port: number;
  readonly #counting: CountingPort;
  readonly #random = new Random(0x50c7e7);
  readonly #ids = new Map<SocketClient, ClientId>();
  readonly clients = {} as Record<Role, SocketClient>;
  /** The leaver's socket once it came back, and what it showed at each commit from its first. */
  returned: SocketClient | undefined;
  returnedCommits: Shown[] = [];

  constructor(port: number, counting: CountingPort) {
    this.#port = port;
    this.#counting = counting;
  }

  /** Every socket that ever opened. */
  get all(): SocketClient[] {
    const clients = Object.values(this.clients);
    return this.returned === undefined ? clients : [...clients, this.returned];
  }

  /** Opens the ten clients, one after the other, so each knows its id on the server. */
  async join(): Promise<void> {
    for (const role of ROLES) this.clients[role] = await this.#open();
  }

  async rejoin(): Promise<void> {
    this.returned = await this.#open();
    this.returnedCommits = recordCommits(this.returned);
    this.returned.send(subscribe(CAMERA));
  }

  /** The moves of `step`, then the follower's churn. */
  async act(step: number): Promise<void> {
    for (const [at, move] of MOVES) if (at === step) await move(this);
    if (step >= 10) this.#churn(this.clients.follower);
  }

  /** Waits until every client that reads got every frame sent to it, and sent every message. */
  async settle(): Promise<void> {
    await until(() => this.all.every((client) => this.#settled(client)), "the frames to arrive");
  }

  #settled(client: SocketClient): boolean {
    if (client.closed || client.socket.isPaused) return true;
    const id = this.#ids.get(client) ?? -1;
    return client.frames === this.#counting.sent(id) && this.#counting.received(id) === client.sent;
  }

  async #open(): Promise<SocketClient> {
    const client = await SocketClient.open(this.#port);
    this.#ids.set(client, this.#counting.last ?? -1);
    return client;
  }

  /** One random move of `client`: a camera, a followed being, a ping, a resync, or nothing. */
  #churn(client: SocketClient): void {
    const roll = this.#random.below(10);
    if (roll < 3) {
      const first = this.#random.below(AROUND.length);
      const size = 1 + this.#random.below(3);
      client.send(subscribe(AROUND.slice(first, first + size)));
    } else if (roll < 6) client.send(follow(roll === 5 ? null : 1 + this.#random.below(3)));
    else if (roll < 8)
      client.send(JSON.stringify({ type: "ping", nonce: this.#random.below(1000) }));
    else if (roll === 8) client.send(JSON.stringify({ type: "resync" }));
  }
}

/** The transport over `server`'s presentation on a free loopback port, counting what passes. */
function behindTransport(server: Server) {
  const counting = new CountingPort(server.presentation);
  const logs: TransportEvent[] = [];
  const transport = serveTransport({
    presentation: counting,
    hostname: LOOPBACK,
    port: 0,
    publicOrigins: [],
    allowedHosts: undefined,
    connections: { global: 64, perIp: 64 },
    log: (event) => logs.push(event),
  });
  return { transport, counting, logs };
}

/**
 * Starts `server` and runs `ticks` steps of the fake clock, each up to half a period after its
 * tick, calling `between` after each.
 */
async function drive(
  server: Server,
  timer: FakeTimer,
  ticks: number,
  between: (step: number) => Promise<void>,
): Promise<void> {
  server.start();
  for (let step = 0; step < ticks; step += 1) {
    await timer.runUntilSettled(step * P + P / 2);
    await between(step);
  }
}

/** A run of the subject with no client: the reference. */
async function quietRun(): Promise<Timeline> {
  const run = subjectRun();
  await drive(run.server, run.timer, TICKS, async () => undefined);
  return run.finish();
}

/** A run of the subject with the crowd behind the real transport. */
async function crowdRun() {
  const run: SubjectRun = subjectRun();
  const history = new PublicHistory();
  run.server.world.subscribeToPublished(history.apply);
  const { transport, counting, logs } = behindTransport(run.server);
  const crowd = new Crowd(transport.port, counting);
  await crowd.join();
  const calm = [crowd.clients.calmA, crowd.clients.calmB, crowd.clients.sleeper].map(recordCommits);
  await drive(run.server, run.timer, TICKS, async (step) => {
    await crowd.act(step);
    await crowd.settle();
  });
  await transport.stop();
  await until(() => crowd.all.every(({ closed }) => closed), "every socket to close");
  const timeline = await run.finish();
  return { run, timeline, crowd, calm, history, counting, logs, transport };
}

let reference: Timeline;
let live: Awaited<ReturnType<typeof crowdRun>>;

beforeAll(async () => {
  reference = await quietRun();
  live = await crowdRun();
});

/** Each commit of `commits` showed the published world at its tick for the chunks `camera`. */
function expectPublished(commits: readonly Shown[], camera: readonly ChunkCoord[]): void {
  const keys = camera.map(chunkKey);
  expect(commits.length).toBeGreaterThan(0);
  for (const { tick, chunks } of commits) {
    expect([tick, chunks]).toEqual([tick, live.history.chunks(tick, keys)]);
  }
}

/** The feed items `client` received about ticks up to `last`. */
function feedOf(client: SocketClient, last: number): FeedItem[] {
  return client.view.messages
    .flatMap((message) => (message.type === "events" ? message.items : []))
    .filter(({ tick }) => tick <= last);
}

describe("the world through real sockets", () => {
  test("ten clients over real sockets leave every tick and the final snapshot as they were (P9)", () => {
    expect(reference.ticks).toBe(TICKS);
    expect(divergence(reference, live.timeline)).toBeUndefined();
    // The clients did act: they subscribed, followed, pinged, and were closed.
    const { follower } = live.crowd.clients;
    expect(follower.sent).toBeGreaterThan(10);
    expect(follower.view.commits.some((commit) => commit.tick > 30)).toBe(true);
    expect(live.counting.closes.length).toBeGreaterThanOrEqual(3);
  });

  test("two clients of the same chunks see the same ticks and the same views, the published world (tests 1 and 2)", () => {
    const [calmA = [], calmB = [], sleeper = []] = live.calm;
    expect(calmA.map(({ tick }) => tick)).toEqual(calmB.map(({ tick }) => tick));
    expect(calmA).toEqual(calmB);
    expect(calmA.length).toBeGreaterThanOrEqual(TICKS - 10);
    expectPublished(calmA, CAMERA);
    // A client that stopped reading for ten periods caught up, consistent at every commit, and so
    // did the client that left and came back.
    expectPublished(sleeper, CAMERA);
    expect(sleeper.at(-1)?.tick).toBe(calmA.at(-1)?.tick);
    const { leaver } = live.crowd.clients;
    expect(leaver.closed).toBe(true);
    expect(live.crowd.returned?.view.messages[0]).toMatchObject({ type: "hello", seq: 0 });
    expect(live.crowd.returned?.view.messages[1]).toMatchObject({ type: "snapshot", reset: true });
    expectPublished(live.crowd.returnedCommits, CAMERA);
    expect(live.crowd.returnedCommits.at(-1)?.tick).toBe(calmA.at(-1)?.tick);
  });

  test("a client of a distant region hears the same feed (test 10)", () => {
    const { calmA, distant } = live.crowd.clients;
    const last = Math.min(...[calmA, distant].map(({ view }) => view.commits.at(-1)?.tick ?? 0));
    const feed = feedOf(calmA, last);
    expect(feed.filter(({ kind }) => kind === "greeting").length).toBeGreaterThanOrEqual(3);
    expect(feedOf(distant, last)).toEqual(feed);
    // Its second camera of 64 new chunks within 2 s was refused, with one strike, and it stayed.
    expect(errorsOf(distant)).toEqual(["rate_limited"]);
    expect([...(distant.view.state.view?.chunks.keys() ?? [])]).toEqual([chunkKey(DISTANT)]);
  });

  test("the hostile battery closes each hostile client with its code, and the others go on (test 12)", () => {
    const { binary, oversized, striker, flooder, follower, calmA, calmB } = live.crowd.clients;
    expect([binary.code, oversized.code, striker.code, flooder.code]).toEqual([
      1003, 1009, 1008, 1008,
    ]);
    expect(errorsOf(striker)).toEqual(["bad_json", "bad_message"]);
    const pongs = flooder.view.messages.filter(({ type }) => type === "pong");
    expect([pongs.length, errorsOf(flooder)]).toEqual([20, ["rate_limited", "rate_limited"]]);
    expect(live.logs).toContainEqual({ event: "binary_frame", size: 3 });
    // A correct client may meet unknown_being, with no strike.
    expect(errorsOf(follower)[0]).toBe("unknown_being");
    expect(
      errorsOf(follower).every((code) => ["unknown_being", "resync_too_soon"].includes(code)),
    ).toBe(true);
    for (const client of [calmA, calmB, follower]) {
      expect([client.code, errorsOf(client).includes("rate_limited")]).toEqual([1001, false]);
      expect(client.view.anomalies).toEqual([]);
    }
    expect(errorsOf(calmA)).toEqual([]);
    expect([live.run.server.presentation.usage().clients, live.transport.connections()]).toEqual([
      0, 0,
    ]);
  });

  test("every frame parses strictly and holds no taint, seal, checksum, or state root of the subject (test 11)", () => {
    const { run, timeline, crowd } = live;
    expect(crowd.all.flatMap(({ errors }) => errors)).toEqual([]);
    const text = crowd.all.flatMap(({ view }) => view.texts).join("\n");
    // The facts the scan needs reached the clients: greetings and tells in the local speech, and
    // the world holds the taints of the research injection of tick 30.
    expect(text).toContain('"act":"greet"');
    expect(text).toContain('"act":"tell"');
    expect(stateText(run.world)).toMatch(/"tn":[1-9]/);
    const forbidden = [
      ...FORBIDDEN_NAMES,
      ...sealsOf(run.world),
      ...timeline.checksums.values(),
      stateRoot(run.world),
    ];
    expect(found(text, forbidden)).toEqual([]);
  });

  test("no frame of the canary world holds a canary, a seed, a seal, or its state root (test 11)", async () => {
    const world = canaryWorld();
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    const server = composeServer(config(), {
      clock,
      timer,
      source: new ScriptedSource(world, canaryScript()),
      worldId: WORLD_ID,
    });
    const { transport, counting } = behindTransport(server);
    const watcher = await SocketClient.open(transport.port);
    const watcherId = counting.last ?? -1;
    const follower = await SocketClient.open(transport.port);
    const followerId = counting.last ?? -1;
    watcher.send(subscribe(CAMERA));
    follower.send(follow(SITTER));
    const caughtUp = () =>
      watcher.frames === counting.sent(watcherId) && follower.frames === counting.sent(followerId);
    await drive(server, timer, 20, () => until(caughtUp, "the canary frames"));
    await transport.stop();
    await server.stop();
    const canaries = [
      ...CANARY_TEXTS,
      ...CANARY_NUMBERS.map(String),
      ...Object.values(CANARY_TRAITS).map(String),
    ];
    // The world holds its sitter's canaries, and the clients saw the sitter.
    expect(found(stateText(world), canaries).length).toBeGreaterThan(6);
    expect(follower.view.state.view?.followed?.id).toBe(SITTER);
    expect([watcher.errors, follower.errors]).toEqual([[], []]);
    const text = [...watcher.view.texts, ...follower.view.texts].join("\n");
    const forbidden = [
      ...FORBIDDEN_NAMES,
      ...canaries,
      ...seedTexts([0x5eed_c0de, 0x0dd_ba11]),
      ...sealsOf(world),
      stateRoot(world),
    ];
    expect(found(text, forbidden)).toEqual([]);
  });
});
