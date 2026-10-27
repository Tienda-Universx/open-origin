/**
 * The arguments of the calibration bench (packages/agents/bench/calibration.ts): it runs only the
 * calibration labels, refuses the default and the held-out ones, which running would burn, and
 * refuses every argument it does not know instead of ignoring it.
 */
import { describe, expect, test } from "bun:test";
import { parseArguments } from "../bench/calibration.ts";
import { LABELS } from "./support/scenario.ts";

describe("the arguments of the calibration bench", () => {
  test("run the four calibration labels for ten days by default", () => {
    expect(parseArguments([])).toEqual({
      labels: [...LABELS.calibration],
      ticks: 63_000,
      variant: undefined,
      spawn: undefined,
    });
  });

  test("name labels by number, a variant, the ticks, and another spawn draw", () => {
    expect(parseArguments(["3", "1", "adverse", "--ticks", "300", "--spawn", "2"])).toEqual({
      labels: [LABELS.calibration[2] as string, LABELS.calibration[0] as string],
      ticks: 300,
      variant: "adverse",
      spawn: 2,
    });
    expect(parseArguments(["favorable"]).variant).toBe("favorable");
  });

  test.each([
    { argv: ["default"] },
    { argv: ["heldout/1"] },
    { argv: ["open-origin/t4/default"] },
    { argv: ["open-origin/t4/heldout/7"] },
    { argv: ["1", "heldout/2"] },
  ])("refuse $argv, which running would burn", ({ argv }) => {
    expect(() => parseArguments(argv)).toThrow("running it would burn it");
  });

  test.each([
    { argv: ["5"], message: 'unknown argument "5"' },
    { argv: ["calibration/1"], message: 'unknown argument "calibration/1"' },
    { argv: ["1", "1"], message: 'unknown argument "1"' },
    { argv: ["--tick", "3"], message: 'unknown argument "--tick"' },
    { argv: ["--ticks"], message: "--ticks needs a value" },
    { argv: ["--ticks", "abc"], message: '--ticks must be a positive integer, not "abc"' },
    { argv: ["--ticks", "0"], message: '--ticks must be a positive integer, not "0"' },
    { argv: ["--ticks", "1.5"], message: '--ticks must be a positive integer, not "1.5"' },
    { argv: ["--ticks", "3", "--ticks", "4"], message: "--ticks is given twice" },
    { argv: ["--spawn"], message: "--spawn needs a value" },
    { argv: ["1", "--spawn", "-1"], message: '--spawn must be a positive integer, not "-1"' },
    { argv: ["adverse", "favorable"], message: "give at most one variant" },
  ])("refuse $argv: $message", ({ argv, message }) => {
    expect(() => parseArguments(argv)).toThrow(message);
  });
});
