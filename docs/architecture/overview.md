# Architecture overview

Open Origin is a persistent universe where an authoritative, deterministic engine is the only
source of truth. AI models only **propose** intentions; the engine validates, applies, records, and
attributes them. This page maps the components, their dependency rule, and where each decision is
recorded. Source: the approved plan `docs/roadmap/v0.1-plan.es.md` (revision 3), §A, §E, §F, §G.

> **The engine is reality. AI is only one of the ways to decide inside it.**
> An LLM never writes state: it proposes; the engine validates, executes, records, and attributes.

## Three systems with strict boundaries

| System | What it is (plan §A) |
|---|---|
| Authoritative universe | Clock, laws, terrain, biology, ecology. Deterministic, persistent, versioned. Advances regardless of who watches |
| Society of minds | Inhabitants with identity, memory, beliefs with provenance, relationships, and goals. Most behavior is cheap and deterministic; LLM reasoning is a scarce resource allocated by internal world rules, never by human attention |
| Window for humans | Spectators (and later players) see filtered projections of the state and act only through valid in-world actions |

## Principles

| # | Principle (plan §E.1) | ADR |
|---|---|---|
| P1 | Hexagonal + screaming architecture: pure core; Bun, Postgres, WebSocket, and LLMs are adapters | [0003](../decisions/0003-authoritative-deterministic-engine.md) |
| P2 | Deterministic authoritative engine: `step(state, inputs) → { state', events, checksum }` at a fixed step | [0003](../decisions/0003-authoritative-deterministic-engine.md) |
| P3 | AI proposes, the engine decides | [0004](../decisions/0004-ai-proposes-engine-decides.md) |
| P4 | Epistemological separation: global state ≠ perception ≠ memory ≠ prompt | [0006](../decisions/0006-provenance-and-inheritable-contamination-taints.md) |
| P5 | Runtime-agnostic core: no Bun, `node:*`, DOM, `Math.random`, `Date`, `crypto.randomUUID`, or transcendental functions in `engine` and `agents` | [0003](../decisions/0003-authoritative-deterministic-engine.md) |
| P6 | State partitioned by chunks from day one | [0003](../decisions/0003-authoritative-deterministic-engine.md) |
| P7 | Everything versioned | [0003](../decisions/0003-authoritative-deterministic-engine.md) |
| P8 | Graceful degradation: with zero AI providers, the world works completely | [0004](../decisions/0004-ai-proposes-engine-decides.md) |
| P9 | Observer independence | [0005](../decisions/0005-observer-independence.md) |
| P10 | Audience projections: clients receive only allowlisted DTOs | [0008](../decisions/0008-data-classification-and-audience-projections.md) |
| P11 | Two interfaces, two planes, two bundles | [0009](../decisions/0009-public-and-private-admin-interfaces.md) |

## Dependency rule

From plan §E.2:

```
engine      → (nothing)
agents      → engine
protocol    → (nothing)          own DTOs per audience
ai-gateway  → (nothing from the domain)
server      → engine, agents, protocol, ai-gateway
web         → protocol
```

- Extra rule, enforced by lint from the batch that creates both modules: the server's cognitive
  allocation module cannot import the WebSocket subscriptions module.
- The engine owns all state, body and mind; `agents` contributes pure policies and prompt logic
  (§E.3). There is one snapshot and one source of truth.
- §E.2 predates the two-interface decision and does not list `apps/admin` or `packages/ui`. What
  §E.6 states: `protocol` has `public` and `admin` audiences; `packages/ui` holds presentational
  components (props, no fetch) shared by both apps, and data containers live in each app.
