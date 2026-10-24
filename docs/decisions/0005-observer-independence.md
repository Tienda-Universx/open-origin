# 0005. Observer independence

- Status: Accepted
- Date: 2026-10-24

## Context

Revision 1 of the plan let the AI priority depend on who was watching. The maintainer rejected
it: watching an inhabitant must not change its behavior, learning, or cognitive capabilities. If
human attention changes an inhabitant's cognitive budget, every conclusion about its behavior is
biased (plan §C, risk 5). Visual optimization, response latency, and scientific behavior must be
separated, with experimental controls that detect observation bias (plan §K.6).

## Decision

**P9 Observer independence.** No input of the engine, the minds, or the cognitive allocator
depends on anything outside the world: who watches, who follows whom, which view is open, which
client is connected, or who pays.

| Plane | May depend on observation | May not |
|---|---|---|
| Presentation | Send rate to that client, level of detail, chunk prefetch, interpolation, projection cache | Write to the world |
| Response latency | *Transmission* order to the client | Cognitive queue order, model, tokens, think time |
| Scientific behavior | — | Everything: budget, model, memory depth, `k`, and triggers are the same for all inhabitants in the same internal situation |

- A future human player's conversation is an event **inside** the world, not observation. It gets
  the same `k`, model, and budget as a conversation with an AI inhabitant. If latency is poor, `k`
  changes for all conversations as a world rule, never as special treatment.
- Paying for cognition (future) is a declared experimental variable: forbidden in scientific
  worlds or recorded as a treatment.
- The adopted default allocation rule ([0004](0004-ai-proposes-engine-decides.md): equal daily
  share, a common pool for internal salience, queue by trigger tick) takes only world data as input.
- `follow` only affects the presentation plane (§I.3). Watching from the admin panel affects
  nothing ([0009](0009-public-and-private-admin-interfaces.md)).

Experimental controls:
1. **Invariance test** (CI, no-AI and mock modes): same seed and log with 0 observers vs. N
   observers following random inhabitants ⇒ identical hashes at every tick.
2. **Static boundary**: a lint rule stops the cognitive allocator from importing the WebSocket
   subscriptions module; the allocator's input type contains only world data.
3. **Separate telemetry**: observation exposure is recorded in a C3 table the simulation cannot
   read.
4. **Statistical audit** (live LLM mode): observed vs. unobserved inhabitants matched by traits and
   situation; compare deliberations/day, tokens per deliberation, model used, timeouts, plan
   success, and memory growth; alert on significant differences.
5. **Randomized placebo observation**: spectator bots assigned at random to inhabitants, to
   estimate the causal effect of "being observed" (expected: null).

## Consequences

- v0.1 ships the P9 boundary, the invariance test, and separate telemetry (controls 1–3). The
  statistical audit and the placebo (controls 4–5) need a live LLM and are future requirements
  (plan §L).
- Provider degradation must also be independent of observation; the "served vs. degraded
  deliberations" metric feeds the audit (§J.5).
- Plan §N criterion 9 (identical hashes with 0 and N observers) verifies it; T6 builds the boundary.

## Alternatives considered

- Allocating AI priority by observer salience, that is, by who is watching (plan revision 1):
  rejected by the maintainer because watching must not change behavior, learning, or cognitive
  capabilities (tracker L2 point 2; plan "Qué cambió", point 2).
- A shorter `k` for human players' conversations: rejected; if latency is poor, `k` changes for all
  conversations as a world rule (plan §K.6).
- Paid cognition as an unrecorded advantage: rejected; it is a declared experimental variable,
  forbidden in scientific worlds or recorded as a treatment (plan §C.2 tension 7, §K.6).

## References

- Plan: P9 (§E.1), §C, §C.2, §E.2, §F, §I.3, §J.5, §J.6, §K.6, §L, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L2 point 2.
