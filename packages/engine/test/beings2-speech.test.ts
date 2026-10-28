/**
 * The act of speech of beings@2 (ADR 0024, docs/architecture/mind.md "Speech", "Relationships",
 * "Events", and "Commands and faults"): a `talk { to, act, about? }` is the only step of its
 * intention, judged after the mental operations against what the being perceived in the same
 * decision; it lasts `speech.actMs`, counts as idle for the needs, and captures a tell's content
 * when the being decides; it obeys `speech.perDay`, and `speech.turns`, `speech.gap`, and
 * `speech.cooldown` per hearer; a failed condition or quota rejects the whole intention with its
 * reason; and only forced sleep, incapacity, or death cut it short, which `speech.uttered` then
 * never reports.
 */
import { describe, expect, test } from "bun:test";
import { beings, type EngineEvent, type mind } from "../src/index.ts";
import { beingOf, runTo } from "./support/beings-world.ts";
import { eventsAt, idling } from "./support/beings2-mind.ts";
import {
  A,
  B,
  eventsOfBeing,
  eventsOfType,
  FAR,
  FOUR,
  LONG,
  mindIn,
  NEAR,
  type Script,
  scripted,
  THREE,
  talk,
} from "./support/beings2-speech.ts";
import { being2, life2With } from "./support/beings2-world.ts";
import { belief, foodAt, mindOf, own, relationship } from "./support/mind-records.ts";

/** Being 1, the speaker, at A holding `held`; being 2, the hearer, at B. */
const pair = (held?: mind.Mind) => [
  being2(1, A, held === undefined ? {} : { mind: held }),
  being2(2, B),
];

/** A script that proposes `first` at the first decision and idles long after. */
const once =
  (first: beings.Intention2): Script =>
  (_senses, decision) =>
    decision === 0 ? first : idling(LONG);

/** The laws of life@2 with their one species' speech changed by `change`. */
const speechWith = (change: Partial<beings.SpeechLaws>, deathEnabled = false) => {
  const life = life2With((species) => ({ ...species, speech: { ...species.speech, ...change } }));
  return { ...life, deathEnabled };
};

/** The relationship being 1 of `world` holds with `who`. */
const relationWith = (world: Parameters<typeof beingOf>[0], who: number) =>
  mindIn(world, 1).relations.find((relationship) => relationship.who === who);

