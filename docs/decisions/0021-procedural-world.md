# 0021. Procedural world: latent terrain, a sealed genesis, and primitive observables

- Status: Accepted
- Date: 2026-10-25

## Context

T3 builds the world (plan §M): "Generación por chunks con semilla y versión de generador;
observables primitivos", with golden chunk hashes per seed (§N.5), day and night (§L), and no new
dependencies. [overview](../architecture/overview.md) places worldgen and the calendar inside
`packages/engine`, and [0020](0020-deterministic-core-design.md) left the calendar to the batch
that defines the length of a day, an internal law (plan O-13). The maintainer confirmed O-13
(non-terrestrial laws by default) on 2026-10-25 ([tracker](../roadmap/v0.1-tracker.md) L35).

The forces:

- **Observer independence** ([0005](0005-observer-independence.md)). Generating terrain on demand
  must not let a viewer, a cache, or the order of requests change the world.
- **Classification** ([0008](0008-data-classification-and-audience-projections.md)). Terrain of
  subscribed chunks is C0; seeds and law parameters are C3.
- **Laws as versioned data** (plan §K.8, [0006](0006-provenance-and-inheritable-contamination-taints.md)),
  non-terrestrial so that an inhabitant predicting Earth behavior reveals prior knowledge.
- **Cost per tick** ([0020](0020-deterministic-core-design.md)): work grows with what changes,
  never with the size of the world.

Evidence gathered while planning (tracker L36; Bun 1.4.4 on the two-core Codespace, indicative):

- **`ctr-mix32@1` hides nothing from its outputs.** It folds the seed `[s0, s1]` into one 32-bit
  state, and every later step of MurmurHash3 x86_32 can be undone. One draw whose stream, key, and
  counter are known gives back that state, which predicts every draw of every stream; this was
  reproduced three times independently. A quantized draw takes a search over 2^32 states, and a seed
  derived from the world seed inherits the same 32 bits. Terrain is the first output of randomness
  that becomes public, so it cannot come from the world seed.
- **The tick cannot read a seed or the length of a tick.** `ReadView` and `TickContext` expose the
  tick, the chunks, the global value, and per-tick draws. Inside `step`, `ctx.tick` is the tick being
  computed, and the kernel runs `validateGlobal` at creation, at decoding, and at every commit that
  wrote the global value.
- **Costs.** A ChaCha20 block costs 112.3 ns and a ChaCha12 block 74.8 ns with the same
  implementation; six octaves of integer gradient noise cost 0.14–0.24 ms per field for a chunk of
  32×32 cells. Canonical `number[]` fields retain up to 88 KB per chunk and take 2.9 ms to digest as
  canonical text; typed arrays retain about 44 KB and digest as words in about 30 µs.
- **Integer pitfalls.** `|0`, `>>`, and `imul` overflow in the fade, in interpolation, and at the
  upper edge of the world, and a fixed-point fade written naively is not monotonic. Both were
  measured by an independent reviewer.

## Decision

We will build the world as a latent field that the engine evaluates and never stores, with the
following rules.

**Latent world, sparse materialization.** Base terrain is a pure function of the generator version,
the genesis, and the cell. It never enters the engine state. The state holds only materialized
chunks, whose values stay small (changes and occupants, defined from T4), so a dirty chunk never
rehashes terrain. A chunk is materialized only inside `step`, by a cause inside the world: world data
or a command. Reading, displaying, generating, or caching terrain never materializes a chunk.

**Space.** A chunk has 32×32 cells, indexed `y·32 + x`. Cells lie in [−2^31, 2^31 − 1] and chunks
in [−2^26, 2^26 − 1]. A ruleset that uses worldgen rejects a chunk key outside these bounds in
`check`, as a rejection, never as a fault that poisons the world. Kernel chunk keys stay any safe
integers.

**Genesis, sealed.** The world's global value holds `genesis` and `genesisSeal`:

- `genesis` has the terrain seed (eight u32 words that the host draws from a CSPRNG), the laws (day,
  liquid, thermal, radiance), and the terrain parameters (relief, substrate, deposits). Each
  parameter has bounds that keep every intermediate value a safe integer; the bounds table lives in
  the worldgen specification.
- `genesisSeal = digest(["genesis", WORLDGEN_VERSION, genesis])`. Every ruleset that uses worldgen
  calls `sealedGenesisIssues` from `validateGlobal`, which checks the schema, the bounds, and the seal.
- The genesis is written once. Changing laws means a new world or a new epoch
  ([0009](0009-public-and-private-admin-interfaces.md)). What each path gives:

