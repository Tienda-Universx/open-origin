/**
 * The tooling of T5's soak (packages/agents/bench/mind-soak.ts, test/support/mind-soak.ts): its
 * arguments name only held-out labels, or calibration labels with `--calibration`, and refuse the
 * reserve in any spelling; the Spearman correlation of the credulity hypothesis, ties included; the
 * summary of the hypotheses; and the target of the false claim, by the preregistered rule.
 */
import { describe, expect, test } from "bun:test";
import { beings, worldgen } from "@open-origin/engine";
import { PREPARED } from "../../engine/test/support/beings-world.ts";
import { type LabelRuns, parseArguments, ranks, spearman, summarize } from "../bench/mind-soak.ts";
import type { EvaluationOutput } from "./support/mind-evaluation.ts";
import { LABELS2 } from "./support/mind-scenario.ts";
import { claimTarget } from "./support/mind-soak.ts";

describe("the arguments of the soak of T5", () => {
  test("run the six held-out labels, or those named, in order", () => {
    expect(parseArguments([])).toEqual({ labels: [...LABELS2.heldout] });
    expect(parseArguments(["3", "1"])).toEqual({
      labels: ["open-origin/t5/heldout/3", "open-origin/t5/heldout/1"],
    });
  });

  test("run the calibration labels instead with --calibration, which burns nothing", () => {
    expect(parseArguments(["--calibration"])).toEqual({ labels: [...LABELS2.calibration] });
    expect(parseArguments(["--calibration", "2"])).toEqual({
      labels: ["open-origin/t5/calibration/2"],
    });
  });

  test.each([
    [["7"]],
    [["12"]],
    [["0"]],
    [["01"]],
    [["heldout/7"]],
    [["open-origin/t5/heldout/7"]],
    [["1", "1"]],
    [["--calibration", "5"]],
    [["--calibration", "--calibration"]],
    [["--ticks"]],
  ])("refuse %p", (argv) => {
    expect(() => parseArguments(argv)).toThrow();
  });

  test("name the reserve when they refuse it", () => {
    expect(() => parseArguments(["7"])).toThrow("the reserve, heldout/7 to /12, never runs");
  });
});

describe("the Spearman correlation of the credulity hypothesis", () => {
  test("ranks ties by the mean of their ranks", () => {
    expect(ranks([10, 30, 20, 30])).toEqual([1, 3.5, 2, 3.5]);
  });

  test("is 1 for a monotone rise, −1 for a fall, and between with ties", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [9, 7, 5, 1])).toBe(-1);
    // Ranks of y: 1, 2.5, 2.5, 4: covariance 4.5 over √(5 · 4.5).
    expect(spearman([1, 2, 3, 4], [1, 2, 2, 3])).toBeCloseTo(4.5 / Math.sqrt(5 * 4.5), 12);
  });

  test("is undefined, NaN, when one side never varies", () => {
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNaN();
  });
});

/** A run of the soak with the measures that the summary reads. */
function runOf(soak: object, credulity: readonly number[] = []): EvaluationOutput {
  const minds = credulity.map((value) => ({ credulity: value, ledger: {} }));
  const beings = credulity.map(() => ({
    mealCells: [],
    incapacitated: 0,
    died: 0,
    exhausted: 0,
    rejected: 0,
  }));
  return {
    soak,
    minds,
    record: { beings, regrewAndEaten: true },
    conversations: 10,
    diverse: true,
    integrity: {
      priorSuspect: 0,
      rules: { count: 0 },
      oracle: { count: 0 },
      invariants: { count: 0 },
    },
  } as unknown as EvaluationOutput;
}

describe("the summary of the soak", () => {
  test("pairs the median hungry spell by label, counts the false claims corrected, and ranks credulity", () => {
    const labels: LabelRuns[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      label: `l${n}`,
      mind: runOf(
        {
          spells: n === 6 ? [50, 60] : [10, 20, 30],
          testimony: [
            { being: 1, judged: 2, false: n % 2 },
            { being: 2, judged: 0, false: 0 },
          ],
        },
        [800 + n, 1200],
      ),
      amnesic: runOf({ spells: [40, 40] }),
      claim: runOf({ claim: { corrected: n !== 3 } }),
    }));
    const summary = summarize(labels);
    // Shorter under mind@1 on five labels: on l6 the median, 60, is longer than 40.
    expect(summary.memory).toEqual({ shorter: 5, of: 6 });
    expect(summary.labels[0]?.medians).toEqual({ mind: 20, amnesic: 40 });
    expect(summary.falseClaim).toEqual({ corrected: 5, of: 6, holds: true });
    // Only being 1 of each label had a judged belief: credulity 801 to 806 against 0.5 or 0.
    expect(summary.credulity.beings).toBe(6);
    expect(summary.credulity.rho).toBeCloseTo(
      spearman([801, 802, 803, 804, 805, 806], [0.5, 0, 0.5, 0, 0.5, 0]),
      12,
    );
  });

  test("does not hold the false claim's hypothesis on four labels of six", () => {
    const labels: LabelRuns[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      label: `l${n}`,
      mind: runOf({ spells: [], testimony: [] }),
      amnesic: runOf({ spells: [] }),
      claim: runOf({ claim: { corrected: n <= 4 } }),
    }));
    expect(summarize(labels).falseClaim).toEqual({ corrected: 4, of: 6, holds: false });
  });
});

describe("the target of the false claim", () => {
  const species = beings.defaultLife2().species[0] as beings.Species2;
  const ground = { prepared: PREPARED, species, sps: 12 };
  const level = worldgen.liquidLevel(worldgen.genesisOf(PREPARED));

  /** The deposit and the depth of the liquid at `cell` of the test genesis. */
  function groundAt(cell: readonly [number, number]) {
    const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
    const surface = worldgen.sampleSurface(PREPARED, rect, species.diet.deposit);
    return {
      deposit: surface.deposit[0] ?? 0,
      depth: Math.max(0, level - (surface.elevation[0] ?? 0)),
    };
  }

  test.each([[[0, 0]], [[40, -20]], [[-90, 75]]] as const)(
    "from %p is the nearest passable cell without food at distance 5 or more, then by y, then x",
    (from) => {
      const target = claimTarget(ground, from);
      if (target === undefined) throw new Error(`no target from ${from}`);
      const distance = (cell: readonly number[]) =>
        Math.max(Math.abs((cell[0] as number) - from[0]), Math.abs((cell[1] as number) - from[1]));
      const fits = (cell: readonly [number, number]) => {
        const at = groundAt(cell);
        return distance(cell) >= 5 && at.deposit === 0 && at.depth <= species.locomotion.maxWade;
      };
      expect(fits(target)).toBe(true);
      // No cell before it, by distance, then y, then x, fits as well.
      const d = distance(target);
      for (let y = from[1] - d; y <= from[1] + d; y += 1)
        for (let x = from[0] - d; x <= from[0] + d; x += 1) {
          const cell: [number, number] = [x, y];
          const before =
            distance(cell) < d ||
            (distance(cell) === d && (y < target[1] || (y === target[1] && x < target[0])));
          if (before) expect(fits(cell)).toBe(false);
        }
    },
  );
});
