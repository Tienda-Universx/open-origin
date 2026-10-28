/**
 * The scan of the engine symbols a brain may use (ADR 0024, docs/architecture/mind.md "Provenance
 * and taints", plan §6). packages/agents/src imports only the engine's public entry
 * (engine-purity.ts), and that entry also exports the kernel, worldgen's terrain, and the mind
 * layer's state machinery: a brain that named `readView`, `worldgen.sampleSurface`, or
 * `beings.senseWindow` could read the world beyond its senses, and one that named `mind.TAINTS`
 * could reason about the taints it must never see. This scan allows only the symbols of
 * BRAIN_SYMBOLS: values and types of the brain's port, integer helpers, the bounds of the world,
 * and the pure law of salience that a brain needs to predict which of its records a full store
 * keeps.
 *
 * Every import from the engine names its symbols: a namespace import, a default import,
 * `export *`, and a type-level `import()` are refused, because they would hide which symbols a
 * file uses. A namespace of the engine (`beings`, `mind`, `worldgen`) is checked at each use of its
 * local name: a member access `ns.Member`, or a destructuring `{ Member } = ns`, names one of its
 * listed members; any other use, such as a computed member or the namespace passed on as a value,
 * is refused, since the scan could not tell which member it reaches. A key named like the
 * namespace (`{ beings: … }`) is not a use of it.
 *
 * The scan is lexical, like engine-purity.ts: comments and the text of string literals are blanked
 * first, so neither counts as a use. A local binding that shadows an imported namespace is read as
 * the namespace, which errs on the side of rejecting, and so is a namespace's name inside the text
 * of a template literal.
 */
import type { SourceFile } from "./engine-purity.ts";

export type SymbolIssue = { file: string; line: number; message: string };

/** A symbol any use of which is allowed: a function, a class, or a type, not a namespace. */
const ANY = "any";

/**
 * The engine symbols a brain may name, by their exported name: "any" for a symbol allowed in any
 * use, and for a namespace the members it may name, sorted. Everything else is refused.
 */
export const BRAIN_SYMBOLS: Readonly<Record<string, readonly string[] | typeof ANY>> =
  Object.freeze({
    DeepReadonly: ANY,
    EngineError: ANY,
    Issue: ANY,
    floorDiv: ANY,
    floorMod: ANY,
    beings: Object.freeze([
      "Activity",
      "BEING_BOUNDS",
      "Behavior",
      "Cell",
      "Controller",
      "Controller2",
      "Cooldown",
      "CooldownRequest",
      "DIRECTIONS",
      "HeardMessage",
      "Intention",
      "Intention2",
      "MAX_INTENTION_STEPS",
      "MAX_WALK_STEPS",
      "MindIntention",
      "NEED_MAX",
      "Outcome",
      "PerceivedBeing",
      "Perception",
      "PlanStep",
      "SensedWindow",
      "Senses",
      "Senses2",
      "Species",
      "Species2",
      "SpeechLaws",
      "TalkStep",
      "Traits",
      "Traits2",
      "WakeConditions",
    ]),
    mind: Object.freeze([
      "ACTS",
      "Act",
      "BeliefView",
      "Cell",
      "EVIDENCE",
      "EpisodeView",
      "FAILURES",
      "INT31_MAX",
      "LocalId",
      "MindLaws",
      "MindView",
      "Proposition",
      "Ratio",
      "RelationshipView",
      "Term",
      "decay",
      "sameProposition",
      "scaledHalfLife",
    ]),
    worldgen: Object.freeze(["MAX_CELL", "MIN_CELL"]),
  });

/** The engine's public entry, the only package a brain imports (engine-purity.ts). */
const ENGINE = "@open-origin/engine";

/** The engine's entry as a pattern. */
const ENGINE_PATTERN = ENGINE.replace("/", "\\/");

/** Comments, string literals (group 1), and template literals (group 2), which stay as they are. */
const COMMENT_OR_STRING =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** `source` with comments blanked and, when `strings` is true, the text of string literals too. */
function blank(source: string, strings: boolean): string {
  return source.replace(
    COMMENT_OR_STRING,
    (match, quoted: string | undefined, template: string | undefined) => {
      if (template !== undefined) return template;
      if (quoted === undefined) return match.replace(/[^\n]/g, " ");
      if (!strings) return quoted;
      return `${quoted[0]}${" ".repeat(quoted.length - 2)}${quoted[0]}`;
    },
  );
}

/** The 1-based line of the character at `index`. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Before a keyword or a name: the previous character is not part of a name or a property access. */
const START = String.raw`(?<![\w$.])`;

/**
 * An import or export clause from the engine, also across lines: group 1 is the keyword, group 2
 * what lies between it and `from`, with no statement end or string in between.
 */
const ENGINE_CLAUSE = new RegExp(
  String.raw`${START}(import|export)\b([^;"'\x60]*?)\bfrom\s*["']${ENGINE_PATTERN}["']`,
  "g",
);

/** A type-level or dynamic `import("@open-origin/engine")`. */
const ENGINE_CALL = new RegExp(String.raw`${START}import\s*\(\s*["']${ENGINE_PATTERN}["']`, "g");

type Finding = { index: number; message: string };

/** A symbol a clause imports: its exported name, and the name it is bound to in the file. */
type Imported = { readonly name: string; readonly local: string };

const forbidden = (symbol: string): string =>
  `"${symbol}" is not an engine symbol a brain may use: a brain reads the world only through its senses (ADR 0024)`;
