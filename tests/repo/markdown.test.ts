import { describe, expect, test } from "bun:test";
import { endsInsideBlock, visibleLines } from "./markdown.ts";

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

  test("does not open a fence indented four or more spaces (an indented code block)", () => {
    expect(visibleLines(["    ```", "## heading"])).toEqual(["    ```", "## heading"]);
  });

  test("does not open a fence inside an HTML comment", () => {
    expect(visibleLines(["<!--", "```", "-->", "## heading"])).toEqual(["", "", "", "## heading"]);
  });

  test("keeps the text that follows a comment closing on the same line", () => {
    expect(visibleLines(["<!--", "hidden", "-->kept"])).toEqual(["", "", "kept"]);
  });

  test("enters comment mode when a closed comment is followed by an unclosed one", () => {
    expect(visibleLines(["a <!-- x --> b <!--", "## hidden", "-->"])).toEqual(["a  b ", "", ""]);
  });

  test("does not treat a closing marker before an opening marker as a comment", () => {
    expect(visibleLines(["a --> b <!-- c", "## hidden", "--> d"])).toEqual(["a --> b ", "", " d"]);
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

describe("endsInsideBlock", () => {
  test("detects a document left inside an unclosed fence or HTML comment", () => {
    expect(endsInsideBlock("text\n```\ncode")).toBe(true);
    expect(endsInsideBlock("text <!-- note")).toBe(true);
    // A comment marker shown in a code span opens a comment that hides the rest of the file.
    expect(endsInsideBlock("Write `<!--` to start a comment.\n\nMore text.")).toBe(true);
  });

  test("accepts a document whose fences and comments are closed", () => {
    expect(endsInsideBlock("text\n```\ncode\n```\n<!-- a -->\nend\n")).toBe(false);
    expect(endsInsideBlock("")).toBe(false);
  });
});
