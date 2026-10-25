/**
 * The brain `utility@1` (ADR 0023, plan §5.3, L1): a Utility AI that scores five behaviors —
 * forage, eat here, sleep, explore, and rest — from integer considerations of its senses, picks
 * the best with a commitment to what it already does, and plans it with the recipes of L2. It is
 * a pure function of its senses: what it must remember travels in `behavior` and `cooldowns`,
 * and its only randomness is the draw that sets its heading at its first decision.
 *
 * It decides only at decision points: each intention asks to be woken at the needs and the light
 * that would change its choice, instead of deciding again every tick.
 */
import { beings, type DeepReadonly, floorDiv } from "@open-origin/engine";
import { compensated, felt, greatest, PERMILLE, respond } from "./curves.ts";
import {
  ALERTNESS,
  BEHAVIORS,
  COMMITMENT,
  DARKNESS,
  DAWN_LIGHT,
  DUSK_LIGHT,
  EXHAUSTION_GUARD,
  KEEP_EATING,
  KEEP_SLEEPING,
  MEAL_COOLDOWN_MS,
  MEAL_TARGET,
  NIGHT_REST_MS,
  NIGHT_SLEEP,
  REST_MS,
  REST_SCORE,
  ROUTE_COOLDOWN_MS,
  SEARCH_ANCHOR_MS,
  SEARCH_RANGE,
  SEARCH_STEP,
  SLEEP_TARGET,
  START_EATING,
  STARVING,
  SWITCH_MARGIN,
  URGENT_SLEEP,
  UTILITY_BRAIN,
  WANDER_DRIVE,
  WANDER_PAUSE_MS,
  WANDER_REACH,
  WANDER_SIGHT,
} from "./parameters.ts";
import {
  bestFood,
  centerOf,
  cueWorth,
  type FoodTarget,
  fitsOneWalk,
  indexOf,
  searchLeg,
  type View,
  walkable,
  wanderLeg,
} from "./recipes.ts";

type Senses = DeepReadonly<beings.Senses>;
type CooldownRequest = beings.CooldownRequest;

/** What the brain reads from its senses before it scores anything. */
type Mind = {
  readonly senses: Senses;
  readonly view: View;
  /** Hunger and tiredness as the being feels them, scaled by its traits, in permille. */
  readonly hunger: number;
  readonly tiredness: number;
  readonly darkness: number;
  readonly current: string;
  /**
   * The behavior the being is committed to: its current one, unless a wake condition it asked for
   * interrupted it, which is the brain's own request to weigh everything again.
   */
  readonly committed: string;
  readonly canWalk: boolean;
  /** The window indices of the cells the being avoids. */
  readonly cooled: readonly number[];
  /** The drive to eat: to start, or to keep eating once foraging or eating. */
  readonly drive: number;
};

/** The loss of `level` from full, in permille. */
function lossOf(level: number): number {
  return floorDiv(beings.NEED_MAX - level, PERMILLE);
}

/** The mind of a being from its senses. */
function mindOf(senses: Senses): Mind {
  const { self, window } = senses;
  const view: View = {
    origin: window.origin,
    side: window.side,
    edgeMs: window.edgeMs as Int32Array,
    foodCue: window.foodCue as Uint8Array,
  };
  const hunger = felt(lossOf(self.needs.nutrition), self.traits.appetite);
  const current = self.behavior.kind;
  const eating = current === "forage" || current === "eat";
  const woken = self.outcome.result === "interrupted" && self.outcome.reason === "wake_condition";
  return {
    senses,
    view,
    hunger,
    tiredness: felt(lossOf(self.needs.rest), self.traits.sleepiness),
    darkness: respond(DARKNESS, senses.light),
    current,
    committed: woken ? "" : current,
    canWalk: self.condition === "ok",
    cooled: self.cooldowns.map(({ cell }) => indexOf(view, cell)).filter((index) => index >= 0),
    drive: respond(eating ? KEEP_EATING : START_EATING, hunger),
  };
}

