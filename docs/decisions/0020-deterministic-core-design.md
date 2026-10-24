# 0020. Deterministic core design: ownership, failures, digests, and randomness

- Status: Accepted
- Date: 2026-10-24

## Context

T2 builds `packages/engine`, the core that [0003](0003-authoritative-deterministic-engine.md)
specifies. Planning T2 surfaced decisions that ADR 0003 leaves open and three points where it
needs refinement ([tracker](../roadmap/v0.1-tracker.md) L22–L24):

- **PRNG state.** Plan §I.1.2 and ADR 0003 keep `counters: Record<stream, u32>` in the snapshot
  and also promise that adding an entity does not shift the random sequence of the others. With
  one counter shared by every entity of a stream, an extra draw by one entity shifts the draws of
  every entity processed after it. An independent review confirmed the contradiction.
- **Hashing.** ADR 0003 asks for a per-tick non-cryptographic hash composed per chunk as a hash
  tree, without fixing its width or its update cost. The maintainer asked for a comparison of
  64-bit or wider options before the snapshot format is frozen, and for a clear line between
  divergence detection and cryptographic integrity.
- **Ownership and failures.** `step(state, inputs) → { state', events, checksum }` (P2) does not
  say who may hold references to the state, or what happens when a system fails after it has
  changed part of the state. The maintainer asked for guarantees that hold at run time, not only
  in TypeScript, and that a partially changed state can never be continued, observed as valid, or
  saved.
- **Cost.** `AGENTS.md` requires that work per tick scales with active entities and chunks, never
  with the size of the world.

Measurements taken on 2026-10-24 with prototype code (Bun 1.4.4 on JavaScriptCore, a two-core
Codespace, one run each; indicative, not a benchmark of the final code):

| Measurement | Result |
|---|---|
| Hash throughput over 1 MiB | xxHash32 ≈ 1,900 MiB/s; MurmurHash3 x86_32 ≈ 1,480 MiB/s; MurmurHash3 x86_128 ≈ 1,495 MiB/s; FNV-1a 64 with `BigInt` ≈ 9 MiB/s |
| One dirty chunk of about 7 KB of canonical text | canonicalize and validate 68–110 µs; UTF-8 encoding 12 µs; 128-bit hash 4 µs; deep copy 37 µs |
| 10,000 field reads | plain objects 18–25 µs; frozen, sealed, or non-extensible arrays 220–290 µs |
| NFC check on every string | about 30% of the canonicalization cost; about 1% with a fast path for text below U+0300 |

## Decision

We will build the engine as a pure, synchronous kernel with an injected ruleset, with the rules
below. They refine ADR 0003 where noted; everything else in ADR 0003 stands.

**Kernel and ruleset.** The kernel provides time, randomness, ordering, commands, events,
canonical values, digests, and snapshots. A ruleset supplies systems (a fixed, ordered list),
command handlers, and validators for its global and chunk data. The host composes the ruleset and
passes it to the kernel, because `engine` depends on nothing while the deterministic policies of
`agents` must run inside the tick (plan §E.2).

**Ownership (refines P2).** `step` advances, in place, the world it owns; it never copies the
whole world per tick.

