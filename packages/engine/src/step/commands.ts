/**
 * The commands of a step (ADR 0003; ADR 0020, failures): every command is validated and copied
 * before the tick changes anything, so an invalid list leaves the world exactly as it was. Each
 * member is read once, through its own descriptor, as at every boundary (world/members.ts).
 */
import { canonicalize } from "../canonical/encode.ts";
import { sortedOwnKeys } from "../canonical/order.ts";
import { utf8Length } from "../canonical/utf8.ts";
import { type CanonicalValue, pointer } from "../canonical/value.ts";
import { describeValue, IssueList } from "../errors.ts";
import type { Tick } from "../time/tick.ts";
import type { Command, CommandOrigin } from "../world/contracts.ts";
import {
  copyAt,
  isRecord,
  readElements,
  readMember,
  readRecordKeys,
  readText,
  UNREAD,
} from "../world/members.ts";

/** The most UTF-8 bytes of canonical text a command's payload may take: 8 KiB (ADR 0020). */
export const MAX_PAYLOAD_BYTES = 8192;

/** The members of a command, sorted by UTF-16 code units. */
const ENVELOPE = ["applyTick", "origin", "payload", "seq", "type"];

const NOT_COMMAND = "a command must be a record { applyTick, seq, type, origin, payload }";
const NOT_ENVELOPE =
  "not part of a command: a command has applyTick, seq, type, origin, and payload";
const ORIGIN = 'the origin must be { kind: "admin" } or { kind: "inhabitant", actor }';

/** The member `key` of a command, or UNREAD after an issue, a missing member included. */
function readField(record: object, key: string, path: string, issues: IssueList): unknown {
  const at = `${path}/${key}`;
  const value = readMember(record, key, at, issues);
  if (value !== undefined) return value;
  issues.report(at, `the command has no ${key}`);
  return UNREAD;
}

function checkApplyTick(value: unknown, at: string, applyTick: Tick, issues: IssueList): void {
  if (value === UNREAD || value === applyTick) return;
  const message = `applyTick must be ${applyTick}, the tick this step computes, not ${describeValue(value)}`;
  issues.report(at, message);
}

function readSeq(value: unknown, at: string, issues: IssueList): number | undefined {
  if (value === UNREAD) return undefined;
  const isSeq = typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (isSeq && !Object.is(value, -0)) return value;
  const message = `${describeValue(value)} is not a sequence number: seq is a safe integer from 0`;
  issues.report(at, message);
  return undefined;
}

function readActor(actor: CanonicalValue | undefined, at: string, issues: IssueList) {
  if (typeof actor === "number" && actor >= 1) return { kind: "inhabitant", actor } as const;
  const message = `${describeValue(actor)} is not an entity id: entity ids are safe integers from 1`;
  issues.report(at, message);
  return undefined;
}

function readOrigin(value: unknown, at: string, issues: IssueList): CommandOrigin | undefined {
  const copy = copyAt(value, at, issues);
  if (copy === undefined) return undefined;
  if (isRecord(copy)) {
    // A canonical copy: a plain record of canonical values.
    const origin = copy as { readonly [key: string]: CanonicalValue };
    const keys = sortedOwnKeys(origin).join();
    if (origin.kind === "admin" && keys === "kind") return { kind: "admin" };
    if (origin.kind === "inhabitant" && keys === "actor,kind") {
      return readActor(origin.actor, `${at}/actor`, issues);
    }
  }
  issues.report(at, ORIGIN);
  return undefined;
}

function readPayload(value: unknown, at: string, issues: IssueList): CanonicalValue | undefined {
  const copy = copyAt(value, at, issues);
  if (copy === undefined) return undefined;
  const bytes = utf8Length(canonicalize(copy));
  if (bytes <= MAX_PAYLOAD_BYTES) return copy;
  const message = `the payload takes ${bytes} bytes of canonical UTF-8, more than the ${MAX_PAYLOAD_BYTES} allowed`;
  issues.report(at, message);
  return undefined;
}

/** A command as read: its copy when it is valid, and its seq whenever that is valid. */
type ReadCommand = { readonly seq: number | undefined; readonly command: Command | undefined };

function readCommand(
  value: unknown,
  path: string,
  applyTick: Tick,
  issues: IssueList,
): ReadCommand {
  const read = readRecordKeys(value, path, NOT_COMMAND, issues);
  if (read === undefined) return { seq: undefined, command: undefined };
  const { record, keys } = read;
  for (const key of keys) {
    if (!ENVELOPE.includes(key)) issues.report(`${path}${pointer([key])}`, NOT_ENVELOPE);
  }
  const field = (key: string) => readField(record, key, path, issues);
  checkApplyTick(field("applyTick"), `${path}/applyTick`, applyTick, issues);
  const seq = readSeq(field("seq"), `${path}/seq`, issues);
  const type = readText(field("type"), `${path}/type`, "the command type", issues);
  const origin = readOrigin(field("origin"), `${path}/origin`, issues);
  const payload = readPayload(field("payload"), `${path}/payload`, issues);
  const valid = seq !== undefined && type !== undefined && origin !== undefined;
  if (!valid || payload === undefined) return { seq, command: undefined };
  return { seq, command: { applyTick, seq, type, origin, payload } };
}

/**
 * The commands `value` for the tick `applyTick`, validated and copied. Throws
 * EngineError("invalid_input") with every problem, each at its path into `{ commands }`:
 *
 * - `commands` is a dense array of records with exactly applyTick, seq, type, origin, payload;
 * - applyTick is `applyTick`, the tick the step computes;
 * - seq is a safe integer from 0, and the seqs strictly increase along the list;
 * - type is a non-empty canonical string;
 * - origin is `{ kind: "admin" }` or `{ kind: "inhabitant", actor }`, actor a safe integer from 1;
 * - payload is canonical, at most MAX_PAYLOAD_BYTES of UTF-8 canonical text.
 */
export function readCommands(value: unknown, applyTick: Tick): Command[] {
  const issues = new IssueList();
  const notArray = "the commands must be an array of commands";
  const elements = readElements(value, "/commands", notArray, issues) ?? [];
  const commands: Command[] = [];
  let largest: number | undefined;
  elements.forEach((element, index) => {
    const path = `/commands/${index}`;
    const { seq, command } = readCommand(element, path, applyTick, issues);
    if (seq !== undefined && largest !== undefined && seq <= largest) {
      const message = `seq ${seq} is not greater than ${largest}, the largest before it: seqs strictly increase`;
      issues.report(`${path}/seq`, message);
    } else if (seq !== undefined) largest = seq;
    if (command !== undefined) commands.push(command);
  });
  issues.throwIfAny("invalid_input");
  return commands;
}
