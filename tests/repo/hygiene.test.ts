import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFiles } from "./files.ts";
import { findInvisibleChars, readTextKeepingBom } from "./hygiene.ts";

const ROOT = Bun.fileURLToPath(new URL("../../", import.meta.url));
const TEXT_FILE = /[.](?:ts|tsx|js|json|jsonc|yml|yaml|md|css|html)$/;

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

describe("readTextKeepingBom", () => {
  test("keeps a leading byte order mark so the scan can report it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "open-origin-bom-"));
    try {
      const path = join(dir, "bom.md");
      writeFileSync(path, new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
      expect(findInvisibleChars(await readTextKeepingBom(path))).toEqual([
        { line: 1, codePoint: "U+FEFF" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repository hygiene", () => {
  test("text files contain no invisible or bidirectional control characters", async () => {
    const files = repoFiles(ROOT);
    // Guard against a vacuous pass: the scan must see this very file.
    expect(files).toContain("tests/repo/hygiene.test.ts");
    const offenders: string[] = [];
    for (const path of files.filter((file) => TEXT_FILE.test(file))) {
      const absolute = `${ROOT}${path}`;
      // git still lists a tracked file deleted from the working tree; there is nothing to read.
      if (!(await Bun.file(absolute).exists())) continue;
      for (const { line, codePoint } of findInvisibleChars(await readTextKeepingBom(absolute))) {
        offenders.push(`${path}:${line} ${codePoint}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
