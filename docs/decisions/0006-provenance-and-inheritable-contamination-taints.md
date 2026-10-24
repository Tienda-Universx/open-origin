# 0006. Provenance and inheritable contamination taints instead of lexical blocking

- Status: Accepted
- Date: 2026-10-24

## Context

Revision 1 of the plan proposed a filter that rejected external concepts; the maintainer rejected
it. Inhabitants must be free to form new hypotheses from their own observations, including about
consciousness, a creator, simulation, or an external reality. The LLM already knows Earth physics,
the simulation hypothesis, and its own nature, so a "discovery" may be recall (plan §C, risk 2).
We need to tell reasoned discoveries apart from model prior knowledge and from player suggestions,
and agents must be able to develop original hypotheses without a fixed discovery catalog
(plan §K.8).

## Decision

**No lexical blocking.** We control what enters the prompt and we attribute provenance; we do not
censor what comes out (plan §K.4, §K.7).

Prompt input (§K.4): built only from the inhabitant's perception and memory, in internal
vocabulary; it never states AI, game, simulation, player, or server as given facts. Templates are
versioned and audited so they do not **seed** target topics. This restricts what **we** inject, not
what **they** may think or say.

| Origin of a belief or hypothesis | Criterion |
|---|---|
| Reasoned | Its support chain in the provenance graph reaches own observations or experiments, or grounded testimony from other inhabitants, and it formed without prior contaminated inputs |
| Model prior (suspect) | Its premises are not in the context manifest of the decision that produced it |
| Player-suggested | Its lineage contains human-origin content |
| Implementation self-reference | "I am a language model", company or server names: tagged and measured, not deleted |

**Inheritable taints:** `{model-prior-suspect, human-external, implementation-leak}`. A derived
belief inherits the union of its sources' taints, including testimony between inhabitants.
Analysis can filter whole lineages.

Controls (§K.7):
1. Context ablation, offline, on the research budget.
2. Control worlds without the phenomena in question, for base rates.
3. Semantic similarity to human inputs received by the inhabitant or its social network.
4. Non-terrestrial internal laws: adopted default (2026-10-24), configurable (O-13). Predicting
   Earth behavior where the world differs is evidence of prior knowledge; converging to the internal
   law is evidence of internal learning.
5. Self-reference policy: tag, do not intervene. Adopted default (2026-10-24), configurable
   (O-14). A research world may declare another policy as part of its recorded experimental
   configuration.

**Composable scientific representations (§K.8).** The action space is finite but composable:
- Open ontology: concepts are registered IDs (not enums) defined compositionally over primitive
  observables the engine exposes; inhabitants may coin new concepts.
- Hypotheses are typed trees in a small language (relation, conditions and domain, functional form),
  validated by types, by reference to known concepts, and by size and depth limits.
- Experimental designs are programs in a total language (bounded, with "gas") that the engine runs
  as normal actions; results are engine measurements.
- Inventions are material and component graphs whose properties emerge from composable physics.
- The engine never rules on a hypothesis' truth. Reference truth is C3, used only for research.

## Consequences

- T5 delivers propositions with provenance and inheritable taints (plan §M row T5); context
  manifests ship with the AI gateway in T9 (plan §M row T9). v0.1 also ships the §K.8 essentials:
  primitive observables and measurement events, an open-concept proposition schema with provenance,
  and laws as versioned ruleset data. Plan §N criterion 13 tests taint inheritance.
- Context ablation, control worlds, semantic similarity, the experiment language, inventions, and
  nested simulations are future requirements this design does not block (plan §L).
- Whether the official world's internal laws are public or private data is an open question
  recorded in [0008](0008-data-classification-and-audience-projections.md) (O-15).

## Alternatives considered

- Lexical blocking: an output filter that rejected external concepts such as consciousness,
  creator, simulation, or external reality (plan revision 1): rejected by the maintainer
  (tracker L2 point 3; plan "Qué cambió", point 3).
- Deleting implementation self-references: rejected; they are tagged and measured (plan §K.7,
  O-14).
- A predefined catalog of discoveries (plan revision 1): replaced by composable, validatable
  representations (tracker L2 point 8; plan "Qué cambió", point 8; §K.8).

## References

- Plan: §C, §K.3, §K.4, §K.5, §K.7, §K.8, §K.9, §L, §M, O-13, O-14, O-15, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L2 points 3 and 8.
- [0004. AI proposes, the engine decides](0004-ai-proposes-engine-decides.md).
