# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-24

## Context

Open Origin is a long-lived, open-source project with scientific goals. Decisions about the
simulation engine, AI usage, persistence, and data handling have consequences that are hard to
reverse and must stay traceable for contributors and for research reproducibility. The approved
v0.1 plan (`docs/roadmap/v0.1-plan.es.md`) already lists the decisions that need a durable record.

## Decision

We will record every architecturally significant decision as an Architecture Decision Record in
`docs/decisions/`, one file per decision, named `NNNN-kebab-case-title.md` and following
`0000-adr-template.md`.

- Decisions the maintainers have approved are `Accepted`; open ones are `Proposed`.
- An ADR is never rewritten to change its meaning. A new ADR supersedes it, and the old one is
  marked `Superseded by NNNN`.
- ADRs are written in English. The original vision and the approved plan stay in Spanish, verbatim.
- `tests/repo/adr.test.ts` enforces the format in CI.

## Consequences

- Every significant change has a reviewable rationale and a stable link.
- Contributors must add or supersede an ADR in the same pull request that changes an
  architectural rule.
- The numbering is strictly sequential, so parallel branches that add ADRs may need renumbering
  before merge.

## Alternatives considered

- Decisions only in pull request descriptions: hard to find and not versioned with the code.
- A single growing architecture document: loses the history of why each rule changed.

## References

- Michael Nygard, "Documenting Architecture Decisions":
  https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
