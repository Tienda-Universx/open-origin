/**
 * The server's messages as text (ADR 0026, "Server to client" and "Ordering and liveness"). A frame
 * is built once, without its `seq`: the fan-out writes the client's next `seq` when it sends it, so
 * a part that waits for a later period keeps its place in the order. Every frame is
 * `{"type":…,"seq":…,` followed by its rest, which starts with `"tick"`.
 */
import {
  AUDIENCE,
  CLIENT_LIMITS,
  type Clock,
  type DURABILITIES,
  PROTOCOL_ID,
  type SERVER_MESSAGE_TYPES,
  type WORLD_STATES,
} from "@open-origin/protocol/public";
import { byteLength } from "./bytes.ts";

/** A type of server message. */
export type MessageType = (typeof SERVER_MESSAGE_TYPES)[number];

/** A message without its `seq`: its type and the JSON text after the `seq` member. */
export type Frame = {
  readonly type: MessageType;
  readonly rest: string;
  readonly restBytes: number;
};

/** The widest safe integer, which bounds every `seq`, tick, and transaction id. */
export const WIDEST_INTEGER = String(Number.MAX_SAFE_INTEGER);

/** The text of a frame before its rest, with `seq`. */
function headOf(type: MessageType, seq: number): string {
  return `{"type":"${type}","seq":${seq},`;
}

/** The most bytes the head of a frame of `type` takes: its `seq` at its widest. */
export function headBytes(type: MessageType): number {
  return headOf(type, Number.MAX_SAFE_INTEGER).length;
}

/** A frame of `type` whose rest is the JSON text `rest`, from `"tick"` to the closing brace. */
export function frameOf(type: MessageType, rest: string): Frame {
  return Object.freeze({ type, rest, restBytes: byteLength(rest) });
}

/** A frame of `type` whose members after `seq` are those of `body`, whose first is `tick`. */
function frameFrom(
  type: MessageType,
  body: { readonly tick: number } & Record<string, unknown>,
): Frame {
  // The body's JSON without its opening brace is the rest: `"tick":…}`.
  return frameOf(type, JSON.stringify(body).slice(1));
}

/** The text a client receives for `frame` sent as its message `seq`. */
export function frameText(frame: Frame, seq: number): string {
  return headOf(frame.type, seq) + frame.rest;
}

/** The UTF-8 bytes of `frame` sent as message `seq`. */
export function frameBytes(frame: Frame, seq: number): number {
  return headOf(frame.type, seq).length + frame.restBytes;
}

/** What `hello` tells a client of the world: its random id, and whether it survives a restart. */
export type WorldInfo = {
  readonly id: string;
  readonly durability: (typeof DURABILITIES)[number];
};

/** The first message of a connection, with the visible tick `clock.tick` and the world's state. */
export function helloFrame(
  world: WorldInfo,
  clock: Clock,
  state: (typeof WORLD_STATES)[number],
): Frame {
  return frameFrom("hello", {
    tick: clock.tick,
    protocol: PROTOCOL_ID,
    audience: AUDIENCE,
    world: { id: world.id },
    durability: world.durability,
    state,
    clock,
    limits: { ...CLIENT_LIMITS },
  });
}

/** Closes the transaction `txn` at `clock.tick`: the client applies it whole. */
export function commitFrame(txn: number, clock: Clock): Frame {
  return frameFrom("commit", { tick: clock.tick, txn, clock });
}

/** Cancels the transaction `txn` of tick `tick`: the client discards its parts. */
export function abortFrame(txn: number, tick: number): Frame {
  return frameFrom("abort", { tick, txn });
}
