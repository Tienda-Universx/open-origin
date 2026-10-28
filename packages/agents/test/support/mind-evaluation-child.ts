import type { EvaluationInput } from "./mind-evaluation.ts";
import { evaluate } from "./mind-evaluation-run.ts";

/**
 * The child process of an evaluation run (mind-evaluation.ts): run as
 * `bun mind-evaluation-child.ts`, it reads one EvaluationInput as JSON from stdin, runs it
 * (mind-evaluation-run.ts), and writes one EvaluationOutput as JSON to stdout. An input it does not
 * know, or anything it cannot do, it throws, so the process exits with an error that the parent
 * reports.
 */

const input = JSON.parse(await Bun.stdin.text()) as EvaluationInput;
await Bun.write(Bun.stdout, JSON.stringify(evaluate(input)));