describe("a talk", () => {
  test("starts at a decision, holds its hearer and act, lasts speech.actMs, and ends uttered", () => {
    const { world, sensed } = scripted(pair(), { 1: once(talk(2, "greet")) });
    const started = runTo(world, 1);
    expect(eventsOfBeing(started, 1, 1).slice(0, 1)).toEqual([
      ["being.started", { id: 1, activity: "talk" }],
    ]);
    const speaker = beingOf(world, 1) as beings.Being2;
    expect(speaker.activity).toEqual({
      kind: "talk",
      start: 1,
      to: 2,
      act: "greet",
      captured: { tn: 0, ex: 0 },
    });
    // speech.actMs, 4,000 ms, ends within the next tick of 12 s.
    expect(speaker.wake).toBe(2);
    expect(speaker.mind.quota).toEqual({ day: 0, said: 1, woken: 0 });
    expect(relationWith(world, 2)).toMatchObject({ talk: 1, turns: 1 });
    const ended = runTo(world, 2);
    const own = eventsOfBeing(ended, 2, 1);
    expect(own[0]).toEqual([
      "being.finished",
      { id: 1, activity: "talk", result: "done", reason: "" },
    ]);
    // The being decides at the end of its act, and speech.uttered is its last event of the phase.
    expect(sensed.get(1)).toHaveLength(2);
    expect(own.map(([type]) => type)).toEqual([
      "being.finished",
      "being.started",
      "mind.changed",
      "mind.provenance",
      "speech.uttered",
    ]);
    expect(own.at(-1)).toEqual(["speech.uttered", { id: 1, to: 2, act: "greet", cell: [...A] }]);
  });

  test("counts as idle for the needs", () => {
    const talking = scripted(pair(), { 1: once(talk(2, "greet")) });
    const idle = scripted(pair(), { 1: once(idling(1)) });
    runTo(talking.world, 2);
    runTo(idle.world, 2);
    const [a, b] = [beingOf(talking.world, 1), beingOf(idle.world, 1)];
    expect({ needs: a.needs, anchor: a.anchor, health: a.health }).toEqual({
      needs: b.needs,
      anchor: b.anchor,
      health: b.health,
    });
  });

  test("of a tell captures the belief's proposition, band, and tn, and its ex with the exposure", () => {
    const told = foodAt(3, 4, 1);
    const held = mindOf({ beliefs: [belief(5, { p: told, cr: 650, tn: 2, ex: 4 })], exposure: 3 });
    const { world } = scripted(pair(held), { 1: once(talk(2, "tell", 5)) });
    runTo(world, 1);
    expect(beingOf(world, 1).activity).toMatchObject({
      kind: "talk",
      act: "tell",
      captured: { p: told, band: 1, tn: 2, ex: 7 },
    });
    const events = runTo(world, 2);
    // Uttered in public: the proposition and the band, never a taint.
    expect(eventsOfType(events, "speech.uttered")).toEqual([
      { tick: 2, payload: { id: 1, to: 2, act: "tell", p: told, band: 1, cell: [...A] } },
    ]);
  });

  test("of a tell gives the band of the speaker's confidence: 2 from 800, 1 from 500, else 0", () => {
    // Four speakers at A, NEAR, B, and THREE, all within reach of the hearer at NEAR.
    const speakers = [800, 799, 500, 499].map((cr, index) =>
      being2(index + 1, [A[0] + index, A[1]], {
        mind: mindOf({ beliefs: [belief(1, { p: foodAt(index, 0), cr })] }),
      }),
    );
    const scripts = Object.fromEntries(speakers.map(({ id }) => [id, once(talk(9, "tell", 1))]));
    const { world } = scripted([...speakers, being2(9, NEAR)], scripts);
    const events = runTo(world, 2);
    expect(
      eventsOfType(events, "speech.uttered").map(
        ({ payload }) => (payload as { band: number }).band,
      ),
    ).toEqual([2, 1, 1, 0]);
  });

  test("may tell a belief formed in the same decision, by the id predicted from next", () => {
    // A concept of the test brains' namespace, t1.
    const told = { ...foodAt(7, 7, 2), p: "t1.food-at" };
    const formed = { p: told, cr: 900, ev: [], rule: "guess" };
    const { world } = scripted(pair(), { 1: once(talk(2, "tell", 2, { believe: [formed] })) });
    runTo(world, 1);
    // Step 1 made the relationship with being 2 id 1; the belief takes 2, citing nothing.
    expect(beingOf(world, 1).activity).toMatchObject({
      act: "tell",
      captured: { p: told, band: 2, tn: 1, ex: 1 },
    });
  });

  test("of an ask names the food of its species, and of a greet or unknown nothing", () => {
    for (const [act, about] of [
      ["ask", "obs.deposit.0"],
      ["greet", undefined],
      ["unknown", undefined],
    ] as const) {
      const { world } = scripted(pair(), { 1: once(talk(2, act, about)) });
      const events = runTo(world, 2);
      expect(eventsOfType(events, "speech.uttered")).toEqual([
        { tick: 2, payload: { id: 1, to: 2, act, cell: [...A] } },
      ]);
    }
  });
});

