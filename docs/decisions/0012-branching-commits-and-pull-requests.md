# 0012. Branching, commits, and pull requests

- Status: Accepted
- Date: 2026-10-24

## Context

The master vision (§32) sets the development method: work in batches ("tandas"), keep commits
small and descriptive, never commit directly to `main`, use branches and pull requests, never
publish secrets, and never run production deployments without authorization. The repository is
public, so everything pushed becomes public (plan O-28). Plan O-19 and §M turn these rules into a
branching and commit policy.

## Decision

We will deliver every batch through branches and pull requests into `main`.

| Rule | Detail | Source |
|---|---|---|
| One branch per batch | Each batch has a branch and a PR (≈400 lines as a reference), tests and docs next to the code, and a prior brief (goal, scope, files, dependencies, risks, tests, criteria) | Plan §M, O-19 |
| Never commit to `main` | All changes reach `main` through a pull request | Vision §32 |
| Chained PRs | A batch with separable deliveries uses chained PRs, each based on the previous branch (T1: two PRs, O-27; T8: three PRs, §M) | Plan O-27, §M, §P |
| Conventional Commits | Small, descriptive commits per work unit | Plan O-19, §P; vision §32 |
| No AI attribution | No `Co-Authored-By` trailers | Plan O-19, §P |
| Explicit authorization | Push, opening PRs, and any deployment happen only with the maintainer's explicit authorization at that moment | Plan §P criterion 8; vision §32 |

- An architectural change adds or supersedes an ADR in the same pull request
  ([0001](0001-record-architecture-decisions.md)).
- Plan O-29 recommends that the maintainer enable "require pull request" on `main` in GitHub; it
  could not be verified from the Codespace.

## Consequences

- Each batch is reviewable on its own, and large text-only deliveries do not hide tooling changes
  (the reason T1 is split into two PRs, plan §P).
- Branch protection is a maintainer action outside the repository; until it is enabled, the rule
  relies on discipline and review.
- The ≈400-line size is a reference, not a hard limit.

## Alternatives considered

- Direct commits to `main`: forbidden by the master vision §32.
- One PR per batch regardless of content: makes verbatim documents bury tooling review (plan §P).

## References

- Master vision `docs/vision/master-vision.es.md` §32.
- Plan: §M, §P, O-19, O-27, O-28, O-29.
- Tracker `docs/roadmap/v0.1-tracker.md`: S1.
