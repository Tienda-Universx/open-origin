import { EngineError } from "../../src/index.ts";

/** Runs `action`, which must throw an EngineError, and returns that error. */
export function engineErrorOf(action: () => unknown): EngineError {
  try {
    action();
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error("expected an EngineError, but nothing was thrown");
}
