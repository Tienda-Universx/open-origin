import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { REPO_ROOT, repoFiles } from "./files.ts";

/**
 * The public entry of packages/protocol never reaches the admin contracts (ADR 0026): a module
 * under src/public/ imports only relative paths that stay inside src/public/, and exactly `zod`.
 * Biome's import rule for the package allows any relative path, so it cannot see a public module
 * that imports `../admin/…`; this scan does, in every form an import takes: static and type-only
 * imports, re-exports, side-effect imports, import-equals, and dynamic and type-level `import()`,
 * whose specifier must be a literal.
 *
 * The scan is lexical, as tests/repo/engine-purity.ts's is: comments are blanked, string literals
 * are kept, so a string that reads like an import is reported too, which errs on the side of
 * rejecting.
 */

const PUBLIC_SRC = "packages/protocol/src/public";
const ADMIN_SRC = "packages/protocol/src/admin";

/** A string literal on one line: group 1 or 2 holds its text. */
const STRING = String.raw`(?:"([^"\n]*)"|'([^'\n]*)')`;
/** Before a keyword: the previous character is not part of a name or a property access. */
const KEYWORD = String.raw`(?<![\w$.])`;

/** `import … from "x"` and `export … from "x"`, also across lines. */
const FROM_CLAUSE = new RegExp(
  String.raw`${KEYWORD}(?:import|export)\b(?:[^;"'\x60]|"[^"\n]*"|'[^'\n]*')*?\bfrom\s*${STRING}`,
  "g",
);
/** `import "x"`. */
const SIDE_EFFECT_IMPORT = new RegExp(String.raw`${KEYWORD}import\s*${STRING}`, "g");
/** `import name = require("x")`. */
const IMPORT_EQUALS = new RegExp(
  String.raw`${KEYWORD}import\s+(?:type\s+)?[\w$]+\s*=\s*require\s*\(\s*${STRING}`,
  "g",
);
/** `import(…)`, dynamic or type-level. */
const DYNAMIC_IMPORT = new RegExp(String.raw`${KEYWORD}import\s*\(`, "g");
const LITERAL_ARGUMENT = new RegExp(String.raw`^\s*${STRING}\s*[,)]`);

/** String and template literals (kept) and comments (blanked, keeping line breaks). */
const LITERAL_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

const RELATIVE = /^\.\.?(?:\/|$)/;

type Finding = { line: number; message: string };

