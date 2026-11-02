/**
 * The boundary of the server's planes (ADR 0025, "Planes and the boundary"), checked on the
 * transitive import graph of apps/server/src:
 *
 * 1. from outside presentation/ and transport/, only compose.ts and main.ts import them;
 * 2. presentation/ and transport/ import only `@open-origin/protocol/*`, each other, and, as a type
 *    only, world/published.ts;
 * 3. world/ and projection/ import no `bun` and name no WebSocket;
 * 4. config/ is imported only by compose.ts and main.ts.
 *
 * Each rule holds for what a module reaches through any chain of imports, not only for what it
 * imports itself: a world module that imports compose.ts reaches the presentation plane through it.
 * Every import counts, type-only ones included: static imports, re-exports, `import x =
 * require("…")`, `import("…")`, and the `require("…")` and `import.meta.require("…")` that Bun's types
 * declare. For rule 2's exception, a type-only import is an `import type` or `export type`
 * statement, an `import type x = require("…")`, or a `typeof import("…")`. An import every specifier
 * of which carries an inline `type` is still a runtime import under verbatimModuleSyntax, so it does
 * not count as one. Specifiers are relative paths with their extension, which must name a module of
 * apps/server/src, or package names, `bun:*` and `node:*` included; an absolute path, any other
 * URL (`file://` among them), and a computed specifier are rejected, and so is every triple-slash
 * reference directive, which pulls a file into the program without an import.
 *
 * The same reader checks the import rules of packages/scenarios/src and packages/protocol/src in
 * the places Biome's rule for each cannot: a relative path that leaves `src`, a type-level
 * `import("…")`, a `require`, and a triple-slash reference directive.
 *
 * The scan is lexical, as tests/repo/engine-purity.ts's is: comments are blanked and string literals
 * kept, so a string that reads like an import counts as one, which errs on the side of rejecting. A
 * type-level `import("…")` without `typeof` reads as a runtime import. A `require` reached through
 * another name (`const load = require`, `module.require`) is left to review.
 */
import { posix } from "node:path";

export type SourceFile = { readonly path: string; readonly content: string };
export type Finding = { readonly file: string; readonly line: number; readonly message: string };

/** An import: its specifier (undefined when computed), whether it is type-only, and its line. */
export type ImportEdge = {
  readonly specifier: string | undefined;
  readonly typeOnly: boolean;
  readonly line: number;
};

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
/**
 * A call that loads a module: `import(…)`, dynamic or type-level, whose group 1 is `import`, and
 * `require(…)` and `import.meta.require(…)`, `import name = require(…)` among them.
 */
const LOADING_CALL = new RegExp(
  String.raw`${KEYWORD}(import|(?:import\.meta\.)?require)\s*\(`,
  "g",
);
const LITERAL_ARGUMENT = new RegExp(String.raw`^\s*${STRING}\s*[,)]`);
/** A statement that imports or re-exports types only. */
const TYPE_ONLY_STATEMENT = /^(?:import|export)\s+type\b/;
/** `typeof` right before an `import(…)`: a type-level import, which loads nothing. */
const TYPE_QUERY = /\btypeof\s*$/;
/** `import type name =` right before a `require(…)`: an import of types only. */
const TYPE_IMPORT_EQUALS = /\bimport\s+type\s+[\w$]+\s*=\s*$/;
/** A triple-slash reference directive, which the reader of imports would blank as a comment. */
const REFERENCE_DIRECTIVE = /^[ \t]*\/\/\/[ \t]*<reference\b/gm;

/** String and template literals (kept) and comments (blanked, keeping line breaks). */
const LITERAL_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** `content` with every comment blanked, keeping line breaks so that line numbers still match. */
function blankComments(content: string): string {
  return content.replace(LITERAL_OR_COMMENT, (match, literal: string | undefined) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

/** The 1-based line of the character at `index`. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Whether the call `match` of LOADING_CALL in `code` loads types only. */
function loadsTypesOnly(code: string, match: RegExpExecArray): boolean {
  const before = code.slice(0, match.index);
  return match[1] === "import" ? TYPE_QUERY.test(before) : TYPE_IMPORT_EQUALS.test(before);
}

/** Every import of `content`, in the order of its lines. */
export function importsOf(content: string): ImportEdge[] {
  const code = blankComments(content);
  const statements = [FROM_CLAUSE, SIDE_EFFECT_IMPORT].flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => ({
      specifier: match[1] ?? match[2] ?? "",
      typeOnly: TYPE_ONLY_STATEMENT.test(match[0]),
      line: lineAt(code, match.index),
    })),
  );
  const calls = [...code.matchAll(LOADING_CALL)].map((match) => {
    const argument = LITERAL_ARGUMENT.exec(code.slice(match.index + match[0].length));
    return {
      specifier: argument === null ? undefined : (argument[1] ?? argument[2] ?? ""),
      typeOnly: loadsTypesOnly(code, match),
      line: lineAt(code, match.index),
    };
  });
  return [...statements, ...calls].sort((a, b) => a.line - b.line);
}