| Path | Result |
|---|---|
| Ruleset code changes the genesis through `writeGlobal` | The commit of that tick fails with an issue at the seal; the world is poisoned and nothing is saved |
| Ruleset code changes it through a live read, behind the barrier | Audit finds it at that tick in tests; in production `encodeSnapshot` refuses the snapshot, and the next commit that writes the global value fails at the seal |
| A snapshot with an edited genesis and its old seal | `decodeSnapshot` fails with `invalid_snapshot` |
| The host | It holds no reference to the state ([0020](0020-deterministic-core-design.md)) |
| Ruleset code that also recomputes the seal | Not prevented: ruleset code is trusted, so this is outside the threat model |

The issue sits at `/genesisSeal` of the global value, under the prefix the kernel adds to every
validator issue: `/init/global` at creation, `/global` at a commit, and `/world/global` at
decoding. The check costs one digest of the genesis on ticks that write the global value, and
nothing on the others; it never depends on the number of chunks.

**Randomness for terrain.** Terrain never draws from `ctr-mix32@1`, nor from anything derived from
the world seed. It uses the ChaCha20 block function of RFC 8439, with 20 fixed rounds, keyed by the
terrain seed, in `src/rng/chacha.ts`. Each input names its field, octave, and lattice coordinates, so
no two uses share a block. What this gives, and what it does not:

- **Determinism.** The same seed and input give the same words on every ECMAScript engine, because
  the block uses only 32-bit addition, xor, and rotation, which ECMA-262 defines exactly. This does
  not depend on the number of rounds.
- **Unpredictability.** Without the terrain seed, lattice values nobody observed cannot be computed
  from observed ones, under the standard assumption that ChaCha20 is a pseudorandom function with a
  256-bit key. Public cryptanalysis supports that assumption; nothing proves it.
- **Generator security.** It depends on more than the function. The terrain seed must stay secret:
  the host draws it from a CSPRNG, it is C3, and it is never projected. And no two uses may share an
  input. Even then, observed terrain reveals the dominant shape within the coarsest lattice cell it
  touches, without breaking ChaCha20. Nothing here protects against someone with C3 access, makes
  observed terrain secret, or replaces the kernel's randomness.

**Noise.** Terrain uses 2D gradient noise summed over octaves (fBm). It computes with safe-integer
doubles, uses `floorDiv` and `floorMod` from `int.ts`, and uses a monotonic Horner fade. Values become
u32 words only at the input of the pseudorandom function. Substrate comes from Voronoi regions, each
with a class drawn by weights from the genesis. One function, `sampleRegion`, evaluates any
rectangle of cells up to a bounded size, with a lattice cache. A chunk is a 32×32 region and a cell a
1×1 region, so the equalities between them test both the cache and continuity.

**Permanent and temporal layers.**

| Layer | Content | Depends on |
|---|---|---|
| Permanent, primary | `elevation`, `substrate`, `thermalBase`, `deposits` | generator version, genesis, cell |
| Permanent, derived | `liquid.depth` | generator version, genesis, cell |
| Temporal | `radiance`, `diurnal`, day, phase | generator version, laws, instant |

- A generated chunk holds only the primary permanent fields, in typed arrays.
- `terrainDigest` hashes them with MurmurHash3 x86_128, over a documented word layout. The digest
  leaves out the seed and never depends on time.
- `observe(prepared, { id, cell, instant })` requires an instant for every observable. A temporal
  observable equals its permanent part plus its temporal part, as `thermal = thermalBase + diurnal`.
- An instant is a tick and the seconds per tick; its simulated second is their product, the kernel's
  `simSeconds`. Inside the `step` that computes tick T, the instant is `{ tick: ctx.tick,
  simSecondsPerTick: ctx.simSecondsPerTick }`, so a measurement taken inside tick T equals one taken
  outside at tick T.
- Three sets of golden values stay separate:
  - terrain covers the permanent layer only and does not depend on the instant;
  - time does not depend on the terrain seed;
  - observation covers pairs of a cell and an instant, so it spans both layers.
- `timeLawIssues(laws, simSecondsPerTick)` requires a day of at least 16 ticks, so every day has at
  least 16 distinct phases. `validateGlobal` cannot run it, because it sees only the global value,
  so the host that creates a world calls it before `createWorld`. Decoding does not repeat it: both
  values are immutable, and they were checked together at creation.

**Four layers of information.** What the engine computes, what can be observed, what an inhabitant
knows, and what only operators see stay apart:

| Layer | What it is | Where it lives | Class |
|---|---|---|---|
| Internal reality | The genesis, the latent fields, the materialized state | the kernel and worldgen | C3 for the genesis; visible parts reach C0 only through projections |
| Observable data | Quantities with a unit, range, version, and exposure | the worldgen catalog | T6 decides each projection |
| Knowledge | What an inhabitant believes, with its provenance | T5 | C1 |
| Administration and research | The genesis, complete fields, human labels, reference truth | the admin and research planes (T6, T8) | C3 |

