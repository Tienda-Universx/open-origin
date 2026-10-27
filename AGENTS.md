# AGENTS.md

Instructions for humans and AI agents working in this repository. They apply to every batch
("tanda"), not only to the current one.
The approved plan (`docs/roadmap/v0.1-plan.es.md`) and the ADRs (`docs/decisions/`) are the source
of truth. When this file or the plan disagrees with an ADR, the ADR wins; this file is then fixed,
while the plan stays a verbatim record whose known errata are listed in the tracker log.

## Project in one paragraph

Open Origin is an open-source (AGPL-3.0) persistent universe where autonomous beings and humans
coexist. An authoritative, deterministic simulation engine is the only source of truth. AI models
only **propose** intentions; the engine validates, applies, records, and attributes them.

## Commands

Bun is the only runtime and package manager for project code. Do not use npm, yarn, or pnpm, do not
run project code with Node.js, and do not install global tools. Node-ecosystem tools that work under
Bun are allowed when they add value.

| Task | Command |
|---|---|
| Install | `bun install` (CI uses `bun install --frozen-lockfile`) |
| Everything CI runs | `bun run check` |
| Typecheck | `bun run typecheck` |
| Lint, format and complexity checks (Biome, oxlint) | `bun run lint` |
| Apply formatting and safe fixes | `bun run format` |
| Tests | `bun test` |
| Engine benchmark (manual, not part of `check`) | `bun packages/engine/bench/step.ts` |
| Worldgen benchmark (manual, not part of `check`) | `bun packages/engine/bench/worldgen.ts` |
| Beings benchmark (manual, not part of `check`) | `bun packages/agents/bench/beings.ts` |

CLIs whose launcher targets Node (for example `tsc`, `biome`) run with `bunx --no-install --bun`:
`--bun` keeps them on Bun, and `--no-install` stops bunx from downloading a registry package when
the tool is not installed locally (the npm package named `tsc` is not TypeScript). Run `bun install`
first, then check that a tool exists and which version it is (`bun --version`,
`bunx --no-install --bun tsc --version`); do not assume.

## Architecture rules (do not break)

1. **The engine is reality.** Simulation state changes only through the engine's `step`.
   Clients, AI, and admin tools submit commands; they never write state.
2. **AI proposes, the engine decides.** Model output is validated, recorded as a command, and never
   trusted as a result. Experiment outcomes always come from the engine.
3. **Pure, runtime-agnostic core.** `packages/engine` and `packages/agents` must not use Bun,
   `node:*`, DOM APIs, `Math.random`, `Date`, `crypto.randomUUID`, or math whose results each
   JavaScript engine only approximates (`sin`, `cos`, `exp`, `pow`, `**`, and the rest listed in
   ADR 0003). State holds only safe integers
   (`Number.isSafeInteger`), strings, booleans, arrays, and plain records.
4. **Observer independence.** Nothing outside the world (who is watching, which UI is open, who
   pays) may influence the engine, the minds, or the cognitive budget allocator.
5. **No lexical censorship of ideas.** Inhabitants may think about anything. We control what enters
   prompts and we attribute provenance; we do not block words.
6. **Audience projections.** Clients receive explicit allow-listed DTOs per audience, never raw
   state. Data classes C0 public, C1 inhabitant-internal, C2 player-private, C3 operations/research,
   C4 secrets.
7. **Two interfaces, two planes.** `apps/web` (public) and `apps/admin` (private) never share a
   bundle, listener, or API. The admin plane is never exposed publicly without authentication and
   authorization; in v0.1 it binds to `127.0.0.1` and requires a token.
8. **UI stack.** React + Vite + native CSS, CSS Modules, and CSS custom properties via the shared
   `packages/ui` design system. No Tailwind, shadcn/ui, or CSS frameworks. PixiJS renders only the
   interactive universe; React renders every interface.
9. **AI is off by default.** `AI_MODE=off`. Paid usage requires an explicit server flag plus spend
   caps, and is never enabled by an agent.
10. **No empty packages.** Create a workspace package only in the batch that needs it.
11. **Scientific integrity.** Never present a metric or a behavior as proof that inhabitants are
    conscious (no accepted test exists, plan §C), never inject the concepts we want to observe into
    prompts, and keep provenance for every belief (plan §C, §K).
12. **One shared public universe.** The public universe is one world with one clock, advanced only
    by the server at a fixed rate. No player, spectator, or client can pause, speed up, slow down,
    or rewind it; cameras and visual preferences are presentation; replays and private simulations
    run apart, with their own clocks ([ADR 0022](docs/decisions/0022-single-shared-public-universe.md)).

