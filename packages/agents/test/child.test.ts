/**
 * Child processes that read and write JSON (support/child.ts), which the survival runs and the
 * mid-run resume use: the value a child writes; and a child that exits with an error, writes
 * something that is not JSON, or hangs, each reported with what it wrote on stderr, the last one
 * killed and reaped.
 */
import { describe, expect, test } from "bun:test";
import { jsonResult, startJsonChild, stopChild } from "./support/child.ts";
import type { Ask } from "./support/fake-child.ts";

const FAKE = Bun.fileURLToPath(new URL("./support/fake-child.ts", import.meta.url));

/** Starts the fake child with `ask`. */
const start = (ask: Ask) => startJsonChild(FAKE, ask, "on purpose");

/** Whether the process `pid` still exists: signal 0 only checks. */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("a JSON child process", () => {
  test("gives the value it wrote", async () => {
    const value = { record: [1, "two", { three: 3 }] };
    expect(await jsonResult(start({ echo: value }), 10_000)).toEqual(value);
  });

  test("that exits with an error is reported with its code and the end of its stderr", async () => {
    await expect(jsonResult(start({ exit: 3 }), 10_000)).rejects.toThrow(
      "the child process fake-child.ts (on purpose) exited with 3: the child failed on purpose",
    );
  });

  test("is named in its errors by its file name alone when nothing else names it", async () => {
    await expect(jsonResult(startJsonChild(FAKE, { exit: 2 }), 10_000)).rejects.toThrow(
      "the child process fake-child.ts exited with 2: the child failed on purpose",
    );
  });

  test("that writes something that is not JSON is reported with what it wrote", async () => {
    await expect(jsonResult(start({ text: "not JSON" }), 10_000)).rejects.toThrow(
      "the child process fake-child.ts (on purpose) wrote output that is not JSON: not JSON",
    );
  });

  test("that runs past its time limit is killed with SIGKILL, reaped, and reported", async () => {
    const child = start({ hang: true });
    const { pid } = child.process;
    await expect(jsonResult(child, 500)).rejects.toThrow(
      `the child process fake-child.ts (on purpose) ran past 500 ms and was killed: child ${pid} hangs`,
    );
    expect(exists(pid)).toBe(false);
  });

  test("that is stopped is killed and reaped", async () => {
    const child = start({ hang: true });
    await stopChild(child);
    expect(child.process.signalCode).toBe("SIGKILL");
    expect(exists(child.process.pid)).toBe(false);
  });
});
