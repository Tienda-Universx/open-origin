/**
 * The cause a fault leaves for the operator's log (ADR 0025, "Faults"): an engine error's code
 * alone, another error's message and string code, any other value as text, and never a throw.
 */
import { describe, expect, test } from "bun:test";
import { EngineError } from "@open-origin/engine";
import { causeOf } from "../src/world/fault.ts";

describe("causeOf", () => {
  test("keeps only the code of an engine error, whose issues may name C3 data", () => {
    const error = new EngineError("system_fault", [{ path: "/secret", message: "C3 detail" }]);
    expect(causeOf(error)).toEqual({ code: "system_fault" });
  });

  test("keeps another error's message, and its code when it is a string", () => {
    expect(causeOf(new Error("disk full"))).toEqual({ message: "disk full" });
    const system = Object.assign(new Error("no space left"), { code: "ENOSPC" });
    expect(causeOf(system)).toEqual({ code: "ENOSPC", message: "no space left" });
    const numbered = Object.assign(new Error("numbered"), { code: 28 });
    expect(causeOf(numbered)).toEqual({ message: "numbered" });
  });

  test("shows any other thrown value as text, and never throws", () => {
    expect(causeOf("a string")).toEqual({ message: "a string" });
    expect(causeOf(undefined)).toEqual({ message: "undefined" });
    expect(causeOf({ code: "E1" })).toEqual({ code: "E1", message: "[object Object]" });
    const unshowable = "a thrown value that cannot be shown as text";
    expect(causeOf(Object.create(null))).toEqual({ message: unshowable });
    const trap = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("a trap");
        },
      },
    );
    expect(causeOf(trap)).toEqual({ message: unshowable });
  });
});
