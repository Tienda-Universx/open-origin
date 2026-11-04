/**
 * Sessions and untrusted input (plan test 12 in process; ADR 0026, "Client to server" and "Limits
 * and backpressure"): one raw text message of a client, through `Presentation.receive`, is read
 * with the protocol's strict schema, then held to the bucket of messages, 10 a second with a burst
 * of 20, and to the bucket of new chunks, 64 every 2 s: a subscribe's chunks new to its camera, and
 * the chunks a follow's window adds to its interest, but not the window's moves with its being. A
 * rejected message gets `error` with one of the fixed codes and nothing of its input, and a strike,
 * unless a correct client may meet it too (`unknown_being`, `resync_too_soon`); the third strike
 * within 10 s closes the client with 1008, with no `error` for it. `ping` gets `pong` with its
 * nonce, and `resync` a reset, at most once every 2 s. Every timing is exact on the fake clock.
 */
import { describe, expect, test } from "bun:test";
import type { ChunkCoord, ErrorCode, ServerMessage } from "@open-origin/protocol/public";
import type { ClientId } from "../src/presentation/interest.ts";
import type { Presentation } from "../src/presentation/presentation.ts";
import { being, ModelWorld, presentationOver, ViewClient } from "./support/presentation.ts";

/** A presentation over one being, and a client that already received hello and its first commit. */
function served() {
  const model = new ModelWorld(0, [being(1, [5, 5])]);
  const over = presentationOver(model);
  const client = new ViewClient();
  const id = over.presentation.connect(client);
  over.presentation.period();
  expect(client.commits.map(({ tick }) => tick)).toEqual([0]);
  return { ...over, model, client, id };
}

/** What `client` received after its first `from` messages. */
const since = (client: ViewClient, from: number): ServerMessage[] => client.messages.slice(from);

/** The nonces of the `pong`s among `messages`. */
const pongsOf = (messages: readonly ServerMessage[]) =>
  messages.flatMap((message) => (message.type === "pong" ? [message.nonce] : []));

/** The `error` codes among `messages`. */
const codes = (messages: readonly ServerMessage[]) =>
  messages.flatMap((message) => (message.type === "error" ? [message.code] : []));

/** Sends `message` to `presentation` as the text a client would send. */
const send = (presentation: Presentation, id: ClientId, message: object) =>
  presentation.receive(id, JSON.stringify(message));

/** `count` distinct chunks from `[x, 0]` on. */
const row = (x: number, count: number): ChunkCoord[] =>
  Array.from({ length: count }, (_, index): ChunkCoord => [x + index, 0]);

/** Each hostile message and the code it earns. */
const HOSTILE: readonly (readonly [string, ErrorCode])[] = [
  ["{", "bad_json"],
  ["\u0000\u0001\u00ff", "bad_json"],
  ["not json", "bad_json"],
  ["[]", "bad_message"],
  ['"subscribe"', "bad_message"],
  ['{"type":1}', "bad_message"],
  ['{"chunks":[]}', "bad_message"],
  ['{"type":"pause","canary":"c4n4ry-in-input"}', "unknown_type"],
  ['{"type":"speed","factor":2}', "unknown_type"],
  ['{"type":"step"}', "unknown_type"],
  ['{"type":"seek","tick":0}', "unknown_type"],
  ['{"type":"rewind"}', "unknown_type"],
  ['{"type":"tick"}', "unknown_type"],
  ['{"type":"rate","hz":50}', "unknown_type"],
  ['{"type":"ping","nonce":1,"extra":true}', "bad_message"],
  ['{"type":"ping","nonce":2147483648}', "bad_message"],
  ['{"type":"subscribe","chunks":[],"__proto__":{"chunks":[[0,0]]}}', "bad_message"],
  ['{"type":"subscribe","chunks":[[0,0],[0,0]]}', "bad_message"],
  [JSON.stringify({ type: "subscribe", chunks: row(0, 65) }), "too_many_chunks"],
  ['{"type":"subscribe","chunks":[[67108864,0]]}', "out_of_bounds"],
  [JSON.stringify({ type: "ping", nonce: 1, pad: "x".repeat(5000) }), "bad_message"],
];

