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
- A separate admin/research plane. v0.1: binds to `127.0.0.1` and requires a local token, behind a
  flag (O-21). Before any public exposure: authentication, authorization (RBAC), and an audit log
  (DF-4, §E.6; [0009](0009-public-and-private-admin-interfaces.md)).
- Clients are read-only in v0.1; every input is schema-validated with size and rate limits.
- No inhabitant has tools with network, file, or infrastructure access.

## Consequences

- Every new field needs a class and an explicit place in a projection before any client sees it.
- Plan §N criterion 10 (no public message key outside the allowlist; no secrets in the bundle)
  verifies it; T6 builds the projections and T8 the bundle scans.
- Details, examples, and the test map live in
  [data classification](../architecture/data-classification.md).
- **Open question (O-15):** whether the official world's internal laws are public or private data.
  If the laws live in the public AGPL code, players can learn and share them; one option is to keep
  them as configuration data of the official world. It is decided before any public phase, with
  legal advice (plan §C.2 tension 4). Until then, law parameters stay C3.

## Alternatives considered

- Implicit privacy without a classification (plan revision 1): replaced by a classification by
  audience (tracker L2 point 7; plan "Qué cambió", point 7).
- Serializing whole entities to clients: never; explicit projection functions with allowlisted
  DTOs instead (plan §E.4).
- Authoritative clients: replaced by read-only clients in v0.1 (plan §E.5).
- Broadcasting everything to everyone: replaced by per-chunk subscription (plan §E.5).

## References

- Plan: DF-4, P10 (§E.1), §C.2, §E.4, §E.5, §E.6, §I.1.2, §L, O-15, O-21, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L2 point 7.
- [0009. Two interfaces](0009-public-and-private-admin-interfaces.md).