- Everything that enters the engine (the world definition, commands, decoded snapshots, the
  ruleset's lists) is validated and deep-copied once at the boundary. Only own data properties
  are copied; accessors are rejected. Everything that leaves it (views, chunks, events, step
  results, hashes) is a detached copy or a primitive. The host never holds a reference into the
  live state.
- `World` keeps its state in ES2022 private fields and is recognized with a brand check, so a
  forged object is rejected.
- Inside the tick, ruleset code gets live references for speed. `writeChunk` and `writeGlobal`
  mark data dirty; the context is revoked when `step` returns. The core has no `async`, no
  `Promise`, and no timers, and systems and handlers must return `undefined`, so ruleset code runs
  only inside `step`.
- A write that bypasses the barrier is detected, not prevented: every tick in `audit` mode
  (tests), and on every snapshot encoding in production, which recomputes every digest and refuses
  to produce a snapshot whose state disagrees with its incremental checksums.

**Failures.** All inputs are validated and copied before anything changes, so an invalid input
fails with `invalid_input` and leaves the world byte-for-byte unchanged. A failure after the first
change (a handler or system that throws, a non-canonical value, a broken ruleset invariant, an
exhausted counter) poisons the world: it can no longer step, be read, be hashed, or be encoded, the
events of that tick are discarded, and only its status remains readable. Recovery starts from the
last snapshot. Ruleset validators run on every commit over the dirty data, so a broken invariant
fails at the tick that broke it.

**Cost.** The kernel's work per tick is O(K + E + D log D + B + C): commands with their payloads,
events, dirty chunks (sorted for output), canonical bytes of dirty data, and created chunks. No
per-tick step depends on the number of chunks N. The sorted chunk index is lazy: creating a chunk
is amortized O(1), and the sorted list is materialized only when a caller asks for all keys.
Encoding and decoding snapshots and full checksums are O(N), and run only at checkpoints, on load,
or for audits. A ruleset system that iterates every chunk each tick is O(N) by its own choice;
T4 adds an activity index based on world data only ([0005](0005-observer-independence.md)).

**Digests (refines hashing).** Divergence detection and integrity are separate mechanisms.

| Purpose | Threat model | Mechanism |
|---|---|---|
| Divergence detection: replay, recovery, observer invariance, replicas | Accidental: bugs and non-determinism | 128-bit MurmurHash3 x86_128 over the UTF-8 bytes of canonical text, inside the core, every tick |
| Snapshot integrity | Corruption and tampering | SHA-256 via WebCrypto over the snapshot bytes, in the adapter |
| Authenticity (who wrote a snapshot) | An attacker with write access | Not provided in v0.1 |

- Every digest hashes a canonical array that starts with a domain tag. A chunk contributes the
  term `digest(["chunk", key, chunk])`. The chunk terms are summed modulo 2^128 in four 32-bit
  lanes with carry. `stateRoot = digest(["state", kernelDigest, globalDigest, chunkSum,
  chunkCount])`. The tick checksum is `digest(["tick", stateRoot, digest(["events", events])])`,
  so it covers what the tick emitted as well as the state.
- The sum is updated in O(dirty), does not depend on creation order, and composes by region: the
  root of a partitioned world is the sum of its regions' sums, with no global order.
- MurmurHash3 is not cryptographic (multicollisions can be constructed on purpose); integrity
  against tampering is SHA-256's job.

**Randomness (refines the PRNG row).** `ctr-mix32@1` is MurmurHash3 x86_32 over the 32-bit words
`[s1, stream, length(key), ...key, n]` with seed `s0`, where `[s0, s1]` is the world seed.

- Per-tick draws use the key `[tickLo, tickHi, entityLo, entityHi]`. The general key lets T3 draw
  per chunk without a tick, so a chunk generates identically whenever it is generated.
- `n` is a transient counter per `(stream, entity)` that restarts every tick. Snapshots exist only
  between ticks, so the RNG state in a snapshot is `{ algorithm: "ctr-mix32@1", seed }`; the
  `counters` field of ADR 0003 is dropped.
- Each system or handler declares its streams. A stream id is MurmurHash3 x86_32 of its name;
  colliding ids, streams shared by two owners, and the reserved `engine.` prefix are rejected when
  the ruleset is validated, and drawing from an undeclared stream is a fault.
- Bounded integers use rejection sampling (bounds 1 to 2^32), each retry consuming the next `n`.
  The conflict permutation of plan §I.1.3 is a Fisher–Yates shuffle over the caller's own stream,
  keyed by the resource id.

**Canonical values.** Safe integers without `-0`, strings, booleans, dense arrays, and plain
records; no `null`. Strings and record keys must be well formed and in NFC: the core validates and
never normalizes. The key `__proto__` is rejected, cycles are rejected, nesting depth is at most 64, and a command
payload is at most 8 KiB. The text form is the subset of RFC 8785 these values need: keys sorted by
UTF-16 code units, integers in decimal, strings escaped as `JSON.stringify` does, no whitespace.
The parser accepts exactly the canonical texts: it parses, validates, re-serializes, and requires
an identical result. The core encodes UTF-8 itself; adapters decode with a fatal `TextDecoder`.

**Snapshots.** Version 1 is `{ header: { snapshotSchemaVersion: 1, engineVersion,
rulesetVersion, generatorVersion, brainVersion }, stateRoot, world: { epoch, tick, nextEntityId,
rng, config: { simSecondsPerTick }, global, chunks } }`.

- Decoding checks the schema: a supported version, exactly the expected keys, and a `stateRoot`
  equal to the recomputed one.
- Stepping checks replay compatibility: the header must equal the running engine and ruleset
  versions, and every difference is reported. A snapshot from another version can therefore be
  loaded, but not replayed.
- `epoch` is part of version 1. Opening an epoch (after an upgrade or an experimental change,
  [0009](0009-public-and-private-admin-interfaces.md)) ships with T7 and T8, and the `vN → vN+1`
  migration chain with the first version 2. A frozen version 1 fixture must keep loading.
- The world id is host metadata, not engine state, so replicas of a world can be compared.
- The engine snapshot holds the seed and is therefore C3 as a whole
  ([0008](0008-data-classification-and-audience-projections.md)).

**Time.** The engine knows only ticks; `simSecondsPerTick` is world configuration inside the hashed
state. `TICK_RATE_HZ` paces real time, so it belongs to the scheduler (T6). The calendar waits for
the batch that defines the length of a day, an internal law (plan O-13).

**Determinism rules enforced by tools.** In `packages/engine/src`:

- the type library is ES2024 without host types;
- Biome denies host and non-deterministic globals (among them `Reflect` and `JSON`, which
  enumerate or serialize keys in insertion order), Node modules, `console`, `process`, `eval`,
  `for…in`, and non-relative imports;
- GritQL plugins deny `**`, `async`/`await`, locale-dependent methods, own-key enumeration
  (`Object.keys`, `values`, `entries`, `getOwnPropertyNames`, `getOwnPropertySymbols`,
  `getOwnPropertyDescriptors`) outside the ordering helper, binding or destructuring `Object`,
  and `.constructor`, which reaches the `Function` constructor;
- `Math` is allowed only in the integer helper module, `JSON` only in the canonical encoder, and
  `Map`/`Set` only in listed modules; each exception is a reviewed override in `biome.json`;
- a repository test rejects reference directives, every `declare` declaration (a local
  `declare const Bun` would bypass both the type library and the global rules), declaration
  files, imports that leave `src`, Biome suppression comments, and `@ts-ignore`,
  `@ts-expect-error`, or `@ts-nocheck`.

Each rule has a fixture that proves it rejects.

## Consequences

- The host cannot change the universe through any value it gave or received.
- Inside the tick, isolation is checked rather than prevented, because JavaScript has no cheap
  immutability: freezing made later reads 10–14 times slower in the measurements above. Rulesets
  in T3–T5 must pass the determinism suite with `audit` on.
- A failed tick never leaves a readable, steppable, or encodable partial state. A failed world
  cannot be inspected in memory; it is diagnosed from its status and the last snapshot.
- Per-tick cost tracks what changed. Full snapshots stay O(N) and become impractical at very large
  scale; T7's incremental checkpoints build on the per-tick list of changed chunks.
- Accidental collisions stop being a practical concern (about 2^-128 per divergent comparison). The
  128-bit width costs the same as 32 bits in the measurements and 16 bytes per chunk in the cache.
- MurmurHash3 x86_128 is less common in other languages than its x64 variant; a port (for example
  the Go comparison allowed by [0002](0002-bun-and-typescript-as-main-stack.md)) follows the public
  reference.
- The additive root cannot bisect a remote divergence in O(log N); local diagnosis compares
  per-chunk digests (O(N), on demand), and region sums cover distribution later.
- Revisit:
  - when the benchmark shows serialization limiting a batch: stream canonical bytes straight into
    the hash, which does not change the format;
  - in T4: the activity index;
  - in T7: idempotency keys, which need snapshot version 2 and a migration, epoch opening, and
    incremental checkpoints.

## Alternatives considered

- **Deep-freezing the state** for runtime immutability. Rejected: reads of frozen, sealed, or
  non-extensible arrays were 10–14 times slower on JavaScriptCore.
- **Read-only `Proxy` views.** Rejected: a trap on every property access in the hottest path.
- **Copy-on-write chunks**, which keep the previous tick valid after a failure. Rejected: a copy per
  dirty chunk every tick (about 37 µs per 7 KB) for the same guarantee that poisoning gives. The
  last snapshot already preserves the previous state.
- **Copying the whole world per tick.** Rejected: O(N) per tick.
- **A persisted counter per stream** (ADR 0003 as written). Rejected for the contradiction in the
  Context.
- **32-bit checksums (xxHash32, MurmurHash3 x86_32).** Rejected: about 2^-32 per divergent
  comparison is thin for a scientific record that runs for years, and 128 bits cost the same.
- **Two seeded xxHash32 values, or XXH64 emulated with 16-bit limbs.** Rejected: the two values are
  not independent, and the emulation is about four times slower.
- **`BigInt` 64-bit hashes.** Rejected: about 160 times slower.
- **SHA-256 every tick.** Rejected: WebCrypto is asynchronous and not ECMAScript, a pure-JavaScript
  SHA-256 is slower, and accidental divergence does not need cryptographic strength.
- **A Merkle tree over sorted chunk keys.** Rejected for v0.1: it needs a global order, its updates
  cost O(log N) each, and it does not compose by region. It would allow remote O(log N) bisection.
- **A binary canonical format such as CBOR.** Rejected: text is readable, matches the RFC 8785
  inspiration of ADR 0003, and costs only size.
- **A property-testing library (fast-check).** Rejected: plan §M adds no dependencies in T2; a small
  seeded generator covers the fuzz tests.

## References

- [0003. Authoritative deterministic engine](0003-authoritative-deterministic-engine.md), refined
  here.
- [0004](0004-ai-proposes-engine-decides.md), [0005](0005-observer-independence.md),
  [0007](0007-persistence-atomic-tick-batches-and-recovery.md),
  [0008](0008-data-classification-and-audience-projections.md),
  [0009](0009-public-and-private-admin-interfaces.md),
  [0015](0015-automated-quality-gates.md).
- Plan `docs/roadmap/v0.1-plan.es.md`: §E.2, §E.5, §I.1, §M, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: S13, S14, L22–L24.
- RFC 8785, JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
- MurmurHash3 reference implementation (SMHasher):
  https://github.com/aappleby/smhasher/blob/master/src/MurmurHash3.cpp
- ECMA-262, `Array.prototype.sort` and consistent comparators:
  https://tc39.es/ecma262/#sec-array.prototype.sort