describe("a talk is refused, and then no operation of its intention applies", () => {
  /** Being 1's first decision: a talk with a remember, among `others`, with `held` and `life`. */
  const refused = (
    intention: beings.Intention2,
    options: {
      readonly others?: readonly beings.Being2[];
      readonly held?: mind.Mind;
      readonly life?: beings.LifeConfig2;
    } = {},
  ) => {
    // A valid remember: the food cue of its own cell, a percept every decision holds.
    const remember = [{ percept: { food: [A[0], A[1]] as const }, w: 500 }];
    const withMemory = { ...intention, mind: { remember } };
    const speaker = being2(1, A, options.held === undefined ? {} : { mind: options.held });
    const { world } = scripted(
      [speaker, ...(options.others ?? [being2(2, B)])],
      { 1: once(withMemory as beings.Intention2) },
      options.life === undefined ? {} : { life: options.life },
    );
    const before = beingOf(world, 1) as beings.Being2;
    const events = runTo(world, 1);
    const after = beingOf(world, 1) as beings.Being2;
    const rejected = eventsOfType(events, "being.intention_rejected").filter(
      ({ payload }) => (payload as { id: number }).id === 1,
    );
    return { after, before, rejected, events };
  };

  /** Expects the refusal of `intention` with `reason`, its effects on being 1 none of its own. */
  const expectRefused = (reason: string, ...args: Parameters<typeof refused>) => {
    const { after, before, rejected } = refused(...args);
    expect(rejected).toEqual([{ tick: 1, payload: { id: 1, reason } }]);
    expect(after.outcome).toEqual({ result: "rejected", tick: 1, reason });
    expect(after.activity).toEqual({ kind: "idle", start: 1, ms: beings.REFUSED_IDLE_MS });
    // No episode was remembered, no act counted, no hearer addressed.
    expect(after.mind.episodes).toEqual(before.mind.episodes);
    expect(after.mind.quota).toEqual(before.mind.quota);
    expect(after.mind.relations.every((held) => held.talk === 0 && held.turns === 0)).toBe(true);
  };

  test("to a being it did not perceive in this decision, as talk_unseen", () => {
    expectRefused("talk_unseen", talk(99, "greet"));
    expectRefused("talk_unseen", talk(2, "greet"), { others: [being2(2, FAR)] });
    // Attention keeps only the nearest: being 3, at NEAR, hides being 2.
    const life = life2With((species) => ({
      ...species,
      perception: { ...species.perception, attention: 1 },
    }));
    expectRefused("talk_unseen", talk(2, "greet"), {
      others: [being2(2, B), being2(3, NEAR)],
      life,
    });
    // Its own self is never perceived.
    expectRefused("talk_unseen", talk(1, "greet"));
  });

  test("to a being farther than speech.range, as talk_out_of_range", () => {
    expectRefused("talk_out_of_range", talk(2, "greet"), { others: [being2(2, FOUR)] });
  });

  test("to a being that sleeps, as talk_asleep", () => {
    const sleeper = {
      ...being2(2, B, { needs: { nutrition: beings.NEED_MAX, rest: 1000 } }),
      activity: { kind: "sleep" as const, untilRest: beings.NEED_MAX, forced: false },
      wake: 500,
    };
    expectRefused("talk_asleep", talk(2, "greet"), { others: [sleeper] });
  });

  test("of a belief it does not hold, as talk_unheld", () => {
    expectRefused("talk_unheld", talk(2, "tell", 77));
    // A record that is not a belief is no belief to tell.
    expectRefused("talk_unheld", talk(2, "tell", 1), { held: mindOf({ episodes: [own(1)] }) });
  });

  test("of an ask about a concept the species does not perceive, as ask_concept", () => {
    for (const concept of ["obs.deposit.1", "obs.light", "m1.food-at", "t1.creator"])
      expectRefused("ask_concept", talk(2, "ask", concept));
  });

  test("beyond speech.perDay, as talk_quota, which perDay 0 always is", () => {
    expectRefused("talk_quota", talk(2, "greet"), { life: speechWith({ perDay: 0 }) });
  });

  test("of a shape speech does not have, as malformed", () => {
    const shapes: unknown[] = [
      {
        ...talk(2, "greet"),
        steps: [
          { kind: "talk", to: 2, act: "greet" },
          { kind: "idle", ms: 1 },
        ],
      },
      {
        ...talk(2, "greet"),
        steps: [
          { kind: "idle", ms: 1 },
          { kind: "talk", to: 2, act: "greet" },
        ],
      },
      talk(2, "greet", 5),
      talk(2, "unknown", "obs.deposit.0"),
      talk(2, "tell"),
      talk(2, "tell", "obs.deposit.0"),
      talk(2, "ask"),
      talk(2, "ask", 5),
      talk(2, "ask", "Food"),
      talk(0, "greet"),
      talk(2, "lie" as mind.Act),
      { ...talk(2, "greet"), steps: [{ kind: "talk", act: "greet" }] },
      { ...talk(2, "greet"), steps: [{ kind: "talk", to: 2, act: "greet", loud: true }] },
    ];
    for (const shape of shapes) expectRefused("malformed", shape as beings.Intention2);
  });

  test("by its first failed condition: unseen, out of range, asleep, content, then quota", () => {
    const life = speechWith({ perDay: 0 });
    expectRefused("talk_unseen", talk(99, "tell", 77), { life });
    expectRefused("talk_out_of_range", talk(2, "tell", 77), { others: [being2(2, FOUR)], life });
    expectRefused("talk_unheld", talk(2, "tell", 77), { life });
    expectRefused("ask_concept", talk(2, "ask", "m1.food-at"), { life });
  });
});

