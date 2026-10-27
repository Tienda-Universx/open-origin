import { writeSync } from "node:fs";

/**
 * A child process for the tests of child.ts: run as `bun fake-child.ts`, it reads one Ask as JSON
 * from stdin and does what it asks: writes a value back as JSON or some text, exits with a code
 * after a line on stderr, or hangs after it writes its process id on stderr.
 */
export type Ask = {
  readonly echo?: unknown;
  readonly text?: string;
  readonly exit?: number;
  readonly hang?: boolean;
};

const ask = JSON.parse(await Bun.stdin.text()) as Ask;
if (ask.hang === true) {
  writeSync(2, `child ${process.pid} hangs\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (ask.exit !== undefined) {
  writeSync(2, "the child failed on purpose\n");
  process.exit(ask.exit);
}
writeSync(1, ask.text ?? JSON.stringify(ask.echo));
