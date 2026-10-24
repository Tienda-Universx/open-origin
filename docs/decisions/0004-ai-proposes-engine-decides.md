# 0004. AI proposes, the engine decides; AI modes with off by default

- Status: Accepted
- Date: 2026-10-24

## Context

LLMs can confabulate, are not deterministic, are retired or replaced often, and cost tokens
(plan §C). The world must work with zero providers and must never spend money by accident. Plan
§J.5 estimated demand and the demonstrable free supply (marked [E]). With the conservative free
supply (Workers AI + OpenRouter, C ≈ 1.2 M tokens/day) and the density formula
`D = C / (N × R × 2,150 × 1.2)`, 10 inhabitants at R = 60 get 0.78 reflections per inhabitant and
simulated day. The plan's demonstrated conclusion: at R = 60, free tiers **do not sustain even 10
inhabitants with one daily reflection (0.78 < 1)**; 10 inhabitants with full P1 need R ≤ 46. The
guaranteed free supply is 0: no free tier has an SLA and limits change without notice.

## Decision

**P3 AI proposes, the engine decides.** Model output is a validated, recorded command, never state.
**P8 Graceful degradation.** With zero AI providers the world works completely.

Deliberation contract (plan §K.5):
- The LLM answers JSON validated against a schema: `{ thought?, proposals: [...] }`.
- Each proposal passes preconditions, technical capability (acting with a technique requires having
  learned it), and the ethical action catalog. Thinking and hypothesizing have no content limits.
- It applies at `t + k`, with the adopted default `k` = 25 ticks plus 25 ticks of grace
  (2026-10-24, configurable; [0003](0003-authoritative-deterministic-engine.md)); a rejection
  becomes the inhabitant's experience.
- Each decision stores a **context manifest**: IDs of included memories and perceptions, template
  version, model, prompt hash, and raw output.

AI modes (plan §J.4), implemented by an in-house gateway over `fetch` (O-20):

| Mode | Behavior |
|---|---|
| `off` (**default**) | No outbound calls; L3 triggers fall back to L1–L2 |
| `mock` | Deterministic local provider for tests and demos |
| `free-only` | Only an allowlist of `(provider, model, plan="free", declared limits)`; anything else is rejected before touching the network. OpenRouter: `:free` IDs only, no fallbacks. Workers AI: local counter ≤ 10,000 neurons/day. Gemini free: excluded by default |
| `paid` | Requires `AI_ALLOW_PAID=true` + `AI_DAILY_USD_CAP` + `AI_MONTHLY_USD_CAP` |

- **Double key for paid.** The admin panel cannot enable `paid` unless the server started with
  `AI_ALLOW_PAID=true` (§E.6).
- **Local caps.** Before each paid call the gateway reserves the maximum cost
  ((input + output `max_tokens`) × price), reconciles with the real `usage` afterwards, and rejects
  the call if the reservation exceeds the balance. Provider caps add to local caps, never replace
  them. Local counters of tokens, neurons, and dollars always run (§J.6).
- **Cognitive allocation: adopted default (2026-10-24), configurable** (plan §J.5, marked [D]
  there). Each inhabitant gets an equal daily share C/N; a common pool serves high **internal**
  salience triggers (new phenomenon, conversation); the queue is ordered by trigger tick with a
  deterministic tie-break; everything is recorded.
- Cognitive allocation depends only on world data, never on who watches or who pays
  ([0005](0005-observer-independence.md)). Shared time never depends on the AI budget. Each world
  with LLMs declares its budget and resulting cognitive density. The research budget is separate.

## Consequences

- From 100 inhabitants the free LLM is a minor fraction of cognition: the world must be rich in
  deterministic (P0) behavior and LLM deliberation exceptional (§J.5). R = 60 (adopted default,
  2026-10-24, configurable; [0003](0003-authoritative-deterministic-engine.md)) is the default for
  the demo with AI off; worlds with LLMs choose R according to their budget (O-10).
- Model output is auditable and replayable from the log (reproducibility level N2).
- Plan §N criteria 11 and 12 verify the defaults and the mock behavior; T9 builds the gateway.
- The allocation default and `k` are revisited with measurements in the batch that implements
  them (plan §M).

## Alternatives considered

- Estimating AI cost from daily requests (revision 1): replaced by an input/output token budget
  with per-model limits, concurrency, and availability (tracker L2 point 1; plan §J.5).
- A synchronous LLM call inside the tick: replaced by an async queue plus a fixed think time
  (plan §E.5).
- Cognitive cost proportional to population × acceleration: replaced by an allocator with a global
  budget and degradation (plan §E.5, §J.5).
- Agent frameworks: opaque and non-deterministic (plan §D.2).
- Lock-in to one LLM provider: replaced by an in-house contract over the OpenAI-compatible API, a
  thin gateway over `fetch` (plan §D.2, §E.5, O-20).
- Gemini free tier in `free-only`: excluded by default; it uses prompts to improve products, with
  human review, and its limits are not published (plan §J.4).
- Ollama in this Codespace: not recommended; it competes with the engine for 2 vCPU (plan §J.5).

## References

- Plan: P3, P8 (§E.1), §C, §D.2, §E.5, §H, §J.4–J.6, §K.2, §K.5, O-10, O-11, O-20, §M, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L2 point 1.