describe("the quotas of speech", () => {
  /**
   * Being 1 at A, idle until `tick`, holding `relations` and `quota`, then talking to being 2 at
   * B, and to being 3 at THREE, by `script`; under turns 2, gap 120 s, and cooldown 600 s.
   */
  const at = (
    tick: number,
    script: Script,
    held: { readonly relations?: mind.Relationship[]; readonly quota?: mind.Quota } = {},
    change: Partial<beings.SpeechLaws> = {},
  ) => {
    const relations = held.relations ?? [];
    const speaker = {
      ...being2(1, A, {
        mind: { ...mindOf({ relations }), ...(held.quota ? { quota: held.quota } : {}) },
      }),
      activity: { kind: "idle" as const, start: 0, ms: tick * 12_000 },
      wake: tick,
    };
    const life = speechWith({ turns: 2, gap: 120, cooldown: 600, ...change });
    const { world } = scripted([speaker, being2(2, B), being2(3, THREE)], { 1: script }, { life });
    const events = runTo(world, tick);
    const reasons = eventsOfType(events, "being.intention_rejected")
      .filter(({ payload }) => (payload as { id: number }).id === 1)
      .map(({ payload }) => (payload as { reason: string }).reason);
    return { world, reasons };
  };
  const greet2 = once(talk(2, "greet"));
  const D = 60;

  test("a full conversation keeps speech.cooldown before the pair talks again", () => {
    // Two acts addressed to being 2, the last 588 s before: within the cooldown of 600 s.
    const full = [relationship(1, 2, { seen: D - 49, talk: D - 49, turns: 2 })];
    expect(at(D, greet2, { relations: full }).reasons).toEqual(["talk_quota"]);
    // Exactly the cooldown later, a new conversation starts.
    const cooled = [relationship(1, 2, { seen: D - 50, talk: D - 50, turns: 2 })];
    const { world, reasons } = at(D, greet2, { relations: cooled });
    expect(reasons).toEqual([]);
    expect(relationWith(world, 2)).toMatchObject({ talk: D, turns: 1 });
  });

  test("a conversation continues within speech.gap, and ends after a longer pause", () => {
    const within = [relationship(1, 2, { seen: D - 10, talk: D - 10, turns: 1 })];
    const going = at(D, greet2, { relations: within });
    expect(going.reasons).toEqual([]);
    expect(relationWith(going.world, 2)).toMatchObject({ talk: D, turns: 2 });
    const paused = [relationship(1, 2, { seen: D - 11, talk: D - 11, turns: 1 })];
    const fresh = at(D, greet2, { relations: paused });
    expect(fresh.reasons).toEqual([]);
    expect(relationWith(fresh.world, 2)).toMatchObject({ talk: D, turns: 1 });
  });

  test("a full conversation with one being leaves another free", () => {
    const full = [relationship(1, 2, { seen: D - 1, talk: D - 1, turns: 2 })];
    const { world, reasons } = at(D, once(talk(3, "greet")), { relations: full });
    expect(reasons).toEqual([]);
    expect(relationWith(world, 2)).toMatchObject({ talk: D - 1, turns: 2 });
    expect(relationWith(world, 3)).toMatchObject({ talk: D, turns: 1 });
  });

  test("speech.perDay counts the acts of the day, and a new day starts at none", () => {
    const quota = { day: 0, said: 10, woken: 0 };
    expect(at(D, greet2, { quota }).reasons).toEqual(["talk_quota"]);
    // Tick 100 is the first of day 1, of the test genesis's days of 1,200 s.
    const { world, reasons } = at(100, greet2, { quota });
    expect(reasons).toEqual([]);
    expect(mindIn(world, 1).quota).toEqual({ day: 1, said: 1, woken: 0 });
  });

  test("consecutive acts fill a conversation, and the next one to that being is refused", () => {
    const greets: Script = (_senses, decision) => (decision < 3 ? talk(2, "greet") : idling(LONG));
    const { world } = at(D, greets);
    // Each act lasts one tick, so the being decides again at D + 1 and D + 2.
    const events = runTo(world, D + 2);
    expect(
      eventsOfType(events, "being.intention_rejected").map(({ tick, payload }) => [tick, payload]),
    ).toEqual([[D + 2, { id: 1, reason: "talk_quota" }]]);
    expect(relationWith(world, 2)).toMatchObject({ talk: D + 1, turns: 2 });
    expect(mindIn(world, 1).quota).toMatchObject({ said: 2 });
  });
});