## Change protocol (mandatory for every significant change)

A change is significant when it refactors, optimizes, upgrades a dependency, or modifies behavior,
contracts, CI, or security-relevant code. A change is complete only when there is evidence that the
expected behavior is preserved and the relevant checks pass. Compiling or a green suite alone is not
evidence.

### Phase A: examine the original state

1. Read the code involved, its callers, and its dependencies; list the contracts it must keep.
2. Inventory existing tests (unit, integration, functional, end-to-end).
3. Run them **before** modifying anything and record which pass, fail, or cannot run.
4. Investigate every pre-existing failure, so pre-existing problems are not confused with new ones.
5. Check that the tests assert real outcomes, not only that code runs without throwing: the exact
   result when it is known, and never a vacuous pass (a scan that finds nothing, a document that
   ends inside an open block).

### Phase B: check that the tests can fail

1. Where it adds value, introduce a controlled defect in an isolated copy (never in the working
   tree you will commit, never in production): break an expected result or a key condition.
2. The related test must fail. If it keeps passing, the test is insufficient and must be improved.
3. Restore the original code and confirm the suite passes again. Never keep a deliberate defect.
4. When an important behavior has no test, first add characterization or regression tests that pin
   the correct behavior, then change the code.

### Phase C: make the change

1. State what will improve and why; list risks and side effects.
2. Choose the simplest maintainable solution; avoid duplication, coupling, and over-engineering.
3. Make small, reviewable changes; keep public interfaces and behavior unless a functional change
   is explicitly justified. Refactor in small steps and rerun the tests and checks after each one.
4. Write the failing test first when a deterministic test is possible (RED), then the change
   (GREEN).
5. Never weaken or edit tests just to make them pass. When behavior changes on purpose, document it
   and update the tests to the new requirement.

### Phase D: validate

1. Run the relevant tests, then the full suite, and compare with the Phase A baseline.
2. Run typecheck, lint, format check, builds, and integration tests when they exist.
3. Confirm the original problem is fixed and no regression appeared; probe edge cases, invalid
   input, race conditions, and recovery paths where they apply.
4. Measure performance or resource use when the change can affect them; do not assume.
5. Repeat Phase B for new tests: they must detect real defects.
6. Get an independent review of the final result: a reviewer or agent that did not write the
   change.

If a check fails, find and fix the cause. Never hide, skip, or disable a failure without a
documented justification.

### Phase E: close-out sweep

Before reporting any work as done, search the change and the repository for residue it left:

- debug output, commented-out code, `TODO`/`FIXME` without an issue, placeholder text;
- unused files, exports, dependencies, scripts, or configuration;
- scratch files, temporary branches, worktrees, and generated artifacts;
- AI slop: comments or docs that restate the code, inflate claims, or contradict the code;
  duplicated documentation; filler wording;
- claims in docs, commit messages, or PR descriptions without evidence; stale references (renamed
  files, old versions, broken links).

Remove what is residue and report what was found and removed.

## Engineering practices

Apply them wherever they improve the code, never mechanically, and never refactor only to move a
metric: readability, security, simplicity, performance, and correct behavior come first.

| Practice | Rule |
|---|---|
| Guard clauses and early returns | Handle invalid and trivial cases first and return; avoid nested `if`/`else`. |
| Cyclomatic complexity | Review every function above the limit (see Automated controls): split it, or justify it with `// oxlint-disable-next-line eslint/complexity -- <reason>` in a reviewed change. |
| Cognitive complexity | Code reads top to bottom; simplify first where it is hard to follow. |
| DRY | Remove real duplication of logic (same rule, same reason to change); never abstract code that only looks alike. |
| Single responsibility | Each function, class, and module has one clear reason to change. |
| Fail fast | Validate inputs and invariants at the boundary and report errors where they happen; never continue on a corrupt state. |
| Type safety | Strict TypeScript; no unjustified `any`, unsafe `as` casts, non-null assertions, or `@ts-ignore`/`@ts-expect-error`. |
| Testability and determinism | Pure functions with injected effects (time, randomness, I/O) and reproducible results, especially in the simulation core (architecture rule 3). |

The principles the maintainer listed for every change (tracker L11) apply with the same judgment:
SOLID, KISS, YAGNI, separation of concerns, explicit contracts and errors, input and output
validation, least privilege, compatibility and versioning, observability, measured performance,
cost and dependency control, and up-to-date documentation.