/** The lines of the triple-slash reference directives of `content`, which importsOf cannot see. */
export function referencesOf(content: string): number[] {
  return [...content.matchAll(REFERENCE_DIRECTIVE)].map((match) => lineAt(content, match.index));
}

/** A TypeScript source of any extension. */
const TYPESCRIPT = /\.[cm]?tsx?$/;
const RELATIVE = /^\.\.?(?:\/|$)/;
const COMPUTED = "a dynamic import or a require with a computed specifier cannot be checked";
const REFERENCE = "a triple-slash reference directive cannot be checked: use an import";
/** A specifier with a URL scheme, such as `file:`, `data:`, or `https:`. */
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
/** The schemes of the runtime's own modules, which name packages, not files. */
const RUNTIME_SCHEME = /^(?:bun|node):/;

function isUnder(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`);
}

/** Whether `path` is a TypeScript module under `directory`. */
function isModuleOf(directory: string, path: string): boolean {
  return isUnder(path, directory) && TYPESCRIPT.test(path);
}

/** `specifier`, imported from `file`, as a repository-relative path. */
function resolveFrom(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

/** The findings of the triple-slash reference directives of `file`. */
function referenceFindings({ path, content }: SourceFile): Finding[] {
  return referencesOf(content).map((line) => ({ file: path, line, message: REFERENCE }));
}

/** The sources of the TypeScript modules under `directory` among `paths`, read with `read`. */
export async function readModules(
  directory: string,
  paths: readonly string[],
  read: (path: string) => Promise<string>,
): Promise<SourceFile[]> {
  const modules = paths.filter((path) => isModuleOf(directory, path)).sort();
  return Promise.all(modules.map(async (path) => ({ path, content: await read(path) })));
}

// The server ------------------------------------------------------------------------------------

export const SERVER_SRC = "apps/server/src";
/** A package a module imports, as a node of the graph. */
const PACKAGE = "package:";

/** One import between nodes: a module's path, or PACKAGE and a package's specifier. */
type Edge = { readonly target: string; readonly typeOnly: boolean; readonly line: number };

/** The path of `node` as diagnostics show it: relative to src, or a package's quoted specifier. */
function shown(node: string): string {
  if (node.startsWith(PACKAGE)) return `"${node.slice(PACKAGE.length)}"`;
  return node.slice(SERVER_SRC.length + 1);
}

/** The folder of src that holds `path`, or its name when it sits at the top of src. */
function zoneOf(path: string): string {
  return path.slice(SERVER_SRC.length + 1).split("/")[0] ?? "";
}

const inZone =
  (...zones: string[]) =>
  (node: string): boolean =>
    !node.startsWith(PACKAGE) && zones.includes(zoneOf(node));

const isPresentation = inZone("presentation", "transport");
const isRoot = inZone("compose.ts", "main.ts");
const PUBLISHED = `${SERVER_SRC}/world/published.ts`;

/** Why the specifier, which is not a relative path, cannot name a package; undefined when it can. */
function nonRelativeProblem(specifier: string): string | undefined {
  if (specifier === "@open-origin/server" || specifier.startsWith("@open-origin/server/")) {
    return `"${specifier}" names the server's own package: import its modules by relative path`;
  }
  // A path or a URL would join the graph as a package, out of reach of every rule.
  const byPath = `import the modules of ${SERVER_SRC} by relative path`;
  if (specifier.startsWith("/")) return `"${specifier}" is an absolute path: ${byPath}`;
  if (URL_SCHEME.test(specifier) && !RUNTIME_SCHEME.test(specifier)) {
    return `"${specifier}" is a URL: ${byPath}`;
  }
  return undefined;
}

/** Why the import `specifier` of `file` cannot join the graph; undefined when it can. */
function edgeProblem(file: string, specifier: string, modules: ReadonlySet<string>) {
  if (!RELATIVE.test(specifier)) return nonRelativeProblem(specifier);
  const resolved = resolveFrom(file, specifier);
  if (!isUnder(resolved, SERVER_SRC)) return `"${specifier}" resolves outside ${SERVER_SRC}`;
  if (!modules.has(resolved)) return `"${specifier}" resolves to no module of ${SERVER_SRC}`;
  return undefined;
}

