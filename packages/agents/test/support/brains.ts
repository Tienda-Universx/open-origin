import { beings } from "@open-origin/engine";
import { Sfc32 } from "../../../engine/test/support/sfc32.ts";

/**
 * Brains that are not `utility@1`, for the negative controls of the survival test and the baseline
 * of the soak (docs/architecture/beings.md, "Evaluation"; plan §9.4). Each is a pure function of
 * its senses, as the Controller contract requires: what it draws comes from the senses' draws.
 */

/** What a brain senses. */
type Senses = Parameters<beings.Controller["decide"]>[0];

/** The longest idle a brain may ask for: 2^32 ms, about 49.7 days. */
const LONGEST_IDLE_MS = 0x1_0000_0000;

/** An intention of `steps`, remembering `kind`, woken by `wakeWhen`. */
function intention(
  kind: string,
  steps: readonly beings.PlanStep[],
  wakeWhen: beings.WakeConditions = {},
): beings.Intention {
  return { steps, wakeWhen, behavior: { kind, since: 0, heading: 0 } };
}

/** The food cue of the window's center: the being's own cell. */
function cueHere(senses: Senses): number {
  const { side, foodCue } = senses.window;
  const radius = (side - 1) / 2;
  return foodCue[radius * side + radius] ?? 0;
}

/** A brain that never eats and never sleeps of its own accord: it idles as long as it may. */
export function neverEats(): beings.Controller {
  return {
    brain: "never-eats@1",
    decide: () => intention("idle", [{ kind: "idle", ms: LONGEST_IDLE_MS }]),
  };
}

/** How long `neverSleeps` idles where `inner` would sleep. */
const SLEEPLESS_MS = 3_600_000;

/** `inner`, except that every sleep it plans becomes an idle of an hour: it never sleeps. */
export function neverSleeps(inner: beings.Controller): beings.Controller {
  return {
    brain: `never-sleeps(${inner.brain})`,
    decide: (senses) => {
      const planned = inner.decide(senses);
      const steps = planned.steps.map(
        (step): beings.PlanStep =>
          step.kind === "sleep" ? { kind: "idle", ms: SLEEPLESS_MS } : step,
      );
      return { ...planned, steps };
    },
  };
}

/** The rest at which the stationary and the random-walk brains go to sleep. */
const TIRED = 300_000;

/** How long the stationary brain waits before it looks at its cell again. */
const STATIONARY_WAIT_MS = 21_600_000;

/**
 * The stationary baseline (plan §9.4): it never walks. It sleeps to full rest once rest falls to
 * TIRED, eats to full whenever its own cell cues food and it is not full, and otherwise waits six
 * hours before it looks at its cell again. It eats whatever its cell regrows, a cue at a time.
 */
export function stationary(): beings.Controller {
  return {
    brain: "stationary@1",
    decide: (senses) => {
      const { nutrition, rest } = senses.self.needs;
      if (rest <= TIRED) return intention("sleep", [{ kind: "sleep", untilRest: beings.NEED_MAX }]);
      const tired = { restBelow: TIRED };
      if (cueHere(senses) > 0 && nutrition < beings.NEED_MAX)
        return intention("eat", [{ kind: "eat", untilNutrition: beings.NEED_MAX }], tired);
      return intention("wait", [{ kind: "idle", ms: STATIONARY_WAIT_MS }], tired);
    },
  };
}

/** The nutrition at which the random-walk brain eats when its cell has food. */
const HUNGRY = 600_000;

/** The most steps of one random walk. */
const RANDOM_STEPS = 12;

/** How long the random-walk brain idles when no step can be taken or it cannot walk. */
const STUCK_MS = 600_000;

/** A walk of up to RANDOM_STEPS steps from the window's center, each in a random open direction. */
function randomWalk(senses: Senses, random: Sfc32): string {
  const { side, edgeMs } = senses.window;
  let x = (side - 1) / 2;
  let y = x;
  let dirs = "";
  for (let step = 0; step < RANDOM_STEPS; step += 1) {
    const open = beings.DIRECTIONS.flatMap((_, d) =>
      (edgeMs[(y * side + x) * 8 + d] ?? -1) >= 0 ? [d] : [],
    );
    if (open.length === 0) break;
    const d = random.pick(open);
    const [dx, dy] = beings.DIRECTIONS[d] as readonly [number, number];
    x += dx;
    y += dy;
    dirs += `${d}`;
  }
  return dirs;
}

/**
 * The random-walk baseline of the soak, which is informative only: it sleeps to full rest once
 * rest falls to TIRED, eats to full when it is hungry and its own cell cues food, and otherwise
 * walks up to 12 steps, each in a direction drawn among those it can take, from its draws.
 */
export function randomWalker(): beings.Controller {
  return {
    brain: "random-walk@1",
    decide: (senses) => {
      const { nutrition, rest } = senses.self.needs;
      if (rest <= TIRED) return intention("sleep", [{ kind: "sleep", untilRest: beings.NEED_MAX }]);
      const wake =
        nutrition > HUNGRY ? { restBelow: TIRED, nutritionBelow: HUNGRY } : { restBelow: TIRED };
      if (nutrition <= HUNGRY && cueHere(senses) > 0)
        return intention("eat", [{ kind: "eat", untilNutrition: beings.NEED_MAX }], {
          restBelow: TIRED,
        });
      const [a = 0, b = 0] = senses.draws;
      const dirs =
        senses.self.condition === "ok" ? randomWalk(senses, new Sfc32((a ^ (b << 1)) >>> 0)) : "";
      if (dirs === "") return intention("stuck", [{ kind: "idle", ms: STUCK_MS }], wake);
      return intention("walk", [{ kind: "walk", dirs }], wake);
    },
  };
}
