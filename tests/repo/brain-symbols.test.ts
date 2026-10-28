/**
 * The scan of the engine symbols a brain may use (ADR 0024, docs/architecture/mind.md "Provenance
 * and taints", plan §6): packages/agents/src names only the symbols of the allowlist, so a brain
 * reads the world only through its senses, never through the kernel, worldgen's terrain, or the
 * mind layer's state machinery, and never names a taint. The fixtures below are sources that use
 * one forbidden symbol each, in every form the scan reads; the last test scans the real sources.
 */
import { describe, expect, test } from "bun:test";
import { BRAIN_SYMBOLS, checkBrainSymbols, type SymbolIssue } from "./brain-symbols.ts";
import { AGENTS_SRC, isAgentsSource } from "./engine-purity.ts";
import { REPO_ROOT, repoFiles } from "./files.ts";

const FILE = `${AGENTS_SRC}/brain/fixture.ts`;

function scan(content: string): SymbolIssue[] {
  return checkBrainSymbols({ path: FILE, content });
}

const forbidden = (symbol: string) =>
  `"${symbol}" is not an engine symbol a brain may use: a brain reads the world only through its senses (ADR 0024)`;
const hidden = (form: string) =>
  `${form} hides which engine symbols a brain uses: import them by name`;
const reexported = (binding: string) =>
  `re-exporting "${binding}" hides the uses of its members from the scan: import it where it is used`;
const bare = (binding: string) =>
  `"${binding}" is used other than through a member: name the member, so that the scan can check it`;