/** The edge of one import of `file`, or the finding of why it cannot join the graph. */
function edgeOf(
  file: string,
  { specifier, typeOnly, line }: ImportEdge,
  modules: ReadonlySet<string>,
): { readonly edge: Edge } | { readonly finding: Finding } {
  if (specifier === undefined) return { finding: { file, line, message: COMPUTED } };
  const problem = edgeProblem(file, specifier, modules);
  if (problem !== undefined) return { finding: { file, line, message: problem } };
  const target = RELATIVE.test(specifier) ? resolveFrom(file, specifier) : PACKAGE + specifier;
  return { edge: { target, typeOnly, line } };
}

/** The graph of `files`, and the findings of the imports that cannot join it. */
function graphOf(files: readonly SourceFile[]) {
  const modules = new Set(files.map(({ path }) => path));
  const graph = new Map<string, readonly Edge[]>();
  const findings: Finding[] = [];
  for (const file of files) {
    const results = importsOf(file.content).map((imported) => edgeOf(file.path, imported, modules));
    graph.set(
      file.path,
      results.flatMap((result) => ("edge" in result ? [result.edge] : [])),
    );
    findings.push(...referenceFindings(file));
    findings.push(...results.flatMap((result) => ("finding" in result ? [result.finding] : [])));
  }
  return { graph, findings };
}

/** One rule of ADR 0025's boundary. */
type Rule = {
  readonly text: string;
  /** Whether the rule holds for what `module` reaches. */
  readonly applies: (module: string) => boolean;
  /** How reaching the node `edge` imports breaks the rule; undefined when it does not. */
  readonly breaks: (edge: Edge) => string | undefined;
  /** The findings of the module's own text, beyond its imports. */
  readonly own?: (file: SourceFile) => Finding[];
};

const WEBSOCKET = /WebSocket/g;

/** The lines of `file` that name a WebSocket, comments aside. */
function webSocketFindings({ path, content }: SourceFile, text: string): Finding[] {
  const code = blankComments(content);
  return [...code.matchAll(WEBSOCKET)].map((match) => ({
    file: path,
    line: lineAt(code, match.index),
    message: `names a WebSocket: ${text}`,
  }));
}

const reaches = (target: string) => `reaches ${shown(target)}`;
const isWorldPlane = inZone("world", "projection");
const isConfig = inZone("config");
const isBun = (target: string) => target === `${PACKAGE}bun` || target.startsWith(`${PACKAGE}bun:`);
const isProtocol = (target: string) => target.startsWith(`${PACKAGE}@open-origin/protocol/`);

/** How a module of presentation/ or transport/ breaks rule 2 by the import `edge`. */
function presentationBreak({ target, typeOnly }: Edge): string | undefined {
  if (target === PUBLISHED) return typeOnly ? undefined : "imports world/published.ts as a value";
  return isProtocol(target) || isPresentation(target) ? undefined : reaches(target);
}

/** The four rules, over modules whose text `sources` holds. */
function rules(sources: ReadonlyMap<string, string>): Rule[] {
  const namesWebSocket = (node: string) => /WebSocket/.test(blankComments(sources.get(node) ?? ""));
  const rule3 = "world/ and projection/ import no bun and name no WebSocket (ADR 0025, rule 3)";
  return [
    {
      text: "from outside presentation/ and transport/, only compose.ts and main.ts import them (ADR 0025, rule 1)",
      applies: (module) => !isPresentation(module) && !isRoot(module),
      breaks: ({ target }) => (isPresentation(target) ? reaches(target) : undefined),
    },
    {
      text: "presentation/ and transport/ import only @open-origin/protocol/*, each other, and, as a type only, world/published.ts (ADR 0025, rule 2)",
      applies: isPresentation,
      breaks: presentationBreak,
    },
    {
      text: rule3,
      applies: isWorldPlane,
      // A module of world/ or projection/ that names a WebSocket reports it itself.
      breaks: ({ target }) => {
        if (isBun(target)) return reaches(target);
        const named =
          !target.startsWith(PACKAGE) && !isWorldPlane(target) && namesWebSocket(target);
        return named ? `reaches a WebSocket in ${shown(target)}` : undefined;
      },
      own: (file) => webSocketFindings(file, rule3),
    },
    {
      text: "config/ is imported only by compose.ts and main.ts (ADR 0025, rule 4)",
      applies: (module) => !isRoot(module) && !isConfig(module),
      breaks: ({ target }) => (isConfig(target) ? reaches(target) : undefined),
    },
  ];
}

