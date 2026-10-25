# 0023. Autonomous beings: a body in the engine, a brain that proposes, and decision points

- Status: Accepted
- Date: 2026-10-25

## Context

T4 builds the inhabitants (plan §M): "Necesidades enteras, acciones, A*, utility AI", with the key
test "≥10 días simulados sin colapso" and acceptance criterion §N.15. The maintainer asked for
beings that exist, move, satisfy needs, and survive by real mechanisms of the world, not by
scripts, with `AI_MODE=off`, and for a base that T5 can extend with perception, memory, beliefs,
and relationships ([tracker](../roadmap/v0.1-tracker.md) S18, L43). Earlier decisions leave T4
four things: the activity index based on world data only
([0020](0020-deterministic-core-design.md)), and the schema of a materialized chunk, perception,
and the cost of terrain reads ([0021](0021-procedural-world.md)).

The forces:

- **The kernel has no entity store.** It provides `EntityId`, `newEntityId()`, and the counter in
  the snapshot. State is a global value, which is digested whole on every write and pays the
  genesis seal check, plus chunk values, which are digested only when they change. Chunks cannot be
  deleted, every system runs every tick, and `chunkKeys()` copies every key.
- **Cost per tick** grows with what changes, never with the size of the world
  ([0020](0020-deterministic-core-design.md), `AGENTS.md`).
- **The brain proposes, the engine decides** ([0004](0004-ai-proposes-engine-decides.md)), and the
  dependency rule puts policies in `packages/agents`, which depends on `engine`, never the reverse
  (plan §E.2, §E.3).
- **Observer independence** ([0005](0005-observer-independence.md)) and the separation of state,
  perception, and memory (P4).
- **Laws as versioned data**, not terrestrial (plan §K.8, O-13), and time laws that never depend on
  the length of a tick ([0021](0021-procedural-world.md)).
- **Death** is implemented and disabled by a flag until reproduction exists (plan O-16).

Evidence gathered while planning (tracker L44; Bun 1.4.4 on the two-core Codespace, indicative):

- `sampleRegion` with the default genesis costs about 1.0–1.1 ms for 49×49 cells and 3.7 ms for
  97×97; elevation and one deposit are about 0.38 ms of the 1.0 ms. A single cell costs about 40 µs.
- Dijkstra over a 49×49 window costs about 0.34 ms.
- A being's canonical text is about 423 B asleep and 511 B on a walk of 20 steps; a chunk that
  changes costs about 19–23 µs at commit per such being, and audit adds about 3.2 µs per chunk and
  tick.
- `Object.freeze` throws on a non-empty typed array in Bun, so typed arrays handed to a brain are
  read-only by type only.
- `deposit.<k>` has the exposure "measurement" in the observable catalog, not "surface".

## Decision

We will build the beings as a ruleset layer above worldgen, with a pure brain that proposes, and
process each being only at its decision points.

**Placement and layering.**

| Layer | Package | Decides | Never |
|---|---|---|---|
| L0 physiology | `packages/engine/src/beings` | needs, health, forced sleep, incapacity or death | choose a behavior |
| Authority | `packages/engine/src/beings` | validates intentions, routes, preconditions, and contests; executes; emits events; rejects with a reason | trust the brain |
| L1 Utility AI | `packages/agents` | which behavior is worth doing now | write state, see beyond its senses, remember outside the state |
| L2 plan | `packages/agents` | up to three steps and their route, by Dijkstra or A* over the sensed grid | invent costs |

- `src/beings` imports only an allowlist: `src/worldgen/index.ts`, `int`, `errors`, `time/tick`,
  `world/chunk`, `world/members`, `world/contracts` for types only, and the modules under
  `canonical/` and `digest/`. It never imports `rng/*`, `step/*`, `snapshot/*`, `world/world.ts`,
  `world/create.ts`, or `src/index.ts`, so randomness enters only through `ctx.random` and the
  terrain seed is never touched. Neither the kernel nor worldgen imports `src/beings`. The
  repository scan `tests/repo/engine-purity.ts` enforces this from T4-2.
- `packages/agents` imports only the public entry `@open-origin/engine`. It shares the engine's
  denied globals and GritQL plugins, has its own import rule, and has no module state.
