/**
 * What the server does with a promise rejection that nothing handled (ADR 0025, "Faults"). With
 * `AI_MODE=off` no code of the world awaits anything: the engine and the brains are synchronous, so
 * a rejection is a defect, and async work in a brain would be a wall-clock channel into the world.
 * The world halts. The process handler that asks this lives in the entry point.
 */

/** The AI modes the server can start with: only `off` until T9. */
export type AiMode = "off";

/** The decision for an unhandled rejection. */
export type RejectionDecision = { readonly action: "halt"; readonly code: "unhandled_rejection" };

const HALT: RejectionDecision = Object.freeze({ action: "halt", code: "unhandled_rejection" });

/** The decision for an unhandled rejection under `aiMode`: a pure function of the mode. */
export function rejectionPolicy(aiMode: AiMode): RejectionDecision {
  switch (aiMode) {
    case "off":
      return HALT;
  }
}