### Review checklist

Evaluate every significant change for:

- excessively long functions and too many parameters (limits in Automated controls; group related
  values in an object);
- unnecessary dependencies: each new one is justified and pinned as ADR 0015 requires;
- high coupling between modules and violations of the hexagonal boundaries (dependency rule in
  `docs/architecture/overview.md`: the core never imports adapters);
- dead and duplicated code;
- incorrect error handling: swallowed errors, empty `catch`, lost causes, unhandled promises,
  errors that do not name the file, entity, tick, or command at fault, and checkers that stop at the
  first problem;
- race conditions and concurrency: shared state across `await`, ordering, idempotency;
- performance regressions: measure before and after when a change can affect a hot path.

### Code audits

Audit code before a batch builds on it and whenever a change grows a module. Size and metrics show
where to look; they never decide a change on their own, and keeping the current design is a valid
outcome.

- **Size triggers a review, never a split.** Above about 300 lines, check a module's
  responsibilities; above 500, assess its structure; above 800, record why it stays whole or split
  it; above 1,500, audit it first. Tests made of explicit cases and verbatim documents are not split
  for size, and generated files (`bun.lock`) are never edited by hand.
- **Decide each finding on evidence:** the concrete problem a change solves, the risk of leaving it
  and of changing it, whether extracting a function or module beats keeping the design, and whether
  the gain is worth the cost. Choose the simplest change that solves it.
- **Cost per tick.** Work done each tick scales with the active entities and chunks, never with the
  size of the world or with all pairs of inhabitants.

### Automated controls

`bun run check` enforces what tools can verify; everything else stays a review item. A tool
counts as a control only for the rules it actually checks, and a control is listed as enforced only
when a test shows that it rejects bad input, including the boundary case of every documented
threshold: `tests/repo/lint.test.ts` and `tests/repo/engine-lint.test.ts` do it for strict types and
each lint rule below. Those tests pin properties and invariants, not verbatim copies of
configuration, which only add friction.