describe("checkBrainSymbols", () => {
  test("accepts the allowed symbols in every form: named, typed, aliased, members, destructured", () => {
    const content = [
      'import { beings, type DeepReadonly, floorDiv } from "@open-origin/engine";',
      'import type { mind } from "@open-origin/engine";',
      "import {",
      "  worldgen as w,",
      "  EngineError,",
      '} from "@open-origin/engine";',
      'import { helper } from "./helper.ts";',
      "type Senses = DeepReadonly<beings.Senses2>;",
      "type View = mind.MindView;",
      "const { MIN_CELL, MAX_CELL: top } = w;",
      "export function f(senses: Senses, p: mind.Proposition): number {",
      "  const most = beings.BEING_BOUNDS.cooldowns.max;",
      "  const steps = beings ?. MAX_WALK_STEPS;",
      "  if (most < 0) throw new EngineError('invalid_value', []);",
      "  return floorDiv(w.MIN_CELL + top + MIN_CELL + most + steps, helper(senses, p));",
      "}",
      // A key or a member of another value that shares a binding's name is not a use of it.
      "export const shown = (s: { beings: number }) => ({ beings: s.beings });",
      "export type Laws = { readonly mind: { readonly n: number }; readonly beings?: number };",
      "",
    ].join("\n");
    expect(scan(content)).toEqual([]);
  });

  test("ignores symbols that appear only in comments and strings", () => {
    const content = [
      'import { beings } from "@open-origin/engine";',
      '// import { readView } from "@open-origin/engine"; worldgen.sampleSurface',
      "/* beings.senseWindow, mind.TAINTS */",
      'export const text = "beings.senseWindow and beings";',
      "export const n: beings.Cell = [0, 0];",
      "",
    ].join("\n");
    expect(scan(content)).toEqual([]);
  });

  test.each([
    {
      name: "a forbidden named import",
      content: 'import { readView } from "@open-origin/engine";\n',
      message: forbidden("readView"),
    },
    {
      name: "a forbidden type import under an alias",
      content: 'import { type World as W } from "@open-origin/engine";\n',
      message: forbidden("World"),
    },
    {
      name: "a forbidden re-export",
      content: 'export { step } from "@open-origin/engine";\n',
      message: forbidden("step"),
    },
    {
      name: "a namespace import",
      content: 'import * as engine from "@open-origin/engine";\n',
      message: hidden('import * as … from "@open-origin/engine"'),
    },
    {
      name: "a default import",
      content: 'import engine from "@open-origin/engine";\n',
      message: hidden('a default import from "@open-origin/engine"'),
    },
    {
      name: "a re-export of everything",
      content: 'export * from "@open-origin/engine";\n',
      message: hidden('export * from "@open-origin/engine"'),
    },
    {
      name: "a type-level import()",
      content: 'export type T = import("@open-origin/engine").World;\n',
      message: hidden('import("@open-origin/engine")'),
    },
    {
      name: "an import-equals of the engine",
      content: 'import engine = require("@open-origin/engine");\n',
      message: hidden('import … = require("@open-origin/engine")'),
    },
    {
      name: "a dynamic import() of a template literal",
      content: "export const load = () => import(`@open-origin/engine`);\n",
      message: hidden('import("@open-origin/engine")'),
    },
    {
      name: "a re-export of a namespace under an alias",
      content: 'export { mind as m } from "@open-origin/engine";\n',
      message: reexported("mind"),
    },
    {
      name: "a type-only re-export of a namespace",
      content: 'export type { beings } from "@open-origin/engine";\n',
      message: reexported("beings"),
    },
  ])("rejects $name", ({ content, message }) => {
    expect(scan(content)).toEqual([{ file: FILE, line: 1, message }]);
  });

  test.each([
    {
      name: "worldgen's terrain",
      code: "export const read = worldgen.sampleSurface;",
      message: forbidden("worldgen.sampleSurface"),
    },
    {
      name: "the window the engine computes",
      code: "export const read = beings.senseWindow;",
      message: forbidden("beings.senseWindow"),
    },
    {
      name: "the mind layer's view",
      code: "export type T = typeof mind.viewOf;",
      message: forbidden("mind.viewOf"),
    },
    {
      name: "a taint",
      code: "export const taint = mind.TAINTS.humanExternal;",
      message: forbidden("mind.TAINTS"),
    },
    {
      name: "a destructured member",
      code: "const { MIN_CELL, sampleSurface: read } = worldgen;\nexport { MIN_CELL, read };",
      message: forbidden("worldgen.sampleSurface"),
    },
    {
      name: "a computed member",
      code: 'export const read = worldgen["sampleSurface"];',
      message: bare("worldgen"),
    },
    {
      name: "the namespace passed on as a value",
      code: "export const all = { worldgen };",
      message: bare("worldgen"),
    },
    {
      name: "the namespace as a ternary's branch, which looks like a key",
      code: "export const pick = (c: boolean) => (c ? worldgen : undefined);",
      message: bare("worldgen"),
    },
    {
      name: "the namespace spread into an object",
      code: "export function f(): unknown {\n  return { ...beings }.senseWindow;\n}",
      message: bare("beings"),
    },
    {
      name: "the namespace exported by a local clause",
      code: "export { mind };",
      message: bare("mind"),
    },
  ])("rejects $name", ({ code, message }) => {
    const content = `import { beings, mind, worldgen } from "@open-origin/engine";\n${code}\n`;
    // The use lies on the code's last line but one, or on its only line.
    const line = 1 + Math.max(1, code.split("\n").length - 1);
    expect(scan(content)).toEqual([{ file: FILE, line, message }]);
  });

  test("rejects re-exporting a namespace, which would hide its uses in the files that import it", () => {
    // Re-exported, `beings` and `mind` would reach another brain file through a relative path,
    // whose uses the scan would never see.
    const content = 'export { beings, floorDiv, mind } from "@open-origin/engine";\n';
    expect(scan(content)).toEqual([
      { file: FILE, line: 1, message: reexported("beings") },
      { file: FILE, line: 1, message: reexported("mind") },
    ]);
  });

  test("checks a namespace by its local alias, and reports every problem in line order", () => {
    const content = [
      'import { worldgen as w, readView } from "@open-origin/engine";',
      "export const top = w.MAX_CELL;",
      "export const read = w.radiance;",
      'import { createWorld } from "@open-origin/engine";',
      "",
    ].join("\n");
    expect(scan(content)).toEqual([
      { file: FILE, line: 1, message: forbidden("readView") },
      { file: FILE, line: 3, message: forbidden("worldgen.radiance") },
      { file: FILE, line: 4, message: forbidden("createWorld") },
    ]);
  });

  test("allows each namespace only its listed members, and the other symbols in any use", () => {
    expect(BRAIN_SYMBOLS.worldgen).toEqual(["MAX_CELL", "MIN_CELL"]);
    for (const members of Object.values(BRAIN_SYMBOLS))
      if (members !== "any") expect(members).toEqual([...members].sort());
    for (const name of ["readView", "step", "createWorld", "digest", "mix32", "DrawSequence"])
      expect(BRAIN_SYMBOLS[name]).toBeUndefined();
  });
});

describe("packages/agents/src", () => {
  test("every source file names only the engine symbols a brain may use", async () => {
    const paths = repoFiles(REPO_ROOT).filter(isAgentsSource);
    // An empty list would make the scan pass without checking anything.
    expect(paths).toContain(`${AGENTS_SRC}/brain/utility.ts`);
    const files = await Promise.all(
      paths.map(async (path) => ({ path, content: await Bun.file(`${REPO_ROOT}${path}`).text() })),
    );
    expect(files.flatMap(checkBrainSymbols)).toEqual([]);
  });
});
