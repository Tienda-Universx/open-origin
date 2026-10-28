# 0024. The mind: perception, memory, beliefs with provenance, relationships, and speech

- Status: Accepted
- Date: 2026-10-28

## Context

T5 builds the mind (plan §M): "Percepción, memoria con olvido, proposiciones con procedencia y
marcas, relaciones, conversación por plantillas", with the key test "Procedencia y herencia de
marcas correctas" and acceptance criterion §N.13. The maintainer asked for inhabitants with their
own experiences, memories, relationships, and interpretations of the world, arising from the state
and events of the universe, never from narration, with `AI_MODE=off`
([tracker](../roadmap/v0.1-tracker.md) S19, L54). Earlier decisions leave T5 the propositions with
provenance and inheritable taints of [0006](0006-provenance-and-inheritable-contamination-taints.md),
and the perception, memory, and relationships that [0023](0023-autonomous-beings.md) builds on its
senses, events, and controller. [0006](0006-provenance-and-inheritable-contamination-taints.md)
also required the maintainer to confirm O-14 before T5.

The forces:

- **The engine owns all state, body and mind** (plan §E.3), and the brain proposes
  ([0004](0004-ai-proposes-engine-decides.md)). There is one snapshot.
- **Events are not state.** They enter the tick checksum but not the state root or the snapshot,
  and no system can read them ([0020](0020-deterministic-core-design.md)). Memory must be state.