| Control | Tool | Status |
|---|---|---|
| Strict types | `tsc` (`bun run typecheck`) | Enforced |
| Cognitive complexity above 15, functions over 50 lines (outside tests), more than 4 parameters, `else` after `return`, nested ternaries, non-null assertions, parameter reassignment, import cycles, explicit `any`, `@ts-ignore`, unused variables, imports, and parameters | Biome | Enforced |
| Cyclomatic complexity above 10, nesting deeper than 4 | oxlint (only these rules) | Enforced |
| ADR format; invisible characters in file names and contents; UTF-8 text files; package scripts and exact dev-dependency pins in every manifest; every workspace tsconfig in `typecheck` and every workspace test file in the root tsconfig program; workflow permissions, triggers and pinned actions; Dependabot cooldown; Bun telemetry off; the Biome exclusion of the frozen snapshot fixture, exactly its path; links; verbatim documents | `tests/repo/` | Enforced |
| Hexagonal boundaries: `packages/engine/src` imports only relative paths that stay inside `src` (no `bun`, `bun:*`, `node:*`, or packages) | Biome `noRestrictedImports` and `noNodejsModules` for `packages/engine/src`; `tests/repo/engine-purity.ts` for paths that leave `src` and type-level `import()` | Enforced for `packages/engine` (`engine-lint.test.ts`, `engine-purity.test.ts`) and `packages/agents` (next row); each new package adds its own rule |
| Hexagonal boundaries of `packages/agents/src` (ADR 0023): imports only relative paths that stay inside its `src` and exactly `@open-origin/engine`, never a path inside the engine, `bun`, `bun:*`, `node:*`, or another package; static, side-effect, import-equals, dynamic, and type-level `import()` | Biome `noRestrictedImports` in an override of its own and `noNodejsModules` for `packages/agents/src`; `tests/repo/engine-purity.ts` (`checkAgentsSource`) for relative paths that leave `src`, type-level `import()`, and computed specifiers | Enforced (`engine-lint.test.ts`, `engine-purity.test.ts`) |
| Worldgen and beings layering and module state (ADR 0021, ADR 0023): no module under `packages/engine/src` outside `src/worldgen/` and `src/beings/`, except `src/index.ts`, imports a module under either; worldgen modules import only `int.ts`, `errors.ts`, `rng/chacha.ts`, `time/tick.ts`, `world/chunk.ts`, `world/members.ts`, `world/contracts.ts`, and modules under `canonical/`, `digest/`, and `worldgen/`; beings modules import only `int.ts`, `errors.ts`, `time/tick.ts`, `world/chunk.ts`, `world/members.ts`, `world/contracts.ts`, `worldgen/index.ts`, and modules under `canonical/`, `digest/`, and `beings/`; both import `world/contracts.ts` only with `import type` or `export type`; type-level `import()` and re-exports included; no top-level `let` or `var` in either, and no top-level `const` bound to an array, object, `new` expression, or regular expression literal in a beings module. The scan is lexical: worldgen's constant tables, constants bound to other calls, a second declarator (`const a = 1, b = []`), a parenthesized initializer, a default export, a class's static field, and a value-position `typeof import()` are left to review, and the determinism suite's `interleave` and `child-resume` catch state that changes results | `tests/repo/engine-purity.ts`, a lexical scan rather than a Biome override (an override replaces a rule's options instead of merging them, ADR 0020) | Enforced (`engine-purity.test.ts`) |
| Engine purity (ADR 0003 P5) in `packages/engine/src`: the globals `Date`, `Intl`, `globalThis`, `WeakRef`, `FinalizationRegistry`, `SharedArrayBuffer`, `Atomics`, `Promise`, `Proxy`, `Set`, `WeakMap`, `WeakSet`, `Function`, `Bun`, `crypto`, `performance`, `structuredClone`, `Reflect`; every reference outside a type to `JSON` (except in `canonical/encode.ts`), `Map` (except in `canonical/value.ts` and `step/context.ts`), and `Math` (except in `int.ts`, which may reference only `Math.imul` and `Math.floor`); `console`, `process`, `eval`, `for…in`; `**` and `**=`; `async` and `await`; direct member access, with quoted or backtick keys too, to `localeCompare`, `toLocale*`, `constructor`, and `Object.keys`, `values`, `entries`, `getOwnPropertyNames`, `getOwnPropertySymbols`, `getOwnPropertyDescriptors` (except in `canonical/order.ts`); binding or destructuring `Object` into a variable; only ECMAScript 2024 declarations (`lib: ["ES2024"]`, `types: []`); no `/// <reference>`, `declare` declarations (statements, `export declare`, class fields), declaration files (`.d.ts`, `.d.mts`, `.d.cts`, `.d.<ext>.ts`), `@ts-nocheck`, `@ts-expect-error`, `@ts-ignore`, or Biome suppression comments (`biome-ignore`, `-all`, `-start`, `-end`) | Biome stable rules, with one `noRestrictedGlobals` list, and the GritQL plugins in `packages/engine/lint/`: `purity.grit`, plus one plugin per rule that has or will have an exception (`key-order.grit` for key enumeration, `global-json.grit`, `global-map.grit`, `global-math.grit`), each registered for `src` minus its exception file, and `int-math.grit`, registered for `int.ts` alone; five reviewed exceptions, each limited to its file: `canonical/order.ts` may enumerate keys, `canonical/encode.ts` may use `JSON`, `canonical/value.ts` and `step/context.ts` may use `Map`, and `int.ts` may use `Math.imul` and `Math.floor`; `tsc -p packages/engine/tsconfig.json` in `bun run typecheck`; `tests/repo/engine-purity.ts` | Enforced (`engine-lint.test.ts`, `engine-purity.test.ts`, `package.test.ts`) |
| Agents purity (ADR 0023) in `packages/agents/src`: the engine's denied globals and GritQL plugins (`purity.grit`, `key-order.grit`, `global-json.grit`, `global-math.grit`, `global-map.grit`) with no exception file, so no `Math`, `Map`, `JSON`, or key enumeration through `Object` at all; `noProcessGlobal`, `noGlobalEval`, `noConsole`, `noForIn`; only ECMAScript 2024 declarations (`lib: ["ES2024"]`, `types: []`); no `/// <reference>`, `declare` declarations, declaration files, `@ts-nocheck`, `@ts-expect-error`, `@ts-ignore`, or Biome suppression comments; no top-level `let` or `var`, and no top-level `const` bound to an array or object literal, a `new` expression, or a regular expression literal, with the same lexical limits as the beings layer's row | Biome: the one `noRestrictedGlobals` override, which covers both src directories, and an agents override that registers the four plugins with exceptions in the engine; `tsc -p packages/agents/tsconfig.json` in `bun run typecheck`; `tests/repo/engine-purity.ts` | Enforced (`engine-lint.test.ts`, `engine-purity.test.ts`, `package.test.ts`) |
| Duplicated code, dead exports | None yet | Review checklist |
| Engine work per tick that grows with the number of chunks | `bun test` (`packages/engine/test/step-cost.test.ts`) | Enforced: the median tick of 200,000 chunks must cost less than 2 times one of 1,000 |
| Beings work per tick that grows with the number of chunks or with pairs of beings processed together; chunk reads of the beings system beyond what it lists, senses, or occupies | `bun test` (`packages/engine/test/beings-cost.test.ts`) | Enforced: with ten sleeping beings, the median tick of 200,000 empty chunks must cost less than 2 times one of 1,000; a tick that processes 1,200 beings must cost less than 1.6 times per being one that processes 50; a context that counts the system's calls allows no `chunkKeys`, a write of the global value only when the occupancy index grows or the day turns, and per tick at most each listed chunk, the chunks each decision senses, five reads per wake, and the daily prune's reads |
| Race conditions, other performance regressions | None yet | Review checklist, plus the determinism, recovery, and load tests of T2, T3, T6, T7, and T10, and the engine, worldgen, and beings benchmarks |

