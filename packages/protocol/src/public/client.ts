/**
 * Client to server (ADR 0026): an exact allowlist of four types, `subscribe`, `follow`, `ping`, and
 * `resync`. No type controls time: any other type, including one that names pause, speed, step,
 * seek, rewind, tick, or rate, is `unknown_type`. parseClientMessage reads one text frame into a
 * message or an error code, never throws, and never echoes its input.
 */
import { z } from "zod";
import { CLIENT_LIMITS, type ErrorCode, MAX_NONCE } from "./constants.ts";
import { ChunkCoord, distinctChunks, EntityId } from "./dto.ts";
import { utf8Length } from "./utf8.ts";

/** The chunks of a camera: at most CLIENT_LIMITS.maxChunks, each once, inside the world. */
const Camera = z.array(ChunkCoord).max(CLIENT_LIMITS.maxChunks).refine(distinctChunks, {
  message: "each chunk may appear once",
});

/** Replaces the camera interest; `[]` cancels it. */
export const SubscribeMessage = z.strictObject({ type: z.literal("subscribe"), chunks: Camera });

/** Follows a being, or nothing with `null`: presentation only. */
export const FollowMessage = z.strictObject({
  type: z.literal("follow"),
  being: EntityId.nullable(),
});

/** Asks for a `pong` with the same nonce, an integer from 0 to 2^31 − 1. */
export const PingMessage = z.strictObject({
  type: z.literal("ping"),
  nonce: z.int().min(0).max(MAX_NONCE),
});

/** Asks for a reset of the view, at most once every RESYNC_INTERVAL_MS. */
export const ResyncMessage = z.strictObject({ type: z.literal("resync") });

/** The four types a client may send, in this order. */
export const CLIENT_MESSAGE_TYPES = Object.freeze([
  "subscribe",
  "follow",
  "ping",
  "resync",
] as const);

/** A message a client may send. */
export const ClientMessage = z.discriminatedUnion("type", [
  SubscribeMessage,
  FollowMessage,
  PingMessage,
  ResyncMessage,
]);
export type ClientMessage = z.output<typeof ClientMessage>;

/** The codes parseClientMessage may give. */
export type ClientMessageError = Extract<
  ErrorCode,
  "bad_json" | "bad_message" | "unknown_type" | "too_many_chunks" | "out_of_bounds"
>;

/** What parseClientMessage read: a message, or the code of why it is rejected. */
export type ClientParse =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: ClientMessageError };

/** One issue as `codeOf` reads it. */
type Issue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly origin?: unknown;
};

/**
 * The code of the issues of a `subscribe`: too_many_chunks when the camera is too long,
 * out_of_bounds when every issue is a coordinate outside the world, and bad_message otherwise.
 */
function subscribeCode(issues: readonly Issue[]): ClientMessageError {
  if (issues.some(({ code, path }) => code === "too_big" && path.length === 1)) {
    return "too_many_chunks";
  }
  const outside = ({ code, path, origin }: Issue) =>
    (code === "too_big" || code === "too_small") && origin === "number" && path.length === 3;
  return issues.every(outside) ? "out_of_bounds" : "bad_message";
}

/** The own member `type` of `value`, when it is a plain record; undefined otherwise. */
function typeOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // Read through its own descriptor: an inherited `type` is no type.
  return Object.getOwnPropertyDescriptor(value, "type")?.value;
}

/** Whether `text` takes more than CLIENT_LIMITS.maxMessageBytes of UTF-8. */
function oversized(text: string): boolean {
  // A UTF-16 code unit takes at least one byte of UTF-8, so a longer string is oversized unread.
  const limit = CLIENT_LIMITS.maxMessageBytes;
  return text.length > limit || utf8Length(text) > limit;
}

/** The parsed `value` of a client message whose type is known, or why it is rejected. */
function readMessage(value: unknown, type: string): ClientParse {
  const result = ClientMessage.safeParse(value);
  if (result.success) return { ok: true, message: result.data };
  const issues = result.error.issues;
  return { ok: false, code: type === "subscribe" ? subscribeCode(issues) : "bad_message" };
}

/**
 * The client message `text` holds, or the code of why it is rejected:
 *
 * - `bad_message`: more than CLIENT_LIMITS.maxMessageBytes of UTF-8 (the transport closes such a
 *   frame with 1009 first; the parser never reads one), a value that is not a record, a missing
 *   or non-string `type`, or a message whose fields break its schema;
 * - `bad_json`: text that is not JSON;
 * - `unknown_type`: a `type` outside CLIENT_MESSAGE_TYPES;
 * - `too_many_chunks`: a `subscribe` of more than CLIENT_LIMITS.maxChunks chunks;
 * - `out_of_bounds`: a `subscribe` whose only problems are safe integer coordinates outside the
 *   world's chunk bounds (a number beyond 2^53 is no safe integer, and so `bad_message`).
 *
 * It never throws, and the result holds nothing of the input but a valid message.
 */
export function parseClientMessage(text: string): ClientParse {
  if (oversized(text)) return { ok: false, code: "bad_message" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_json" };
  }
  const type = typeOf(value);
  if (typeof type !== "string") return { ok: false, code: "bad_message" };
  const known = CLIENT_MESSAGE_TYPES.find((name) => name === type);
  if (known === undefined) return { ok: false, code: "unknown_type" };
  return readMessage(value, known);
}
