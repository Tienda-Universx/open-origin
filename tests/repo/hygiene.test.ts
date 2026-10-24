import { describe, expect, test } from "bun:test";
import { findInvisibleChars } from "./hygiene.ts";

const ROOT = Bun.fileURLToPath(new URL("../../", import.meta.url));
const TEXT_FILES = "**/*.{ts,tsx,js,json,jsonc,yml,yaml,md,css,html}";
const IGNORED = /(?:^|[/])(?:[.]git|node_modules|[.]codegraph|[.]atl)[/]/;

describe("findInvisibleChars", () => {
  test("accepts ordinary text, including accents and emoji", () => {
    expect(findInvisibleChars("Visión, simulación y ñandú 🌍\nline two")).toEqual([]);
  });

  test.each([
    ["byte order mark", 0xfeff],
    ["zero width space", 0x200b],
    ["right-to-left mark", 0x200f],
    ["right-to-left override", 0x202e],
    ["word joiner", 0x2060],
    ["right-to-left isolate", 0x2067],
  ])("detects a %s and reports its line and code point", (_name, codePoint) => {
    const hidden = String.fromCodePoint(codePoint);
    const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
    expect(findInvisibleChars(`clean\nbad${hidden}line`)).toEqual([
      { line: 2, codePoint: `U+${hex}` },
    ]);
  });
});

describe("repository hygiene", () => {
  test("text files contain no invisible or bidirectional control characters", async () => {
    const offenders: string[] = [];
    for await (const path of new Bun.Glob(TEXT_FILES).scan({ cwd: ROOT, dot: true })) {
      if (IGNORED.test(path)) continue;
      for (const { line, codePoint } of findInvisibleChars(
        await Bun.file(`${ROOT}${path}`).text(),
      )) {
        offenders.push(`${path}:${line} ${codePoint}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
