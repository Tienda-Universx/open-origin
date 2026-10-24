# 0011. Language of artifacts

- Status: Accepted
- Date: 2026-10-24

## Context

The master vision and the approved plan were written in Spanish by the maintainer, and both must be
kept as versioned project documentation (tracker spec S4). The repository is public and
open-source (AGPL-3.0, plan O-28), and code, commits, and technical documents need one consistent
language. Plan O-17 and the T1 brief (plan §P, "Idioma") set the rule; this ADR records it.

## Decision

We will write each artifact in a fixed language:

| Artifact | Language |
|---|---|
| Master vision `docs/vision/master-vision.es.md` | Spanish, verbatim |
| Approved plan `docs/roadmap/v0.1-plan.es.md` | Spanish, verbatim |
| Batch tracker `docs/roadmap/v0.1-tracker.md` | Spanish |
| Code, identifiers, and comments | English |
| Commit messages | English |
| ADRs (`docs/decisions/`) | English |
| Technical specs and architecture docs (`docs/architecture/`) | English |
| `AGENTS.md` | English |
| `README.md` | Bilingual |

- The vision and the plan are copied verbatim, not translated or summarized.
- English artifacts that restate the plan translate it faithfully and cite the plan section they
  come from, so readers can check the original.

## Consequences

- Every technical artifact can be read in English, while the original intent stays available in
  the maintainer's own words.
- English restatements can drift from the Spanish source; citing the plan section keeps each one
  checkable in review.
- The tracker quotes the maintainer's instructions verbatim in Spanish, so specs keep their exact
  wording.

## References

- Plan: O-17, O-28, §G, §P ("Idioma").
- Tracker `docs/roadmap/v0.1-tracker.md`: S4.
- [0001. Record architecture decisions](0001-record-architecture-decisions.md).
