/**
 * The soak of T5 (docs/architecture/mind.md, "Evaluation"): manual, run once, never by `bun test`.
 * On each held-out label of T5 it runs, one at a time, through the evaluation's one entry point
 * (test/support/mind-evaluation.ts), each in a child process:
 *
 * - `mind@1`, 63,000 ticks, with the acceptance of the evaluation, the hungry spells, the beliefs
 *   from testimony judged one day later by the reference truth, and the ablations (a) and (b) of
 *   every decision of the being of lowest id;
 * - the amnesic ablation, every capacity of `mind` and `speech.perDay` at 0, 63,000 ticks, with its
 *   hungry spells;
 * - `mind@1` with the false claim injected at tick 6,300, followed for 2 L, 18,900 ticks.
 *
 * Then it prints the informative hypotheses, whatever they show: memory, the median hungry spell
 * under `mind@1` against the amnesic one, paired by label, on the labels where both brains closed a
 * spell, since a median of none compares nothing; the false claim, revised below 500 or
 * dropped within 2 L on at least five of the six labels; and credulity, the Spearman correlation,
 * across the beings, of credulity with the share of their beliefs from testimony false one day
 * after they formed. Its last line is every number as JSON.
 *
 *   bun packages/agents/bench/mind-soak.ts [1 2 3 4 5 6] [--calibration]
 *
 * The numbers name heldout/1 to /6, all six by default; the reserve, /7 to /12, is refused, as is
 * any other argument. `--calibration` runs the same on calibration/1 to /4 instead, which burns
 * nothing: the check of the tooling before the soak. On a shared machine, run it at low priority.
 */
import {
  type Acceptance,
  acceptance,
  type EvaluationOutput,
  evaluationResult,
  startEvaluation,
} from "../test/support/mind-evaluation.ts";
import { LABELS2 } from "../test/support/mind-scenario.ts";
import { CLAIM_SPAN, CLAIM_TICK } from "../test/support/mind-soak.ts";
import { median } from "./beings.ts";

/** The ticks of a run of the soak, and of the false claim's. */
const TEN_DAYS = 63_000;
/** How long one run may take. */
const RUN_MS = 600_000;

/** What the arguments ask for: the labels. */
export type Arguments = { readonly labels: readonly string[] };

/** Reads the arguments; throws an Error that says what is wrong, for the reserve too. */
export function parseArguments(argv: readonly string[]): Arguments {
  const calibration = argv.includes("--calibration");
  if (argv.filter((arg) => arg === "--calibration").length > 1)
    throw new Error("--calibration is given twice");
  const numbers = argv.filter((arg) => arg !== "--calibration");
  const set = calibration ? LABELS2.calibration : LABELS2.heldout;
  const labels: string[] = [];
  for (const arg of numbers) {
    const label = /^[1-9][0-9]*$/.test(arg) ? set[Number(arg) - 1] : undefined;
    if (label === undefined || labels.includes(label))
      throw new Error(
        `unknown or repeated argument "${arg}": give ${calibration ? "1 to 4" : "1 to 6"}, or --calibration; the reserve, heldout/7 to /12, never runs`,
      );
    labels.push(label);
  }
  return { labels: labels.length > 0 ? labels : [...set] };
}

/** The ranks of `values`, from 1, ties sharing the mean of their ranks. */
export function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length).fill(0);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let at = start; at <= end; at += 1) result[order[at]?.index as number] = rank;
    start = end + 1;
  }
  return result;
}

/** The Spearman correlation of `x` and `y`: the Pearson correlation of their ranks; NaN when undefined. */
export function spearman(x: readonly number[], y: readonly number[]): number {
  const rx = ranks(x);
  const ry = ranks(y);
  const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const mx = mean(rx);
  const my = mean(ry);
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  rx.forEach((value, index) => {
    const dx = value - mx;
    const dy = (ry[index] as number) - my;
    covariance += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  });
  return covariance / Math.sqrt(vx * vy);
}

/** The three runs of one label. */
export type LabelRuns = {
  readonly label: string;
  readonly mind: EvaluationOutput;
  readonly amnesic: EvaluationOutput;
  readonly claim: EvaluationOutput;
};

/** One run of the evaluation's child process, waited for. */
async function runOne(input: Parameters<typeof startEvaluation>[0]): Promise<EvaluationOutput> {
  return evaluationResult(startEvaluation(input), RUN_MS);
}

/** The three runs of `label`, one after another. */
async function runLabel(label: string): Promise<LabelRuns> {
  const mind = await runOne({ label, ticks: TEN_DAYS, soak: true });
  const amnesic = await runOne({ label, ticks: TEN_DAYS, variant: "amnesic", soak: true });
  const claim = await runOne({ label, ticks: CLAIM_TICK + CLAIM_SPAN, falseClaim: true });
  return { label, mind, amnesic, claim };
}