/** A node to visit: the import that reaches it, the line of the start's import, and the path. */
type Visit = { readonly edge: Edge; readonly line: number; readonly through: readonly string[] };

/** The visits of the imports of `visit`'s module, from the same import of the start. */
function nextVisits(graph: ReadonlyMap<string, readonly Edge[]>, { edge, line, through }: Visit) {
  return (graph.get(edge.target) ?? []).map((next) => ({
    edge: next,
    line,
    through: [...through, edge.target],
  }));
}

/**
 * The findings of `rule` for `start`: every forbidden node it reaches, reported once at the line
 * of the start's own import that leads there. Modules the rule also applies to are not walked
 * through: their own check reports what they reach.
 */
function reachFindings(graph: ReadonlyMap<string, readonly Edge[]>, start: string, rule: Rule) {
  const findings = new Map<string, Finding>();
  const queue: Visit[] = (graph.get(start) ?? []).map((edge) => ({
    edge,
    line: edge.line,
    through: [],
  }));
  const walked = new Set([start]);
  for (const visit of queue) {
    const { edge, line, through } = visit;
    const how = rule.breaks(edge);
    const key = `${line} ${edge.target}`;
    if (how !== undefined && !findings.has(key)) {
      const via = through.length === 0 ? "" : ` through ${through.map(shown).join(", ")}`;
      findings.set(key, { file: start, line, message: `${how}${via}: ${rule.text}` });
    }
    const module = !edge.target.startsWith(PACKAGE);
    if (how === undefined && module && !rule.applies(edge.target) && !walked.has(edge.target)) {
      walked.add(edge.target);
      queue.push(...nextVisits(graph, visit));
    }
  }
  return [...findings.values()];
}

/**
 * Every break of the boundary among `files`, the modules of apps/server/src: imports that cannot
 * join the graph, then each rule's findings, each in line order within its module.
 */
export function checkServerBoundaries(files: readonly SourceFile[]): Finding[] {
  const { graph, findings } = graphOf(files);
  const sources = new Map(files.map(({ path, content }) => [path, content]));
  const broken = rules(sources).flatMap((rule) =>
    files
      .filter(({ path }) => rule.applies(path))
      .flatMap((file) => [...(rule.own?.(file) ?? []), ...reachFindings(graph, file.path, rule)]),
  );
  return [...findings, ...broken].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Packages whose own Biome rule cannot see every import -----------------------------------------

/** A package's import rule: relative paths that stay inside `src`, and exactly `packages`. */
export type PackagePolicy = { readonly src: string; readonly packages: readonly string[] };

export const SCENARIOS_POLICY: PackagePolicy = Object.freeze({
  src: "packages/scenarios/src",
  packages: Object.freeze(["@open-origin/engine", "@open-origin/agents"]),
});

export const PROTOCOL_POLICY: PackagePolicy = Object.freeze({
  src: "packages/protocol/src",
  packages: Object.freeze(["zod"]),
});

/** Why `file` may not import `specifier` under `policy`; undefined when it may. */
function packageProblem({ src, packages }: PackagePolicy, file: string, specifier: string) {
  if (RELATIVE.test(specifier)) {
    return isUnder(resolveFrom(file, specifier), src)
      ? undefined
      : `"${specifier}" resolves outside ${src}`;
  }
  if (packages.includes(specifier)) return undefined;
  return `"${specifier}" is neither a relative path nor ${packages.join(" or ")}: ${src} imports nothing else`;
}

/**
 * Every import of `files` that breaks `policy`, in every form, and every triple-slash reference
 * directive, in line order within each file: Biome's rule for these packages does not see a
 * relative path that leaves `src`, a type-level import, a `require`, nor a directive.
 */
export function checkPackageImports(
  policy: PackagePolicy,
  files: readonly SourceFile[],
): Finding[] {
  return files.flatMap((file) => {
    const imports = importsOf(file.content).flatMap(({ specifier, line }) => {
      const message =
        specifier === undefined ? COMPUTED : packageProblem(policy, file.path, specifier);
      return message === undefined ? [] : [{ file: file.path, line, message }];
    });
    return [...referenceFindings(file), ...imports].sort((a, b) => a.line - b.line);
  });
}
