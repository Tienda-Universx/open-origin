# Mind

The mind of T5: what a being perceives, remembers, believes, and feels about others, and how it
speaks, with provenance and inheritable taints on every belief
([0024](../decisions/0024-mind-memory-beliefs-and-speech.md), which refines
[0006](../decisions/0006-provenance-and-inheritable-contamination-taints.md),
[0008](../decisions/0008-data-classification-and-audience-projections.md),
[0021](../decisions/0021-procedural-world.md), and
[0023](../decisions/0023-autonomous-beings.md)). This page is the specification that T5's pull
requests implement, and the preregistration of its scenarios. It extends [Beings](beings.md),
whose `beings@1` stays as it is.

| Part | Code | Pull request |
|---|---|---|
| `beings@1` goldens; follow-ups 1–3 of tracker L53; parallel `bun test` | `packages/engine/test`, `src/beings/{resolve,ruleset}.ts`, `package.json` | T5-2 |
| The pure mind layer and its scans | `packages/engine/src/mind`, `tests/repo/engine-purity.ts` | T5-3 |
| `beings@2`, `life@2`, perception, capacity, the scale gate | `packages/engine/src/beings`, `packages/agents/bench` | T5-4 |
| Memory and belief operations, taints, the ledger | `packages/engine/src/beings` | T5-5a |
| Relationships, `mind.inject`, the fuzz with the ledger oracle | `packages/engine/src/beings`, `packages/engine/test` | T5-5b |
| Speech and its templates | `packages/engine/src/beings`, `packages/agents/src/speech` | T5-6 |
| The brain `mind@1` and the calibration | `packages/agents/src/brain` | T5-7 |
| Determinism, observers, and adversarial tests | `packages/agents/test`, `packages/engine/test/support` | T5-8 |
| The evaluation, the cost, and the close | `packages/agents/{test,bench}` | T5-9 |

## Layers

```
packages/agents       brain "mind@1": composes utility@1 unchanged; pure rules rule(cited);
   │                  retrieval; social policy; templates speech@1
   │ decide(senses) → intention with mental operations and talk steps
   ▼
src/beings            ruleset "beings@2" beside "beings@1": perception, reading and copying of
   │                  untrusted input, validation, contests, delivery, events
   │ typed values, already copied and bounded
   ▼
src/mind              pure: propositions, records, taints, salience, forgetting, formation rules
```

`src/mind` imports only `int`, `errors`, and the modules under `canonical/` and `digest/`: never
`world/*`, `time/*`, `worldgen`, or `beings`, so it cannot read the world, and it never reads
untrusted input, which `beings` copies and bounds first. It receives the tick and its simulated
seconds as numbers, and computes no time of its own.
`src/beings` imports it; the kernel and worldgen do not; `src/index.ts` exports it as the
namespace `mind`. It holds no module state, under the rule that applies to `beings`.

## The five levels

| Level | Where it lives | Who produces it |
|---|---|---|
| 1. What exists | The state of the engine | The engine; reference truth is C3 |
| 2. What can be perceived | `perceptible(view, being)` | The engine, by the laws of the species |
| 3. What was perceived | `senses.perceived` | The engine: attention picks at most K |
| 4. What is remembered | `mind.episodes` | The brain picks; the engine copies the content |
| 5. What is believed | `mind.beliefs` | The brain proposes; the engine validates and taints |

Level 3 is a subset of level 2, which is a subset of level 1. A belief may be false: the engine
validates its structure and references, never its truth, and no belief changes the world.

## Perception

At each decision the engine builds, on top of the senses of T4 and from the state at the start of
the tick:

- **Other beings.** From the chunks the window already reads (one shared loop with
  `senseWindow`, a refactor that changes no output of `beings@1`): every being at Chebyshev
  distance at most `sight` from the cell, where `sight` is `perception.sight.day`, or
  `perception.sight.dim` when the light of the instant is below `perception.dimBelow`. Each gives
  its id, species, cell, the kind of its activity, and the direction of its current step: C0 only,
  never another being's needs, health, or `condition`. Attention keeps the `perception.attention`
  nearest, by distance, then id. Recognition of individuals is perfect, and terrain hides nothing:
  two simplifications.
