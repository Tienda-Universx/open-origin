/**
 * Source checks that keep packages/engine/src inside its own compiler gate (ADR 0003 P5). The
 * engine tsconfig declares only ECMAScript (`lib: ["ES2024"]`, `types: []`), and these bring host
 * APIs back past it: a reference directive, any `declare` declaration (ambient, exported, or a
 * class field), a declaration file, a comment that turns type checking or a Biome rule off, and
 * an import that leaves src. Biome's noRestrictedImports also rejects non-relative imports; this
 * scan adds the cases it misses: paths that leave src through `../` and type-level `import("…")`.
 * It also keeps worldgen in its layer (ADR 0021): no kernel module but src/index.ts imports
 * src/worldgen, worldgen imports only an allowlist of kernel modules, and a worldgen module
 * declares no top-level `let` or `var`. Biome overrides cannot express these: an override replaces
 * a rule's options instead of merging them (ADR 0020).
 *
 * The scan is lexical. Comments are blanked first; string literals are kept, so a string that
 * reads like an import is reported too, which errs on the side of rejecting. A regular expression
 * literal that contains a quote or a comment opener can confuse the comment blanking for the rest
 * of its line (or, with `/*`, up to the next `*\/`), and one that contains a brace shifts the depth
 * the module-state check reads; so does a template literal nested in a substitution.
 */
import { posix } from "node:path";

export type SourceFile = { path: string; content: string };
export type PurityIssue = { file: string; line: number; message: string };

/** Repository-relative directory of the engine core. */
export const ENGINE_SRC = "packages/engine/src";

/** TypeScript sources: `.ts`, `.mts`, `.cts`, `.tsx`, and their declaration files. */
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/** Whether `path` is a TypeScript file under packages/engine/src. */
export function isEngineSource(path: string): boolean {
  return path.startsWith(`${ENGINE_SRC}/`) && TYPESCRIPT_FILE.test(path);
}

/** A string literal (group 1 or 2 holds its text) that stays on one line, like a specifier. */
const STRING = String.raw`(?:"([^"\n]*)"|'([^'\n]*)')`;
/** Before a keyword: the previous character is not part of a name or a property access. */
const KEYWORD = String.raw`(?<![\w$.])`;

/** `import … from "x"` and `export … from "x"`, also across lines; strings may sit in between. */
const FROM_CLAUSE = new RegExp(
  String.raw`${KEYWORD}(?:import|export)\b(?:[^;"'\x60]|"[^"\n]*"|'[^'\n]*')*?\bfrom\s*${STRING}`,
  "g",
);
/** `import "x"`: an import for its side effects only. */
const SIDE_EFFECT_IMPORT = new RegExp(String.raw`${KEYWORD}import\s*${STRING}`, "g");
/** `import fs = require("x")`, TypeScript's import-equals declaration. */
const IMPORT_EQUALS = new RegExp(
  String.raw`${KEYWORD}import\s+(?:type\s+)?[\w$]+\s*=\s*require\s*\(\s*${STRING}`,
  "g",
);
/** `import(…)`: a dynamic import, or a type-level one such as `typeof import("x")`. */
const DYNAMIC_IMPORT = new RegExp(String.raw`${KEYWORD}import\s*\(`, "g");
const LITERAL_ARGUMENT = new RegExp(String.raw`^\s*${STRING}\s*[,)]`);

const DIRECTIVE = /^[ \t]*\/\/\/[ \t]*<reference\b/gm;
/** The `declare` modifier, with the word after it: a declaration keyword or a class field. */
const DECLARE = new RegExp(String.raw`${KEYWORD}declare\s+([\w$]+)`, "g");
const DECLARATION_KEYWORDS = new Set([
  "abstract",
  "class",
  "const",
  "enum",
  "function",
  "global",
  "interface",
  "let",
  "module",
  "namespace",
  "type",
  "var",
]);