/** What the brain found to eat: the best cell to forage, and the cue of its own cell. */
type Food = { readonly target: FoodTarget | undefined; readonly here: number };

/** The food the being sees, searched only when it has a drive to eat and can walk to it. */
function foodOf(mind: Mind): Food {
  const center = centerOf(mind.view);
  const here = mind.cooled.includes(center) ? 0 : (mind.view.foodCue[center] as number);
  const target = mind.drive > 0 && mind.canWalk ? bestFood(mind.view, mind.cooled) : undefined;
  return { target, here };
}

/** The drive to explore: to search when hungry and nothing is in sight, or to wander by day. */
function exploreDrive(mind: Mind, food: Food): number {
  if (mind.drive > 0) return food.target === undefined && food.here === 0 ? mind.drive : 0;
  const curiosity = felt(WANDER_DRIVE, mind.senses.self.traits.curiosity);
  return floorDiv(curiosity * (PERMILLE - mind.darkness), PERMILLE);
}

/** The score of each behavior, in the order of BEHAVIORS; 0 for a behavior it cannot do. */
function scoresOf(mind: Mind, food: Food): number[] {
  const forage = food.target === undefined ? 0 : compensated([mind.drive, food.target.worth]);
  const eat = food.here === 0 ? 0 : compensated([mind.drive, cueWorth(food.here)]);
  const urgency = respond(URGENT_SLEEP, mind.tiredness);
  const sleepy = respond(mind.current === "sleep" ? KEEP_SLEEPING : NIGHT_SLEEP, mind.tiredness);
  const sleep = compensated([sleepy, greatest(urgency, mind.darkness)]);
  const explore = mind.canWalk
    ? compensated([exploreDrive(mind, food), respond(ALERTNESS, mind.tiredness)])
    : 0;
  return [forage, eat, sleep, explore, REST_SCORE];
}

/**
 * The index of the behavior to do: the best score, that of the behavior the being is committed
 * to raised by COMMITMENT, ties going to the earlier behavior. Another behavior replaces the
 * committed one only when it beats it by SWITCH_MARGIN as well, so that two close scores do not
 * take turns; a committed behavior the being can no longer do, scored 0, holds nothing.
 */
export function choose(scores: readonly number[], committed: string): number {
  const at = BEHAVIORS.indexOf(committed);
  let best = 0;
  let bestValue = -1;
  scores.forEach((score, index) => {
    const value = score + (index === at ? COMMITMENT : 0);
    if (value > bestValue) {
      best = index;
      bestValue = value;
    }
  });
  const held = at < 0 ? 0 : (scores[at] as number);
  if (best === at || held === 0) return best;
  return bestValue >= held + COMMITMENT + SWITCH_MARGIN ? best : at;
}

/** The level of a need at or below which its loss, felt through `trait`, passes `from` permille. */
function levelPast(from: number, trait: number): number {
  // felt(loss) > from ⇔ loss·trait ≥ (from + 1)·1000 ⇔ loss ≥ ⌈(from + 1)·1000 / trait⌉.
  const loss = -floorDiv(-(from + 1) * PERMILLE, trait);
  const level = beings.NEED_MAX - loss * PERMILLE;
  return greatest(level, 0);
}

/** The nutrition at which a being starts to want to eat. */
function hungryAt(mind: Mind): number {
  return levelPast(START_EATING[0] as number, mind.senses.self.traits.appetite);
}

/** The rest at which a being wants to sleep: in the dark, or whatever the light. */
function sleepyAt(mind: Mind, dark: boolean): number {
  const curve = dark ? NIGHT_SLEEP : URGENT_SLEEP;
  return levelPast(curve[0] as number, mind.senses.self.traits.sleepiness);
}