- The host composes `createBeingsRuleset({ controllers })`, one brain per species, which the
  engine captures as it captures a ruleset's lists: copied, accessors refused. In T4 the host is the
  tests; in T6, the server.

**Beings live in the chunk of their cell.** A materialized chunk holds `{ beings, depletion, due }`:
the beings whose cell lies in it, ordered by id; the cells whose food was eaten; and the earliest
tick at which any of its beings must be processed. Crossing into another chunk writes both chunks
in the same tick, which the kernel commits atomically or poisons. A chunk is materialized only when
a being is born in it, enters it, or eats in it, never by sensing, viewing, or caching terrain.

**An occupancy index in the global value.** `occupancy` is the sorted list of chunks that may hold
beings: a chunk enters when it receives a being, and chunks left empty are pruned once per
simulated day. The invariant is: chunks with beings ⊆ `occupancy` ⊆ materialized chunks. The global
value is written when a chunk becomes occupied and at the daily prune, not on every crossing. Every
tick the system reads `due` from each chunk in `occupancy`, without hashing anything. The index
depends only on world data. This is the activity index ADR 0020 assigned to T4.

**Decision points, not every tick.** Each being stores `wake`, the next tick at which something
changes for it, and its chunk stores the minimum. Only beings with `wake ≤ tick` are processed, each
once per tick even when it crosses into another chunk. This refines plan §K.2 at its three layers:
L0 runs in closed form instead of every tick; L1 runs at the exact tick a known condition holds
instead of every tick while a being is free; and L2 uses one recipe per behavior instead of HTN or
GOAP. The conditions are the end of a step, a bite, or an activity; the crossing of a need
threshold; the wake conditions the brain asks for (need and light thresholds; radiance has a closed
form in the instant); and a maximum reconsideration interval. Reaction latency is therefore
bounded, and a test pins the bound (T4-6).

**Time in exact simulated seconds.** Laws are rates per simulated second, as ratios `num/den` with
`num` from 0 to 2^20 and `den` from 1 to 2^32, so that `num·den` and `10^6·den` are safe integers;
each quantity changes under one rate at a time. Durations of steps and bites accumulate in integer
simulated milliseconds, and the step i of a walk arrives at the tick
`start + ⌈S_i / (simSecondsPerTick·1000)⌉`, where `S_i` is the exact cumulative duration; several
steps may fall in one tick. Laws and arrival instants therefore do not depend on
`simSecondsPerTick`, and the search optimizes the time actually walked. What does depend on it is
the integration step: the engine observes an arrival at the first tick at or after it, so an
activity lasts a whole number of ticks and needs change over whole ticks. A smaller tick makes that
rounding smaller; it never changes a law.

**Needs in closed form.** A being stores its needs and health with one anchor tick. A need's value
at tick t is
`v0 ∓ ⌊num·E/den⌋` with `E = simSeconds(t) − simSeconds(anchor)`, computed as
`num·⌊E/den⌋ + ⌊num·(E mod den)/den⌋` and saturated before it can exceed its range, so every
intermediate value is a safe integer. When the rate of any of them changes, all of them are re-anchored
together; never because a being was processed, so their values do not depend on how often the being
was processed.
The tick at which it crosses a threshold has an exact formula. Reading a need never writes.

**Senses are bounded, and they are not T5's perception.** At each decision the engine builds a
square window of (2R+1)² cells around the being (R is a species law, at most 32 and 24 by default),
with cells outside the world marked impassable and empty. It exposes what the observable catalog makes
visible at a distance:

- `edgeMs`: the duration of the step along each of the 8 edges of each cell, from `elevation` and
  `liquid.depth` (surface observables), with −1 for an impassable edge or a diagonal that would cut
  a corner;
- a banded cue of the effective food of the deposit the species eats: none, some, or plenty. The
  exact amount is known only by eating, because deposits are measurement observables;
- the light of the instant, and the being's own state, including what its brain stored.

The engine reads terrain by regions: each decision samples its window once, with a worldgen reader
of the elevation and one deposit that returns exactly `sampleRegion`'s values and changes no output
of `worldgen@1`, and each decision gets fresh arrays. A bite reads the one cell it eats from. Perception in T5 builds percepts, memory, and
provenance on top of these senses.

