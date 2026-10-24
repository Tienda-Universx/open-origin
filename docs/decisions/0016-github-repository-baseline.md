# 0016. GitHub repository baseline

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer asked for an audit of the GitHub configuration and delegated the improvements
(tracker L16). A read-only audit on 2026-10-24 found `main` without protection, squash and rebase
merging enabled against [0012](0012-branching-commits-and-pull-requests.md), and several free
security features of public repositories turned off: secret scanning, push protection, code
scanning, private vulnerability reporting, Dependabot security updates, and Dependabot version
updates. The organization is on the GitHub Free plan; repository rulesets are available for this
public repository.

## Decision

We will keep this baseline on the repository and change it only through a new or superseding ADR:

| Setting | Value |
|---|---|
| Ruleset `main` (default branch) | Pull request required (0 approvals, merge commits only), required check "Typecheck, lint and test", no force push, no deletion, no bypass |
| Merge methods | Merge commit only; merged branches are deleted |
| Secret scanning and push protection | Enabled |
| Code scanning | CodeQL default setup (Actions and JavaScript/TypeScript) |
| Private vulnerability reporting | Enabled; `SECURITY.md` explains how to report |
| Dependabot | Alerts and security updates enabled; weekly version updates for `bun` and `github-actions` with a 14-day cooldown (`.github/dependabot.yml`) |
| Actions | Workflow token read-only by default; Actions cannot approve pull requests; actions must be pinned to a full commit SHA |
| Wiki and Projects | Disabled: documentation lives in reviewed pull requests |

The two files in the repository (`SECURITY.md`, `.github/dependabot.yml`) are reviewed like code;
`tests/repo/dependabot.test.ts` pins the cooldown, ecosystems and commit prefix. The other settings
live in GitHub and are recorded here.

## Consequences

- Nobody, administrators included, can push to `main` directly, force-push it, or delete it; every
  change needs a pull request whose CI is green.
- The required check is matched by name: renaming the CI job "Typecheck, lint and test" would block
  every merge, so `tests/repo/ci.test.ts` pins the name.
- A sole maintainer can still merge: no approval is required, because GitHub does not let authors
  approve their own pull requests.
- "Branch up to date" is not required, so stacked pull requests keep working
  ([0012](0012-branching-commits-and-pull-requests.md)).
- Push protection rejects a push that contains a detected secret: remove it from the commits and
  rotate it.
- A Dependabot pull request that replaced a full SHA with a tag would fail both the pinning
  requirement and `tests/repo/ci.test.ts`.
- In an emergency the maintainer can disable the ruleset in the repository settings and enable it
  again afterwards; doing so is recorded in the tracker log.
- Organization-wide settings (two-factor requirement, third-party app access) are maintainer actions
  in the web interface and are not part of this baseline.

## Alternatives considered

- **Classic branch protection.** Equivalent here, but rulesets are GitHub's current mechanism;
  organization-level rulesets would need a paid plan (the API answered 403 on GitHub Free).
- **Requiring one approving review.** Rejected: it would block every merge while there is a single
  maintainer.
- **Requiring branches to be up to date before merging.** Rejected: it forces extra rebases and
  breaks the stacked pull request flow.
- **Managing settings as code through a third-party app.** Rejected: it adds an app with
  administration rights for a handful of settings.

## References

- Rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- Secret scanning: https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning
- Dependabot options (cooldown, ecosystems): https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- Actions settings (SHA pinning): https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
- Tracker `docs/roadmap/v0.1-tracker.md`: L16, L17.