/** The light conditions that wake a being at dusk, at dawn, or both in the twilight between. */
function lightWake(light: number): beings.WakeConditions {
  const wake: { lightBelow?: number; lightAbove?: number } = {};
  if (light > DUSK_LIGHT) wake.lightBelow = DUSK_LIGHT;
  if (light < DAWN_LIGHT) wake.lightAbove = DAWN_LIGHT;
  return wake;
}

/** A plan: its steps, its wake conditions, the heading to remember, and the cooldowns to add. */
type Plan = {
  readonly steps: beings.PlanStep[];
  readonly wakeWhen: beings.WakeConditions;
  readonly heading: number;
  readonly cooldowns: CooldownRequest[];
};

/** Foraging: the walk to the target, and the meal on arrival when one walk reaches it. */
function forage(mind: Mind, target: FoodTarget): Plan {
  const walk: beings.PlanStep = { kind: "walk", dirs: walkable(target.path) };
  const steps: beings.PlanStep[] = fitsOneWalk(target.path)
    ? [walk, { kind: "eat", untilNutrition: MEAL_TARGET }]
    : [walk];
  return {
    steps,
    wakeWhen: { restBelow: EXHAUSTION_GUARD },
    heading: headingOf(mind),
    cooldowns: [],
  };
}

/** Eating here, until the meal is full or the cell has nothing left. */
function eat(mind: Mind): Plan {
  return {
    steps: [{ kind: "eat", untilNutrition: MEAL_TARGET }],
    wakeWhen: { restBelow: EXHAUSTION_GUARD },
    heading: headingOf(mind),
    cooldowns: [],
  };
}

/** Sleeping until rested, woken only by starvation. */
function sleep(mind: Mind): Plan {
  return {
    steps: [{ kind: "sleep", untilRest: SLEEP_TARGET }],
    wakeWhen: { nutritionBelow: STARVING },
    heading: headingOf(mind),
    cooldowns: [],
  };
}

/** Resting: a long idle, woken by hunger, by tiredness, and at dusk or dawn. */
function rest(mind: Mind): Plan {
  const dark = mind.darkness > 0;
  return {
    steps: [{ kind: "idle", ms: dark ? NIGHT_REST_MS : REST_MS }],
    wakeWhen: {
      nutritionBelow: hungryAt(mind),
      restBelow: sleepyAt(mind, dark),
      ...lightWake(mind.senses.light),
    },
    heading: headingOf(mind),
    cooldowns: [],
  };
}

/**
 * Where a hungry being searches: around the oldest cooldown within SEARCH_RANGE, a place where it
 * found nothing, or around a new one where it stands, which it adds.
 */
function searchAnchor(mind: Mind): { anchor: readonly number[]; added: CooldownRequest[] } {
  const { cell, cooldowns } = mind.senses.self;
  const [x = 0, y = 0] = cell;
  const near = cooldowns.find(({ cell: [cx = 0, cy = 0] }) => {
    const dx = cx - x;
    const dy = cy - y;
    return dx <= SEARCH_RANGE && -dx <= SEARCH_RANGE && dy <= SEARCH_RANGE && -dy <= SEARCH_RANGE;
  });
  if (near !== undefined) return { anchor: near.cell, added: [] };
  return { anchor: [x, y], added: [{ cell: [x, y], ms: SEARCH_ANCHOR_MS }] };
}

/**
 * Exploring. A hungry being with nothing in sight searches: it walks a spiral around where its
 * search began, which sweeps the land nearest first, turn after turn. A sated one wanders by
 * day along its heading, which it keeps from leg to leg and from one exploration to the next,
 * turning only when blocked or when food would fall out of sight; it pauses after each leg, and is
 * woken by hunger, tiredness, or dusk. When no leg has a route, the being rests, and avoids the
 * targets that had none.
 */