/** String and template literals (kept) and comments (replaced). */
const LITERAL_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** The source with every comment blanked out, keeping line breaks so line numbers still match. */
function blankComments(source: string): string {
  return source.replace(LITERAL_OR_COMMENT, (match, literal: string | undefined) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

/** The 1-based line of the character at `index`. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

type Finding = { index: number; message: string };

/** Whether `path` is `directory` or lies under it. */
function isUnder(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** The procedural world generator, which only the engine's entry point exposes (ADR 0021). */
const WORLDGEN = `${ENGINE_SRC}/worldgen`;
const ENTRY_POINT = `${ENGINE_SRC}/index.ts`;
/** The kernel modules worldgen may import, relative to src. */
const WORLDGEN_MODULES = [
  "int.ts",
  "errors.ts",
  "rng/chacha.ts",
  "time/tick.ts",
  "world/chunk.ts",
  "world/members.ts",
  "world/contracts.ts",
];
/** The directories under src whose modules worldgen may import: its own among them. */
const WORLDGEN_DIRECTORIES = ["canonical", "digest", "worldgen"];
/** What worldgen may import, as its diagnostic lists it. */
const WORLDGEN_ALLOWLIST = `${WORLDGEN_MODULES.join(", ")}, and the modules under ${WORLDGEN_DIRECTORIES.map((directory) => `${directory}/`).join(", ")}`;

/** Whether a worldgen module may import the module at `resolved`. */
function worldgenMayImport(resolved: string): boolean {
  const path = resolved.slice(ENGINE_SRC.length + 1);
  return (
    WORLDGEN_MODULES.includes(path) ||
    WORLDGEN_DIRECTORIES.some((directory) => isUnder(path, directory))
  );
}

/**
 * Why `file` may not import the module at `resolved` (`specifier`) under worldgen's layering
 * (ADR 0021): the kernel never imports worldgen, except the entry point that re-exports it, and
 * worldgen imports only the allowlist above, so it cannot reach the world's state or its
 * randomness. Undefined when the import is allowed.
 */
function layerProblem(file: string, specifier: string, resolved: string): string | undefined {
  if (isUnder(file, WORLDGEN)) {
    if (worldgenMayImport(resolved)) return undefined;
    return `"${specifier}" is not a module worldgen may import: it may import ${WORLDGEN_ALLOWLIST} (ADR 0021)`;
  }
  if (file === ENTRY_POINT || !isUnder(resolved, WORLDGEN)) return undefined;
  return `"${specifier}" imports worldgen: the kernel never depends on worldgen, which only ${ENTRY_POINT} re-exports (ADR 0021)`;
}

/** Why `specifier`, imported from `file`, is not allowed; undefined when it is. */
function specifierProblem(file: string, specifier: string): string | undefined {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) {
    return `"${specifier}" is not a relative import: the engine depends on nothing`;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (!isUnder(resolved, ENGINE_SRC)) return `"${specifier}" resolves outside ${ENGINE_SRC}`;
  return layerProblem(file, specifier, resolved);
}

/** Every literal specifier the patterns capture, checked against the engine's import rule. */
function specifierFindings(file: string, code: string): Finding[] {
  return [FROM_CLAUSE, SIDE_EFFECT_IMPORT, IMPORT_EQUALS].flatMap((pattern) =>
    [...code.matchAll(pattern)].flatMap((match) => {
      const message = specifierProblem(file, match[1] ?? match[2] ?? "");
      return message === undefined ? [] : [{ index: match.index, message }];
    }),
  );
}

/** Dynamic imports: a literal specifier follows the import rule; a computed one is rejected. */
function dynamicImportFindings(file: string, code: string): Finding[] {
  return [...code.matchAll(DYNAMIC_IMPORT)].flatMap((match) => {
    const argument = LITERAL_ARGUMENT.exec(code.slice(match.index + match[0].length));
    const message =
      argument === null
        ? "a dynamic import with a computed specifier cannot be checked"
        : specifierProblem(file, argument[1] ?? argument[2] ?? "");
    return message === undefined ? [] : [{ index: match.index, message }];
  });
}

/**
 * Declarations that no engine code backs: reference directives (read from the raw source, since
 * they are comments) and every `declare` declaration, which can give a host global a type even
 * inside a module.
 */
function declarationFindings(source: string, code: string): Finding[] {
  const directives = [...source.matchAll(DIRECTIVE)].map((match) => ({
    index: match.index,
    message: "`/// <reference>` directives add declarations the engine tsconfig excludes",
  }));
  const declared = [...code.matchAll(DECLARE)].map((match) => ({
    index: match.index,
    message: DECLARATION_KEYWORDS.has(match[1] ?? "")
      ? `\`declare ${match[1]}\` adds ambient declarations the engine tsconfig excludes`
      : "a `declare` field declares a value that no engine code provides",
  }));
  return [...directives, ...declared];
}

/**
 * Tokens that switch a gate off: Biome suppressions (an exception belongs in a reviewed
 * biome.json override) and TypeScript's directives that skip type errors. TypeScript matches its
 * directives as prefixes, so they need no word boundary.
 */
const GATE_TOKENS = [
  {
    pattern: /\bbiome-ignore(?:-all|-start|-end)?\b/g,
    reason: "can silently disable a purity rule: add a reviewed override in biome.json instead",
  },
  {
    pattern: /@ts-(?:nocheck|expect-error|ignore)/g,
    reason: "can silently disable the engine's type gate: fix the type error instead",
  },
];

/**
 * Every gate-switching directive anywhere in the source, strings included. A comment inside a
 * template substitution reads as template text to this lexical scan, so restricting the search to
 * comments would miss it; engine code has no reason to spell these tokens in a string.
 */
function gateTokenFindings(source: string): Finding[] {
  return GATE_TOKENS.flatMap(({ pattern, reason }) =>
    [...source.matchAll(pattern)].map((match) => ({
      index: match.index,
      message: `\`${match[0]}\` ${reason}`,
    })),
  );
}

/** `let` and `var`, which declare bindings that can be reassigned. */
const MUTABLE_DECLARATION = new RegExp(String.raw`${KEYWORD}(?:let|var)\b`, "g");

/** The code (comments already blanked) with every string and template literal blanked too. */
function blankLiterals(code: string): string {
  return code.replace(LITERAL_OR_COMMENT, (match) => match.replace(/[^\n]/g, " "));
}

/** How many more `{` than `}` the text holds. */
function braceBalance(text: string): number {
  return (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
}

/**
 * The `let` and `var` declarations at the top level of a worldgen module: module state, which
 * would let one generator call depend on the calls before it (ADR 0021). Top level is brace depth
 * 0 once literals are blanked, so a top-level `for (let …)` is reported too, which errs on the
 * side of rejecting.
 */
function moduleStateFindings(code: string): Finding[] {
  const text = blankLiterals(code);
  const findings: Finding[] = [];
  let depth = 0;
  let scanned = 0;
  for (const match of text.matchAll(MUTABLE_DECLARATION)) {
    depth += braceBalance(text.slice(scanned, match.index));
    scanned = match.index;
    if (depth !== 0) continue;
    findings.push({
      index: match.index,
      message: `a top-level \`${match[0]}\` declares module state: worldgen modules keep no state between calls (ADR 0021)`,
    });
  }
  return findings;
}

/** Every purity issue in one engine source file, in line order. */
export function checkEngineSource({ path, content }: SourceFile): PurityIssue[] {
  // `.d.ts`, `.d.mts`, `.d.cts`, and declaration files for other extensions (`x.d.json.ts`).
  if (/\.d\.(?:[^./]+\.)?[cm]?ts$/.test(path)) {
    return [
      {
        file: path,
        line: 1,
        message: "declaration files can declare globals: write a .ts module instead",
      },
    ];
  }
  const code = blankComments(content);
  return [
    ...declarationFindings(content, code),
    ...gateTokenFindings(content),
    ...specifierFindings(path, code),
    ...dynamicImportFindings(path, code),
    ...(isUnder(path, WORLDGEN) ? moduleStateFindings(code) : []),
  ]
    .sort((a, b) => a.index - b.index)
    .map(({ index, message }) => ({ file: path, line: lineAt(content, index), message }));
}