const hidden = (form: string): string =>
  `${form} hides which engine symbols a brain uses: import them by name`;

/** The symbols of the named list `{ … }` of a clause; `type` modifiers are dropped. */
function namedSymbols(list: string): Imported[] {
  return list
    .split(",")
    .map((entry) => entry.trim().replace(/^type\s+/, ""))
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [name = "", local = name] = entry.split(/\s+as\s+/);
      return { name: name.trim(), local: local.trim() };
    });
}

/** What one clause from the engine imports, or why the scan refuses its form. */
function readClause(keyword: string, body: string): Imported[] | string {
  const between = body.trim().replace(/^type\b\s*/, "");
  if (between.startsWith("*")) {
    return keyword === "import"
      ? hidden(`import * as … from "${ENGINE}"`)
      : hidden(`export * from "${ENGINE}"`);
  }
  const named = /^\{([\s\S]*)\}$/.exec(between);
  if (named === null) return hidden(`a default import from "${ENGINE}"`);
  return namedSymbols(named[1] ?? "");
}

/** What the clauses of `code` from the engine refuse, the namespaces they bind, and their spans. */
type Imports = {
  readonly findings: readonly Finding[];
  readonly namespaces: readonly Imported[];
  readonly spans: readonly (readonly [number, number])[];
};

/** The engine's clauses of `code`, each symbol checked against BRAIN_SYMBOLS. */
function readImports(code: string): Imports {
  const findings: Finding[] = [];
  const namespaces: Imported[] = [];
  const spans: (readonly [number, number])[] = [];
  for (const match of code.matchAll(ENGINE_CLAUSE)) {
    spans.push([match.index, match.index + match[0].length]);
    const read = readClause(match[1] ?? "", match[2] ?? "");
    if (typeof read === "string") {
      findings.push({ index: match.index, message: read });
      continue;
    }
    for (const symbol of read) {
      const allowed = BRAIN_SYMBOLS[symbol.name];
      if (allowed === undefined)
        findings.push({ index: match.index, message: forbidden(symbol.name) });
      else if (allowed !== ANY) namespaces.push(symbol);
    }
  }
  for (const match of code.matchAll(ENGINE_CALL))
    findings.push({ index: match.index, message: hidden(`import("${ENGINE}")`) });
  return { findings, namespaces, spans };
}

/** `code` with the text of each span blanked, keeping line breaks. */
function withoutSpans(code: string, spans: Imports["spans"]): string {
  let text = code;
  for (const [from, to] of spans)
    text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);
  return text;
}

/** An identifier. */
const NAME = String.raw`[A-Za-z_$][\w$]*`;

/**
 * Each destructuring `{ … } = ns` of the namespace bound to `local`: the index of the namespace's
 * name and the members it names.
 */
function destructurings(code: string, local: string): { at: number; members: string[] }[] {
  const pattern = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*(${local})(?![\w$])`, "dg");
  return [...code.matchAll(pattern)].map((match) => ({
    at: match.indices?.[2]?.[0] ?? match.index,
    members: (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().split(/[\s:=]/)[0] ?? "")
      .filter((member) => member !== ""),
  }));
}

/**
 * Whether the name at `index`, followed by `after`, is a key or a parameter that shares the
 * namespace's name rather than a use of it: it follows `{`, `,`, `(`, or `;`, perhaps through
 * `readonly`, and precedes `:` or `?:`.
 * A ternary's branch (`c ? ns : x`) follows `?`, so it stays a use.
 */
function isKey(code: string, index: number, after: string): boolean {
  const before =
    code
      .slice(0, index)
      .replace(/\breadonly\s*$/, "")
      .trimEnd()
      .at(-1) ?? "";
  return "{,(;".includes(before) && /^\s*\??:/.test(after);
}

/** Every use of the namespace `symbol` in `code` that names no member it may use. */
function namespaceFindings(code: string, symbol: Imported): Finding[] {
  const members = BRAIN_SYMBOLS[symbol.name] as readonly string[];
  const findings: Finding[] = [];
  const check = (index: number, member: string) => {
    if (!members.includes(member))
      findings.push({ index, message: forbidden(`${symbol.name}.${member}`) });
  };
  const sources: number[] = [];
  for (const { at, members: named } of destructurings(code, symbol.local)) {
    sources.push(at);
    for (const member of named) check(at, member);
  }
  for (const match of code.matchAll(
    new RegExp(String.raw`${START}${symbol.local}(?![\w$])`, "g"),
  )) {
    const after = code.slice(match.index + symbol.local.length);
    const member = new RegExp(String.raw`^\s*\??\.\s*(${NAME})`).exec(after);
    if (member !== null) check(match.index, member[1] ?? "");
    else if (!sources.includes(match.index) && !isKey(code, match.index, after))
      findings.push({
        index: match.index,
        message: `"${symbol.name}" is used other than through a member: name the member, so that the scan can check it`,
      });
  }
  return findings;
}

/** Every use of an engine symbol in one source of packages/agents/src that a brain may not make. */
export function checkBrainSymbols({ path, content }: SourceFile): SymbolIssue[] {
  const { findings, namespaces, spans } = readImports(blank(content, false));
  const uses = withoutSpans(blank(content, true), spans);
  return [...findings, ...namespaces.flatMap((symbol) => namespaceFindings(uses, symbol))]
    .sort((a, b) => a.index - b.index)
    .map(({ index, message }) => ({ file: path, line: lineAt(content, index), message }));
}
