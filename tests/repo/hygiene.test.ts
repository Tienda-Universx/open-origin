import { describe, expect, test } from "bun:test";
import { REPO_ROOT, repoFiles } from "./files.ts";
import { decodeUtf8, findInvisibleChars, isProbablyText } from "./hygiene.ts";

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
    ["hangul filler, used as an invisible identifier", 0x3164],
    ["halfwidth hangul filler", 0xffa0],
    ["hangul choseong filler", 0x115f],
    ["combining grapheme joiner", 0x034f],
    ["khmer vowel inherent aq", 0x17b4],
    ["mongolian free variation selector one", 0x180b],
    ["unassigned default-ignorable code point", 0x2065],
    ["musical symbol begin beam", 0x1d173],
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

describe("decodeUtf8", () => {
  test("keeps a leading byte order mark so the scan can report it", () => {
    const text = decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    expect(findInvisibleChars(text ?? "")).toEqual([{ line: 1, codePoint: "U+FEFF" }]);
  });

  test("rejects bytes that are not UTF-8, such as Latin-1 accented letters", () => {
    // "año" saved as Latin-1 would otherwise decode silently to "a\uFFFDo".
    expect(decodeUtf8(new Uint8Array([0x61, 0xf1, 0x6f]))).toBeUndefined();
    expect(decodeUtf8(new TextEncoder().encode("año"))).toBe("año");
  });
});

describe("isProbablyText", () => {
  test("treats content with a NUL byte as binary, like git does", () => {
    expect(isProbablyText(new TextEncoder().encode("plain text, ñandú"))).toBe(true);
    expect(isProbablyText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBe(false);
  });
});

type Scan = { text: string[]; binary: string[]; notUtf8: string[]; offenders: string[] };

/** Sorts the files git tracks or would track, and records invisible characters in names and text. */
async function scanRepository(): Promise<Scan> {
  const scan: Scan = { text: [], binary: [], notUtf8: [], offenders: [] };
  for (const path of repoFiles(REPO_ROOT)) {
    for (const { codePoint } of findInvisibleChars(path)) {
      scan.offenders.push(`${path} (file name) ${codePoint}`);
    }
    const file = Bun.file(`${REPO_ROOT}${path}`);
    // git still lists a tracked file deleted from the working tree; there is nothing to read.
    if (!(await file.exists())) continue;
    const bytes = await file.bytes();
    if (!isProbablyText(bytes)) {
      scan.binary.push(path);
      continue;
    }
    const text = decodeUtf8(bytes);
    if (text === undefined) {
      scan.notUtf8.push(path);
      continue;
    }
    scan.text.push(path);
    for (const { line, codePoint } of findInvisibleChars(text)) {
      scan.offenders.push(`${path}:${line} ${codePoint}`);
    }
  }
  return scan;
}

// Read the repository once for both tests below.
const repository = scanRepository();

describe("repository hygiene", () => {
  test("file names and text files contain no invisible or bidirectional control characters", async () => {
    const scan = await repository;
    // Guard against a vacuous pass: every text file counts, whatever its extension.
    expect(scan.text).toEqual(
      expect.arrayContaining([".gitignore", "bun.lock", "LICENSE", "tests/repo/hygiene.test.ts"]),
    );
    expect(scan.offenders).toEqual([]);
  });

  test("every file is UTF-8 text", async () => {
    // A NUL byte would otherwise exempt a whole file from the scan, and git would show its diff
    // as binary. The repository has no binary files; the first one needs a reviewed allowlist here.
    const { binary, notUtf8 } = await repository;
    expect({ binary, notUtf8 }).toEqual({ binary: [], notUtf8: [] });
  });
});