See [ADR 0015](docs/decisions/0015-automated-quality-gates.md) for the tool choices and thresholds.

## Honest reporting

- Never claim a test, build, or check ran unless it ran; report the command and the observed result.
- Separate observed results from assumptions and estimates; say "unverified" when you could not
  check something.
- Do not finish significant work while a blocking error remains; report it instead.
- Keep code, tests, documentation, and ADRs consistent; a change to an architectural rule adds or
  supersedes an ADR in the same pull request.

## Secrets and safety

- Never commit, log, print, or send secrets to a client, prompt, or snapshot. `.env*` files are
  ignored; only `.env.example` is versioned. Do not name credentials in public documents.
- Never deploy, activate paid services, or create cloud resources without explicit maintainer
  authorization.
- This repository is public: everything pushed is public.
- Telemetry stays off: `bunfig.toml` turns off Bun's crash reports, and a new tool that sends usage
  data is adopted only with its telemetry turned off in a versioned file (ADR 0018).
- Write invisible or bidirectional control characters only as escapes; `tests/repo/hygiene.test.ts`
  rejects them in text files.

## Workflow

- Work in batches ("tandas") from `docs/roadmap/v0.1-tracker.md`. Each pull request has its own
  branch; a batch ships as one pull request or a chain of them. Never commit directly to `main`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`), small and
  descriptive. Commit messages carry no AI attribution trailers (such as `Co-Authored-By`).
- Pull requests are merged with a merge commit (no squash, no rebase-merge), parent first in stacked
  PRs, using GitHub's default merge message (never the PR body); see
  [ADR 0012](docs/decisions/0012-branching-commits-and-pull-requests.md). A ruleset on `main`
  enforces the pull request, the merge method, and a green CI check
  ([ADR 0016](docs/decisions/0016-github-repository-baseline.md)). Merged branches are deleted and
  GitHub retargets the child of a stacked PR; close and reopen it if its CI does not run.
- Push and open pull requests with a user-authenticated token. In T1, pushes and pull requests made
  with a Codespace's built-in credentials did not start GitHub Actions workflows.
- The maintainer delegated delivery decisions (tracker L26), so the agent pushes, opens pull
  requests, and merges without asking. A pull request is merged only when:
  - CI is green on its head;
  - independent verification and native review left no open blocker;
  - its diff holds only its own commits.

  Report each merge with its evidence. Deployments, paid services, and cloud resources still need
  explicit authorization ([ADR 0012](docs/decisions/0012-branching-commits-and-pull-requests.md)).
- The maintainer's standing consent (tracker L28) covers only starting the native review of a
  candidate: answer every native review consent prompt by running the provider-issued `granted`
  invocation unchanged, never `declined`, and report that consent was granted under this
  instruction. It never approves the change, never skips verification, and never authorizes
  delivery: a merge still needs every condition of the bullet above.
- Tests and docs ship with the behavior they cover.

## Documentation map

| Path | Content | Language |
|---|---|---|
| `docs/vision/master-vision.es.md` | Original master vision, verbatim | Spanish |
| `docs/roadmap/v0.1-plan.es.md` | Approved v0.1 plan, verbatim | Spanish |
| `docs/roadmap/v0.1-tracker.md` | Batch tracker: specs, tasks, log | Spanish |
| `docs/decisions/` | Architecture Decision Records | English |
| `docs/architecture/` | Technical architecture | English |

Code, identifiers, comments, commit messages, ADRs, and technical docs are written in English.