describe("the end of a talk", () => {
  /** Being 1 talks to being 2 for 60 s, from tick 1 to tick 6, with `needs`, `health`, and `life`. */
  const longTalk = (body: Partial<beings.Being2>, life: beings.LifeConfig2) => {
    const speaker = { ...being2(1, A), ...body };
    const { world } = scripted([speaker, being2(2, B)], { 1: once(talk(2, "greet")) }, { life });
    const events: EngineEvent[] = runTo(world, 12);
    const finished = eventsOfType(events, "being.finished").filter(
      ({ payload }) => (payload as { activity: string; id: number }).activity === "talk",
    );
    return { world, events, finished };
  };

  test("cut short by forced sleep, utters nothing", () => {
    const life = speechWith({ actMs: 60_000 });
    const { events, finished } = longTalk(
      { needs: { nutrition: beings.NEED_MAX, rest: 300 } },
      life,
    );
    expect(finished).toHaveLength(1);
    const [cut] = finished;
    expect(cut?.payload).toEqual({
      id: 1,
      activity: "talk",
      result: "interrupted",
      reason: "exhausted",
    });
    expect(cut?.tick).toBeLessThan(6);
    expect(eventsOfType(events, "speech.uttered")).toEqual([]);
  });

  test("cut short by incapacity, or by death, utters nothing", () => {
    const starving = { needs: { nutrition: 0, rest: beings.NEED_MAX }, health: 300 };
    const incapacitated = longTalk(starving, speechWith({ actMs: 60_000 }));
    expect(incapacitated.finished.map(({ payload }) => payload)).toEqual([
      { id: 1, activity: "talk", result: "interrupted", reason: "incapacitated" },
    ]);
    expect(eventsOfType(incapacitated.events, "speech.uttered")).toEqual([]);
    const dead = longTalk(starving, speechWith({ actMs: 60_000 }, true));
    expect(eventsOfType(dead.events, "being.died")).toHaveLength(1);
    expect(dead.finished).toEqual([]);
    expect(eventsOfType(dead.events, "speech.uttered")).toEqual([]);
  });

  test("comes at speech.actMs whatever wake condition holds or message arrives meanwhile", () => {
    const message: mind.InboxMessage = { who: 2, t: 1, cell: [...B], act: "greet", tn: 0, ex: 0 };
    // Talking since tick 0 for 60 s, until tick 5, with a message that arrived at tick 1 and a
    // wake condition its nutrition crosses within the first tick.
    const nutrition = 500_000;
    const speaker: beings.Being2 = {
      ...being2(1, A, {
        mind: mindOf({ inbox: [message] }),
        needs: { nutrition, rest: beings.NEED_MAX },
      }),
      activity: { kind: "talk", start: 0, to: 2, act: "greet", captured: { tn: 0, ex: 0 } },
      wakeWhen: { nutritionBelow: nutrition - 10 },
      wake: 1,
    };
    const { world, sensed } = scripted(
      [speaker, being2(2, B)],
      {},
      { life: speechWith({ actMs: 60_000 }) },
    );
    const events = runTo(world, 5);
    expect(
      eventsOfType(events, "being.finished").filter(
        ({ payload }) => (payload as { id: number }).id === 1,
      ),
    ).toEqual([{ tick: 5, payload: { id: 1, activity: "talk", result: "done", reason: "" } }]);
    // It decided once, at the end of its act, and heard the message then.
    expect(sensed.get(1)?.map((senses) => senses.perceived.heard)).toEqual([
      [{ who: 2, cell: [...B], act: "greet" }],
    ]);
    expect(eventsAt(events, 5).some(([type]) => type === "speech.uttered")).toBe(true);
  });
});

