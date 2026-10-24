@AGENTS.md

## Claude Code notes

`AGENTS.md` (imported above) is the single source of project rules, including the mandatory change
protocol. These notes add Claude Code specifics and how Claude Code applies those rules.

- Tool parameters decode escape sequences: a backslash-u escape typed in an edit can be written to
  disk as the literal invisible character. After writing regexes or strings with escapes, verify the
  bytes (for example with `od -c`) and run `bun test`, which includes the hygiene check.
- Read a file before editing it, and re-run `bun run check` after every change set.
- Apply the engineering practices (code-audit criteria included), the review checklist, and the
  Phase E close-out sweep of `AGENTS.md` to every change, including work delegated to subagents.
