import { describe, expect, test } from "bun:test";
import { visibleLines } from "./markdown.ts";

const FENCED = "[fenced code]";

describe("visibleLines", () => {
  test("replaces every line of a fenced block, markers included, with a placeholder", () => {
    expect(visibleLines(["before", "```ts", "## not a heading", "```", "after"])).toEqual([
      "before",
      FENCED,
      FENCED,
      FENCED,
      "after",
    ]);
  });

  test("does not close a fence with a shorter marker", () => {
    expect(visibleLines(["````md", "```", "## inside", "````", "## outside"])).toEqual([
      FENCED,
      FENCED,
      FENCED,
      FENCED,
      "## outside",
    ]);
  });

  test("does not close a fence with a marker followed by text", () => {
    expect(visibleLines(["```", "``` not a closer", "## inside", "```", "## outside"])).toEqual([
      FENCED,
      FENCED,
      FENCED,
      FENCED,
      "## outside",
    ]);
  });

  test("blanks multi-line HTML comments and strips inline ones", () => {
    expect(visibleLines(["<!--", "## hidden", "-->", "kept <!-- note --> text"])).toEqual([
      "",
      "",
      "",
      "kept  text",
    ]);
  });
});