**The brain is a pure function of its senses.** `Controller.decide(senses) → Intention`. Whatever it
must remember between decisions (its current behavior, its exploration heading, its recent failed
targets) is stored in the being as C1 data and returned in the senses. An intention has one to three
steps (`walk`, `eat`, `sleep`, `idle`), its wake conditions, and its behavior. The engine copies it
canonically, reading each member once and refusing accessors as `members.ts` does, then validates
it. An invalid intention is a rejection that becomes the being's experience (plan §K.5), never a
fault; a brain that throws is a code error and poisons the world (ADR 0020). A future
`llm-assisted` controller cannot be a pure function: its proposals enter as commands recorded in the
log ([0004](0004-ai-proposes-engine-decides.md)) and go through the same validation (plan §K.1).

**Routes are validated once.** A walk has at most 64 steps. When the engine accepts it, it checks
every step against the window of the same tick and computes its duration. Terrain is permanent and
nothing blocks a step in T4, so executing a step reads no terrain.

**Laws of life are sealed world data.** The global value adds `life`, the species and their laws,
and `lifeSeal = digest(["life", LIFE_VERSION, life])`, with the same checks and guarantees as the
genesis seal of ADR 0021. Each world may have its own biology without code changes; changing it
needs a new world or a new epoch. T4 knows two kinds of need, nutrition and rest; a species declares
its laws for them, its diet (one deposit of the genesis), locomotion, sleep, health, regrowth, and
senses. In `life@1` every species eats the same deposit with the same regrowth, because a depletion
entry does not record which deposit was taken. Other kinds of need, animals, and pets add species
and brains later, with new versions.

**Contests over food.** Several beings may share a cell in T4: there are no bodies or physics (plan
O-6), and a capacity law waits for bodies or buildings. Bites that fall due in the same tick and
cell, with food for fewer than all, are ordered by `random.permutation` on the system's stream
`beings.contest`, keyed by the lowest claimant id. This refines ADR 0020, which keys the
permutation by the resource id: a cell needs 64 bits and is not a safe-integer id, while each being
claims at most one cell per tick. Contested cells are resolved in canonical order; losers get an
outcome and are processed again at the next tick.

**Death follows O-16.** The rule is implemented and `life.deathEnabled` is false by default. At
health 0 with death disabled, a being is incapacitated: it cannot walk, may eat in its cell and
sleep, and recovers when its health does. With death enabled, it dies, leaves its chunk, and an
event records it.

**Versions.** The ruleset version is `beings@1`, the generator stays `worldgen@1`, and the brain
version composes the species and their brains in order, for example `s1:utility@1`.
`ENGINE_VERSION` does not change: the kernel's outputs do not change. The engine adds the `beings`
namespace and exports `floorDiv` and `floorMod`.

