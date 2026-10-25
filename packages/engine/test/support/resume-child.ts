import { decodeSnapshot } from "../../src/index.ts";
import {
  type ChildInput,
  type ChildOutput,
  finalSnapshot,
  recordRun,
  rulesetFactory,
} from "./determinism-records.ts";

/**
 * The child process of the determinism suite's resume check (plan §2.5, §8 "Reanudación"): a
 * fresh process, whose modules start without the state that earlier runs left in the parent, so
 * a ruleset that keeps a module-level cache diverges here and not in process.
 *
 * Run as `bun resume-child.ts`, it reads one ChildInput as JSON from stdin: the ruleset's module
 * and factory, the snapshot text, the tick to continue from, the whole script, and whether to
 * audit. It decodes the snapshot with a fresh ruleset, steps it to the end of the script, and
 * writes one ChildOutput as JSON to stdout: the record of every tick and the final snapshot. A
 * resume decodes under audit, as the in-process resume does; the interleaving's run of the second
 * seed alone does not, as its in-process worlds do not. Anything it cannot do, it throws, so the
 * process exits with an error that the suite reports.
 */

const input = JSON.parse(await Bun.stdin.text()) as ChildInput;
const fresh = await rulesetFactory(input.ruleset);
const world = decodeSnapshot(input.snapshot, fresh(), { audit: input.audit });
const records = recordRun(world, input.script, input.from);
const output: ChildOutput = { records, ...finalSnapshot(world, records) };
await Bun.write(Bun.stdout, JSON.stringify(output));
