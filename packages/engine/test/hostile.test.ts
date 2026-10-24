import { describe, expect, test } from "bun:test";
import { canonicalize, copyCanonical, EngineError, validateCanonical } from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/**
 * Objects that throw while they are read: a revoked Proxy, a trap that throws (an EngineError
 * included), and a trap that breaks a Proxy invariant. Every operation turns the throw into an
 * issue at the object's path and keeps walking; an EngineError keeps the thrown value as its cause.
 */

const THREW = "the object threw while being read: ";
const BOOM = new Error("boom");
const boom = (): never => {
  throw BOOM;
};

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** Each hostile object, and what it throws: BOOM, or a TypeError from the Proxy machinery. */
const HOSTILE: [string, () => object, "boom" | "TypeError"][] = [
  ["a revoked Proxy", revokedProxy, "TypeError"],
  ["a throwing ownKeys trap", () => new Proxy({}, { ownKeys: boom }), "boom"],
  [
    "a throwing getOwnPropertyDescriptor trap",
    () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor: boom }),
    "boom",
  ],
  ["a throwing getPrototypeOf trap", () => new Proxy({}, { getPrototypeOf: boom }), "boom"],
  ["duplicate keys from ownKeys", () => new Proxy({}, { ownKeys: () => ["a", "a"] }), "TypeError"],
  [
    "an array whose getOwnPropertyDescriptor trap throws",
    () => new Proxy([1, 2], { getOwnPropertyDescriptor: boom }),
    "boom",
  ],
];

function expectThrown(cause: unknown, kind: "boom" | "TypeError"): void {
  if (kind === "boom") expect(cause).toBe(BOOM);
  else expect(cause).toBeInstanceOf(TypeError);
}

describe.each(HOSTILE)("%s", (_name, hostile, kind) => {
  test("validateCanonical reports it at its path and keeps walking", () => {
    const issues = validateCanonical({ a: hostile(), b: null });
    expect(issues).toHaveLength(2);
    expect(issues[0]?.path).toBe("/a");
    expect(issues[0]?.message).toStartWith(THREW);
    expect(issues[1]).toEqual({ path: "/b", message: "null is not a canonical value" });
    expect(validateCanonical(hostile())[0]?.path).toBe("");
  });

  test("copyCanonical throws an EngineError whose cause is the thrown value", () => {
    const error = engineErrorOf(() => copyCanonical([0, hostile()]));
    expect(error.code).toBe("invalid_value");
    expect(error.issues.map(({ path }) => path)).toEqual(["/1"]);
    expectThrown(error.cause, kind);
  });

  test("canonicalize throws an EngineError whose cause is the thrown value", () => {
    const error = engineErrorOf(() => canonicalize({ z: hostile() }));
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toBe("/z");
    expect(error.issues[0]?.message).toStartWith(THREW);
    expectThrown(error.cause, kind);
  });
});

describe("thrown values", () => {
  test("name the error type and message", () => {
    expect(validateCanonical(new Proxy({}, { ownKeys: boom }))).toEqual([
      { path: "", message: `${THREW}Error: boom` },
    ]);
    const thrownText = new Proxy(
      {},
      {
        ownKeys: () => {
          throw "text";
        },
      },
    );
    expect(validateCanonical(thrownText)).toEqual([
      { path: "", message: `${THREW}a thrown string` },
    ]);
  });

  test("a thrown undefined is an issue too, however the operation collects issues", () => {
    const throwsUndefined = new Proxy(
      {},
      {
        ownKeys: () => {
          throw undefined;
        },
      },
    );
    const issue = { path: "/0", message: `${THREW}a thrown undefined` };
    expect(validateCanonical([throwsUndefined])).toEqual([issue]);
    expect(engineErrorOf(() => copyCanonical([throwsUndefined])).issues).toEqual([issue]);
    expect(engineErrorOf(() => canonicalize([throwsUndefined])).issues).toEqual([issue]);
  });

  test("a thrown value that itself throws when inspected is still an issue", () => {
    const unreadable = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("unreadable");
        },
      },
    );
    const throwsUnreadable = new Proxy(
      {},
      {
        ownKeys: () => {
          throw unreadable;
        },
      },
    );
    expect(validateCanonical(throwsUnreadable)).toEqual([
      { path: "", message: `${THREW}an exception that cannot be described` },
    ]);
    expect(engineErrorOf(() => copyCanonical(throwsUnreadable)).cause).toBe(unreadable);
  });
});

describe("an EngineError thrown by a trap", () => {
  const forged = new EngineError("invalid_value", [{ path: "/forged", message: "forged" }]);
  const forging = () =>
    new Proxy(
      {},
      {
        ownKeys: () => {
          throw forged;
        },
      },
    );
  const FORGED_ISSUE = `${THREW}EngineError: invalid_value at /forged: forged`;

  test("is an issue at the object's path, so validateCanonical still returns", () => {
    expect(validateCanonical({ a: forging(), b: null })).toEqual([
      { path: "/a", message: FORGED_ISSUE },
      { path: "/b", message: "null is not a canonical value" },
    ]);
  });

  test.each([
    ["copyCanonical", copyCanonical],
    ["canonicalize", canonicalize],
  ])("is the cause of a new EngineError from %s", (_name, operation) => {
    const error = engineErrorOf(() => operation([0, forging()]));
    expect(error).not.toBe(forged);
    expect(error.issues).toEqual([{ path: "/1", message: FORGED_ISSUE }]);
    expect(error.cause).toBe(forged);
  });
});

describe("the fail-fast error of canonicalize", () => {
  test("passes through every enclosing object, a Proxy included, unchanged", () => {
    const error = engineErrorOf(() => canonicalize({ a: new Proxy({ b: [null] }, {}) }));
    expect(error.issues).toEqual([{ path: "/a/b/0", message: "null is not a canonical value" }]);
    expect(error.cause).toBeUndefined();
  });
});

describe("an object that throws midway through its contents", () => {
  test("is reported after the issues found before the throw; the rest is not checked", () => {
    const midway = new Proxy(
      { a: Number.NaN, b: 0, c: null },
      {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === "b") throw BOOM;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(validateCanonical({ p: midway, q: null })).toEqual([
      { path: "/p/a", message: "NaN is not a safe integer" },
      { path: "/p", message: `${THREW}Error: boom` },
      { path: "/q", message: "null is not a canonical value" },
    ]);
  });
});