function explore(mind: Mind): Chosen {
  if (mind.drive > 0) return search(mind);
  const wander = { reach: WANDER_REACH, sight: WANDER_SIGHT };
  const leg = wanderLeg(mind.view, headingOf(mind), wander, mind.cooled);
  const cooldowns = leg.blocked.map((cell) => ({ cell, ms: ROUTE_COOLDOWN_MS }));
  if (leg.heading === undefined) return { kind: "rest", plan: { ...rest(mind), cooldowns } };
  const wakeWhen = {
    nutritionBelow: hungryAt(mind),
    restBelow: sleepyAt(mind, false),
    ...lightWake(mind.senses.light),
  };
  const steps: beings.PlanStep[] = [
    { kind: "walk", dirs: walkable(leg.path) },
    { kind: "idle", ms: WANDER_PAUSE_MS },
  ];
  return { kind: "explore", plan: { steps, wakeWhen, heading: leg.heading, cooldowns } };
}

/** Searching for food: one leg along the spiral of the search, woken only by tiredness. */
function search(mind: Mind): Chosen {
  const { anchor, added } = searchAnchor(mind);
  const leg = searchLeg(mind.view, { anchor, step: SEARCH_STEP }, headingOf(mind), mind.cooled);
  if (leg.heading === undefined) return { kind: "rest", plan: { ...rest(mind), cooldowns: added } };
  const steps: beings.PlanStep[] = [{ kind: "walk", dirs: walkable(leg.path) }];
  const wakeWhen = { restBelow: sleepyAt(mind, false) };
  return { kind: "explore", plan: { steps, wakeWhen, heading: leg.heading, cooldowns: added } };
}

/** The behavior the engine gives a being at its birth, before its first decision. */
const FIRST_BEHAVIOR = "none";

/** The behavior a being does and its plan. */
type Chosen = { readonly kind: string; readonly plan: Plan };

/**
 * The heading of the being, which every behavior keeps and exploring turns: drawn at its first
 * decision, when its behavior is still the engine's "none".
 */
function headingOf(mind: Mind): number {
  const { self, draws } = mind.senses;
  return mind.current === FIRST_BEHAVIOR ? (draws[0] ?? 0) % 8 : self.behavior.heading;
}

/** A meal that failed where the being stands, which it then avoids for a while. */
function failedMeal(mind: Mind): CooldownRequest[] {
  const { outcome, cell } = mind.senses.self;
  const failed = outcome.result === "failed" || outcome.result === "lost";
  const food = outcome.reason === "no_food" || outcome.reason === "food_gone";
  const [x = 0, y = 0] = cell;
  return failed && food ? [{ cell: [x, y], ms: MEAL_COOLDOWN_MS }] : [];
}

/** The behavior at `index` and its plan; exploring may end up resting. */
function planOf(mind: Mind, food: Food, index: number): Chosen {
  const kind = BEHAVIORS[index] as string;
  if (kind === "forage" && food.target !== undefined)
    return { kind, plan: forage(mind, food.target) };
  if (kind === "eat") return { kind, plan: eat(mind) };
  if (kind === "sleep") return { kind, plan: sleep(mind) };
  if (kind === "explore") return explore(mind);
  return { kind: "rest", plan: rest(mind) };
}

/** The decision of `utility@1` from `senses`. */
function decideUtility(senses: Senses): beings.Intention {
  const mind = mindOf(senses);
  const food = foodOf(mind);
  const { kind, plan } = planOf(mind, food, choose(scoresOf(mind, food), mind.committed));
  const most = beings.BEING_BOUNDS.cooldowns.max;
  const cooldowns = [...failedMeal(mind), ...plan.cooldowns].slice(0, most);
  return {
    steps: plan.steps,
    wakeWhen: plan.wakeWhen,
    behavior: { kind, since: 0, heading: plan.heading },
    ...(cooldowns.length > 0 ? { cooldowns } : {}),
  };
}

/** The brain `utility@1`: a Controller whose decide is a pure function of its senses. */
export function utilityController(): beings.Controller {
  return Object.freeze({ brain: UTILITY_BRAIN, decide: decideUtility });
}