- **What it hears.** The messages in its inbox ([Speech](#speech)), consumed at this decision, in
  the order they arrived: each as `{ who?, cell?, act, p?, band? }`, a fresh copy, with neither its
  tick nor its taints; an injection's as `{ act: "tell", p }`.
- **Its own experience.** The result of its last activity, and the units it ate if it ate: the
  being's `outcome` in its senses, whose `units`, in `beings@2`, the meal that just ended ate.
  A deposit's exposure is "measurement" in the catalog ([0021](../decisions/0021-procedural-world.md)):
  the senses of T4 give its food only in bands across the window, and its exact amount is known
  only through the being's own action on its cell.
- **Its mind.** A view of its episodes, beliefs, and relationships, with ages in simulated seconds
  (saturating at 2^31 − 1) instead of ticks, familiarity as it stands at that moment, from 0 to
  1000, and `next`, so that a brain can cite a record it creates in the same decision. A
  relationship's `seen` is left out of the view until the being first perceives that being, and
  its `talk` until the being first addresses it. A
  research injection appears in it as a message whose speaker is not visible: the kind `external`
  and the evidence bit 8 are C3, and the view shows them as `heard` and as told. That a message came
  with no visible speaker is the one thing the being can tell, a declared limit.

The senses and the view are built by allowlist, derived from the
[classification registry](#classification): `tn`, `ex`, `exposure`, and the captured content of a
talk in progress never reach a brain, and neither do the `draws` of T4 reach the view or, in T9, a
prompt, because they reveal the kernel's randomness.

## State

### Laws of `life@2`

`life@2` keeps every law of a `life@1` species, unchanged and with the same defaults, and adds:

| Law | Meaning | Default | Validated |
|---|---|---|---|
| `perception.sight.day`, `.dim` | Cells seen in light and in dim light | 12, 4 | 0 to the window radius R |
| `perception.dimBelow` | The radiance below which sight is dim; the default genesis goes from 40 at night to 1,000 at its peak | 150 | 0 to 2^20 |
| `perception.attention` | Beings perceived per decision | 6 | 0 to 8 |
| `mind.episodes`, `.beliefs`, `.relations`, `.inbox` | Capacities | 8, 8, 6, 2 | 0–16, 0–16, 0–12, 0–4 |
| `mind.ops` | Mental operations per decision | 4 | 0 to 8 |
| `mind.depth` | Deepest inference | 6 | 1 to 8 |
| `mind.halfLife.episode`, `.belief` | Half-life of salience, in seconds, scaled by `retention` | 75,600, 302,400 | 1 to 2^31 − 1 |
| `mind.floor`, `.pinLevel`, `.pins`, `.recall` | Salience below which an episode is forgotten; importance from which it never fades; pinned episodes per being; the importance a recall adds | 50, 900, 2, 200 | 0–999, 1–1000 and above `floor`, 0–4, 0–1000 |
| `relations.rate` | Familiarity per second of co-presence, a ratio; `f` saturates at `⌈1000 / rate⌉` seconds | 5/36 | as the rates of T4, and `⌈1000 / rate⌉ ≤ 2^22`, so every product of the salience formula stays a safe integer |
| `relations.gap`, `.halfLife` | Longest pause between two perceptions still counted as co-presence; half-life of familiarity in absence, in seconds, not scaled by traits | 600, 756,000 | 1 to 2^31 − 1 |
| `relations.delta` | Largest change of affinity or trust in one operation | 200 | 0 to 1000 |
| `speech.range`, `.actMs` | Reach of speech in cells; duration of one act | 3, 4,000 | 1 to 8 and at most `perception.sight.dim`; 1–60,000 |
| `speech.turns`, `.gap`, `.cooldown` | Acts one being addresses to another in one conversation; the longest pause between two delivered acts of a conversation, and the pause one pair keeps after a full one, in seconds | 3, 120, 18,900 | 1–8, 1 to 2^31 − 1 |
| `speech.perDay`, `.wakesPerDay` | Acts a being may say, and times hearing may wake it, per simulated day | 10, 8 | 0 to 64; `perDay` is 0 when `mind.relations` is 0, because the quotas per pair live in relationships |
| `capacity` | Beings per chunk: a law of `life@2` itself, beside `deathEnabled`, not of a species | 64 | 1 to 1,024 |
| `traits` | The trait bounds of T4, now for six traits: also `sociability`, `credulity`, and `retention` | [800, 1,200] each | the rule of T4 |

The defaults are where calibration starts (T5-7); the values frozen after it replace them here.
Durations of 75,600 s are one day of the default genesis, written as data, because each world has
its own day.

### The mind of a being

A `beings@2` being adds `mind`, the three traits, and the units of a meal in its outcome;
`beings.spawn` accepts the traits but never mental content.

| Member | Class | Content |
|---|---|---|
| `traits.sociability`, `.credulity`, `.retention` | C1 | Permille; retention scales both half-lives |
| `outcome.units` | C1 | Present only when the activity that ended was `eat`: the units it ate in total, 0 when it ate nothing |
| `mind.next` | C1 | The next local id, from 1 to 2^31 − 1; local ids only grow and are never reused, each store keeps its records in increasing id, and a mind whose ids run out takes no new record |
| `mind.episodes`, `.beliefs`, `.relations`, `.inbox` | C1, their taints C3 | Below |
| `mind.exposure` | C3 | The being's lifetime exposure: a taint mask that never shrinks |
| `mind.quota` | C1 | `{ day, said, woken }`: acts said and wakes by hearing in that simulated day, counted as the daily prune of T4 counts it, `⌊seconds / day length⌋`; a wake counts in the day of the delivery that caused it |

An **episode** is `{ id, kind, t, cell?, who?, v?, p?, act?, band?, tn?, ex?, w, r }`: its local id;
its kind; the tick it happened; the cell, which an `external` episode does not have; the being it
concerns or who spoke; a value; for a message, its proposition, act, and the speaker's confidence
band; for a message, its taints; its importance `w` from 0 to 1000; and the tick `r` its salience
is anchored at.

| Kind | Made from | Content |
|---|---|---|
| `food` | The window's food cue at a cell | `cell`, `v`: the band 0, 1, or 2 |
| `being` | A perceived being | `who`, `cell`, `v`: the kind of its activity, as its index in the activity list |
| `ate` | Its own last bite | `cell`, `v`: the units eaten |
| `failed` | Its own last result | `cell`, `v`: the index of the reason |
| `heard` | A message from a known speaker | `who`, `cell`, `act`, `p?`, `band?`, `tn`, `ex` |
| `external` | A research injection; the kind is C3, and the view shows it as `heard` with no speaker | `p`, `tn`; no speaker, no cell |

The reasons a `failed` episode indexes, in this order: `no_food`, `food_gone`, `incapacitated`,
`crowded`.

A **belief** is `{ id, p, cr, src, who?, ev, lost, tn, ex, dp, u }`: its proposition; its
confidence from 0 to 1000; `src`, the mask of the kinds of evidence that ever supported it (1 seen,
2 told, 4 inferred, 8 external, the last C3 and shown to the brain as 2), which only grows; `who`,
the last speaker it came from; `ev`, the local ids of the live records it cites, at most 3; `lost`,
how many cited records it has lost, up to 2^31 − 1; its taints `tn` and `ex`; its depth `dp`; and
`u`, the tick it was last formed, revised, or cited.

A **relationship** is `{ id, who, f, seen, aff, tr, tn, talk, turns }`: its local id; the other
being; `f`, its familiarity as seconds of co-presence, decayed by absences, as of the tick `seen` it
was last perceived, saturating where it gives 1000; `seen` is 0, and `f` with it, while the being
was only heard, never perceived; affinity from −1000 to 1000, starting at 0;
trust in its claims from 0 to 1000, starting at 500; its taints; the tick the being last addressed
it, 0 before it ever did, which no act can be, since the first tick a world computes is 1; and the
acts addressed to it in the current conversation. A mind holds one relationship per being.

An **inbox message** is `{ who?, t, cell?, act, p?, band?, tn, ex }`. An injection's message has
no `who` and no `cell`, and its act is `tell`.

### Propositions `prop@1`

`{ p, a, v?, neg? }`: a concept id; one or two terms, each `{ e: id }`, `{ c: [x, y] }`, or
`{ n: integer }`; an optional integer value; and `neg: true` for its negation. At most 96 bytes of
canonical text.

A concept id is an engineering identifier, never shown to an inhabitant
([0021](../decisions/0021-procedural-world.md)), and not an enum. It matches
`^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$` with at most 48 characters, in a namespace:
`obs.` followed by an observable of the catalog, or the namespace a brain declares when it is
captured, such as `m1.` for `mind@1`, whose concepts are defined over observables:

| Concept | Terms | Value | Definition |
|---|---|---|---|
| `m1.food-at` | a cell | a band 0–2 | The band of the effective food of the species' deposit at the cell |
| `m1.food-near` | a cell | — | Some cell within 8 cells of it holds food of band 1 or more |

The engine validates the structure, never the meaning. The typed hypothesis trees of plan §K.8
come as `prop@2`.

## Time, salience, and forgetting

The salience of a record at a moment, with `E` the seconds from its anchor to the moment:

```
H = max(1, ⌊halfLife · retention / 1000⌋)       k = ⌊E / H⌋
s = 0                                            when k ≥ 30
a = ⌊w / 2^k⌋    s = a − ⌊(a − ⌊a / 2⌋) · (E mod H) / H⌋   otherwise
```

It is exact, never increases with E, and uses no power function or shift that could overflow. For
an episode, `w` is its importance and the anchor is `r`; an episode with `w ≥ pinLevel` keeps
`s = w`. For a belief, `w` is `max(cr, 1000 − cr)` and the anchor is `u`. A relationship's
familiarity at a moment is `min(1000, ⌊rate · f′⌋)`, where `f′` is `f` itself when the seconds
since `seen` are at most `relations.gap`, and otherwise `f` decayed by the formula over all those
seconds, with `w = f`, the anchor `seen`, and `relations.halfLife`, which retention does not scale.

- An episode with `s < floor` is forgotten. Beliefs and relationships are never forgotten by
  salience; they are displaced when their store is full.
- A full store of episodes or beliefs evicts the record with the lowest salience, the new one
  included, then the oldest (an episode by `t`, a belief by `u`), then the lowest id. A full store
  of relationships admits a being met for the first time and evicts the other relationship with
  the lowest familiarity, then the one seen longest ago, then the lowest id, among those whose being
  the mind has not addressed in the last `max(speech.gap + 1, speech.cooldown)` seconds: it never
  evicts a relationship whose `talk` is a tick from 1 to now, less than that long ago, which holds
  the quotas of a conversation that a pause of at most `gap` continues, or of its cooldown; a `talk` of 0, or after now, which no world holds,
  keeps nothing. When every relationship it holds is within that window, the newcomer gets none,
  and nothing is evicted.
- A recall, or citing the episode as evidence, sets `w` to `min(1000, s + recall)` and `r` to now.
  At most `pins` episodes have `w ≥ pinLevel`: beyond that, a new importance is capped at
  `pinLevel − 1`.
- Forgetting is applied only when the being decides. The view a brain gets is a pure function of
  the mind and the moment, so it is the same whether the being was processed often or seldom; the
  ticks at which records leave the state, and their events, follow the being's decisions.

## Provenance and taints

The taint mask has 1 `model-prior-suspect`, 2 `human-external`, and 4 `implementation-leak`. ADR
0006 classifies a belief by its lineage, and plan §K.7 calls it reasoned when it formed without
prior contaminated inputs: two criteria, kept in two fields.

| Record | `tn`, lineage | `ex`, exposure |
|---|---|---|
| A `food`, `being`, `ate`, or `failed` episode | ∅ | ∅ |
| A `heard` episode of a `tell` | The `tn` of the speaker's belief, captured when it decided to speak | The `ex` of that belief ∪ the speaker's `exposure` at that decision |
| A `heard` episode of `greet`, `ask`, or `unknown` | ∅: the act carries no content | ∅ |
| An `external` episode | `human-external` and the taints the injection declares | ∅ |
| A relationship | The union of the `tn` of the records an operation cited for it | — |
| A new belief | The union of the `tn` of what it cites, plus `model-prior-suspect` when it cites nothing | `exposure` ∪ the `ex` of what it cites |
| A revised belief | Its own ∪ the new evidence's: never smaller | `exposure` ∪ its own ∪ the new evidence's |

- `exposure` grows with the `tn` and `ex` of every message that reaches the inbox, and with the
  `tn` of every belief the being forms. It never shrinks. A message that is not delivered adds
  nothing: it was never an input.
- A belief is **reasoned** when `tn ∪ ex = ∅`. Lineage is exact; exposure is strict and cannot be
  avoided by what a brain cites or by rephrasing a proposition.
- **Taints flow downstream.** When the taints of a record grow (a revision, a `relate` that cites a
  tainted record), every belief that cites it, directly or through other beliefs, takes them too, in
  the same decision or delivery, visiting beliefs by increasing id: one pass, since a belief only
  cites beliefs of a lower id, over at most `mind.beliefs` beliefs. `mind.provenance` records each
  growth. A belief's taints therefore always contain those of everything it cites now.
- A chunk is invalid if any belief has a `tn` or `ex` that does not contain the union over the
  live records it cites, so not even a crafted snapshot holds an unclosed taint; a legal world
  always satisfies it, because of the flow above.
- When a cited record is forgotten or displaced, its id leaves `ev`, `lost` grows, and the ledger
  records the link; `tn`, `ex`, `src`, and `who` stay in the belief.

**The ledger.** Every change of a mind emits events (see [Events](#events)); the events of a tick
enter its checksum, and T7 persists those checksums by batch, so the ledger is tamper-evident. The
state keeps summaries; the ledger keeps the whole provenance graph, which a test oracle rebuilds.
T7 must never prune these events.

**Hidden channels.** A brain can keep information outside its records: `behavior.kind`, the cells of
its cooldowns, the steps of a plan, the thresholds of `wakeWhen`, and the values it proposes. In
`beings@2`, `behavior.kind` is one of the behaviors the brain declares when it is captured. The rest
cannot be removed without removing behavior; `ex` covers them, because it does not depend on what a
belief cites.

**Limits.** A brain that hides a tainted premise can make `tn` name the wrong kind of taint, never
an empty one when `ex` is counted. Influence through the world, such as following a being that was
told something, is not traced. The whole-decision ablation of `mind@1` is a property of that brain,
not a guard against hostile ones.

## Beliefs

An intention of `beings@2` may carry `mind`, with at most `mind.ops` operations in all:

| Operation | Effect |
|---|---|
| `remember: [{ percept, w }]` | An episode from a percept of this decision, copied by the engine: `{ being: index }`, `{ heard: index }`, `{ food: cell }` within the window, or `{ outcome: true }` |
| `recall: [id]` | Refreshes an episode |
| `believe: [{ p, cr, ev, rule }]` | A belief citing live records; adopting a proposition already held revises it |
| `revise: [{ id, cr, ev }]` | New confidence, and new evidence added |
| `drop: [id]` | Removes a belief |
| `relate: [{ who, aff?, tr?, because }]` | Changes a relationship, citing in `because` one to three live records, at least one of which involves `who` |

At a decision, in this order:

1. the engine forgets what has faded by now, and updates familiarity, creating a relationship for
   each perceived being and each speaker heard that has none (affinity 0, trust 500): first the
   perceived beings in the order attention keeps them, then the speakers of the inbox by increasing
   id, each evicting by the rule above when the store is full, or getting none when that rule
   keeps every relationship the store holds. Hearing is no co-presence: a
   speaker's relationship records that no perception happened, `seen` 0, and hearing a speaker
   the mind already knows changes nothing;
2. the brain decides on the view of that mind;
3. the operations apply in this order of kinds: `remember`, `recall`, `believe`, `revise`, `drop`,
   `relate`, each kind in the order given. New records take the ids `next`, `next + 1`, and so on in
   that order, so a brain cites a record created in the same decision by the id it predicts from
   `next`.

The operations are atomic: if any fails, the intention is rejected with that operation's reason and
no operation applies; what step 1 did stays, because it is a law, not a proposal.

- A belief may cite episodes and relationships of any id, but only beliefs of a **lower** id, so
  support cannot be circular. Its depth is one more than the deepest belief it cites, 1 when it
  cites none, at most `mind.depth`. Depth follows the live citations, so it falls when a cited
  belief leaves. An operation is refused when it makes a belief, new or held, deeper than it was and
  deeper than `mind.depth`; a belief already deeper does not stop an operation that leaves it no
  deeper. A new belief's depth is judged as it is formed, before its store admits it, so a full
  store that would evict it, or its premise, changes nothing.
- `revise` must cite at least one record it did not cite before; `ev` keeps the three most recent
  citations, those of the operation last, in the order given, and the ledger records any it drops.
  `src`, `tn`, and `ex` keep what the dropped ones brought.
- Citing a `food`, `being`, `ate`, or `failed` episode is evidence seen; a `heard` one, told; an
  `external` one, external; and a belief or a relationship, inferred. `who` becomes the speaker of
  the last `heard` episode an operation cites.
- A new belief that its full store evicts at once still takes its id, so a brain's predictions from
  `next` hold. Once ids have run out, `believe` is `mind_malformed`, and a perception of a being
  with no relationship creates none.
- A record **involves** a being when it is a `being` or `heard` episode whose `who` is that being,
  or a belief whose `who` is that being.
- Validation receives the decision's **manifest**: in T5 the whole live mind; in T9 the context of
  the prompt, where citing a record outside it will add `model-prior-suspect`.
- `rule` names the brain's rule, at most 32 characters, for the ledger. In `mind@1` each belief
  operation is the output of an exported pure function of the records it cites, the being's
  traits, and the laws of its species, and of nothing else.

| Failure | Reason |
|---|---|
| A member, a count, a bound, or a grammar of the operations | `mind_malformed` |
| A percept, record, or being that the mind does not hold | `unknown_record` |
| A belief citing a belief of a higher or equal id, or a `revise` with nothing new | `premise_order` |
| Deeper than `mind.depth` | `depth_exceeded` |

How the engine reads and applies them (T5-5a):

- **Order of the checks.** Before the intention is copied, every list and record of its `mind` is
  bounded from its length: more than 256 entries in all, a string or key longer than 64
  characters, or a length that is not a count, is `mind_malformed`, since no legal operations hold
  that. Then a value that is not canonical, or a body of the wrong shape, is `malformed`; operations
  of the wrong shape, count, bound, or grammar, `mind_malformed`; then `walk_not_first` and
  `walk_blocked`; and last the operations apply, in their order, and the first that fails gives its
  reason. Within one operation: a `remember` of a percept that does not exist is `unknown_record`,
  before ids that have run out, `mind_malformed`; a `recall` or `drop` of a record not held,
  `unknown_record`; a `believe` or `revise` citing a record twice is `mind_malformed`, then one not
  held `unknown_record`; a `believe` once ids have run out is `mind_malformed`, before its depth,
  `depth_exceeded`; a `revise` of a belief not held is `unknown_record`, then `premise_order`,
  then `depth_exceeded`; and a `relate` reads as its grammar `who`, an entity id, `aff` and `tr`,
  signed changes each at most `relations.delta` either way, and `because`, one to three ids, all
  `mind_malformed` otherwise, then applies: an id cited twice is `mind_malformed`, one not held
  `unknown_record`, a being with no relationship `unknown_record`, and citations of which none
  involves `who` `premise_order`.
- **Percepts.** `{ being: i }` is the i-th being perceived, in the order attention keeps them;
  `{ heard: i }` the i-th message heard, in the order of the inbox, a `heard` episode of a known
  speaker's message and an `external` one of an injection's, with the message's content and taints;
  `{ food: [x, y] }` a cell of the
  window, which a cell outside the world never is; and `{ outcome: true }` a `failed` episode when
  the outcome's result is `failed`, whose reasons are exactly those a `failed` episode indexes, an
  `ate` episode when the outcome holds `units`, 0 included, saturating at 2^20, the largest value
  an episode holds, which a meal under valid laws may pass, and no percept otherwise. An episode
  happens at the tick of the decision, one of the outcome at the outcome's tick; `r` is now, and `w`
  is the brain's, within the pins. Anything else the episode holds the engine copies from what it
  perceived, never from the brain.
- **Grammars.** `rule` is an identifier, as a behavior is: 1 to 32 characters, a lowercase letter
  first, then lowercase letters, digits, `.`, `_`, or `-`. A brain forms only concepts of the
  namespace it declares, or `obs.` followed by an id of the catalog of observables; the namespace
  `obs` is reserved for those, and the capture refuses a brain that declares it. `recall` may name
  an episode more than once, each time refreshing it from its salience then.

A brain of `beings@2` declares, besides its version and its `decide`, `behaviors`, the 1 to 16
identifiers its `behavior.kind` may take, and `concepts`, the namespace of its concepts; the capture
refuses one without them. `utility@1` runs on `beings@2` as the mindless baseline through a test
helper that adds its five behaviors and no concepts, under its own brain version: it declares the
namespace `none`, which defines no concept.

## Relationships

Familiarity is a law. At each perception of `who`, if the seconds since `seen` are at most
`relations.gap`, they are added to `f`, exactly, with no rounding; after a longer absence `f`
decays over the whole absence and nothing is added; then `seen` becomes now. The first perception
adds nothing, the first after a message included: a relationship a message created holds `seen` 0,
and its first perception only sets `seen`, since the time since the message was never co-presence.
A chunk is invalid if a relationship with `seen` 0 holds an `f` other than 0. A full store ranks
such a relationship as seen longest ago. So a brain that decides every tick earns no more than one
that decides every minute while the other stays in view, and familiarity lost to an absence stays
lost. A relationship exists only after a percept or a message of that being. It also holds the
quotas of speech to that being, `talk` and `turns`, so a full store never evicts one the mind
addressed within `max(speech.gap + 1, speech.cooldown)` seconds ("Time, salience, and forgetting"):
evicting it and meeting the being again would reset a conversation or its cooldown. Affinity and
trust change only by `relate`, by at most `relations.delta`, and the relationship takes the `tn`
of what it cites. Knowing someone is familiarity; trusting its claims is a judgment the brain makes
by checking its testimony against what it later sees.

How the engine applies them (T5-5b): `relate`'s `aff` and `tr` are signed changes, absent meaning
0, and each result saturates at its bounds, −1000 to 1000 and 0 to 1000. The relationship's `tn`
becomes its own united with the `tn` of every record the operation cites, so it never shrinks, and
flows downstream like a belief's; a relationship has no `ex`, and relating grows no exposure. The
records it cites are refreshed as any citation refreshes them. A record created in the same
decision may be cited, a `being` episode that a `remember` of that decision made among them, since
`relate` applies last.

The key is an entity id, so other species, and future human avatars, fit without a new structure.
Speech from a human avatar will carry `human-external` because of the kind of its controller (T9
and later).

## Speech

| Act | Content | When the being decides it |
|---|---|---|
| `greet` | — | The hearer was perceived in this decision, at distance at most `speech.range`, and its activity is not `sleep` |
| `ask` | A concept the species perceives: the `obs.` id of its food deposit | As for `greet` |
| `tell` | One of its beliefs: the engine captures its proposition, its confidence band (≥ 800: 2; ≥ 500: 1; else 0), its `tn`, and its `ex` united with the speaker's `exposure` at that decision | As for `greet`, and the belief exists |
| `unknown` | — ("I do not know") | As for `greet` |

A `talk { to, act, about? }` step lasts `speech.actMs`, counts as idle for the needs, and is always
the last step of its intention, so the being decides when it ends. The
captured content lives in the activity as a C3 member the senses never copy. The quotas: at most
`speech.perDay` acts per simulated day, and at most `speech.turns` acts to the same hearer in a
conversation, which ends after a pause longer than `speech.gap`; after a full one, the pair keeps
`speech.cooldown` before the being addresses that hearer again. A failed quota or condition is the
rejection `talk_unseen` (the hearer was not perceived in this decision), `talk_out_of_range`,
`talk_asleep` (the hearer sleeps), `talk_unheld` (no such belief), `talk_quota`, or `ask_concept`
(a concept the species does not perceive). Hearing does not interrupt a being that is talking: its
inbox waits for the decision at the end of the act, which every act reaches.

How the engine applies it (T5-6):

- **The step.** A talk is the only step of its intention: one with any other step is `malformed`,
  so its conditions are judged where the act starts, and its content is captured when it starts.
  `to` is an entity id; `act` one of `greet`, `ask`, `tell`, and `unknown`; and `about` the local id
  of the belief a tell tells, the concept id an ask names, and absent for the other two acts; any
  other shape is `malformed`. The concept a species perceives is `obs.deposit.<k>`, the observable
  of the deposit its diet eats. An ask carries no content: its concept is the one its species
  perceives, so its message holds none, and a hearer hears the act.
- **The judgment.** It comes after the mental operations, against the mind they leave and the
  beings perceived in the decision, so a brain may tell a belief it forms in the same decision, by
  the id it predicts from `next`, and the captured `ex` holds the exposure those operations grew.
  The checks run in this order, and the first that fails is the reason, which rejects the whole
  intention, its operations included: `talk_unseen`; `talk_out_of_range`, by Chebyshev distance;
  `talk_asleep`, when the hearer's perceived activity is `sleep`; `talk_unheld`, for a tell of a
  record that is not a belief the mind holds, or `ask_concept`; and `talk_quota`.
- **The quotas.** An accepted act counts at once: one more in `quota.said`, in the day of the
  decision, and, in the relationship with the hearer, `talk` set to the tick of the decision and
  `turns` to the act's place in its conversation: 1 when the being never addressed that being or
  paused longer than `speech.gap`, or when `speech.cooldown` has passed, at least, since a full
  conversation; `turns + 1` otherwise; and while a full conversation cools down, the act is
  `talk_quota`. So is an act beyond `speech.perDay`, and one to a being the mind holds no
  relationship with after step 1: ids ran out, a full store kept no room for it because the mind
  addressed every being it holds within the window of the store's rule, or a later perception or
  speaker of the same step 1 evicted it. An act counts whether or not it is later cut short or
  heard.
- **The activity.** `{ kind: "talk", start, to, act, captured }`, where `captured` is
  `{ p?, band?, tn, ex }`, a tell's content and taints, and `{ tn: 0, ex: 0 }` for the other acts.
  `talk` comes last in the list of kinds of activity of `beings@2`, after those of T4, whose index
  a `being` episode holds. A plan never holds a talk. A chunk is invalid if a talk captured content
  its act cannot carry: a tell without a proposition and a band, or another act with any content
  or taint; if a plan follows a talk, which is the only step of its intention; or if a talk is
  addressed to the being itself.
- **The end.** The act ends at `start + ⌈actMs / (seconds per tick · 1,000)⌉`; at that tick the
  being says what it captured, `speech.uttered`, and decides. Physiology comes first at every tick,
  so forced sleep, incapacity, or death at that tick, or before it, cut the talk short:
  `being.finished` with the result `interrupted` and the reason `exhausted` or `incapacitated`, or
  only `being.died`. Becoming incapacitated cuts a talk as it cuts a walk; an incapacitated being
  may still start one, since incapacity, as in T4, stops only locomotion. No wake condition
  interrupts a talk.

Delivery, when the act ends at tick t:

1. **Phase 2,** from the state at the start of t: the hearer exists, is within `speech.range`, is
   not asleep, and is not incapacitated. The speaker decides at the end of its act, so the hearer's
   chunk is among those its window reads, and finding the hearer reads nothing more. A talk cut
   short by forced sleep, incapacity, or death delivers nothing.
2. **Phase 3:** a hearer that died at t hears nothing; when more messages reach a hearer than its
   inbox has room for, its speakers, by increasing id, are ordered by `random.permutation` on the
   stream `beings.speech`, keyed by the hearer's id, and the first fill the room; the rest are not
   heard.
3. **Phase 4:** each message merges into the hearer's final record, found by binary search, in
   order of speaker id, before its chunk's `due` is computed; the hearer's chunk is written; its
   `exposure` grows; and it wakes at t + 1 only if its activity is `idle` and
   `quota.woken < speech.wakesPerDay` in the day of t. A hearer that walks, eats, or sleeps keeps
   the message for its next decision: hearing interrupts no meal and no walk.

How the engine delivers it (T5-6):

- **Phase 2.** The hearer is found by binary search among the beings of each chunk the window of
  the speaker's decision at the end of its act read. It is not heard, with the first reason that
  holds: `gone` when none of those chunks holds it, because it died before t or left them; `range`
  beyond `speech.range`, by Chebyshev distance from the speaker's cell; `asleep`; `condition`.
- **Phase 3.** A hearer that died at t is `gone` for the acts that reached it in phase 2. Its room
  is its species' `mind.inbox` less the messages its mind holds at the end of t: a hearer that
  decided at t consumed its inbox, and a loser of the contest for room holds the mind it started
  the tick with. When no room is left, every message is `full`, without a draw.
- **The message** is `{ who, t, cell, act, p?, band?, tn, ex }`: the speaker, the tick of the
  delivery, the speaker's cell, and what its talk captured. A greet, an ask, and an unknown carry
  no content and no taint.
- **Phase 4.** A hearer processed at t takes its messages in its final record, whose wake follows
  the rule of a hearer; the record of a hearer the tick did not process is written anew in its
  chunk, with its messages and, when the rule wakes it, a wake at t + 1 at the latest. Its chunk is
  among those the tick writes, and its `due` follows.
- **Events.** After those of phase 3, for each hearer by increasing id and each of its speakers by
  increasing id: `speech.delivered`, followed by `mind.provenance` `{ id, records: [], exposure }`
  of the hearer when that message grew its exposure; or `speech.unheard` with its reason.

The speaker learns nothing about whether it was heard, so a hearer's `condition` never leaks. The
templates of `speech@1` (`packages/agents`, pure, versioned) render acts for logs and for T6's feed;
a test checks that no template seeds a target topic (plan §K.4), which restricts what we inject, not
what inhabitants think. `renderAct` writes an act as `speech.uttered` reports it, in English: the
speaker and the hearer, as "being" and their id unless the caller names them; a greet, an ask for
food, an "I do not know", or a tell with its confidence (sure, fairly sure, unsure, by band) and its
claim. The claim is the food of a cell, or near it, only for a proposition of the shape the table
of `prop@1` gives those concepts: one cell as its term, no negation, and a band from 0 to 2 as the
value of `m1.food-at` and no value for `m1.food-near`; any other proposition is written as its
concept id, its terms, and its value, negated when it is a negation. The audit renders every act,
band, negation, and kind of term and
finds no consciousness, creator, simulation, or external reality, nor AI, game, player, or server;
an inhabitant's own concept, whatever it names, is written as it is.

## The tick of `beings@2`

1. `collectDue`, as in T4.
2. `advance`, by id, over the state at the start of the tick: physiology and arrivals; the delivery
   of a talk that ends; and, at a decision, the senses, the percepts, and the view, then `decide`,
   called without `this`, the validation, and the new mind from `src/mind`.
3. `resolveClaims` for food; then the **contest for room**: a chunk has as free places `capacity`
   less the beings it holds when the beings system starts, after the commands of the tick (spawns
   included), since a departure frees no place until the next tick. When more beings arrive than it has free places, the arrivals, by increasing id, are ordered
   by `random.permutation` on the stream `beings.crowd`, keyed by the lowest arriving id, and the
   first take the places. The rest end their walk at the cell they started the tick in, which their
   own chunk still counts, with the result `failed`, the reason `crowded`, an idle of 1 ms, and a
   wake at t + 1. A loser keeps nothing of its decision of that tick: a walk whose last step arrived
   at t ended in phase 2, where the being decided at its new cell, and that intention is discarded,
   with its plan, behavior, wake conditions, and cooldowns, and from T5-5a on the mental operations,
   forgetting, and familiarity of that decision, so its mind is the one it had at the start of the
   tick; it decides again at t + 1 from its start cell. The events of that decision and of its walk
   are dropped too (`being.finished` of the walk that ended, `being.started`,
   `being.intention_rejected`, and from T5-5a on `mind.*` and `speech.uttered`) and replaced by the
   single `being.finished` of its walk, with the result `failed` and the reason `crowded`, which the
   contest for room emits. The events of its body, facts of L0 rather than of the decision,
   `being.exhausted`, `being.incapacitated`, `being.recovered`, and `being.died`, stay in their
   phase-2 order, and its record matches the events it keeps: its condition, and a forced sleep its
   body put it into at t, which it keeps at its start cell, `{ kind: "sleep", forced: true, … }`
   with the plan `[]` and the wake conditions `{}`, together with that sleep's `being.started`. So
   `beings@2` holds each being's events of phase 2 until that contest, then emits them in the order
   below. Then deliveries are resolved.
4. `applyWorks`: the final records, where an unchanged mind is the same value, not a copy; then the
   deliveries; then `due` and the occupancy.
5. Events: those of phase 2 by being id, each being's in the order T4 emits them, then its
   `mind.changed` and `mind.provenance`, then its `speech.uttered`; those of phase 3, contests by
   place as in T4, then the contest for room by chunk key; those of phase 4, deliveries by hearer
   id, then speaker id.

A being's mind is copied only when it decides. A spawn into a chunk at `capacity` is rejected with
`invalid_spawn`.

## Versions and compatibility

`createBeingsRuleset({ controllers })` stays `beings@1` with `life@1`, byte for byte.
`createBeingsRuleset({ controllers, rules: "beings@2" })` requires `life@2`; `rules: "beings@1"` is
the same as no `rules`, and any other value is refused with `invalid_ruleset`. Each version is one
immutable object of rules with its own lists: the members of a being, the kinds of activity, the
validators. They differ in `ruleset.ts`
(`readTraits`, `newBeing`, `globalIssues`, the capture), `being.ts`, `chunk.ts`, `laws.ts`,
`env.ts`, `advance.ts` (`workOf`, `carryOn`, `sensesOf`), `intention.ts`, `body.ts`,
`resolve.ts` (`finalBeing`, `activityTick`, `applyWorks`), and `beings.beingIssues`.

| Version | Content |
|---|---|
| Ruleset | `beings@1` unchanged; `beings@2` new |
| Laws | `life@1` unchanged; `life@2` new |
| Brain | `s1:utility@1` unchanged; `s1:mind@1` new |
| Propositions, speech | `prop@1`, `speech@1` |
| Kernel | `ENGINE_VERSION` 0.1.0, snapshot version 1: unchanged |

`beings@1` changes only where a world faulted or a host was misconfigured, so no valid history
changes: a spawn into a chunk that holds 65,536 beings is rejected with `invalid_spawn` instead of
poisoning the world, and the capture refuses a `decide` that is an async function or a generator
(T5-2). `beings@2` also treats a result of `decide` that is not a plain record, a promise among
them, as a code error that poisons the world, and calls `decide` without `this`. An intention with
a member that is not canonical is still rejected as `malformed` in both. The engine cannot handle a
promise (it may not name `Promise`), so the host's contract (T6) must handle rejections it leaves
unhandled.

Before any code changes, T5-2 adds goldens computed on `6fa7375`: digests of the per-tick checksums
of T4's fuzz seeds, of T4's determinism subject, of `countedRun`, and of the default and `heldout/1`
runs of the survival child, which already runs them. Every T4 test runs unchanged.
[Determinism](determinism.md) needs no change: its suite rules apply to `beings@2` as written.

## Events

| Event | Class | Payload |
|---|---|---|
| `speech.uttered` | C0 | `{ id, to, act, p?, band?, cell }`, when an act ends without being cut short: the speaker, the hearer, the act, a tell's proposition and band, and the speaker's cell |
| `speech.delivered` | C1, the hearer's | `{ id, to }`: the speaker and the hearer |
| `speech.unheard` | C3, because its reason tells the hearer's condition | `{ id, to, reason }`: `range`, `asleep`, `gone`, `full`, or `condition` |
| `mind.changed` | C1 | `{ id, encoded, formed, revised, dropped, forgot, related }`: ids, with each formed belief's rule and each forgotten record's citing beliefs |
| `mind.provenance` | C3 | `{ id, records, exposure }`: the `tn`, `ex`, and evidence of each record created, revised, or tainted downstream, and the being's exposure |
| `mind.injected` | C3 | `{ id }`, for an accepted `mind.inject` |

A decision with changes to a mind emits one `mind.changed` and one `mind.provenance`. A decision
changed a mind when the mind it leaves is not the one it held, a recall alone included, which
changes `w` and `r`; both events are emitted then, even when every list is empty. `forgot` lists,
each with the beliefs that lost it, every record that left the mind but by `drop`: those that faded
at step 1, by increasing id, then those a full store evicted, in the order of the operations.
`mind.provenance` lists `{ id, tn, ex, ev }` for each live record the decision created, revised,
related, or tainted downstream, by increasing id, an episode with `ev: []`, and `exposure` after the
decision; the `ev` of a revised belief records the citations it pushed out, those of its previous
`ev` it no longer holds. `related` lists, by increasing id, each relationship the decision created
at step 1, one a full store evicted at once included, and each one a `relate` changed; a
relationship's entry in `mind.provenance` has `ex: 0` and, as `ev`, the records its `relate`
operations cited, `[]` when it was only created. Familiarity, a law recomputed from perception, is
not in the ledger. A delivery emits `speech.delivered`, and a `mind.provenance` when it changes an
exposure; an accepted injection emits `mind.injected` and a `mind.provenance`. Every change of a
mind is therefore in the ledger.

## Commands and faults

`mind.inject { being, cell, p, taints }` is admin-only: it adds an `external` message to the inbox
of the being at `cell`, so the engine never searches the world for it, with `human-external` always
among its taints. Commands apply before the systems of their tick, so the being wakes at t + 1 under
the rule of a hearer, without spending its daily wakes. Rejections: `admin_only`, `not_found`,
`full`, `invalid_inject`.

How the engine applies it (T5-5b): the payload has exactly those members, which the kernel already
bounds at 8 KiB of canonical text: `being` an entity id; `cell` a cell of the world; `p` a
proposition of `prop@1` by `mind.checkProposition`, of any namespace; and `taints` a mask from 0 to
7; anything else is `invalid_inject`, with every issue in its details. The being is found by binary
search among the beings of the chunk of `cell`, and must stand at that cell, or it is `not_found`;
an inbox holding `mind.inbox` messages is `full`, so the injections of one tick count as they
apply. The message is `{ t, act: "tell", p, tn, ex: 0 }`, `t` the tick and `tn` the declared taints
with `human-external`; the being's exposure grows with it at once. The rule of a hearer, which
speech (T5-6) shares: messages that reach the inbox at tick t wake the being at t + 1 when its
activity is idle and its quota counts fewer than `speech.wakesPerDay` wakes by hearing in the day
of t; at t + 1 its idle is interrupted, `being.finished` with the reason `heard`, and it decides.
The check holds at the delivery, for its wake, at the end of t, for a being processed at t that
did not decide then, and at t + 1, where the being is woken; all three judge the day of t, the
delivery's, even when t + 1 begins another. A wake by hearing counts one in `quota.woken`, in the
day of t, when a message of a speaker reached the inbox at t; an injection's message wakes the
being under the same check and counts nothing. Only a wake that interrupts the idle counts: a
being whose idle ends at t + 1, or whose wake condition holds then, decides anyway, and the
reason of its `being.finished` names that. A being that walks, eats, or sleeps keeps the message
for its next decision.

An intention or operation that fails validation is a rejection, the being's experience: `malformed`,
`mind_malformed`, `unknown_record`, `premise_order`, `depth_exceeded`, `talk_unseen`,
`talk_out_of_range`, `talk_asleep`, `talk_unheld`, `talk_quota`, `ask_concept`. `beings` copies
brain output with `copyCanonicalReported`, which refuses accessors and reads a Proxy only through
its own data properties, refusing one that throws; it reads every length once and bounds it before
iterating, refusing one that misreports a length, and requires exact members, NFC strings, and the
grammars above.

## Classification

| Class | What T5 adds |
|---|---|
| C0 | The `talk` activity, its hearer, and its act; `speech.uttered` |
| C1 | Episodes, beliefs, and relationships without their taints; the inbox; the three traits; `mind.quota`; `mind.changed`, `speech.delivered` |
| C3 | `tn`, `ex`, `exposure`; the episode kind `external` and the evidence bit 8; the captured content of a talk in progress; `speech.unheard`, `mind.provenance`, `mind.injected`, `mind.inject`; the laws of `life@2`; reference truth |

The events and the command of T4 are classified too: `being.spawned`, `being.started`, and
`being.died`, which an observer could see happen, are C0; the other `being.*` events, the being's
own experience and body, are C1; and `beings.spawn`, an admin command, is C3.

Taints are C3, not C1, because C1 may reach the inhabitant itself
([0008](../decisions/0008-data-classification-and-audience-projections.md)), and an inhabitant
must never see them. A classification registry in code covers every member, nested ones included,
every event, and every command; a test fails when a member has no class, and the allowlist of the
senses is derived from it. T6 builds its projections on it.

## The brain `mind@1`

`mind@1` lives in new files of `packages/agents/src/brain` and leaves `utility@1`, `parameters.ts`,
and `freeze.test.ts` untouched. It keeps `utility@1`'s behaviors for survival and adds:

- going to food it remembers or was told about, when none is in sight;
- greeting a being it meets or meets again, asking for food when hungry and knowing none, telling
  food it believes to a being that asks or that it knows, answering "I do not know", and waiting a
  moment, idle, for an answer;
- revising a belief when what it sees contradicts it, and changing its trust in a speaker by what
  its testimony turned out to be.

Each belief operation is an exported pure function of the records it cites, the being's traits,
and the laws of its species. Retrieval ranks records by age, importance, and relevance (plan §K.3)
in one pass. Traits modulate it: sociability its will to speak, credulity the confidence it gives
to testimony, retention its memory. A message whose speaker is not visible is weighed as one from a
being it does not know, with the trust of a new relationship.

### How `mind@1` decides (T5-7)

`mindController({ species, dayLength })` builds the brain for a species of `life@2` in a world whose
day lasts `dayLength` seconds; it copies the laws it reads when it is built, and refuses a day that
is not a positive whole number of seconds. Its version is `mind@1`, its namespace `m1`, and its
behaviors the five of `utility@1` and `seek`, `approach`, `talk`, and `wait`: `behavior.kind` holds
one of them, cooldowns hold what `utility@1` puts there, and no other channel carries anything
between decisions. Its code is in `packages/agents/src/brain/mind.ts` and `mind/`; its parameters
are in `mind/parameters.ts`.

**Composition.** At every decision it asks `utility@1` for its plan. When the plan is to forage, eat,
or sleep, a need wins: the plan stands and only mental operations are added. Otherwise, in this
order: a reply to what it heard; after its own act, `behavior.kind` `talk`, an idle of
`min(60 s, speech.gap)` that waits for an answer, with the plan's wake conditions; when the plan is
to explore and the being is hungry as `utility@1` feels it (a search), a walk to food it believes in
beyond its window, else an ask, else the search; and when sated, as it wills, a greet, else a walk
toward a being to greet it. Each of its walks and its wait keeps the plan's wake conditions and
cooldowns, and its heading; a talk has no wake condition, since none interrupts it. After any of its
own behaviors, `utility@1` sees a behavior it does not know, so it holds no commitment then.

**The concept and its rules** (`mind/rules.ts`). `mind@1` forms only `m1.food-at`: one cell as its
term, a band 0 to 2 as its value, never a negation. Each belief operation is its rule applied to the
records it cites, reading only their content (an episode's kind, cell, speaker, value, act,
proposition, and band, a relationship's being and trust), never an age or an importance:

| Rule | Cites | Forms |
|---|---|---|
| `seen-food` | one `food` episode | its cell at its band, confidence 900 |
| `told-food` | a `heard` episode of a `tell` of `m1.food-at`, then, when the being holds one, the relationship with its speaker | the claim told, confidence `min(1000, ⌊[300, 600, 800][band] · (500 + trust) · credulity / 10^6⌋)`, the trust 500 of a new relationship when no relationship is cited, and band 1 for a message with none |
| revision | one `food` episode of the belief's cell | confidence 900 when it shows the believed band, 100 when it shows another; the belief's own confidence is not read |

A message whose speaker is not visible, an injection, is a `heard` episode with no speaker, so it
cites no relationship and weighs as a stranger's at band 1. A checked testimony changes the trust in
its speaker by `min(100, relations.delta)` up when the cue shows the claimed band, down otherwise.

**Memory** (`mind/memory.ts`, `mind/operations.ts`). Each decision proposes, by priority and each
only whole: a **testimony**, the first `tell` of a food claim it does not hold whose `told-food`
confidence is at least 500, remembered (importance 600) and believed; a **check**, by retrieval, of
a belief whose cell the window shows with another band, or with its band when the belief's
confidence is below 900, remembered (importance 500) and revised, and, for a belief told by a being
it holds a relationship with, `relate` with the trust change, citing the belief and the cue; a
belief contradicted again at confidence 100 or less is dropped instead; a **forgotten** food, the
one it could walk no nearer to; a **landmark**, the window's best cue (highest band, then nearest,
then first by index) farther than 12 cells from every food it believes in at 500 or more, not
cooled, and not believed at that band already, remembered (importance 500) and believed by
`seen-food`; and the **being it meets**, the hearer of its act, remembered (importance 400). The
whole stays within `mind.ops` and the ids left, and cites nothing a full store would evict first:
the brain predicts each store with the engine's law of salience, as the engine fills it.

**Retrieval** (`mind/retrieval.ts`) scores a record `⌊1000·H / (H + age)⌋ · importance · relevance`,
`H` the half-life of a belief scaled by retention, in one pass; ties go to the lower id, and a score
of 0 is never retrieved. Food to seek: beliefs of band 1 or 2 at 500 or more, beyond the window and
not cooled, importance their confidence, relevance `⌊1000·R·band / (2·(R + d))⌋` for a window of
radius R and a distance d. A belief to tell: the same beliefs but not told by the hearer, relevance
`500·band`. A belief to check: importance `max(cr, 1000 − cr)`, relevance 1000 when contradicted
and 500 when confirmed.

**Walks** (`mind/paths.ts`) search the window once with Dijkstra. Seeking food walks to the
reachable cell nearest the believed cell, by Chebyshev distance, then by the shortest route; when
that is where the being stands, it forgets the belief and searches instead. Approaching walks to the
reachable cell within `speech.range` of the being, not its cell, by the shortest route, toward the
nearest perceived being it would greet, awake and not walking, beyond `speech.range` and within
`⌊8 · sociability / 1000⌋` cells; never twice in a row.

**Speech** (`mind/social.ts`). The brain senses neither the tick nor its quota, so it keeps every
quota by a budget it counts in its relationships. With the talk window `W = max(speech.gap + 1,
speech.cooldown)`, it addresses a being only when it never did, within its conversation (a pause of
at most `speech.gap` and fewer than `speech.turns` acts), or once `W` has passed, so all its acts
to a being in the last `W` seconds are the `turns` of one conversation, and the engine never evicts
that relationship within `W`. It speaks only while those turns sum to less than
`⌊speech.perDay / ⌈dayLength / W⌉⌋`, 2 with the defaults, so no day holds more than
`speech.perDay` acts and no act is ever `talk_quota`. A hearer is perceived, within `speech.range`,
not asleep, and held in a relationship. The acts:

- a **reply**, to the first message it answers, in the order heard: an `ask`, with a `tell` of the
  food it believes most, by retrieval, or `unknown`; a `greet` that opens a conversation, with a
  `greet`; its own greet answered, or a `tell` while it has said at most one act of the
  conversation, with a `tell`, as it wills;
- an **ask** for its species' food (`obs.deposit.<k>`), when searching with no food to seek, to the
  nearest being it may address;
- a **greet**, when sated and as it wills, of the nearest being it meets or meets again: one it never
  addressed, or not within `W`.

It wills an act when `draws[1] mod 1000` is below `min(1000, ⌊800 · sociability / 1000⌋)`. It tells
a belief that no operation of the same decision changes or evicts.

## Preregistration

Registered before any calibration. Every choice below is fixed: none is left to the pull request
that implements it.

### Seeds and scenario

The rule of [T4](beings.md#seeds) with the labels of T5:

| Set | Labels | Use |
|---|---|---|
| Default | `open-origin/t5/default` | The evaluation in CI |
| Calibration | `open-origin/t5/calibration/1` to `/4` | Calibrating the laws of `life@2` and `mind@1`, and nothing else |
| Held out | `open-origin/t5/heldout/1` to `/6` | Evaluation: `/1` in CI, all six in the soak |
| Reserve | `open-origin/t5/heldout/7` to `/12` | Replacement after a burn |
| Bench | `open-origin/t5/bench` | The benchmark; measuring on it burns nothing |

The scenario is [T4's](beings.md#scenario) with the default laws of `life@2` and the brain
`mind@1`. Each being draws, in this order: its cell, nutrition, rest, appetite, sleepiness,
curiosity, sociability, credulity, and retention, the last three within their bounds.

The spawn areas, computed with the rule of T4 on `worldgen@1` before any law of mind existed:

| Label | Coverage (cells of 2^20) | Area needs | Center chunk | Land cells | Food cells |
|---|---|---|---|---|---|
| `default` | 50,666 (4.83%) | 446 | (0, 0) | 9,071 | 2,034 |
| `calibration/1` | 83,737 (7.99%) | 736 | (0, 0) | 9,216 | 909 |
| `calibration/2` | 71,377 (6.81%) | 628 | (−3, 3) | 9,216 | 1,295 |
| `calibration/3` | 100,314 (9.57%) | 882 | (−5, 3) | 9,216 | 929 |
| `calibration/4` | 73,110 (6.97%) | 643 | (0, 0) | 9,216 | 6,220 |
| `heldout/1` | 110,492 (10.54%) | 972 | (0, 0) | 9,216 | 9,216 |
| `heldout/2` | 68,739 (6.56%) | 605 | (2, 5) | 9,216 | 927 |
| `heldout/3` | 54,948 (5.24%) | 483 | (−12, 10) | 6,980 | 643 |
| `heldout/4` | 97,076 (9.26%) | 854 | (−3, −7) | 5,132 | 2,217 |
| `heldout/5` | 74,556 (7.11%) | 656 | (−2, 16) | 5,974 | 893 |
| `heldout/6` | 74,492 (7.10%) | 655 | (2, 1) | 9,216 | 1,390 |
| `heldout/7` | 64,619 (6.16%) | 568 | (1, 4) | 4,866 | 874 |
| `heldout/8` | 73,031 (6.96%) | 642 | (−4, 7) | 4,768 | 1,732 |
| `heldout/9` | 88,614 (8.45%) | 779 | (−4, 4) | 9,216 | 2,159 |
| `heldout/10` | 54,864 (5.23%) | 483 | (−13, 6) | 7,731 | 849 |
| `heldout/11` | 90,985 (8.68%) | 800 | (0, 0) | 9,216 | 1,458 |
| `heldout/12` | 110,036 (10.49%) | 968 | (5, 15) | 8,498 | 2,311 |

### Targets of calibration

Expressed in the world's day L, with neutral traits:

| Target | Range |
|---|---|
| An episode of importance 500, never recalled, is forgotten | 2 L to 5 L after it happened |
| Familiarity after 1 L of continuous co-presence | at least 500 |
| Familiarity after 10 L of absence, against before it | at most a half |
| Time a being spends talking | at most 5% of its awake time |
| The survival of T4 | every item of [T4's acceptance](beings.md#evaluation) on every calibration seed |

### Evaluation

- The laws of `life@2` and `mind@1` are calibrated on the calibration seeds only, then frozen
  together in T5-7, with `mind-freeze.test.ts` pinning the seal of the default `life@2` and a digest
  of `mind@1`'s parameters. Because much of T5's behavior is code, CI also pins the exact results of
  the evaluation; changing them burns every held-out label already evaluated, and the evaluation
  moves to the reserve.
- The held-out seeds run only in T5-9, after the adversarial work of T5-8, so that fixing a
  laundering bug burns nothing.
- Each item below is a predicate over the events of the run (the ledger), so a test computes it
  without judging:
  - a belief **from its own observations**: a `believe` that cites a `food`, `being`, `ate`, or
    `failed` episode;
  - a belief **from testimony**: a `believe` or `revise` that cites a `heard` episode of a `tell`;
  - a belief **revised down after seeing it contradicted**: a `revise` of an `m1.food-at` belief that
    lowers `cr` and cites, at the same cell, a `food` episode whose band differs from the belief's
    or a `failed` episode whose reason is `no_food` or `food_gone`;
  - **trust changed by checking a testimony**: a `relate` with a nonzero trust change that cites a
    belief whose `who` is that being and whose `src` includes told, and, at that belief's cell, a
    `food`, `ate`, or `failed` episode;
  - a **conversation**: delivered acts between one pair, at least one in each direction, each
    delivered within `speech.gap` of the one before;
  - **greeted and was greeted**: a `speech.delivered` of a `greet` with the being as speaker, and one
    with it as hearer;
  - **hungry with no food in sight**: a decision with nutrition below 500,000 and a food cue of 0 in
    every cell of the window.
- Acceptance on the default seed and `heldout/1`, over 63,000 ticks:
  - **every being** meets every item of T4's acceptance, where a rejected mental operation counts as
    a rejected intention; encoded at least one `food` and one `being` episode; formed at least three
    beliefs from its own observations; and holds at least one relationship at the last tick;
  - **the population** revised at least one belief down after seeing it contradicted; held at least
    10 conversations; every being greeted and was greeted; formed at least one belief from
    testimony; and changed trust at least once by checking a testimony;
  - **integrity:** no belief of `mind@1` has `model-prior-suspect`; the ledger oracle matches every
    taint and link; every flow invariant holds at every tick; no quota is exceeded; every belief
    operation equals its rule applied to what it cites;
  - **diversity:** at the last tick, the sets of believed propositions of any two beings differ.
- Informative hypotheses for the soak, on `heldout/1` to `/6`, recorded whatever they show:
  - **memory:** the median time from hungry with no food in sight to the next bite is shorter under
    `mind@1` than under `mind@1` with every capacity of `mind` at 0 and `speech.perDay` at 0, paired
    by label;
  - **a false claim:** at tick 6,300 (1 L), `mind.inject` gives the being of lowest id
    `m1.food-at` with band 2 at the nearest cell, by Chebyshev distance of at least 5, then y, then x,
    that is passable and has no food, with `human-external` only; it is revised below 500, or
    dropped, within 2 L on at least five of the six labels;
  - **credulity:** across the 48 beings, the share of beliefs from testimony that are false one day
    after they form, by the reference truth, decreases as credulity decreases (a Spearman
    correlation, reported with its value).
- **The ablation of whole decisions** (soak, `mind@1` only, every decision of the being of lowest id
  on each held-out label): for each belief operation, with ids kept, (a) `decide` again with the
  records it cites removed: no operation forms or revises the same proposition unless it cites other
  live records; (b) `decide` again with only the records it cites, and every input that is not a
  record: an operation with the same proposition and the same citations is among the result.
  Confidence, and believe against revise, are not compared.

## Cost

Targets, measured with the named scenarios of [T4's benchmark](beings.md#the-scale-benchmark):

- One decision of `mind@1`, end to end, by T4's method: in "dispersed 1,000", median at most 4 ms
  (T4 measured 2.96 to 3.27 ms); in "concentrated 10, 3 × 3", where beings see each other, median
  at most 5 ms.
- A wake that does not decide: in the same run of "dispersed 1,000" under `beings@1` and under
  `beings@2` with every mind at capacity, the median cost of such a wake differs by at most 150 µs.
- A sleeping being: at most 1 µs per tick, and no mental work for a being that is not due, by count.
- "dispersed 10": median at most 1 ms. "dispersed 1,000": median at most 50 ms, p99 at most 100 ms,
  and p99 hashed at most 1 MB.
- Many speaking: 1,000 beings in 500 pairs cost linearly in acts; 50 speaking to one hearer cost at
  most its `speech.wakesPerDay` decisions a day.
- **The largest mind**, which tests build exactly: every episode a `heard` episode of a `tell` and
  every message in the inbox a `tell`, each with every optional member; every belief with `who` and
  three citations; every relationship full; propositions with `neg`. With values typical of v0.1
  (coordinates −99,999, ticks 99,999,999, local ids 999, entity ids 99,999, so a proposition of
  63 B) it must stay at most 4.5 KB; measured while planning, 4,056 B. With the largest values
  (coordinates −2^31, ticks and entity ids 2^53 − 1, local ids 2^31 − 1, propositions of 96 B), at
  most 6 KB; measured, 5,711 B. A chunk at `capacity` is then at most 64 × 6.3 KB, about 0.4 MB.
  Shorter member names would save about 4%, so the names stay readable.
- If a decision or the p99 of "dispersed 1,000" misses its target, the window's edges, about two
  fifths of a decision ([beings](beings.md#the-scale-benchmark)), are optimized by a refactor that
  changes no output; a miss that remains is recorded as it is.

**The gate of the entity section.** In T5-4, before the brain exists, a benchmark brain gives every
being of "dispersed 1,000" **the gate's mind**, the record mix a `mind@1` being holds, decided here:
5 `food`, 1 `being`, 1 `ate`, and 1 `heard` episode of a `tell`; 8 beliefs of `m1.food-at`, each
citing 2 records; 6 relationships; an empty inbox, which every decision consumes; typical values and
propositions without `neg`. Its values, which tests build exactly: distinct local ids of three
digits (the records take 977 to 998, and `next` is 999); every tick 99,999,999 (`t`, `r`, `u`,
`seen`, `talk`, and `quota.day`); every cell [−99,999, −99,999]; entity ids of five digits, 99,999
and below, one per relationship; each proposition `{ p: "m1.food-at", a: [{ c: cell }], v: 2 }`. The
`food` episodes have `v` 2, the `being` episode `v` 1, the `ate` episode `v` 25, and the `heard`
episode `act` "tell", `band` 2, `tn` and `ex` 0, and no `v`; every episode has `w` 600. Each belief
has `cr` 800, `src` 1, two of the episodes 977 to 983 in `ev`, never the `heard` one, `lost` 0, `tn`
and `ex` 0, `dp` 1, and no `who`. Each relationship has `f` 3,600, `aff` 100, `tr` 600, `tn` 0, and
`turns` 1. The exposure is 0, and the quota `{ said: 5, woken: 2 }`. It measures 2,680 B, so a being
is about 3.2 KB, and the estimate from T4's 112.4 KB at p99 is about 0.7 MB, below the trigger. If
the measured p99 hashed is below 1 MB, the entity section stays in T7. If not, the capacities come
down first (the largest mind at 6 episodes, 6 beliefs, and 4 relationships measured 3,096 B with
typical values); if the smallest useful mind is still above it, T5 stops for the maintainer's
decision, because bringing the section forward changes the kernel, `ENGINE_VERSION`, and the goldens
of T2 to T4. "dispersed 10,000" already crosses it: at about 1.3 KB per being its p99 reaches 1 MB
([beings](beings.md#ceilings)), so with minds it is a ceiling outside what v0.1 supports, measured
and recorded in T5-9. For T7, the section needs one hash term per component, body and mind, so that
a step rehashes about 0.5 KB rather than about 4 KB; T5-9 measures the share of writes that change
only the body as evidence for that design.

**Measured: the gate** (2026-10-28, `bun packages/agents/bench/gate.ts`, one run at `nice -n 19` on
the Codespace, Bun 1.4.4; indicative). "dispersed 1,000" on the terrain of `open-origin/t5/bench`,
whose spawn area centers on chunk (−4, −4), built as initial chunks with every being of `beings@2`
holding the gate's mind, ran one simulated day (6,300 ticks after 100 of warm-up) under the
mindless baseline, stepped in turn with the same beings under `beings@1` and `utility@1`; both
worlds woke and decided the same number of beings at every tick, which the benchmark checks. Under
`beings@2`: 247.8 KB hashed at the median tick and 419.5 KB at p99, against 52.6 and 106.2 KB under
`beings@1`; ticks of 50.01 ms at the median and 113.28 ms at p99, against 26.74 and 68.89 ms; and a
wake that does not decide cost 486 µs against 143 µs (152 such ticks), 320 µs more paired tick by
tick. The p99 hashed is below 1 MB, so the entity section stays in T7. With full minds, the time
targets of "dispersed 1,000" are missed: the median tick of 50.01 ms misses at most 50 by 0.01 ms;
the p99 of 113.28 ms misses at most 100; and 320 µs more per wake that does not decide misses at
most 150. The cause is not yet measured: every write of a being turns its whole
chunk, mind included, into canonical text, hashes it, and validates it. T5-9 profiles that cost
before any optimization, and a miss that remains is recorded as it is.

## Verification plan

| Requirement | Pull request |
|---|---|
| Two beings in different situations form different episodes, each equal to its percept | T5-5a |
| An observation's belief traces back to a percept that matches the state of its tick | T5-5a |
| A testimony keeps its speaker, tick, and act, in the belief and in the ledger | T5-6 |
| A derived belief inherits the taints of its premises: random graphs against an oracle, and a chain of five beings | T5-3, T5-8 |
| Forgetting, displacement, adoption again, and corroboration never lower a taint | T5-3, T5-8 |
| A false injected claim changes nothing in the world; the being goes, finds nothing, and revises | T5-8 |
| Relationships change only by perceptions and delivered acts; familiarity is equal for idles of 1 ms and of 60 s, at the ticks both decide | T5-5b, T5-6 |
| Speech is refused out of reach, to the sleeping, and to the unseen; it arrives at t + 1; a hearer that died, moved out of reach, fell asleep, or has a full inbox hears nothing; quotas hold | T5-6 |
| No path to models; purity and brain-symbol scans | every pull request |
| `utility@1` on `beings@1` unchanged; `utility@1` on `beings@2` as the mindless baseline; `mind@1` meets T4's survival items | T5-2, T5-4, T5-9 |
| The determinism suite with audit, cuts at the first act, delivery, forgetting, revision, injection, contest for room, day edge, new chunk, and seeded ticks; `child-resume`; `interleave`; a fresh controller per decision; resume at mid-run | T5-8, T5-9 |
| Observers that read minds every tick change nothing; a coupled observer diverges | T5-8 |
| Fuzz with invariants at every tick and the ledger oracle; planted defects | T5-5b, T5-8 |
| The cost targets and the gate | T5-4, T5-9 |

Each planted defect must fail its test: a union of the first premise only; a revision that clears
taints; an exposure that does not grow with a belief of its own; forgetting without a ledger entry;
delivery out of reach, to the asleep, in the same tick, or waking a walker; telling a belief not
held; an observation with content from the brain; a relationship without an encounter; familiarity
by count of decisions; taints in the senses or the view; a view that shares values with the state; a
brain with memory in a closure, or that passes senses between beings of one tick; salience that
decays per decision; perception after a write; an extra chunk read; a sweep of minds per tick;
capacity checked only in phase 2; a mind copied at every wake; an observer that compacts a mind;
citing a higher id; a belief without evidence and without `model-prior-suspect`; an injection
without `human-external`; a belief operation that is not its rule; a speaker that never stops; many
speakers to one hearer.