/** Ten seconds on the fake clock: a strike no longer counts after it. */
const TEN_SECONDS = 10_000_000;

describe("a client's message", () => {
  test("ping gets pong with its nonce, at the client's visible tick, at once", () => {
    const { presentation, client, id } = served();
    const before = client.messages.length;
    send(presentation, id, { type: "ping", nonce: 2_147_483_647 });
    expect(since(client, before)).toEqual([
      { type: "pong", seq: before, tick: 0, nonce: 2_147_483_647 },
    ]);
  });

  test("hostile input gets its fixed code, nothing of the input, and a strike", () => {
    const { presentation, client, clock, id } = served();
    const before = client.messages.length;
    for (const [text] of HOSTILE) {
      presentation.receive(id, text);
      // Strikes ten seconds apart never make three within 10 s.
      clock.advance(TEN_SECONDS);
    }
    const answers = since(client, before);
    expect(codes(answers)).toEqual(HOSTILE.map(([, code]) => code));
    expect(answers.every(({ type, tick }) => type === "error" && tick === 0)).toBe(true);
    expect(client.texts.filter((text) => text.includes("c4n4ry"))).toEqual([]);
    expect(presentation.telemetry()).toMatchObject({ strikes: HOSTILE.length, strikeCloses: 0 });
    expect(client.ended).toBeUndefined();
  });

  test("a third strike within 10 s closes the client with 1008 and no error, a third at 10 s does not", () => {
    const { presentation, client, clock, id } = served();
    const before = client.messages.length;
    presentation.receive(id, "{");
    clock.advance(TEN_SECONDS);
    presentation.receive(id, "{");
    clock.advance(5_000_000);
    presentation.receive(id, "{");
    // The strikes at 10 s and 15 s count; the one at 0 s no longer did at 10 s.
    expect(client.ended).toBeUndefined();
    expect(codes(since(client, before))).toEqual(["bad_json", "bad_json", "bad_json"]);
    clock.advance(TEN_SECONDS - 5_000_001);
    // At 19.999999 s, the strikes at 10 s and 15 s and this one are three within 10 s.
    presentation.receive(id, '{"type":"pause"}');
    expect(client.ended).toEqual({ reason: "strikes", code: 1008 });
    expect(codes(since(client, before))).toEqual(["bad_json", "bad_json", "bad_json"]);
    expect(() => presentation.receive(id, "{")).toThrow(`client ${id} is not connected`);
    expect(presentation.usage()).toMatchObject({ clients: 0, pins: 0 });
    expect(presentation.telemetry()).toMatchObject({ strikes: 4, strikeCloses: 1 });
  });

  test("a third strike 10 s after the first, the second between, does not close the client", () => {
    const { presentation, client, clock, id } = served();
    presentation.receive(id, "{");
    clock.advance(5_000_000);
    presentation.receive(id, "{");
    clock.advance(5_000_000);
    // At 10 s, the strike at 0 s no longer counts.
    presentation.receive(id, "{");
    expect(client.ended).toBeUndefined();
    expect(presentation.telemetry()).toMatchObject({ strikes: 3, strikeCloses: 0 });
  });

  test("the bucket holds 20 at most, however long the client was idle", () => {
    const { presentation, client, clock, id } = served();
    clock.advance(60_000_000);
    const before = client.messages.length;
    for (let nonce = 0; nonce < 21; nonce += 1) send(presentation, id, { type: "ping", nonce });
    expect(pongsOf(since(client, before))).toEqual(Array.from({ length: 20 }, (_, nonce) => nonce));
    expect(codes(since(client, before))).toEqual(["rate_limited"]);
  });

  test("a message the schema rejects takes no token", () => {
    const { presentation, client, clock, id } = served();
    // Three rejected messages, 10 s apart so that their strikes never close the client.
    for (let rejected = 0; rejected < 3; rejected += 1) {
      presentation.receive(id, "{");
      clock.advance(TEN_SECONDS);
    }
    // The bucket refilled in the first 2 s and none of the three took a token: 20 pings pass.
    presentation.receive(id, "{");
    const before = client.messages.length;
    for (let nonce = 0; nonce < 20; nonce += 1) send(presentation, id, { type: "ping", nonce });
    expect(pongsOf(since(client, before))).toEqual(Array.from({ length: 20 }, (_, nonce) => nonce));
  });

  test("passes 20 at once, then one each 100 ms: the rest get rate_limited and a strike", () => {
    const { presentation, client, clock, id } = served();
    const before = client.messages.length;
    for (let nonce = 0; nonce < 20; nonce += 1) send(presentation, id, { type: "ping", nonce });
    send(presentation, id, { type: "ping", nonce: 20 });
    clock.advance(99_999);
    send(presentation, id, { type: "ping", nonce: 21 });
    clock.advance(1);
    send(presentation, id, { type: "ping", nonce: 22 });
    const answers = since(client, before);
    const pongs = answers.flatMap((message) => (message.type === "pong" ? [message.nonce] : []));
    expect(pongs).toEqual([...Array.from({ length: 20 }, (_, nonce) => nonce), 22]);
    expect(codes(answers)).toEqual(["rate_limited", "rate_limited"]);
    expect(presentation.telemetry().strikes).toBe(2);
    // A full bucket again after 2 s: a burst of 20 passes.
    clock.advance(2_000_000);
    const burst = client.messages.length;
    for (let nonce = 0; nonce < 20; nonce += 1) send(presentation, id, { type: "ping", nonce });
    expect(since(client, burst).map(({ type }) => type)).toEqual(Array(20).fill("pong"));
  });

  test("subscribe passes 64 chunks new to the camera every 2 s, one each 31.25 ms", () => {
    const { presentation, client, clock, advance, id } = served();
    const before = client.messages.length;
    send(presentation, id, { type: "subscribe", chunks: row(0, 64) });
    send(presentation, id, { type: "subscribe", chunks: row(64, 64) });
    // The same camera again brings no new chunk.
    send(presentation, id, { type: "subscribe", chunks: row(0, 64) });
    clock.advance(31_249);
    send(presentation, id, { type: "subscribe", chunks: row(1, 64) });
    clock.advance(1);
    send(presentation, id, { type: "subscribe", chunks: row(1, 64) });
    expect(codes(since(client, before))).toEqual(["rate_limited", "rate_limited"]);
    expect(presentation.telemetry().strikes).toBe(2);
    // The camera is the last one passed, chunks 1 to 64: their terrain is generated in four
    // periods, 16 a period, and their content, 270 KB, takes two.
    for (let period = 0; period < 5; period += 1) advance();
    const view = [...(client.state.view?.chunks.keys() ?? [])].sort();
    expect(view).toEqual(
      row(1, 64)
        .map(([x, y]) => `${x},${y}`)
        .sort(),
    );
  });

  test("follow takes from the same bucket the chunks its window adds to the interest, and a refused one changes nothing", () => {
    // Beings 10 chunks apart: each follow from one to the other adds a whole window of 9 chunks.
    const model = new ModelWorld(0, [being(1, [5, 5]), being(2, [325, 325])]);
    const { presentation, clock } = presentationOver(model);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.period();
    const before = client.messages.length;
    // Seven follows take 63 of the 64 chunks; the eighth needs 9 and finds 1.
    for (const target of [1, 2, 1, 2, 1, 2, 1, 2]) {
      send(presentation, id, { type: "follow", being: target });
    }
    expect(codes(since(client, before))).toEqual(["rate_limited"]);
    const following = () => [presentation.followers(1), presentation.followers(2)];
    expect(following()).toEqual([1, 0]);
    expect(presentation.usage().interest.indexEntries).toBe(9);
    // The 8 chunks missing come back in 250 ms, one each 31.25 ms.
    clock.advance(249_999);
    send(presentation, id, { type: "follow", being: 2 });
    clock.advance(1);
    send(presentation, id, { type: "follow", being: 2 });
    expect(codes(since(client, before))).toEqual(["rate_limited", "rate_limited"]);
    expect(following()).toEqual([0, 1]);
    // The bucket is empty, and a follow of nothing adds no chunk.
    send(presentation, id, { type: "follow", being: null });
    expect(codes(since(client, before))).toHaveLength(2);
    expect(following()).toEqual([0, 0]);
    expect(presentation.telemetry().strikes).toBe(2);
  });

  test("the follow window moving with its being takes nothing from the bucket of new chunks", () => {
    const { presentation, client, advance, id } = served();
    const before = client.messages.length;
    // The follow takes 9 of the 64 chunks. The clock never moves: none comes back.
    send(presentation, id, { type: "follow", being: 1 });
    // The being crosses into the chunk (1, 0), and its window moves with it, three chunks east.
    advance({ set: [being(1, [37, 5])] });
    expect(client.commits.at(-1)?.tick).toBe(1);
    expect(client.state.view?.chunks.has("2,0")).toBe(true);
    // The 55 chunks left pass at once, and not one more.
    send(presentation, id, { type: "subscribe", chunks: row(100, 55) });
    expect(codes(since(client, before))).toEqual([]);
    send(presentation, id, { type: "subscribe", chunks: row(100, 56) });
    expect(codes(since(client, before))).toEqual(["rate_limited"]);
  });

  test("resync gets a reset at most once every 2 s; resync_too_soon earns no strike", () => {
    const { presentation, client, clock, advance, id } = served();
    const before = client.messages.length;
    send(presentation, id, { type: "resync" });
    for (let n = 0; n < 4; n += 1) send(presentation, id, { type: "resync" });
    clock.advance(1_999_999);
    send(presentation, id, { type: "resync" });
    expect(codes(since(client, before))).toEqual(Array(5).fill("resync_too_soon"));
    expect(client.ended).toBeUndefined();
    expect(presentation.telemetry().strikes).toBe(0);
    advance();
    expect(client.commits.at(-1)).toMatchObject({ tick: 1, reset: true });
    clock.advance(1);
    send(presentation, id, { type: "resync" });
    advance();
    expect(client.commits.at(-1)).toMatchObject({ tick: 2, reset: true });
  });

  test("follow of a being the world does not hold gets unknown_being, no strike, and changes nothing", () => {
    const { presentation, client, id } = served();
    const before = client.messages.length;
    for (let n = 0; n < 3; n += 1) send(presentation, id, { type: "follow", being: 999 });
    expect(codes(since(client, before))).toEqual(Array(3).fill("unknown_being"));
    expect(presentation.followers(999)).toBe(0);
    expect(presentation.telemetry().strikes).toBe(0);
    send(presentation, id, { type: "follow", being: 1 });
    expect(presentation.followers(1)).toBe(1);
    send(presentation, id, { type: "follow", being: null });
    expect(presentation.followers(1)).toBe(0);
    expect(codes(since(client, before))).toHaveLength(3);
  });

  test("a message the schema accepts takes a token whatever its outcome, so even a harmless refusal is paced", () => {
    const { presentation, client, id } = served();
    const before = client.messages.length;
    for (let n = 0; n < 20; n += 1) send(presentation, id, { type: "follow", being: 999 });
    send(presentation, id, { type: "ping", nonce: 1 });
    expect(codes(since(client, before))).toEqual([
      ...Array(20).fill("unknown_being"),
      "rate_limited",
    ]);
    expect(presentation.telemetry().strikes).toBe(1);
  });

  test("answers to a lagging client wait, coalesce by kind, and go first once it drains", () => {
    const { presentation, client, id } = served();
    const before = client.messages.length;
    client.lag = true;
    for (const nonce of [1, 2, 3]) send(presentation, id, { type: "ping", nonce });
    for (let n = 0; n < 5; n += 1) send(presentation, id, { type: "follow", being: 999 });
    presentation.receive(id, "{");
    expect(since(client, before)).toEqual([]);
    client.lag = false;
    presentation.drained(id);
    const answers = since(client, before);
    expect(answers.map((message) => [message.type, message.seq])).toEqual([
      ["pong", before],
      ["error", before + 1],
      ["error", before + 2],
    ]);
    expect(answers[0]).toMatchObject({ nonce: 3 });
    expect(codes(answers)).toEqual(["unknown_being", "bad_json"]);
  });
});
