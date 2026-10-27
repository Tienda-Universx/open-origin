/**
 * Cooldowns (ADR 0023, docs/architecture/beings.md "The brain"): the targets a brain asks the
 * engine to avoid for a while. An intention may add up to four, each a cell and a duration in
 * milliseconds; the engine copies and bounds them like the rest of the intention, stamps each with
 * the tick it ends at, drops those that ended before the brain senses them, and keeps the newest
 * four, one per cell. An intention without them changes nothing.
 */
import { describe, expect, test } from "bun:test";
import { beings } from "../src/index.ts";
import {
  behavior,
  beingOf,
  beingsWorld,
  brain,
  lifeWith,
  runTo,
  type Senses,
  SPECIES,
  spawn,
  windowAt,
} from "./support/beings-world.ts";

const { acceptIntention } = beings;

/** A species that senses only 4 cells around it, which keeps each decision cheap. */
const NEAR = lifeWith((species) => ({ ...species, senses: { radius: 4 } }));

/** An intention that idles for `ms` and adds `cooldowns`, when given. */
function idleWith(ms: number, cooldowns?: unknown): beings.Intention {
  const intention = { steps: [{ kind: "idle", ms }], wakeWhen: {}, behavior: behavior("rest") };
  return (cooldowns === undefined ? intention : { ...intention, cooldowns }) as beings.Intention;
}

describe("acceptIntention with cooldowns", () => {
  const window = windowAt([5, 5]);
  const accept = (intention: unknown) => acceptIntention(intention, { tick: 9, window });

  test("copies the cooldowns an intention adds, and adds none when it has none", () => {
    const cooldowns: { cell: [number, number]; ms: number }[] = [
      { cell: [3, -4], ms: 60_000 },
      { cell: [-2_147_483_648, 2_147_483_647], ms: 0x1_0000_0000 },
    ];
    const given = idleWith(1_000, cooldowns);
    const accepted = accept(given);
    expect(accepted).toEqual({
      kind: "accepted",
      activity: { kind: "idle", start: 9, ms: 1_000 },
      plan: [],
      wakeWhen: {},
      behavior: behavior("rest"),
      cooldowns,
    });
    // A copy: changing what the brain returned changes nothing the engine accepted.
    cooldowns[0] = { cell: [0, 0], ms: 1 };
    expect(accepted.kind === "accepted" && accepted.cooldowns?.[0]).toEqual({
      cell: [3, -4],
      ms: 60_000,
    });
    expect(accept(idleWith(1_000, []))).toMatchObject({ kind: "accepted", cooldowns: [] });
    expect("cooldowns" in accept(idleWith(1_000))).toBe(false);
  });

  test.each([
    ["five entries", Array.from({ length: 5 }, (_, x) => ({ cell: [x, 0], ms: 1 }))],
    ["a list that is not one", { cell: [0, 0], ms: 1 }],
    ["a cell outside the world", [{ cell: [2_147_483_648, 0], ms: 1 }]],
    ["a cell of one axis", [{ cell: [0], ms: 1 }]],
    ["no time", [{ cell: [0, 0], ms: 0 }]],
    ["more time than a step may last", [{ cell: [0, 0], ms: 0x1_0000_0001 }]],
    ["a fraction of a millisecond", [{ cell: [0, 0], ms: 1.5 }]],
    ["a missing member", [{ cell: [0, 0] }]],
    ["an unknown member", [{ cell: [0, 0], ms: 1, until: 3 }]],
  ])("rejects %s as malformed", (_name, cooldowns) => {
    expect(accept(idleWith(1_000, cooldowns))).toEqual({ kind: "rejected", reason: "malformed" });
  });
});

/**
 * A world of one being at (5, 5) whose brain idles for `idleMs` at each decision, adding the
 * cooldowns `plan` gives for the decision's index; `sensed` collects the cooldowns it sensed.
 */
function cooling(
  plan: (decision: number) => unknown,
  options: { readonly idleMs: number; readonly simSecondsPerTick?: number },
) {
  const sensed: (readonly beings.Cooldown[])[] = [];
  const decide = (senses: Senses) => {
    sensed.push(senses.self.cooldowns as readonly beings.Cooldown[]);
    return idleWith(options.idleMs, plan(sensed.length - 1));
  };
  const world = beingsWorld({
    controllers: { [SPECIES.id]: brain(decide) },
    life: NEAR,
    audit: false,
    ...(options.simSecondsPerTick === undefined
      ? {}
      : { simSecondsPerTick: options.simSecondsPerTick }),
  });
  return { world, sensed, born: [spawn(1, { species: SPECIES.id, cell: [5, 5] })] };
}

