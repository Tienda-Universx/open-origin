/**
 * The arguments of the calibration bench of T5 (packages/agents/bench/mind-calibration.ts): it
 * runs only the T5 calibration labels, refuses the default and the held-out ones, which running
 * would burn, refuses a variant of the laws, which T5 does not calibrate, and refuses every
 * argument it does not know instead of ignoring it.
 */
import { describe, expect, test } from "bun:test";
import { parseArguments } from "../bench/mind-calibration.ts";
import { LABELS2 } from "./support/mind-scenario.ts";

describe("the arguments of the calibration bench of T5", () => {
  test("run the four T5 calibration labels for ten days with mind@1 by default", () => {
    expect(parseArguments([])).toEqual({
      labels: [...LABELS2.calibration],
      ticks: 63_000,
      spawn: undefined,
      brain: "mind",
    });
  });

  test("name labels by number, the ticks, another spawn draw, and the mindless baseline", () => {
    expect(parseArguments(["3", "1", "--ticks", "300", "--spawn", "2", "--mindless"])).toEqual({
      labels: [LABELS2.calibration[2] as string, LABELS2.calibration[0] as string],
      ticks: 300,
      spawn: 2,
      brain: "mindless",
    });
  });

  test.each([
    { argv: ["default"] },
    { argv: ["heldout/1"] },
    { argv: ["open-origin/t5/default"] },
    { argv: ["open-origin/t5/heldout/1"] },
    { argv: ["open-origin/t5/heldout/9"] },
    { argv: ["2", "--mindless", "heldout/3"] },
  ])("refuse $argv, which running would burn", ({ argv }) => {
    expect(() => parseArguments(argv)).toThrow("running it would burn it");
  });

  test.each([
    { argv: ["adverse"], message: "adverse: the calibration of T5 runs no variant of the laws" },
    { argv: ["1", "favorable"], message: "favorable: the calibration of T5 runs no variant" },
    { argv: ["--mindless", "--mindless"], message: "--mindless is given twice" },
    { argv: ["5"], message: 'unknown argument "5"' },
    { argv: ["calibration/1"], message: 'unknown argument "calibration/1"' },
    { argv: ["--mind"], message: 'unknown argument "--mind"' },
    { argv: ["--ticks", "0"], message: '--ticks must be a positive integer, not "0"' },
  ])("refuse $argv: $message", ({ argv, message }) => {
    expect(() => parseArguments(argv)).toThrow(message);
  });
});
