/**
 * What a fault of the world plane leaves for the operator's log (C3; ADR 0025, "Faults"). An
 * engine error keeps only its code: its issues can name C3 data. Anything else thrown keeps its
 * message, and its code when it carries a string one, as Node's system errors do (`ENOSPC`).
 */
import { EngineError } from "@open-origin/engine";

/** What a fault threw: an engine error's code alone, or another value's message and code. */
export type FaultCause = { readonly code?: string; readonly message?: string };

/** The message of a value that cannot be shown as text: its conversion threw. */
const UNSHOWABLE = "a thrown value that cannot be shown as text";

/** The string `code` that `error` carries, or undefined. */
function stringCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * The cause of a fault that threw `error`. It never throws, whatever it is given: reading a
 * Proxy, or converting a value without a string form, falls back to a fixed message.
 */
export function causeOf(error: unknown): FaultCause {
  if (EngineError.isEngineError(error)) return { code: error.code };
  try {
    const message = error instanceof Error ? error.message : String(error);
    const code = stringCode(error);
    return code === undefined ? { message } : { code, message };
  } catch {
    return { message: UNSHOWABLE };
  }
}