describe("cooldowns in the tick", () => {
  test("end at the tick ⌈ms / (simSecondsPerTick·1000)⌉ after the decision, at 12 and 6 s", () => {
    const cooldowns = [
      { cell: [1, 1], ms: 1 },
      { cell: [2, 2], ms: 24_000 },
      { cell: [3, 3], ms: 24_001 },
    ];
    // The first decision is at tick 2, the tick after the spawn.
    const twelve = cooling((n) => (n === 0 ? cooldowns : undefined), { idleMs: 600_000 });
    runTo(twelve.world, 2, twelve.born);
    expect(beingOf(twelve.world, 1).cooldowns).toEqual([
      { cell: [1, 1], until: 3 },
      { cell: [2, 2], until: 4 },
      { cell: [3, 3], until: 5 },
    ]);
    const six = cooling((n) => (n === 0 ? cooldowns : undefined), {
      idleMs: 600_000,
      simSecondsPerTick: 6,
    });
    runTo(six.world, 2, six.born);
    expect(beingOf(six.world, 1).cooldowns).toEqual([
      { cell: [1, 1], until: 3 },
      { cell: [2, 2], until: 6 },
      { cell: [3, 3], until: 7 },
    ]);
  });

  test("are dropped once their tick has come, before the brain senses them again", () => {
    // Decisions at ticks 2, 4, and 6: an idle of 24 s lasts two ticks.
    const added = [
      { cell: [1, 1], ms: 24_000 },
      { cell: [2, 2], ms: 36_000 },
    ];
    const { world, sensed, born } = cooling((n) => (n === 0 ? added : undefined), {
      idleMs: 24_000,
    });
    runTo(world, 6, born);
    expect(sensed).toEqual([
      [],
      // At tick 4, [1, 1] ended (until 4) and [2, 2] still holds (until 5).
      [{ cell: [2, 2], until: 5 }],
      [],
    ]);
    expect(beingOf(world, 1).cooldowns).toEqual([]);
  });

  test("keep the newest four, one per cell, a later entry replacing an earlier one", () => {
    const first = [
      { cell: [1, 1], ms: 600_000 },
      { cell: [2, 2], ms: 600_000 },
      { cell: [3, 3], ms: 600_000 },
    ];
    const second = [
      { cell: [2, 2], ms: 1_200_000 },
      { cell: [4, 4], ms: 600_000 },
      { cell: [4, 4], ms: 1_200_000 },
      { cell: [5, 5], ms: 600_000 },
    ];
    const { world, born } = cooling((n) => [first, second][n], { idleMs: 24_000 });
    runTo(world, 4, born);
    expect(beingOf(world, 1).cooldowns).toEqual([
      { cell: [3, 3], until: 52 },
      { cell: [2, 2], until: 104 },
      { cell: [4, 4], until: 104 },
      { cell: [5, 5], until: 54 },
    ]);
  });

  test("are left as they were by a refused intention, and unchanged by one without them", () => {
    const added = [{ cell: [1, 1], ms: 600_000 }];
    const refused = { steps: [], wakeWhen: {}, behavior: behavior("rest"), cooldowns: added };
    // The first decision adds the cooldown; the next one, which senses it, is refused.
    const decide = (senses: Senses) =>
      (senses.self.cooldowns.length === 0 ? idleWith(24_000, added) : refused) as never;
    const world = beingsWorld({ controllers: { [SPECIES.id]: brain(decide) }, life: NEAR });
    runTo(world, 4, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(world, 1)).toMatchObject({
      outcome: { result: "rejected", tick: 4, reason: "malformed" },
      cooldowns: [{ cell: [1, 1], until: 52 }],
    });
    // An accepted intention that leaves the member out keeps the cooldowns still in force.
    const keep = (senses: Senses) =>
      senses.self.cooldowns.length === 0 ? idleWith(24_000, added) : idleWith(24_000);
    const kept = beingsWorld({ controllers: { [SPECIES.id]: brain(keep) }, life: NEAR });
    runTo(kept, 4, [spawn(1, { species: SPECIES.id, cell: [5, 5] })]);
    expect(beingOf(kept, 1)).toMatchObject({
      outcome: { result: "none" },
      activity: { kind: "idle", start: 4 },
      cooldowns: [{ cell: [1, 1], until: 52 }],
    });
    const plain = cooling(() => undefined, { idleMs: 24_000 });
    runTo(plain.world, 30, plain.born);
    expect(plain.sensed.length).toBe(15);
    expect(plain.sensed.every((cooldowns) => cooldowns.length === 0)).toBe(true);
    expect(beingOf(plain.world, 1).cooldowns).toEqual([]);
  });
});