/** What the soak found, the hypotheses included. */
export type SoakSummary = {
  readonly labels: readonly {
    readonly label: string;
    readonly acceptance: Acceptance;
    readonly spells: { readonly mind: number[]; readonly amnesic: number[] };
    /** The median spell under each brain; undefined where that brain closed none. */
    readonly medians: { readonly mind: number | undefined; readonly amnesic: number | undefined };
    readonly claim: unknown;
    readonly ablation: unknown;
  }[];
  /** The labels where mind@1's median spell is shorter, of those where both brains closed one. */
  readonly memory: { readonly shorter: number; readonly of: number };
  readonly falseClaim: { readonly corrected: number; readonly of: number; readonly holds: boolean };
  readonly credulity: { readonly beings: number; readonly rho: number };
};

/** The beings' credulity and the share of their beliefs from testimony false one day later. */
function credulityPairs(runs: readonly LabelRuns[]): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const { mind } of runs)
    mind.minds.forEach((being, index) => {
      const judged = mind.soak?.testimony.find((entry) => entry.being === index + 1);
      if (judged === undefined || judged.judged === 0) return;
      x.push(being.credulity);
      y.push(judged.false / judged.judged);
    });
  return { x, y };
}

/** The median of `spells`, or undefined when there is none. */
const medianOf = (spells: readonly number[]) => (spells.length === 0 ? undefined : median(spells));

/** The summary of the soak's runs, with the hypotheses. */
export function summarize(runs: readonly LabelRuns[]): SoakSummary {
  const labels = runs.map(({ label, mind, amnesic, claim }) => {
    const spells = {
      mind: [...(mind.soak?.spells ?? [])],
      amnesic: [...(amnesic.soak?.spells ?? [])],
    };
    return {
      label,
      acceptance: acceptance(mind),
      spells,
      medians: { mind: medianOf(spells.mind), amnesic: medianOf(spells.amnesic) },
      claim: claim.soak?.claim,
      ablation: mind.soak?.ablation,
    };
  });
  // A label compares the brains only when each closed a spell: a median of none means nothing.
  const comparable = labels.flatMap(({ medians: { mind, amnesic } }) =>
    mind === undefined || amnesic === undefined ? [] : [{ mind, amnesic }],
  );
  const corrected = runs.filter(({ claim }) => claim.soak?.claim?.corrected === true).length;
  const { x, y } = credulityPairs(runs);
  return {
    labels,
    memory: {
      shorter: comparable.filter(({ mind, amnesic }) => mind < amnesic).length,
      of: comparable.length,
    },
    falseClaim: { corrected, of: runs.length, holds: corrected >= 5 },
    credulity: { beings: x.length, rho: spearman(x, y) },
  };
}

/** Prints the summary as tables and the hypotheses. */
function print(summary: SoakSummary, runs: readonly LabelRuns[]): void {
  console.log(
    "\n| Label | Beings missing an item | Population, integrity, diversity misses | Hungry spells, median ticks: mind@1 (n) / amnesic (n) | False claim | Ablation: decisions, operations, removable, misses |",
  );
  console.log("|---|---|---|---|---|---|");
  summary.labels.forEach((row, index) => {
    const run = runs[index] as LabelRuns;
    const missing = row.acceptance.beings
      .map((misses, at) => (misses.length > 0 ? `${at + 1}: ${misses.join(", ")}` : ""))
      .filter((text) => text !== "")
      .join("; ");
    const others = [
      ...row.acceptance.population,
      ...row.acceptance.integrity,
      ...(row.acceptance.diverse ? [] : ["not diverse"]),
    ];
    const ablation = run.mind.soak?.ablation;
    console.log(
      `| ${row.label} | ${missing || "none"} | ${others.join(", ") || "none"} | ${row.medians.mind ?? "-"} (${row.spells.mind.length}) / ${row.medians.amnesic ?? "-"} (${row.spells.amnesic.length}) | ${JSON.stringify(row.claim)} | ${ablation === undefined ? "-" : `${ablation.decisions}, ${ablation.operations}, ${ablation.removable}, ${ablation.misses.length}`} |`,
    );
  });
  console.log(
    `\nmemory: the median hungry spell is shorter under mind@1 on ${summary.memory.shorter} of the ${summary.memory.of} labels where both brains closed one`,
  );
  console.log(
    `false claim: corrected within 2 L on ${summary.falseClaim.corrected} of ${summary.falseClaim.of} labels; the hypothesis (at least five) ${summary.falseClaim.holds ? "holds" : "does not hold"}`,
  );
  console.log(
    `credulity: Spearman ρ = ${summary.credulity.rho.toFixed(3)} over ${summary.credulity.beings} beings with a judged belief from testimony`,
  );
}

if (import.meta.main) {
  let options: Arguments;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`mind-soak: ${(error as Error).message}`);
    process.exit(2);
  }
  const runs: LabelRuns[] = [];
  for (const label of options.labels) {
    const started = performance.now();
    runs.push(await runLabel(label));
    console.log(`${label}: three runs in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
  const summary = summarize(runs);
  print(summary, runs);
  console.log(
    JSON.stringify({
      summary,
      runs: runs.map(({ label, mind, amnesic, claim }) => ({
        label,
        mind: { ...mind, kept: undefined },
        amnesic: { ...amnesic, kept: undefined },
        claim: { ...claim, kept: undefined },
      })),
    }),
  );
}
