# 0008. Data classification C0–C4 and audience projections

- Status: Accepted
- Date: 2026-10-24

## Context

The system holds very different information: what anyone in the world could see, inhabitants'
inner life, future player data, operational and research data, and secrets. The maintainer asked
to distinguish public information, private player data, inhabitants' internal memory, and admin or
research tools, and stated that clients must never receive secrets or unnecessary internal
information (plan revision 2, point 7).

## Decision

**P10 Audience projections.** No client receives raw state; only DTOs from an allowlist per
audience (plan §E.4).

| Class | Content | Who receives it | Never |
|---|---|---|---|
| **C0 World-public** | What an observer inside the world could see: terrain of subscribed chunks, positions, visible actions, public speech, public happenings, clock | Spectators | — |
| **C1 Inhabitant-internal** | Memory, beliefs, thoughts, goals, relationships, prompts, raw LLM outputs, context manifests | Research role; the inhabitant itself (through its perception) | Public clients, other inhabitants |
| **C2 Player-private** (future) | Account, email, IP, sessions, payments, private messages | The player; minimum necessary operation | Other clients, inhabitants, LLM providers (only in-world text travels, moderated and without personal data) |
| **C3 Operations and research** | World seed (predicts terrain and all randomness), law parameters, reference truth, observation metrics, logs, admin tools | Server; authenticated and audited research/admin role | Any public client |
| **C4 Secrets** | Provider keys, database credentials, tokens | Host environment variables or secret manager. The admin panel can only **write** them (create, rotate, delete) and shows a fingerprint, never the value | Logs, client bundles, prompts, snapshots, admin API responses |

Mechanisms:
- Explicit projection functions (`toPublicView`, `toResearchView`) with allowlisted DTOs in
  `protocol`. An entity is never serialized whole.
- Tests check that every key of each public message belongs to the allowlist.
- CI scans the client `dist/` for secret patterns. Only `VITE_PUBLIC_*` variables reach the bundle.
- A separate admin/research plane: local only in v0.1 (bound to `127.0.0.1`) behind a flag
  (O-21); authentication and an audit log in public phases.
- Clients are read-only in v0.1; every input is schema-validated with size and rate limits.
- No inhabitant has tools with network, file, or infrastructure access.

## Consequences

- Every new field needs a class and an explicit place in a projection before any client sees it.
- Plan §N criterion 10 (no public message key outside the allowlist; no secrets in the bundle)
  verifies it; T6 builds the projections and T8 the bundle scans.
- Details, examples, and the test map live in
  [data classification](../architecture/data-classification.md).

## References

- Plan: P10 (§E.1), §E.4, §I.1.2, §L, O-21, §N.
- [0009. Two interfaces](0009-public-and-private-admin-interfaces.md).
