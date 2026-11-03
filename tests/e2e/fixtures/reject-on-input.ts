/**
 * A preload for the server's end-to-end test (ADR 0025, "Faults"): `bun --preload` runs it in the
 * server's own process, before main.ts. Each line `reject` on stdin leaves a promise rejected with
 * nothing to handle it, so the test reaches the handler main.ts installs, in a real process, with
 * no switch for tests in the server's code.
 */
process.stdin.on("data", (data) => {
  if (String(data).includes("reject")) {
    void Promise.reject(new Error("a rejection the end-to-end test planted"));
  }
});
