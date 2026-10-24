# 0003. Authoritative deterministic engine with a runtime-agnostic core

- Status: Accepted
- Date: 2026-10-24

## Context

The engine is the only source of truth for the universe. Replays, crash recovery, observer
invariance tests, and scientific reproducibility all require that the same snapshot and the same
commands produce the same state, bit for bit. ECMA-262 leaves `sin`, `cos`, `exp`, and `pow`/`**`
"implementation-approximated", while `+ - * /` and `sqrt` are correctly rounded under IEEE 754
(plan §D). LLM providers are not deterministic, even at temperature 0 (plan §C, risk 7).

## Decision

We will build an authoritative, deterministic engine with a pure core (plan §E.1, §I.1).

- **P1 Hexagonal + screaming architecture.** Pure core; Bun, Postgres, WebSocket, and LLMs are
  adapters. Folders name the domain.
- **P2 Fixed-step engine.** `step(state, inputs) → { state', events, checksum }`. The engine owns
  all state, body and mind (§E.3).
- **P5 Runtime-agnostic core.** `engine` and `agents` use no Bun, `node:*`, DOM, `Math.random`,
  `Date`, `crypto.randomUUID`, or transcendental functions. Lint and a test will enforce it from
  T2.
- **P6 Chunked state** from day one, with a hash per chunk.
- **P7 Everything versioned** (see below).

| Area | Rule (plan §I.1) |
|---|---|
| Time | Integer ticks only; calendar, day/night, and seasons derive from the tick |
| PRNG | Counter-based `mix32(seed, stream, tick, entityId, n)`, integer-only. Snapshot holds `{ algorithm: "ctr-mix32@1", seed: [u32, u32], counters: Record<stream, u32> }`. The seed is C3 |
| Ordering | Fixed system pipeline in the ruleset; entities by ascending `EntityId` from a snapshot counter; commands by `(applyTick, seq)`; conflicts by deterministic permutation `rand(seed, "conflict", tick, resourceId)`; no iteration over `Map`/`Set` or construction-ordered objects |
| Numbers | Safe integers (`Number.isSafeInteger(x)` is true, i.e. \|x\| ≤ 2^53 − 1), NFC strings, booleans, arrays, plain records. No `NaN`, `Infinity`, `-0`, or floats; fixed point for continuous quantities. The serializer rejects anything else |
| Serialization | In-house canonical serializer inspired by RFC 8785: sorted keys, no `undefined`, integers only, UTF-8 |
| Hashing | Per-tick non-cryptographic hash in pure TypeScript, composed per chunk (hash tree); snapshot hash SHA-256 via WebCrypto |
| Versioning | Snapshot header `snapshotSchemaVersion`, `engineVersion`, `rulesetVersion`, `generatorVersion`, `brainVersion`; each AI decision adds `promptTemplateVersion` and `modelId`; pure `vN → vN+1` migrations; a version change opens a new epoch; no replay across versions |
| Concurrency | Single writer per world: single-threaded engine plus a Postgres advisory lock per `world_id`. Async inputs are serialized on arrival with `(applyTick, seq)` |
| Think time | A request made at tick `t` applies exactly at `t + k`; after `t + k + grace` it is discarded, logged as a timeout, and the inhabitant continues with its deterministic policy |

Erratum: plan §I.1.4 writes the bound as "≤ 2^53"; 2^53 is not a safe integer, so the bound is
2^53 − 1, as corrected here.

Reproducibility levels: **N1 core** bit-for-bit replay from snapshot + log, to be guaranteed and
tested from T2; **N2 model decisions** not reproducible live, reproducible from the log because
outputs are recorded; **N3 re-run experiments with models** statistical reproducibility over seeds.

Tests (§I.1.8): golden replay, snapshot round trip, replay across restarts, command fuzz, observer
invariance ([0005](0005-observer-independence.md)), purity lint and import test, and, in the
future, cross-runtime (V8 headless or workerd).

**Adopted defaults (2026-10-24), configurable.** The plan marked these parameters [D]; they are
now defaults adopted under the maintainer's delegation of technical decisions
([tracker](../roadmap/v0.1-tracker.md) L11, L12), revisited with measurements in the batch that
implements each one (plan §M).

| Parameter | Adopted default | Plan |
|---|---|---|
| PRNG | Counter-based `ctr-mix32@1` | §I.1.2, O-9 |
| Time | `TICK_RATE_HZ=5`, `SIM_SECONDS_PER_TICK=12`, so R = 60 simulated days per real day | §I.1.1, O-10 |
| Think time | `k` = 25 ticks (5 simulated minutes) plus a grace of 25 ticks | §I.1.7, O-11 |

## Consequences

- Recovery, observer invariance, and audits can compare hashes instead of trusting logs.
- Adding a system or an entity does not shift other random sequences; regions can be processed
  separately later.
- Provider latency does not change behavior while it stays within the margin.
- Physics and maths in the core are restricted to integer and correctly rounded operations.
- T2 delivers the core and its tests; acceptance criteria 6 and 14 in plan §N verify it.

## Alternatives considered

- Wall-clock time or unseeded randomness in the core: breaks replay; replaced by integer ticks and
  a counter-based PRNG (plan §E.5).
- Unpartitioned global state: compromises scalability; replaced by per-chunk state with a hash per
  chunk (plan §E.5).
- Random IDs: not reproducible; replaced by an ID counter stored in the snapshot (plan §E.5).
- A synchronous LLM call inside the tick: see
  [0004](0004-ai-proposes-engine-decides.md#alternatives-considered).
- An ECS: premature for v0.1 (plan §D.2).
- Rapier 2D physics: deferred; only `rapier2d-deterministic` guarantees cross-platform determinism,
  and bundling with Bun is unverified (plan §D, §D.2, O-6).

## References

- Plan: P1, P2, P5, P6, P7 (§E.1), §E.3, §E.5, §I.1, O-9, O-10, O-11, §M, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L11, L12.
- RFC 8785, JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