**Primitive observables.** `elevation`, `liquid.depth`, `substrate`, `thermal`, `radiance`, and
`deposit.<k>`. A catalog records each one's dimension, unit, kind, range, whether it varies with
time, and its exposure (surface or measurement). Units are the world's own: `len`, `tu`, `ru`, and
`qu`. Identifiers, units, and labels are engineering names: perception never passes them into a
prompt (plan §K.4, §K.7).

**Laws.** Defaults are non-terrestrial (O-13), and each form is chosen for a reason:

- the day is not 86,400 s long;
- liquid fills up to one equipotential level, which any fluid under uniform gravity does;
- thermal level rises with elevation: the simplest discoverable relation, with its sign chosen
  against Earth;
- the diurnal term follows radiance, and radiance follows a smooth day curve with a night floor.

**Versioning.** `generatorVersion` is `"worldgen@1"`. It covers terrain, the calendar, the
observables, and the genesis schema, and it is frozen with its golden values when T3 closes. After
that, any different output for any input, or any new law, needs `worldgen@2` and new golden values.
The code of a version stays as long as a world uses it. A ruleset declares
`versions.generator = WORLDGEN_VERSION`. `ENGINE_VERSION` does not change, because no kernel output
changes.

**Kernel additions.** None of them changes an output:

- `ReadView.simSecondsPerTick`, an added member;
- `floorDiv` and `floorMod` in `int.ts`, added helpers;
- `src/rng/chacha.ts`, a module the kernel itself does not use;
- `export * as worldgen` in `src/index.ts`;
- a lint rule that narrows the exemption of `int.ts` to `Math.imul` and `Math.floor`, which tightens
  an existing control.

Worldgen lives in `packages/engine/src/worldgen`. A repository scan enforces that the kernel never
imports it, that it imports only an allowlist of kernel modules, and that it keeps no module-level
`let` or `var`.

**Classification.** The genesis, the terrain seed, the seal, and every digest that contains C3 or C4
material are C3. That includes the state root, which contains the world seed, and every tick
checksum, which contains the state root. None of them is ever projected to a client, nor enters
perception or a prompt.

**Proof without a production ruleset.** Nothing inside the world materializes a chunk before T4. In
T3, a probe ruleset among the tests passes the determinism suite with audit. Its world factory gives
each suite seed its own terrain seed, so the interleaving check also covers terrain. T4's first
ruleset runs the suite again with worldgen inside `step`.

This ADR refines five earlier ones:

- [0003](0003-authoritative-deterministic-engine.md) and
  [0004](0004-ai-proposes-engine-decides.md): R stays simulated days per real day. The default
  tick settings give 60 simulated seconds per real second, so for a day of L simulated seconds,
  R = 5,184,000 / L. That is about 68.6 for the default day of 75,600 s, and every budget per
  simulated day scales with it.
- [0006](0006-provenance-and-inheritable-contamination-taints.md): control 4 is confirmed.
- [0008](0008-data-classification-and-audience-projections.md): the world seed predicts all of the
  kernel's randomness, but not terrain, which comes from the terrain seed. Both seeds are C3, and so
  is every digest that contains them.
- [0020](0020-deterministic-core-design.md): T3 draws per chunk without a tick using ChaCha20
  under the terrain seed, not `ctr-mix32@1` under the world seed.

## Consequences

- Inside the engine, viewing, caching, and request order cannot change the world, and tests prove
  it. The server boundary, where nothing viewed becomes a command, is proven in T6.
- Snapshots grow with materialized chunks, not with explored area. A tick never rehashes terrain,
  and generating a chunk costs the same anywhere in the world.
- Every world is bound to its generator and its genesis for life, so generator code accumulates one
  version at a time.
- `ctr-mix32@1` stays predictable from any public outcome of a draw. Before any public world with
  players, it is replaced by a keyed pseudorandom function; that changes the engine version for new
  worlds only.
- The seal stops accidents, not deliberate changes, and a write behind the barrier in production is
  found at the next snapshot or the next write of the global value. When T7 introduces snapshot
  version 2, moving the genesis into an immutable kernel section makes the seal unnecessary.
- Terrain read inside a tick is recomputed each time. T4 measures what this costs pathfinding and
  can read whole regions.
- There is no hydrology, so no rivers and no lakes above the liquid level; a `worldgen@2` can add
  regional passes.
- That every JavaScript engine gives the same results rests on ECMA-262's exact integer arithmetic.
  Only Bun is tested, as the project rules require.
