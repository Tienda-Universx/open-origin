import { describe, expect, test } from "bun:test";
import { REPO_ROOT, repoFiles } from "./files.ts";
import { decodeKeepingBom, findInvisibleChars, isProbablyText } from "./hygiene.ts";

describe("findInvisibleChars", () => {
  test("accepts ordinary text, including accents and emoji", () => {
    expect(findInvisibleChars("Visión, simulación y ñandú 🌍\nline two")).toEqual([]);
  });

  test.each([
    ["byte order mark", 0xfeff],
    ["zero width space", 0x200b],
    ["right-to-left mark", 0x200f],
    ["left-to-right embedding", 0x202a],
    ["right-to-left embedding", 0x202b],
    ["pop directional formatting", 0x202c],
    ["left-to-right override", 0x202d],
    ["right-to-left override", 0x202e],
    ["left-to-right mark", 0x200e],
    ["left-to-right isolate", 0x2066],
    ["first strong isolate", 0x2068],
    ["pop directional isolate", 0x2069],
    ["inhibit symmetric swapping", 0x206a],
    ["nominal digit shapes", 0x206f],
    ["word joiner", 0x2060],
    ["right-to-left isolate", 0x2067],
    ["arabic letter mark", 0x061c],
    ["soft hyphen", 0x00ad],
    ["mongolian vowel separator", 0x180e],
    ["line separator", 0x2028],
    ["paragraph separator", 0x2029],
    ["interlinear annotation terminator", 0xfffb],
    ["tag latin small letter a", 0xe0061],
    ["variation selector-17", 0xe0100],
  ])("detects a %s and reports its line and code point", (_name, codePoint) => {
    const hidden = String.fromCodePoint(codePoint);
    const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
    expect(findInvisibleChars(`clean\nbad${hidden}line`)).toEqual([
      { line: 2, codePoint: `U+${hex}` },
    ]);
  });
});

describe("findInvisibleChars, several per line", () => {
  test("reports every hidden character on a line, not only the first", () => {
    const line = `a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x2066)}c`;
    expect(findInvisibleChars(line)).toEqual([
      { line: 1, codePoint: "U+202E" },
      { line: 1, codePoint: "U+2066" },
    ]);
  });
});

describe("findInvisibleChars exceptions", () => {
  test("accepts the emoji variation selectors U+FE00 to U+FE0F, which ordinary emoji use", () => {
    expect(findInvisibleChars(`warning ${String.fromCodePoint(0x26a0, 0xfe0f)}`)).toEqual([]);
  });
});

describe("decodeKeepingBom", () => {
  test("keeps a leading byte order mark so the scan can report it", () => {
    const text = decodeKeepingBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(findInvisibleChars(text)).toEqual([{ line: 1, codePoint: "U+FEFF" }]);
  });
});

describe("isProbablyText", () => {
  test("treats content with a NUL byte as binary, like git does", () => {
    expect(isProbablyText(new TextEncoder().encode("plain text, ñandú"))).toBe(true);
    expect(isProbablyText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBe(false);
  });
});

describe("repository hygiene", () => {
  test("text files contain no invisible or bidirectional control characters", async () => {
    const files = repoFiles(REPO_ROOT);
    // Guard against a vacuous pass: the scan must see this file.
    expect(files).toContain("tests/repo/hygiene.test.ts");
    const scanned: string[] = [];
    const offenders: string[] = [];
    for (const path of files) {
      const file = Bun.file(`${REPO_ROOT}${path}`);
      // git still lists a tracked file deleted from the working tree; there is nothing to read.
      if (!(await file.exists())) continue;
      const bytes = await file.bytes();
      if (!isProbablyText(bytes)) continue;
      scanned.push(path);
      for (const { line, codePoint } of findInvisibleChars(decodeKeepingBom(bytes))) {
        offenders.push(`${path}:${line} ${codePoint}`);
      }
    }
    // Every text file counts, whatever its extension.
    expect(scanned).toEqual(expect.arrayContaining([".gitignore", "bun.lock", "LICENSE"]));
    expect(offenders).toEqual([]);
  });
});