describe("a chunk of beings@2 holding a talk", () => {
  const talking = (activity: unknown, plan: unknown[] = []) =>
    beings.beingIssues({ ...being2(1, A), activity, plan }, "", "beings@2").map(({ path }) => path);
  const greet = { kind: "talk", start: 1, to: 2, act: "greet", captured: { tn: 0, ex: 0 } };
  const tell = {
    ...greet,
    act: "tell",
    captured: { p: foodAt(1, 1), band: 2, tn: 2, ex: 6 },
  };

  test("is valid with a greet that captured nothing and a tell that captured its content", () => {
    expect(talking(greet)).toEqual([]);
    expect(talking(tell)).toEqual([]);
  });

  test("is invalid when the talk captured what its act cannot carry, or misses a member", () => {
    expect(talking({ ...greet, captured: { tn: 2, ex: 0 } })).toEqual(["/activity/captured"]);
    expect(talking({ ...greet, captured: { band: 1, tn: 0, ex: 0 } })).toEqual([
      "/activity/captured",
    ]);
    expect(talking({ ...tell, captured: { tn: 0, ex: 0 } })).toEqual(["/activity/captured"]);
    expect(talking({ ...tell, captured: { ...tell.captured, tn: 8 } })).toEqual([
      "/activity/captured/tn",
    ]);
    expect(talking({ ...greet, act: "shout" })).toEqual(["/activity/act"]);
    expect(talking({ ...greet, to: 0 })).toEqual(["/activity/to"]);
    const { captured: _missing, ...silent } = greet;
    expect(talking(silent)).toEqual(["/activity/captured"]);
  });

  test("is invalid with a talk in a plan, which only an intention's one step may be", () => {
    expect(
      talking({ kind: "idle", start: 1, ms: 1 }, [{ kind: "talk", to: 2, act: "greet" }]),
    ).toEqual(["/plan/0/kind"]);
  });

  test("of beings@1 is invalid: talk is no kind of activity of T4", () => {
    const { mind: _none, ...body } = being2(1, A);
    const traits = { appetite: 1000, sleepiness: 1000, curiosity: 1000 };
    const issues = beings.beingIssues({ ...body, traits, activity: greet }, "", "beings@1");
    expect(issues.map(({ path }) => path)).toEqual(["/activity/kind"]);
  });
});