- `packages/protocol` exposes a public and an admin entry point; which app may import which is
  decided in [0009](../decisions/0009-public-and-private-admin-interfaces.md#decision).

## World plane and presentation plane

| Plane | Contains | May depend on who watches |
|---|---|---|
| World | Tick scheduler, cognitive allocator, persistence, `engine`, `agents`, `ai-gateway` | **No.** Nothing crosses the P9 boundary downward |
| Presentation | WebSocket gateway (interest, send rates, level of detail), audience projections, observation telemetry (C3) | Yes, but it never writes to the world |

Details: [0005. Observer independence](../decisions/0005-observer-independence.md).

## Flow of an AI decision

1. An **internal** world trigger (sleep, conversation, novelty, repeated failure) raises an L3
   deliberation; L0–L2 run every tick without an LLM (§K.2).
2. The cognitive allocator, fed only world data, queues the request by trigger tick with a
   deterministic tie-break, within the world's budget: an equal daily share C/N per inhabitant plus
   a common pool for high internal salience (§J.5; adopted default 2026-10-24, configurable,
   [0004](../decisions/0004-ai-proposes-engine-decides.md)).
3. `ai-gateway` checks the AI mode (`off` by default), the allowlist, the token and request buckets,
   and the spend reservation (§J.4). In `off`, L3 falls back to L1–L2.
4. The prompt is built only from the inhabitant's perception and memory (§K.4). The model answers
   JSON validated against `{ thought?, proposals: [...] }` (§K.5).
5. The proposals become commands with an `idempotency_key` and `(applyTick, seq)`, applied exactly
   at `t + k` (adopted default `k` = 25 ticks plus 25 ticks of grace,
   [0003](../decisions/0003-authoritative-deterministic-engine.md)). A response after
   `t + k + grace` is discarded and logged as a timeout; the inhabitant
   continues with its deterministic policy (§I.1.7, §I.2.3).
6. The engine checks preconditions, technical capability, and the ethical action catalog. A
   rejection becomes the inhabitant's experience (§K.5).
7. A context manifest (memory and perception IDs, template version, model, prompt hash, raw output)
   is recorded with the decision, and the result is persisted in the next tick batch (§K.5, §I.2).

## Component diagram

Adapted from plan §F and §E.6.

```
Browsers
  apps/web    public, C0           React UI + PixiJS only for the universe
  apps/admin  private, C0/C1/C3    React · 127.0.0.1 + token
      ▲ audience DTOs (hello / snapshot / delta)        │ subscribe / follow
      │                                                 ▼
apps/server (Bun)
  PRESENTATION PLANE (may depend on who watches)
    WS gateway: interest, send rates, LOD
    Audience projections · observation telemetry (C3)
  ════════════ P9 boundary: nothing crosses downward ════════════
  WORLD PLANE (observer-independent)
    Tick scheduler (fixed step) ──step()──────────────────▶ packages/engine
    Cognitive allocator (world data only) ◀──requests───── packages/engine
    Cognitive allocator ──commands (applyTick, seq)───────▶ packages/engine
    Cognitive allocator ──calls───────────────────────────▶ packages/ai-gateway
    Persistence: batches, checkpoints, idempotency, lock ◀──batches── packages/engine
    packages/agents: policies, prompts (depends on engine); memory and provenance live in the engine's state
    packages/ai-gateway: modes off / mock / free-only / paid, caps
          │                                   │
          ▼                                   ▼
  PostgreSQL (Docker)              Providers (disabled by default) · Mock
```

The admin plane is a separate server listener with its own API and DTOs; its world-affecting
actions enter as audited commands with `admin` provenance. See [Interfaces](interfaces.md).

## Monorepo map

From plan §G. Each package is created in the batch that needs it; there are no empty folders.

| Path | Batch | Content |
|---|---|---|
| `apps/server/` | T6 | Public plane + admin plane (separate listeners) |
| `apps/web/` | T8 | Public interface (React + PixiJS) |
| `apps/admin/` | T8, T9 | Local admin panel; AI controls in T9 |
| `packages/ui/` | T8 | Design system: tokens + components (CSS Modules) |
| `packages/engine/` | T2, then T3, T4, T7 | T2: the deterministic kernel (canonical values, digests, randomness, ticks, the world, `step` and its fault model, versioned snapshots, purity gates), the determinism suite with its negative controls, and the benchmark ([determinism](determinism.md)). T3 adds worldgen in `src/worldgen` (space, the sealed genesis, terrain, the calendar, and primitive observables) and the ChaCha20 function terrain draws from: pure functions that rulesets call inside `step`, proven by a probe ruleset in the determinism suite ([0021](../decisions/0021-procedural-world.md)). T4 adds `src/beings`, a layer above worldgen with the body of the beings: needs and health in closed form, bounded senses, actions validated and executed, contests over food, the occupancy index, and sealed laws of life; its ruleset runs the suite with worldgen inside `step` ([0023](../decisions/0023-autonomous-beings.md), [beings](beings.md)). T5 adds `src/mind`, a pure layer of propositions, records, taints, salience, and forgetting that cannot read the world, and the ruleset `beings@2` beside `beings@1`, with perception, mental operations, relationships, and speech ([0024](../decisions/0024-mind-memory-beliefs-and-speech.md), [mind](mind.md)). T7 adds the migration chain of snapshot versions (plan §5.2) |
| `packages/agents/` | T4, T5 | T4: the deterministic brain behind the engine's controller port (Utility AI, Dijkstra and A*), a pure function of the senses the engine builds ([0023](../decisions/0023-autonomous-beings.md)); T5: the brain `mind@1`, which composes `utility@1` and proposes what to remember, believe, and say, and the templates of speech ([0024](../decisions/0024-mind-memory-beliefs-and-speech.md)); T9: prompts |
| `packages/protocol/` | T6 | DTOs per audience |
| `packages/ai-gateway/` | T9 | AI modes, allowlist, buckets, budget |
| `tests/` | T1, T6, T7 | T1: repository checks in `tests/repo/` (see `AGENTS.md`, Automated controls); T6: end-to-end synchronization and observer-invariance tests; T7: crash-recovery tests ([0019](../decisions/0019-end-to-end-testing-strategy.md)) |
| `docs/` | T1 | Vision, plan, tracker, ADRs, architecture; determinism spec in T2, persistence spec in T7 |
| `.github/workflows/ci.yml` | T1 | CI |
| `docker-compose.yml` | T7 | Local Postgres |

## Architecture decision records

| ADR | Decision |
|---|---|
| [0000](../decisions/0000-adr-template.md) | ADR template |
| [0001](../decisions/0001-record-architecture-decisions.md) | Record architecture decisions |
| [0002](../decisions/0002-bun-and-typescript-as-main-stack.md) | Bun and TypeScript as the main stack; Go only with reproducible benchmarks |
| [0003](../decisions/0003-authoritative-deterministic-engine.md) | Authoritative deterministic engine with a runtime-agnostic core |
| [0004](../decisions/0004-ai-proposes-engine-decides.md) | AI proposes, the engine decides; AI modes with `off` by default |
| [0005](../decisions/0005-observer-independence.md) | Observer independence |
| [0006](../decisions/0006-provenance-and-inheritable-contamination-taints.md) | Provenance and inheritable contamination taints instead of lexical blocking |
| [0007](../decisions/0007-persistence-atomic-tick-batches-and-recovery.md) | Persistence: atomic tick batches, checkpoints, idempotency, recovery targets |
| [0008](../decisions/0008-data-classification-and-audience-projections.md) | Data classification C0–C4 and audience projections |
| [0009](../decisions/0009-public-and-private-admin-interfaces.md) | Two interfaces: public `apps/web` and private `apps/admin` |
| [0010](../decisions/0010-ui-stack-react-vite-native-css.md) | UI stack: React, Vite, native CSS, in-house design system |
| [0011](../decisions/0011-language-of-artifacts.md) | Language of artifacts |
| [0012](../decisions/0012-branching-commits-and-pull-requests.md) | Branching, commits, and pull requests |
| [0013](../decisions/0013-defer-hosting-v0-1-runs-locally.md) | Hosting deferred; v0.1 runs locally only |
| [0014](../decisions/0014-keep-a-single-repository.md) | Single repository for the backend and the interfaces |
| [0015](../decisions/0015-automated-quality-gates.md) | Automated quality gates with Biome and oxlint |
| [0016](../decisions/0016-github-repository-baseline.md) | GitHub repository baseline (ruleset, security features, Dependabot) |
| [0017](../decisions/0017-no-webhooks-until-a-consumer-exists.md) | No webhooks until a consumer exists |
| [0018](../decisions/0018-telemetry-off.md) | Telemetry off for the tools the repository runs |
| [0019](../decisions/0019-end-to-end-testing-strategy.md) | End-to-end testing strategy: `bun test` for processes, Playwright from T8 |
| [0020](../decisions/0020-deterministic-core-design.md) | Deterministic core design: state ownership, failure model, 128-bit digests, counter-based randomness |
| [0021](../decisions/0021-procedural-world.md) | Procedural world: latent terrain, a sealed genesis, ChaCha20 for terrain, primitive observables |
| [0022](../decisions/0022-single-shared-public-universe.md) | A single public universe, shared and synchronized in real time: one clock, fixed speed, no time controls for users |
| [0023](../decisions/0023-autonomous-beings.md) | Autonomous beings: a body in the engine, a brain in `agents` that only proposes, decision points, exact time, sealed laws of life |
| [0024](../decisions/0024-mind-memory-beliefs-and-speech.md) | The mind: perception, memory that fades, beliefs with lineage and exposure taints, relationships, and speech by structured acts, in a parallel ruleset `beings@2` |

## Related

- [Determinism](determinism.md): the rules that make the engine reproducible, section by
  section as T2 implements them.
- [Worldgen](worldgen.md): space, the sealed genesis, noise, terrain, time, the observables, the
  probe ruleset that runs them inside `step`, their measured cost, and what the worldgen tests
  check ([0021](../decisions/0021-procedural-world.md)).
- [Beings](beings.md): the body, senses, brain port, tick, and the preregistration of T4's
  scenarios ([0023](../decisions/0023-autonomous-beings.md)).
- [Mind](mind.md): perception, memory, beliefs and their taints, relationships, speech, the tick
  of `beings@2`, and the preregistration of T5's scenarios
  ([0024](../decisions/0024-mind-memory-beliefs-and-speech.md)).
- [Interfaces](interfaces.md): planes, message flow, acceptance criteria, and roadmap of both
  interfaces.
- [Data classification](data-classification.md): access by interface, enforcement map, and tests
  for classes C0–C4.
