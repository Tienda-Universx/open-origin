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
| One branch per PR | Each PR has its own branch (≈400 lines as a reference), with tests and docs next to the code. A batch ships as one PR or a chain of PRs, after a prior brief (goal, scope, files, dependencies, risks, tests, criteria) | Plan §M, O-19 |
| Never commit to `main` | All changes reach `main` through a pull request | Vision §32 |
| Chained PRs | A batch with separable deliveries ships as several PRs; a chained PR is based on the previous PR's branch (T1: PRs #1, #2, and #4, tracker T1-D; T8: three PRs, §M) | Plan O-27, §M, §P |
| Conventional Commits | Small, descriptive commits per work unit | Plan O-19, §P; vision §32 |
| No AI attribution in commits | Commit messages carry no `Co-Authored-By` or similar AI trailers. A PR description may carry a tooling footer; it never enters history (see "Merge commits") | Plan O-19, §P; maintainer delegation, 2026-10-24 (tracker L11, L12) |
| Merge commits | PRs are merged with a merge commit (no squash, no rebase-merge) that keeps the work-unit commits. The merge commit uses GitHub's default merge message, which carries the PR title, never the PR body | Maintainer delegation, 2026-10-24 (tracker L11, L12) |
| Merging chained (stacked) PRs | Merge the parent PR first; then retarget the child PR to `main` and merge it after its CI passes | Maintainer delegation, 2026-10-24 (tracker L11, L12) |
| User-authenticated pushes | Pushes and PRs use a user-authenticated token. Observed in T1: pushes and PRs made with the Codespace's built-in credentials did not start workflows | Tracker L10 |
| Explicit authorization | Push, opening PRs, and any deployment happen only with the maintainer's explicit authorization at that moment | Plan §P criterion 8; vision §32 |

- An architectural change adds or supersedes an ADR in the same pull request
  ([0001](0001-record-architecture-decisions.md)).
- Plan O-29 recommends that the maintainer enable "require pull request" on `main` in GitHub; it
  could not be verified from the Codespace.

## Consequences

- Each PR is reviewable on its own, and large text-only deliveries do not hide tooling changes
  (the reason T1 was split into several PRs, plan §P).
- Branch protection is a maintainer action outside the repository; until it is enabled, the rule
  relies on discipline and review.
- `main` keeps every work-unit commit, plus one merge commit per PR.
- The repository still allows squash and rebase merging (GitHub API, checked 2026-10-24), so the
  merge-commit rule is policy only until the maintainer disables those merge modes in the
  repository settings.

## Alternatives considered

- Direct commits to `main`: forbidden by the master vision §32.
- One PR per batch regardless of content: makes verbatim documents bury tooling review (plan §P).

## References

- Master vision `docs/vision/master-vision.es.md` §32.
- Plan: §M, §P, O-19, O-27, O-28, O-29.
- Tracker `docs/roadmap/v0.1-tracker.md`: S1, L10, L11, L12.