**Classification.** What an observer inside the world could see is C0: a being's cell, species,
stage, the kind of its activity, and the direction of its current step. The rest of the being is C1:
its needs, health, traits, the remaining route and targets of its activity, its plan, behavior
(including the brain's heading), wake conditions, outcome, and cooldowns. The laws of life, like the
genesis, are C3. T6 decides each projection.

**Randomness.** T4's contests and initial exploration headings are the first kernel draws whose
outcomes become public once T6 projects positions. This refines ADR 0021: the replacement of
`ctr-mix32@1` by a keyed pseudorandom function is required before the first public deployment of
any world, with players or not, because a public world persists
([0022](0022-single-shared-public-universe.md)) and its generator changes only with an epoch. The
recommended moment is T7, with snapshot version 2, because the seed changes shape.

## Consequences

- Behavior comes from needs, laws, terrain, and food that actually exists: nothing is scripted by
  the hour, and the brain sees only its senses.
- Events record behaviors, not steps, so a being emits on the order of 50 events per simulated day
  (plan §I.2.7 estimates 30); the benchmark measures it.
- A sleeping being in its own chunk costs one read per tick; a chunk that holds no being costs
  nothing. Per-tick work grows with occupied chunks, beings due, changed bytes, and decisions.
- The global value is rewritten when a chunk becomes occupied and once per simulated day, so the
  genesis seal check is paid rarely.
- Ceilings: a crowded chunk is rehashed whole whenever one of its beings changes (estimated at
  about 18 ms for 1,000 beings in one chunk from the measured commit cost; T4-8's benchmark measures
  it), and T5's mind data will be rehashed on every step of its being. Both point to the same exit: an entity section with one hash term per entity in
  snapshot version 2 (T7). The occupancy list is rewritten whole when it changes; the benchmark
  measures from how many occupied chunks it dominates.
- Interactions are local (a window of at most one chunk of radius, contests per cell), which keeps
  a later partition by regions open without building it.
- `ctr-mix32@1` stays in v0.1, where nothing is deployed; its gate is stricter than ADR 0021's.
- The default laws are calibrated in T4-6 against targets registered before calibration, on seeds
  that the evaluation never uses ([beings](../architecture/beings.md#preregistration)).
- Revisit:
  - in T5: perception, memory, and relationships over these senses, events, and the controller;
  - in T6: the projections of being fields and events;
  - in T7: the entity section and the kernel's randomness;
  - when the benchmark shows terrain reads limiting decisions: a terrain cache across ticks keyed by
    the generator version, the genesis seal, and the chunk, which must pass `interleave` and
    `child-resume`.

## Alternatives considered

- **A table of beings in the global value.** Rejected: every movement would rehash the population
  and pay the seal check.
- **Visiting every being every tick.** Rejected: O(population) even when everyone sleeps.
- **A wake queue in the global value, or an exact occupancy list pruned at every crossing.**
  Rejected: the global value would be rewritten almost every tick.
- **Chunks outside the world used as index records.** Rejected: they abuse what a chunk means.
- **Kernel support for entities or queues in T4.** Rejected: it changes `ENGINE_VERSION` and T2's
  contracts; it is the path for T7.
- **Durations rounded to whole ticks.** Rejected: they tie laws to the integration step and make the
  search heuristic inadmissible.
- **A position derived from a route, written only at its ends.** Rejected: a being would be stored
  in a chunk it already left.
- **An omniscient brain, or exact deposit amounts at a distance.** Rejected: it breaks P4 and the
  catalog's exposure.
- **Full GOAP or HTN.** Rejected for T4: each behavior has one recipe; the plan representation
  leaves room for T5.
- **Terrain or a navigation mesh in the state.** Rejected by ADR 0021.
- **A terrain cache across ticks now.** Rejected for T4: eight beings do not need it.
- **Inventory, thirst, or body temperature.** Rejected: not needed to survive, and plan §L sets
  hunger and energy; the body stays extensible.
- **Policies inside `packages/engine`.** Rejected: it contradicts plan §E.2 and §E.3.
- **A brain with memory of its own.** Rejected: it breaks resume and interleaved worlds.
- **Traits drawn at spawn.** Rejected: an extra stream for nothing; the scenario passes them, or
  they take the neutral value.
- **Exclusive cells.** Rejected for T4: without bodies it adds reservations and deadlocks for no
  law of the world.

## References

- Plan `docs/roadmap/v0.1-plan.es.md`: §E.2, §E.3, §H, §I.1, §K.1, §K.2, §K.5, §K.6, §L, §M, §N,
  O-6, O-13, O-16.
- Tracker `docs/roadmap/v0.1-tracker.md`: S18, L43, L44.
- [0003](0003-authoritative-deterministic-engine.md), [0004](0004-ai-proposes-engine-decides.md),
  [0005](0005-observer-independence.md), [0008](0008-data-classification-and-audience-projections.md),
  [0020](0020-deterministic-core-design.md), [0021](0021-procedural-world.md),
  [0022](0022-single-shared-public-universe.md).
- [Beings](../architecture/beings.md): the specification and the preregistration.
- P. E. Hart, N. J. Nilsson, B. Raphael, "A Formal Basis for the Heuristic Determination of
  Minimum Cost Paths" (1968): https://doi.org/10.1109/TSSC.1968.300136
- E. W. Dijkstra, "A note on two problems in connexion with graphs" (1959):
  https://doi.org/10.1007/BF01386390