- Revisit:
  - in T4: the materialized chunk schema, perception, and the cost of terrain reads;
  - in T6: projections and the entropy source of the terrain seed;
  - in T7: the immutable kernel section;
  - before a public world: the kernel's randomness;
  - if a practical attack on ChaCha approaches: a new generator version.

## Alternatives considered

- **Storing every generated chunk.** Rejected: viewing would write state or need a materialization
  rule for observers, each dirty chunk would rehash 20 KB or more, and snapshots would grow with
  explored area.
- **The world seed, or a seed derived from it, for terrain.** Rejected: the first can be inverted
  from one draw, and the second can be found by a 2^32 search.
- **Keyed MurmurHash3, x86_32 or x86_128.** Rejected: both can be inverted from one output. SipHash
  needs emulated 64-bit arithmetic; HalfSipHash has a 64-bit key; simple integer hashes are
  invertible.
- **ChaCha12 or ChaCha8.** Rejected:
  - ChaCha12 keeps 5 rounds of margin over the best published attacks and ChaCha20 keeps 13. Those
    attacks reach 7 rounds and keep improving.
  - Neither variant has an RFC. Go's `x/crypto/chacha20` implements only RFC 8439, and Rust's
    `rand` documents its ChaCha12 `StdRng` as not portable across versions.
  - The saving is about 1% of the cost of a chunk.
- **Integer arithmetic with `|0`, `>>`, and `imul`.** Rejected: it overflows in the fade, in
  interpolation, and at the upper edge.
- **Other noise.** Simplex and OpenSimplex need irrational constants in fixed point. Value noise
  shows grid artifacts. Diamond-square, wave function collapse, erosion, and plate simulation are
  global or depend on order. Thresholds on a single noise give substrate classes that always border
  in the same order.
- **Protecting the genesis with `readonly` and tests alone.** Rejected: `readonly` binds only the
  compiler, and tests cover only the paths they run.
- **An immutable kernel section for the genesis.** Deferred to T7: it changes the version 1
  snapshot format.
- **A ruleset per world that knows its own genesis.** Rejected: the suite builds rulesets from
  factories without arguments.
- **Canonical `number[]` fields digested as text.** Rejected for their memory and digest cost.
- **Chunks of 16 or 64 cells.** Rejected: 16 multiplies subscriptions and messages; 64 costs about
  4 ms per chunk and makes interest management coarse.
- **Separate chunk and cell evaluators.** Rejected: two implementations of one field can diverge.
- **Time laws in ticks, a copy of `simSecondsPerTick` in the global value, or a default instant.**
  Rejected: the first ties a law to the integration step, the second keeps two sources of truth,
  and the third lets an observation depend on a clock nobody named.
- **Storing temporal values in a chunk.** Rejected: a golden value would then depend on when it was
  computed.
- **A version for each piece.** Rejected: nothing consumes separate versions, and one version pins
  everything T3 defines.
- **A separate `packages/world`.** Rejected: it would duplicate every purity control and contradict
  plan §G.
- **A production ruleset in T3.** Rejected: nothing inside the world triggers materialization yet.

## References

- Plan `docs/roadmap/v0.1-plan.es.md`: §E.4, §G, §H, §I.1, §K.4, §K.6–§K.8, §L, §M, §N, O-13.
- Tracker `docs/roadmap/v0.1-tracker.md`: S15, S16, L34–L36.
- [0003](0003-authoritative-deterministic-engine.md), [0004](0004-ai-proposes-engine-decides.md),
  [0005](0005-observer-independence.md),
  [0006](0006-provenance-and-inheritable-contamination-taints.md),
  [0008](0008-data-classification-and-audience-projections.md),
  [0009](0009-public-and-private-admin-interfaces.md),
  [0020](0020-deterministic-core-design.md).
- RFC 8439, ChaCha20 and Poly1305 for IETF Protocols: https://www.rfc-editor.org/rfc/rfc8439
- D. J. Bernstein, ChaCha, a variant of Salsa20: https://cr.yp.to/chacha/chacha-20080128.pdf
- J.-P. Aumasson, Too Much Crypto: https://eprint.iacr.org/2019/1492
- Differential-linear attacks on 7-round ChaCha (ToSC):
  https://tosc.iacr.org/index.php/ToSC/article/view/10983
- Go `x/crypto/chacha20`: https://pkg.go.dev/golang.org/x/crypto/chacha20
- Rust `rand` `StdRng`: https://docs.rs/rand/latest/rand/rngs/struct.StdRng.html
- MurmurHash3 reference implementation (SMHasher):
  https://github.com/aappleby/smhasher/blob/master/src/MurmurHash3.cpp
