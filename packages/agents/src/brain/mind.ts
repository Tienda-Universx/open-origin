/**
 * The brain `mind@1` (ADR 0024, docs/architecture/mind.md "The brain mind@1"): a brain of beings@2
 * that composes `utility@1` without changing it. At every decision it asks `utility@1` for its
 * survival plan; when that plan is to forage, eat, or sleep, a need wins and the plan stands.
 * Otherwise the being may reply to what it heard, wait a moment, idle, for an answer after it
 * spoke, walk to food it believes in when hungry with none in sight, ask for food when it knows
 * none, greet a being it meets, or walk toward one to greet it (social.ts, paths.ts). Whatever it
 * does, it proposes the mental operations of memory.ts: what it hears, what it sees of what it
 * believes, and what it sees anew.
 *
 * It is a pure function of its senses, called without `this`: what it must find again travels in
 * `behavior.kind`, one of MIND_BEHAVIORS, in its records, and in its cooldowns; its laws are
 * copied when it is built; its only randomness is the draws the engine gives each decision.
 */
import { beings, type DeepReadonly, floorDiv } from "@open-origin/engine";
import { felt, least, PERMILLE, respond } from "./curves.ts";
import { type BrainLaws, brainLaws } from "./mind/laws.ts";
import { type ActNeeds, mentalOperations } from "./mind/memory.ts";
import { MIND_BEHAVIORS, MIND_BRAIN, MIND_CONCEPTS, WAIT_MS } from "./mind/parameters.ts";
import { approachLeg, seekLeg, soughtFood } from "./mind/paths.ts";
import { asking, canSpeak, greeting, reply, type Speaking, willing } from "./mind/social.ts";
import { KEEP_EATING, START_EATING } from "./parameters.ts";
import { utilityController } from "./utility.ts";

type Senses2 = DeepReadonly<beings.Senses2>;
type Intention2 = beings.Intention2;

/** What `mind@1` is built with: the laws of its species, and the seconds of its world's day. */
export type MindConfig = { readonly species: beings.Species2; readonly dayLength: number };

/** An act of the decision: its intention, and what it asks of memory. */
type Act = { readonly intention: Intention2; readonly needs: ActNeeds };

/** The behaviors of `utility@1` in which a need wins over every act of `mind@1`. */
const NEEDS: readonly string[] = Object.freeze(["forage", "eat", "sleep"]);

/** Whether the being is hungry as `utility@1` feels it: a drive to eat, to start or to keep on. */
function hungry(senses: Senses2): boolean {
  const { needs, traits, behavior } = senses.self;
  const loss = floorDiv(beings.NEED_MAX - needs.nutrition, PERMILLE);
  const eating = behavior.kind === "forage" || behavior.kind === "eat";
  return respond(eating ? KEEP_EATING : START_EATING, felt(loss, traits.appetite)) > 0;
}

/** `base`, the plan of `utility@1`, as it stands. */
const stands = (base: Intention2): Act => ({ intention: base, needs: {} });

/** `base` with the behavior `kind` and the steps `steps`; its cooldowns, and wake conditions, kept. */
function instead(
  base: Intention2,
  kind: string,
  steps: Intention2["steps"],
  wakeWhen: beings.WakeConditions = base.wakeWhen,
): Intention2 {
  return { ...base, steps, wakeWhen, behavior: { ...base.behavior, kind } };
}

/** An act of speech, which no wake condition interrupts: the talk, its hearer, a told belief. */
function talkAct(base: Intention2, speaking: Speaking): Act {
  const told = speaking.keep === undefined ? {} : { keep: speaking.keep };
  return {
    intention: instead(base, "talk", [speaking.step], {}),
    needs: { meets: speaking.hearer, ...told },
  };
}

/** The idle that waits for an answer, within the pause that continues a conversation. */
function waitAct(laws: BrainLaws, base: Intention2): Act {
  const ms = least(WAIT_MS, laws.speech.gap * 1000);
  return stands(instead(base, "wait", [{ kind: "idle", ms }]));
}

/** A hungry being with nothing in sight: food it believes in, else an ask, else the search. */
function searching(laws: BrainLaws, senses: Senses2, base: Intention2, speaks: boolean): Act {
  const sought = soughtFood(senses, laws);
  if (sought === undefined) {
    const ask = speaks ? asking(senses, laws) : undefined;
    return ask === undefined ? stands(base) : talkAct(base, ask);
  }
  const dirs = seekLeg(senses, sought.cell);
  if (dirs === undefined) return { intention: base, needs: { forget: sought.id } };
  return stands(instead(base, "seek", [{ kind: "walk", dirs }]));
}

/** A sated being: as it wills, a greet of a being it meets, else a walk toward one. */
function sociable(laws: BrainLaws, senses: Senses2, base: Intention2, speaks: boolean): Act {
  if (!speaks || !willing(senses)) return stands(base);
  const greet = greeting(senses, laws);
  if (greet !== undefined) return talkAct(base, greet);
  if (senses.self.behavior.kind === "approach") return stands(base);
  const dirs = approachLeg(senses, laws);
  if (dirs === undefined) return stands(base);
  return stands(instead(base, "approach", [{ kind: "walk", dirs }]));
}

/** The act of the decision, over the plan of `utility@1`. */
function actOf(laws: BrainLaws, senses: Senses2, base: Intention2): Act {
  if (NEEDS.includes(base.behavior.kind)) return stands(base);
  const speaks = canSpeak(senses, laws);
  const answer = speaks ? reply(senses, laws) : undefined;
  if (answer !== undefined) return talkAct(base, answer);
  if (senses.self.behavior.kind === "talk") return waitAct(laws, base);
  if (base.behavior.kind === "explore" && hungry(senses))
    return searching(laws, senses, base, speaks);
  return sociable(laws, senses, base, speaks);
}

/**
 * The brain `mind@1` for a species of `config.species`, in a world whose day lasts
 * `config.dayLength` seconds. Throws EngineError("invalid_value") for a day that is not a positive
 * safe integer.
 */
export function mindController(config: MindConfig): beings.Controller2 {
  const laws = brainLaws(config.species, config.dayLength);
  const survival = utilityController();
  return Object.freeze({
    brain: MIND_BRAIN,
    behaviors: MIND_BEHAVIORS,
    concepts: MIND_CONCEPTS,
    decide: (senses: Senses2): Intention2 => {
      const act = actOf(laws, senses, survival.decide(senses));
      const ops = mentalOperations(senses, laws, act.needs);
      return ops === undefined ? act.intention : { ...act.intention, mind: ops };
    },
  });
}
