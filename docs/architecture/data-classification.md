# Data classification

Every piece of information in Open Origin belongs to one of five classes, C0 to C4, and a client
receives only explicit, allowlisted DTOs projected for its audience (P10). The classes are decided
in [0008](../decisions/0008-data-classification-and-audience-projections.md); this page adds which
interface sees which class, what each mechanism guards, which tests will check it, and why the
world seed is C3. Source: plan §E.4, §E.6, §I.1.2, §K.6, §K.8, §N, O-25.

## Classes

What each class holds, who may receive it, and who never may:
[0008, Decision](../decisions/0008-data-classification-and-audience-projections.md#decision).

C3 items detailed elsewhere in the plan:
- Observation exposure telemetry: a C3 table the simulation cannot read (§K.6, control 3).
- Reference truth for hypotheses: used only for research metrics (§K.8).

## Access by interface

| Interface | Classes (plan §E.6) |
|---|---|
| Public `apps/web` | C0 (plus the player's own C2, in the future) |
| Admin `apps/admin` | C0, C1, C3. C4 write-only |

Details of both interfaces: [Interfaces](interfaces.md).

## Enforcement mechanisms

Each mechanism and the leak it guards against. The mechanisms are decided in
[0008](../decisions/0008-data-classification-and-audience-projections.md),
[0009](../decisions/0009-public-and-private-admin-interfaces.md), and, for prompt input,
[0006](../decisions/0006-provenance-and-inheritable-contamination-taints.md).

| Mechanism (plan §E.4, §E.6) | Guards |
|---|---|
| Explicit projection functions (`toPublicView`, `toResearchView`) with allowlisted DTOs in `protocol`; an entity is never serialized whole | C1, C2, C3 leaking to public clients |
| A test checks that every key of each public message belongs to the allowlist | C0-only public messages |
| CI scans the client `dist/` for secret patterns; only `VITE_PUBLIC_*` variables reach the bundle | C4 in client bundles |
| A test scans the public `dist/` for admin routes and modules | Admin code and DTOs in the public bundle |
| Separate admin/research plane, local-only behind a token in v0.1 ([0009](../decisions/0009-public-and-private-admin-interfaces.md#decision); DF-4, O-21) | C1 and C3 access |
| Provider API key storage, write-only panel, and fingerprint display ([0009](../decisions/0009-public-and-private-admin-interfaces.md#decision); plan O-25) | C4 in clients, admin API responses, logs, prompts, snapshots |
| Read-only clients in v0.1; every input schema-validated with size and rate limits | Untrusted input |
| No inhabitant has tools with network, file, or infrastructure access | Inhabitants reaching infrastructure |
| The prompt is built only from the inhabitant's own perception and memory (§K.4) | Other inhabitants' C1 entering a prompt |

## Tests that will guard the classes

| Plan §N criterion | Check | Batch |
|---|---|---|
| 3 | Public inspector shows only C0 data | T8 |
| 10 | No public message contains keys outside the allowlist; the bundle contains no secrets | T6, T8 |
| 17 | Admin panel listens only on `127.0.0.1`, rejects every request without a valid token (test), and records every action in the audit log | T8 |
| 18 | Public `dist/` contains no admin panel code, routes, or DTOs (scan test) | T8 |
| 19 | Admin API never returns an API key value, only its fingerprint (test) | T9 |

## Why the world seed is C3

- The PRNG is counter-based: every random number is `mix32(seed, stream, tick, entityId, n)`
  ([0003](../decisions/0003-authoritative-deterministic-engine.md), plan §I.1.2).
- Terrain and resources come from seeded noise per chunk (plan §H).
- So whoever knows the seed can predict the terrain and **all** randomness in the world (plan
  §E.4, §I.1.2). It must never reach a public client.
- The seed is stored in the engine snapshot (`seed: [u32, u32]`), so the engine snapshot as a
  whole is C3: its text, its bytes, and every copy of them stay on the operations and research
  plane ([0020](../decisions/0020-deterministic-core-design.md)). The `snapshot` message that
  public clients receive on chunk subscription is a C0 projection of subscribed chunks, never the
  engine snapshot (plan §I.3, P10).

## In practice

A field reaches a client only after it is added to an allowlisted DTO of an audience allowed to see
its class; the allowlist test of that audience then covers it.
