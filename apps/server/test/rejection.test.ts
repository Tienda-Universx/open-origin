/**
 * The policy for an unhandled promise rejection (ADR 0025, "Faults"): with `AI_MODE=off`, the
 * world halts. A pure function of the mode; the process handler that asks it is tested where the
 * entry point installs it.
 */
import { describe, expect, test } from "bun:test";
import { rejectionPolicy } from "../src/world/rejection.ts";

describe("rejectionPolicy", () => {
  test("halts the world with AI_MODE=off, with the code it logs", () => {
    const decision = rejectionPolicy("off");
    expect(decision).toEqual({ action: "halt", code: "unhandled_rejection" });
    expect(Object.isFrozen(decision)).toBe(true);
  });
});