function blankComments(source: string): string {
  return source.replace(LITERAL_OR_COMMENT, (match, literal: string | undefined) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

function isUnder(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** Why `file`, a public module, may not import `specifier`; undefined when it may. */
function specifierProblem(file: string, specifier: string): string | undefined {
  if (specifier === "zod") return undefined;
  if (!RELATIVE.test(specifier)) {
    return `"${specifier}" is neither a relative path nor zod: the public entry imports nothing else`;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (isUnder(resolved, PUBLIC_SRC)) return undefined;
  const into = isUnder(resolved, ADMIN_SRC) ? ", into the admin contracts" : "";
  return `"${specifier}" resolves outside ${PUBLIC_SRC}${into}`;
}

/** Every import of `content`, the source of the public module `path`, that leaves the public entry. */
function checkPublicSource(path: string, content: string): Finding[] {
  const code = blankComments(content);
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;
  const literal = [FROM_CLAUSE, SIDE_EFFECT_IMPORT, IMPORT_EQUALS].flatMap((pattern) =>
    [...code.matchAll(pattern)].flatMap((match) => {
      const message = specifierProblem(path, match[1] ?? match[2] ?? "");
      return message === undefined ? [] : [{ line: lineAt(match.index), message }];
    }),
  );
  const dynamic = [...code.matchAll(DYNAMIC_IMPORT)].flatMap((match) => {
    const argument = LITERAL_ARGUMENT.exec(code.slice(match.index + match[0].length));
    const message =
      argument === null
        ? "a dynamic import with a computed specifier cannot be checked"
        : specifierProblem(path, argument[1] ?? argument[2] ?? "");
    return message === undefined ? [] : [{ line: lineAt(match.index), message }];
  });
  return [...literal, ...dynamic].sort((a, b) => a.line - b.line);
}

/** A TypeScript source of any extension: `.ts`, `.tsx`, `.mts`, `.cts`, and their declarations. */
const TYPESCRIPT = /\.[cm]?tsx?$/;

/** Whether `path`, a repository-relative path, is a module of the public entry. */
function isPublicModule(path: string): boolean {
  return path.startsWith(`${PUBLIC_SRC}/`) && TYPESCRIPT.test(path);
}

/** The findings of each public module among `paths`, whose sources `read` returns. */
function scanPublicModules(
  paths: readonly string[],
  read: (path: string) => Promise<string>,
): Promise<{ path: string; findings: Finding[] }[]> {
  return Promise.all(
    paths
      .filter(isPublicModule)
      .map(async (path) => ({ path, findings: checkPublicSource(path, await read(path)) })),
  );
}

const PUBLIC_FILE = `${PUBLIC_SRC}/view.ts`;
const INTO_ADMIN = `"../admin/index.ts" resolves outside ${PUBLIC_SRC}, into the admin contracts`;

describe("the public entry of packages/protocol", () => {
  test("scans every public module, and no public module leaves the public entry", async () => {
    const scanned = await scanPublicModules(repoFiles(REPO_ROOT), (path) =>
      Bun.file(`${REPO_ROOT}${path}`).text(),
    );
    // An empty list would pass without checking anything.
    expect(scanned.map(({ path }) => path)).toEqual(
      expect.arrayContaining([`${PUBLIC_SRC}/index.ts`, `${PUBLIC_SRC}/reducer.ts`]),
    );
    expect(scanned.filter(({ findings }) => findings.length > 0)).toEqual([]);
  });

  test("reads every TypeScript extension: a planted .mts re-export of admin is found", async () => {
    const reexport = 'export * from "../admin/index.ts";\n';
    const sources = new Map([
      [`${PUBLIC_SRC}/later.mts`, reexport],
      [`${PUBLIC_SRC}/later.cts`, reexport],
      [`${PUBLIC_SRC}/later.tsx`, reexport],
      [`${PUBLIC_SRC}/later.d.mts`, reexport],
      // Not TypeScript, or not in the public entry: not read.
      [`${PUBLIC_SRC}/notes.md`, reexport],
      ["packages/protocol/src/admin/later.mts", reexport],
    ]);
    const scanned = await scanPublicModules([...sources.keys()], async (path) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error(`no source for ${path}`);
      return source;
    });
    const finding = [{ line: 1, message: INTO_ADMIN }];
    expect(scanned).toEqual(
      ["later.mts", "later.cts", "later.tsx", "later.d.mts"].map((name) => ({
        path: `${PUBLIC_SRC}/${name}`,
        findings: finding,
      })),
    );
  });

  test("a planted import of admin in a copy of a real module is found, at its line", async () => {
    const reducer = await Bun.file(`${REPO_ROOT}${PUBLIC_SRC}/reducer.ts`).text();
    const planted = `${reducer}import { ServerStatus } from "../admin/index.ts";\n`;
    expect(checkPublicSource(`${PUBLIC_SRC}/reducer.ts`, reducer)).toEqual([]);
    expect(checkPublicSource(`${PUBLIC_SRC}/reducer.ts`, planted)).toEqual([
      { line: reducer.split("\n").length, message: INTO_ADMIN },
    ]);
  });
});

describe("checkPublicSource", () => {
  test.each([
    'import { ServerStatus } from "../admin/index.ts";',
    'import type { AuditEntry } from "../admin/contracts.ts";',
    "import {\n  type ServerStatus,\n  OperatorCommand,\n} from '../admin/index.ts';",
    'export { ServerStatus } from "../admin/index.ts";',
    'export * from "../admin/index.ts";',
    'export type * as admin from "../admin/index.ts";',
    'import "../admin/contracts.ts";',
    'import admin = require("../admin/index.ts");',
    'export type Status = typeof import("../admin/index.ts");',
    'export type Entry = import("../admin/contracts.ts").AuditEntry;',
    'export const later = () => import("../admin/index.ts");',
    "export const later = (name: string) => import(name);",
    'import { ServerStatus } from "@open-origin/protocol/admin";',
    'import { ServerStatus } from "../../src/admin/index.ts";',
    'import { ServerStatus } from "./../admin/index.ts";',
    'import { readFileSync } from "node:fs";',
    'import { mini } from "zod/mini";',
  ])("finds %p", (source) => {
    const findings = checkPublicSource(PUBLIC_FILE, `export const before = 1;\n${source}\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  test("allows zod and relative paths inside the public entry, and ignores comments", () => {
    const source = [
      'import { z } from "zod";',
      'import { Tick } from "./dto.ts";',
      'import type { PlainText } from "../public/text.ts";',
      'export { chunkKey } from "./client.ts";',
      '// import { ServerStatus } from "../admin/index.ts";',
      '/* export * from "../admin/index.ts"; */',
      "export const parts = [z, Tick];",
    ].join("\n");
    expect(checkPublicSource(PUBLIC_FILE, source)).toEqual([]);
  });
});
