/**
 * Child Bun processes that read one JSON value on stdin and write one on stdout: the survival runs
 * of the scenarios, which run in parallel beside the test process, and the determinism suite's
 * resume child, which continues a snapshot in a fresh process.
 */

/** A child process, and what it writes and how it exits. */
export type JsonChild = {
  readonly process: Bun.Subprocess;
  readonly ended: Promise<readonly [stdout: string, stderr: string, code: number]>;
};

/**
 * Starts `script` in a fresh Bun process with `input` as JSON on its stdin. Its pipes are read
 * from the start, so they drain whenever this process's event loop runs.
 */
export function startJsonChild(script: string, input: unknown): JsonChild {
  const child = Bun.spawn([process.execPath, script], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const ended = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ] as const);
  return { process: child, ended };
}

/**
 * The JSON value that `child` wrote. Throws, with the end of its stderr, when it exits with an
 * error or writes something that is not JSON; past `timeoutMs` from now, it is killed with SIGKILL
 * and reaped first.
 */
export async function jsonResult(child: JsonChild, timeoutMs: number): Promise<unknown> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.process.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await child.ended.finally(() => clearTimeout(timer));
  const tail = stderr.trim().slice(-2000);
  if (timedOut)
    throw new Error(`the child process ran past ${timeoutMs} ms and was killed: ${tail}`);
  if (code !== 0) throw new Error(`the child process exited with ${code}: ${tail}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`the child process wrote output that is not JSON: ${stdout.slice(0, 200)}`);
  }
}

/** Kills `child` with SIGKILL and waits until it is reaped; nothing when it already ended. */
export async function stopChild(child: JsonChild): Promise<void> {
  child.process.kill("SIGKILL");
  await child.ended;
}
