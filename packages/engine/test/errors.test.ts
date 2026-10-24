import { describe, expect, test } from "bun:test";
import { EngineError, type Issue, IssueList, MAX_ISSUES } from "../src/errors.ts";

const issue = (index: number): Issue => ({ path: `/${index}`, message: `problem ${index}` });
const issues = (count: number): Issue[] =>
  Array.from({ length: count }, (_, index) => issue(index));

describe("EngineError", () => {
  test("carries its code and issues, and names the first issue in its message", () => {
    const error = new EngineError("invalid_value", [
      { path: "/a/1", message: "1.5 is not a safe integer" },
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EngineError);
    expect(error.name).toBe("EngineError");
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "/a/1", message: "1.5 is not a safe integer" }]);
    expect(error.message).toBe("invalid_value at /a/1: 1.5 is not a safe integer");
  });

  test("calls the empty path, which points at the whole value, the root", () => {
    const error = new EngineError("invalid_value", [
      { path: "", message: "null is not a canonical value" },
    ]);
    expect(error.message).toBe("invalid_value at the root: null is not a canonical value");
  });

  test("counts every issue in its message", () => {
    expect(new EngineError("invalid_value", issues(3)).message).toBe(
      "invalid_value at /0: problem 0; 3 issues in all",
    );
  });

  test(`keeps exactly ${MAX_ISSUES} issues without dropping any`, () => {
    const error = new EngineError("invalid_value", issues(50));
    expect(error.issues).toEqual(issues(50));
    expect(error.message).toBe("invalid_value at /0: problem 0; 50 issues in all");
  });

  test("keeps the first 50 issues and says how many it dropped", () => {
    const error = new EngineError("invalid_value", issues(51));
    expect(MAX_ISSUES).toBe(50);
    expect(error.issues).toEqual(issues(50));
    expect(error.message).toBe(
      "invalid_value at /0: problem 0; 51 issues in all, 1 dropped beyond the first 50",
    );
  });

  test("counts the issues a collector already dropped", () => {
    const error = new EngineError("invalid_value", issues(50), { issueCount: 120 });
    expect(error.issues).toEqual(issues(50));
    expect(error.message).toBe(
      "invalid_value at /0: problem 0; 120 issues in all, 70 dropped beyond the first 50",
    );
  });

  test("never counts fewer issues than it was given", () => {
    const error = new EngineError("invalid_value", issues(3), { issueCount: 1 });
    expect(error.message).toBe("invalid_value at /0: problem 0; 3 issues in all");
  });

  test("its message is the bare code when there is no issue", () => {
    expect(new EngineError("invalid_value", []).message).toBe("invalid_value");
  });

  test("keeps frozen copies of its issues", () => {
    const first = { path: "/0", message: "problem 0" };
    const given = [first, issue(1)];
    const error = new EngineError("invalid_value", given);
    first.message = "changed";
    given.push(issue(2));
    expect(error.issues).toEqual(issues(2));
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(error.issues.every((kept) => Object.isFrozen(kept))).toBe(true);
  });

  test("keeps its cause, and has none unless given one", () => {
    const cause = new SyntaxError("unexpected token");
    expect(new EngineError("invalid_value", [issue(0)], { cause }).cause).toBe(cause);
    expect(Object.hasOwn(new EngineError("invalid_value", [issue(0)]), "cause")).toBe(false);
  });
});

describe("IssueList", () => {
  test("keeps the first 50 issues it receives and counts them all", () => {
    const list = new IssueList();
    for (const { path, message } of issues(120)) list.report(path, message);
    expect(list.issues).toEqual(issues(50));
    expect(list.count).toBe(120);
  });

  test("toError returns, without throwing, the kept issues, the full count, and the first cause", () => {
    const list = new IssueList();
    const cause = new Error("first cause");
    list.report("/a", "no cause");
    for (const { path, message } of issues(55)) list.report(path, message, cause);
    list.report("/b", "a later cause", new Error("later"));
    const error = list.toError("invalid_input");
    expect(error).toBeInstanceOf(EngineError);
    expect(error.code).toBe("invalid_input");
    expect(error.issues).toEqual([{ path: "/a", message: "no cause" }, ...issues(49)]);
    expect(error.message).toBe(
      "invalid_input at /a: no cause; 57 issues in all, 7 dropped beyond the first 50",
    );
    expect(error.cause).toBe(cause);
  });

  test("toError of an empty list is an error without issues or a cause", () => {
    const error = new IssueList().toError("invalid_value");
    expect(error.issues).toEqual([]);
    expect(error.message).toBe("invalid_value");
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  test("throwIfAny does nothing while the list is empty", () => {
    expect(() => new IssueList().throwIfAny("invalid_value")).not.toThrow();
  });

  test("throwIfAny throws every kept issue and the full count", () => {
    const list = new IssueList();
    for (const { path, message } of issues(60)) list.report(path, message);
    let thrown: unknown;
    try {
      list.throwIfAny("invalid_value");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineError);
    expect(thrown).toMatchObject({
      code: "invalid_value",
      issues: issues(50),
      message: "invalid_value at /0: problem 0; 60 issues in all, 10 dropped beyond the first 50",
    });
  });
});