- **The kernel rehashes a chunk whole** whenever one of its beings changes, and a walking being
  writes its chunk at every step arrival. T4-8 measured "dispersed 1,000" at 57.4 KB hashed per tick
  at the median and 112.4 KB at p99, with 531 µs per wake and a being of about 523 B
  ([beings](../architecture/beings.md#the-scale-benchmark)). A mind several times larger than the
  body multiplies both. [0023](0023-autonomous-beings.md) sets the trigger for an entity section:
  p99 hashed per tick above 1 MB in a scenario the universe must support.
- **`beings@1`, `life@1`, and `utility@1` are frozen**, with T4's evaluation pinned, and their
  schemas admit no new member.
- **Observer independence** ([0005](0005-observer-independence.md)) and no lexical censorship
  ([0006](0006-provenance-and-inheritable-contamination-taints.md)).
- **Brains already keep hidden state**: `behavior.kind`, cooldowns, plans, and wake thresholds are
  brain-written, and one controller object serves every being of a species, called in id order.
  `sensesOf` copies the whole activity to the brain.

Evidence gathered while planning (tracker L55): a mind with one-letter member names, 12 episodes,
10 beliefs, and 6 relationships is 3.4 to 4.1 KB of canonical text, and hashing a chunk with it
costs 165 to 210 µs; the mind specified here, at its capacities of 8 episodes, 8 beliefs, 6
relationships, and 2 messages, is 3,394 B with typical values and 5,075 B with the largest, and
shorter names would save about 4%. Two read-only reviews found that the first draft's 4 KB bound
was false, that a content-keyed Bloom filter of exposure could be evaded and mixed two criteria,
and that a brain could pass information between beings within one tick through its controller
object.

## Decision

We will give each being of a new ruleset `beings@2` a compact mind that the engine owns and a brain
proposes changes to, with two measures of contamination, a ledger of provenance in events, and
speech by structured acts; `beings@1` stays as it is.

**Layers.** A new pure layer `src/mind` holds propositions, records, taints, salience, forgetting,
and the rules of formation. It imports only `int`, `errors`, `canonical/`, and `digest/`, so it
cannot read the world, and it works on values that `src/beings` has already copied and bounded.
Perception, untrusted input, validation, contests, and delivery stay in `src/beings`. `mind@1`, a new
brain in `packages/agents`, composes `utility@1` without changing it.

**A parallel version.** `createBeingsRuleset({ controllers })` stays `beings@1` with `life@1`.
`createBeingsRuleset({ controllers, rules: "beings@2" })` requires `life@2`, which keeps every law of
`life@1` and adds laws of perception, mind, relationships, speech, and a capacity per chunk. The
kernel, `ENGINE_VERSION`, and snapshot version 1 do not change. Goldens of `beings@1` land before any
code that both versions share.

**Five levels kept apart.** What exists (the engine), what can be perceived (laws of sight and
attention), what was perceived (at most K beings, by distance), what is remembered (episodes the
brain picks and the engine copies from percepts), and what is believed (propositions with a
confidence). The engine validates structure and references, never truth: a false belief stays a
belief and changes nothing in the world.

**Perception** reads only the chunks the window of T4 already reads, from the state at the start of
the tick, and only the C0 fields of other beings. Senses and the mind's view are built by an
allowlist derived from a classification registry, so taints, exposure, and the captured content of
a talk never reach a brain.

**The brain proposes mental acts**: remember a percept, recall, believe, revise, drop, and relate,
each citing local records. A belief cites only beliefs of a lower id, so support is acyclic. An
invalid operation is a rejection, the being's experience. Each belief operation of `mind@1` is a
pure function of the records it cites, the being's traits, and the laws of its species.

**Two measures of contamination**, refining [0006](0006-provenance-and-inheritable-contamination-taints.md):
`tn`, the exact union over the lineage, which classifies a belief by the table of 0006; and `ex`,
the being's lifetime exposure at the moment of forming or revising, which plan §K.7's "formed
without prior contaminated inputs" requires and which no citation or rephrasing avoids. Both only
grow, and they flow downstream: when a record's taints grow, every belief that cites it takes them
too, so a belief's taints always contain those of what it cites. A belief is reasoned when both are
empty. A belief that cites nothing gains `model-prior-suspect`; a `tell` carries the belief's
taints and the speaker's exposure; a research injection (`mind.inject`, admin only) always carries
`human-external`. The engine computes both measures; a brain never sees them.

**Provenance is a summary in the state and a ledger in events.** A belief keeps its taints, its
sources, its last speaker, and how many of its supports were forgotten; every change of a mind is in
the ledger, through `mind.changed` (C1), `mind.provenance` (C3), and the events of speech and
injection, and the tick checksums that T7 persists make that ledger tamper-evident. Forgetting is
never silent.

**Forgetting in closed form.** Salience halves every half-life, scaled by a trait, from an anchor,
with exact integer arithmetic; it is applied only when the being decides, and the view a brain gets
does not depend on how often the being was processed. Fundamental memories are pinned.

**Relationships.** Familiarity is a law that credits seconds of co-presence, not counts of
decisions; affinity and trust are judgments the brain proposes, citing a record that involves the
other being, with bounded changes.

**Speech by structured acts**: `greet`, `ask` (only about a concept the species perceives), `tell`
(only a belief the speaker holds, captured with its taints when it decides), and `unknown`. An act
takes simulated time, has reach and quotas, and is delivered at the end of its tick, after phase 3
resolves deaths and full inboxes fairly, so the hearer perceives it at t + 1, and is woken only if it
was idle. Templates only render acts.

**Capacity.** A chunk of `beings@2` holds at most `capacity` beings, 64 by default: arrivals beyond
it are resolved in phase 3, like contests over food, and a spawn into a full chunk is rejected.

**The gate.** T5-4 measures "dispersed 1,000" with every mind at capacity before the brain is built.
If p99 hashed stays below 1 MB, the entity section stays in T7, which must give it one hash term per
component, body and mind. If not, capacities come down; if the smallest useful mind still crosses
it, T5 stops for the maintainer's decision.

**O-14 is confirmed.** On 2026-10-28 the maintainer chose "Etiquetar sin intervenir": implementation
self-references are tagged `implementation-leak`, measured, and inherited, and nothing is deleted or
blocked. The policy is not sealed in the laws: no T5 code reads it; T9's detector will.

**Classification.** Taints, exposure, and the captured content of a talk are C3, refining
[0008](0008-data-classification-and-audience-projections.md) and the knowledge row of
[0021](0021-procedural-world.md), because C1 may reach the inhabitant and taints must not.
Episodes, beliefs, relationships, and the inbox are C1; an act of speech is C0.

The specification and the preregistration are in [Mind](../architecture/mind.md).

## Consequences

- Inhabitants can see each other, remember, believe falsely, revise, trust, and talk, all from
  events that happened in the world; two inhabitants in different places hold different minds.
- Every belief is attributable, and its contamination never decreases; analysis can filter whole
  lineages by `tn` and apply the strict criterion by `ex`.
- A full mind adds about 3.4 KB, with typical values, to a being's record of about 0.5 KB, and
  every step rehashes it; "dispersed 1,000" is estimated at about 0.8 to 0.9 MB p99 hashed, close to
  the trigger, so the gate may lower the capacities. "dispersed 10,000" crosses the trigger: with
  minds it is a ceiling outside what v0.1 supports.
- `beings@2` adds two draws whose outcomes become public once T6 projects positions, the streams
  `beings.crowd` and `beings.speech`; the gate on `ctr-mix32@1` from 0023 still applies.
- A brain's hidden channels are declared, not removed; `ex` covers them, and the whole-decision
  ablation of `mind@1` runs in the soak.
- The ledger grows with the population; T7 must persist it and never prune it.
- Speech in T5 carries only beliefs about food and greetings; overhearing, lying, coined concepts,
  and hypotheses wait for later versions.
- Revisit:
  - in T6: the projections of speech and of mind fields, built on the registry, and a host that
    handles a rejected promise;
  - in T7: the entity section with a term per component, and the persistence of the ledger;
  - in T9: the manifest of a prompt as the manifest of a decision, and the detector of
    implementation self-references.

## Alternatives considered

- **Mind in the global value, in pseudo-chunks, or in the chunk of birth.** Rejected: the global
  value is rehashed whole and pays the seal; a chunk holds what lies in its region; a chunk of birth
  full of minds costs more.
- **An entity section or snapshot version 2 now.** Rejected without evidence; the gate decides with
  measurements.
- **Memory in the event log.** Rejected: events are not state, and memory must be bounded and fade.
- **The engine forming beliefs from observations.** Rejected: interpreting is policy; the engine
  would become a hidden mind.
- **The brain writing the content of its observations.** Rejected: it could invent or learn what it
  never received.
- **A content-keyed Bloom filter of exposure** (the first draft). Rejected: it mixed lineage with
  exposure, a rephrased proposition evaded it, it saturated, and it missed injections and a being's
  own tainted beliefs.
- **Taints computed by walking the graph when asked.** Rejected: forgetting breaks the walk.
- **The whole provenance graph in the state.** Rejected: it grows without bound.
- **Taints visible to the brain.** Rejected: an outside concept inside the world, and a way to
  launder.
- **A lexical filter.** Rejected by 0006.
- **Forgetting by sweeps or a global LRU.** Rejected: cost per tick would follow the population.
- **Free text.** Deferred to T9.
- **Overhearing.** Deferred: it costs one write per bystander per act.
- **Changing `utility@1`.** Rejected: it is frozen; `mind@1` composes it.
- **Evaluating `mind@1` on T4's seeds.** Rejected: a new brain gets its own preregistration.
- **A second CI job.** Rejected: the required check matches the job by name
  ([0016](0016-github-repository-baseline.md)), so a new job would not be required; tests run in
  parallel inside the job instead.

## References

- Plan `docs/roadmap/v0.1-plan.es.md`: §C, §E.3, §E.4, §I.1, §K.2–§K.9, §L, §M, §N, O-14.
- Tracker `docs/roadmap/v0.1-tracker.md`: S19, L53, L54, L55.
- [0004](0004-ai-proposes-engine-decides.md), [0005](0005-observer-independence.md),
  [0006](0006-provenance-and-inheritable-contamination-taints.md),
  [0008](0008-data-classification-and-audience-projections.md),
  [0016](0016-github-repository-baseline.md), [0020](0020-deterministic-core-design.md),
  [0021](0021-procedural-world.md), [0022](0022-single-shared-public-universe.md),
  [0023](0023-autonomous-beings.md).
- [Mind](../architecture/mind.md): the specification and the preregistration.
