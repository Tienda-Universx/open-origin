/**
 * The delivery of speech in beings@2 (ADR 0024, docs/architecture/mind.md "Speech", "Provenance and
 * taints", "Events", "The tick of beings@2", and "Verification plan"): an act that ends at tick t
 * is judged against the state at the start of t, reaches no hearer that died at t, fills a full
 * inbox by a fair draw on `beings.speech` keyed by the hearer, and merges into the hearer's record
 * at the end of t, so that it is heard at t + 1, never in t; the hearer's exposure grows by the
 * message's taints; an idle hearer wakes within its quota, and a busy one keeps the message; a
 * heard tell keeps its speaker, tick, act, and taints in the belief it supports and in the ledger,
 * along a chain of tells; and the speaker learns nothing of whether it was heard.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  DrawSequence,
  type EngineEvent,
  type mind,
  type Seed,
  streamId,
  tickKey,
} from "../src/index.ts";
import { beingOf, cumulative, runTo, walkMs, windowAt } from "./support/beings-world.ts";
import { type Cell, eventsAt, idling } from "./support/beings2-mind.ts";
import {
  A,
  B,
  eventsOfType,
  FOUR,
  LONG,
  mindIn,
  NEAR,
  type Script,
  scripted,
  THREE,
  talk,
} from "./support/beings2-speech.ts";
import { being2, life2With, type Senses2 } from "./support/beings2-world.ts";
import { belief, foodAt, mindOf } from "./support/mind-records.ts";

/** A script that proposes `first` at the first decision and idles long after. */
const once =
  (first: beings.Intention2): Script =>
  (_senses, decision) =>
    decision === 0 ? first : idling(LONG);

/** The laws of life@2 with their one species changed: its speech, perception, mind, and death. */
const lawsWith = (
  change: {
    readonly speech?: Partial<beings.SpeechLaws>;
    readonly perception?: Partial<beings.Perception>;
    readonly inbox?: number;
  },
  deathEnabled = false,
): beings.LifeConfig2 => ({
  ...life2With((species) => ({
    ...species,
    speech: { ...species.speech, ...change.speech },
    perception: { ...species.perception, ...change.perception },
    mind: { ...species.mind, inbox: change.inbox ?? species.mind.inbox },
  })),
  deathEnabled,
});

/** The payloads of the events of `type` in `events` at `tick`. */
const payloadsAt = (events: readonly EngineEvent[], tick: number, type: string) =>
  eventsAt(events, tick)
    .filter(([kind]) => kind === type)
    .map(([, payload]) => payload);

/** A greeting of being 1 at A to being 2, delivered at `t`. */
const greetingAt = (t: number, who = 1, cell: Cell = A): mind.InboxMessage => ({
  who,
  t,
  cell: [cell[0], cell[1]],
  act: "greet",
  tn: 0,
  ex: 0,
});

describe("an act that ends at tick t", () => {
  test("is delivered at the end of t and heard at t + 1, waking an idle hearer", () => {
    const { world, sensed } = scripted([being2(1, A), being2(2, B)], { 1: once(talk(2, "greet")) });
    runTo(world, 1);
    const ended = runTo(world, 2);
    // Phase 4 comes after every event of phase 2: the delivery is the tick's last event.
    expect(eventsAt(ended, 2).at(-1)).toEqual(["speech.delivered", { id: 1, to: 2 }]);
    expect(mindIn(world, 2).inbox).toEqual([greetingAt(2)]);
    expect(beingOf(world, 2).wake).toBe(3);
    // A greet carries no taint: the hearer's exposure did not change, and no provenance says so.
    const ofHearer = (payload: unknown) => (payload as { id: number }).id === 2;
    expect(payloadsAt(ended, 2, "mind.provenance").filter(ofHearer)).toEqual([]);
    expect(mindIn(world, 2).exposure).toBe(0);
    const heard = runTo(world, 3);
    expect(eventsAt(heard, 3)[0]).toEqual([
      "being.finished",
      { id: 2, activity: "idle", result: "interrupted", reason: "heard" },
    ]);
    expect(sensed.get(2)?.map((senses) => senses.perceived.heard)).toEqual([
      [],
      [{ who: 1, cell: [...A], act: "greet" }],
    ]);
    expect(mindIn(world, 2).quota).toMatchObject({ woken: 1 });
  });

  test("is never heard in t: a hearer that decides at t hears it at t + 1", () => {
    // Being 2 decides at tick 2 too, its idle of one tick ending then.
    const hearer = {
      ...being2(2, B),
      activity: { kind: "idle" as const, start: 0, ms: 24_000 },
      wake: 2,
    };
    const { world, sensed } = scripted([being2(1, A), hearer], { 1: once(talk(2, "greet")) });
    runTo(world, 3);
    expect(sensed.get(2)?.map((senses) => senses.perceived.heard)).toEqual([
      [],
      [{ who: 1, cell: [...A], act: "greet" }],
    ]);
    expect(mindIn(world, 2).inbox).toEqual([]);
  });

  test("of a tell grows the hearer's exposure at once, with a mind.provenance", () => {
    const held = mindOf({
      beliefs: [belief(1, { p: foodAt(9, 9), cr: 900, tn: 2, ex: 4 })],
      exposure: 2,
    });
    const { world } = scripted([being2(1, A, { mind: held }), being2(2, B)], {
      1: once(talk(2, "tell", 1)),
    });
    const events = runTo(world, 2);
    expect(eventsAt(events, 2).slice(-2)).toEqual([
      ["speech.delivered", { id: 1, to: 2 }],
      ["mind.provenance", { id: 2, records: [], exposure: 6 }],
    ]);
    expect(mindIn(world, 2)).toMatchObject({
      exposure: 6,
      inbox: [{ who: 1, t: 2, cell: [...A], act: "tell", p: foodAt(9, 9), band: 2, tn: 2, ex: 6 }],
    });
  });
});

describe("an act is not heard", () => {
  /** The outcomes of the deliveries of `events`, as [type, payload]. */
  const outcomes = (events: readonly EngineEvent[]) =>
    events
      .filter(({ type }) => type === "speech.delivered" || type === "speech.unheard")
      .map(({ tick, type, payload }) => [tick, type, payload]);

  test("by a hearer that moved out of reach while the act lasted: range", () => {
    // Being 2 at THREE walks one step east, to FOUR, from tick 1; being 1 starts an act of 60 s
    // at tick 2, while being 2 is still at THREE, which ends at tick 7, after the step arrived.
    const stepMs = cumulative(walkMs(windowAt(THREE), "0") ?? [])[0] ?? Number.POSITIVE_INFINITY;
    expect(1 + Math.ceil(stepMs / 12_000)).toBeLessThan(7);
    const walker: Script = (_senses, decision) =>
      decision === 0
        ? {
            steps: [{ kind: "walk", dirs: "0" }],
            wakeWhen: {},
            behavior: { kind: "x", since: 0, heading: 0 },
          }
        : idling(LONG);
    const speaker = {
      ...being2(1, A),
      activity: { kind: "idle" as const, start: 0, ms: 24_000 },
      wake: 2,
    };
    const { world } = scripted(
      [speaker, being2(2, THREE)],
      { 1: once(talk(2, "greet")), 2: walker },
      { life: lawsWith({ speech: { actMs: 60_000 } }) },
    );
    const events = runTo(world, 7);
    expect(beingOf(world, 2).cell).toEqual([...FOUR]);
    expect(eventsOfType(events, "being.started")[0]).toEqual({
      tick: 1,
      payload: { id: 2, activity: "walk" },
    });
    expect(outcomes(events)).toEqual([[7, "speech.unheard", { id: 1, to: 2, reason: "range" }]]);
    expect(mindIn(world, 2).inbox).toEqual([]);
  });

  test("by a hearer that fell asleep: asleep", () => {
    const sleeper: Script = (_senses, decision) =>
      decision === 0
        ? {
            steps: [{ kind: "sleep", untilRest: beings.NEED_MAX }],
            wakeWhen: {},
            behavior: { kind: "sleep", since: 0, heading: 0 },
          }
        : idling(LONG);
    const tired = being2(2, B, { needs: { nutrition: beings.NEED_MAX, rest: 100_000 } });
    const { world } = scripted([being2(1, A), tired], { 1: once(talk(2, "greet")), 2: sleeper });
    const events = runTo(world, 2);
    expect(outcomes(events)).toEqual([[2, "speech.unheard", { id: 1, to: 2, reason: "asleep" }]]);
    expect(mindIn(world, 2).inbox).toEqual([]);
  });

  test("by a hearer that is incapacitated: condition", () => {
    const weak = { ...being2(2, B), condition: "incapacitated" as const, health: 0 };
    const { world } = scripted([being2(1, A), weak], { 1: once(talk(2, "greet")) });
    const events = runTo(world, 2);
    expect(outcomes(events)).toEqual([
      [2, "speech.unheard", { id: 1, to: 2, reason: "condition" }],
    ]);
    expect(mindIn(world, 2).inbox).toEqual([]);
  });

  test("by a hearer that died at t, or before it: gone", () => {
    // Starving, being 2 reaches health 0 at tick 2: the tick the act of being 1 ends.
    const dying = being2(2, B, { needs: { nutrition: 0, rest: beings.NEED_MAX } });
    const atT = scripted(
      [being2(1, A), { ...dying, health: 200 }],
      { 1: once(talk(2, "greet")) },
      {
        life: lawsWith({}, true),
      },
    );
    const events = runTo(atT.world, 2);
    expect(eventsOfType(events, "being.died").map(({ tick }) => tick)).toEqual([2]);
    expect(outcomes(events)).toEqual([[2, "speech.unheard", { id: 1, to: 2, reason: "gone" }]]);
    // An act of 60 s ends at tick 6, when being 2, dead at tick 2, is no longer in the world.
    const before = scripted(
      [being2(1, A), { ...dying, health: 200 }],
      { 1: once(talk(2, "greet")) },
      {
        life: lawsWith({ speech: { actMs: 60_000 } }, true),
      },
    );
    expect(outcomes(runTo(before.world, 6))).toEqual([
      [6, "speech.unheard", { id: 1, to: 2, reason: "gone" }],
    ]);
  });

  test("by a hearer whose inbox has no room: full, the speakers drawn fairly", () => {
    // Speakers 3, 4, and 5 greet being 9 at once, whose inbox holds two messages.
    const seeds: Seed[] = [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ];
    const lost = new Set<number>();
    for (const seed of seeds) {
      const speakers = [3, 4, 5].map((id, index) => being2(id, [A[0] + index, A[1]]));
      const scripts = {
        3: once(talk(9, "greet")),
        4: once(talk(9, "greet")),
        5: once(talk(9, "greet")),
      };
      const { world } = scripted([...speakers, being2(9, B)], scripts, { seed });
      const events = runTo(world, 2);
      const order = new DrawSequence(seed, streamId(beings.SPEECH_STREAM), tickKey(2, 9))
        .permutation(3)
        .map((index) => [3, 4, 5][index] as number);
      const [first, second, third] = order as [number, number, number];
      lost.add(third);
      // Outcomes and messages follow the speakers' ids, whatever the draw.
      expect(outcomes(events)).toEqual(
        [3, 4, 5].map((id) => [
          2,
          id === third ? "speech.unheard" : "speech.delivered",
          id === third ? { id, to: 9, reason: "full" } : { id, to: 9 },
        ]),
      );
      const kept = [first, second].sort((a, b) => a - b);
      expect(mindIn(world, 9).inbox.map(({ who }) => who)).toEqual(kept);
    }
    // The draw decides: across the seeds, every speaker went unheard at least once.
    expect([...lost].sort()).toEqual([3, 4, 5]);
  });

  test("by a hearer whose inbox holds as many messages as it may: full, without a draw", () => {
    const filled = being2(2, B, { mind: mindOf({ inbox: [greetingAt(0, 7), greetingAt(0, 8)] }) });
    const hearer = {
      ...filled,
      activity: { kind: "idle" as const, start: 0, ms: LONG },
      wake: 500,
    };
    const { world } = scripted([being2(1, A), hearer], { 1: once(talk(2, "greet")) });
    const events = runTo(world, 2);
    expect(outcomes(events)).toEqual([[2, "speech.unheard", { id: 1, to: 2, reason: "full" }]]);
    expect(mindIn(world, 2).inbox.map(({ who }) => who)).toEqual([7, 8]);
  });
});

describe("a hearer", () => {
  test("that walks keeps the message for the decision at the end of its walk", () => {
    const stepMs = cumulative(walkMs(windowAt(B), "00") ?? []).at(-1) ?? Number.POSITIVE_INFINITY;
    const arrival = 1 + Math.ceil(stepMs / 12_000);
    expect(arrival).toBeGreaterThan(3);
    const walker: Script = (_senses, decision) =>
      decision === 0
        ? {
            steps: [{ kind: "walk", dirs: "00" }],
            wakeWhen: {},
            behavior: { kind: "x", since: 0, heading: 0 },
          }
        : idling(LONG);
    const { world, sensed } = scripted([being2(1, A), being2(2, B)], {
      1: once(talk(2, "greet")),
      2: walker,
    });
    const events = runTo(world, arrival);
    expect(payloadsAt(events, 2, "speech.delivered")).toEqual([{ id: 1, to: 2 }]);
    // Not woken at tick 3: it decided when its walk ended, and heard the greeting then.
    expect(eventsAt(events, 3)).toEqual([]);
    expect(sensed.get(2)?.map((senses) => senses.perceived.heard)).toEqual([
      [],
      [{ who: 1, cell: [...A], act: "greet" }],
    ]);
    expect(mindIn(world, 2).quota).toMatchObject({ woken: 0 });
  });

  test("that talks keeps the message for the decision at the end of its act", () => {
    // Acts of 30 s: being 1's, from tick 1, ends at tick 4, while being 2's, from tick 2, lasts
    // until tick 5.
    const later = {
      ...being2(2, B),
      activity: { kind: "idle" as const, start: 0, ms: 24_000 },
      wake: 2,
    };
    const { world, sensed } = scripted(
      [being2(1, A), later],
      { 1: once(talk(2, "greet")), 2: once(talk(1, "greet")) },
      { life: lawsWith({ speech: { actMs: 30_000 } }) },
    );
    const events = runTo(world, 5);
    expect(payloadsAt(events, 4, "speech.delivered")).toEqual([{ id: 1, to: 2 }]);
    // Not woken by it: being 2 decided only at the end of its own act, and heard it then.
    expect(
      eventsAt(events, 5).find(
        ([type, payload]) => type === "being.finished" && (payload as { id: number }).id === 2,
      ),
    ).toEqual(["being.finished", { id: 2, activity: "talk", result: "done", reason: "" }]);
    expect(sensed.get(2)?.map((senses) => senses.perceived.heard)).toEqual([
      [],
      [{ who: 1, cell: [...A], act: "greet" }],
    ]);
  });

  test("is woken at most speech.wakesPerDay times a day; later messages wait", () => {
    // Being 1 greets being 2 twice; under one wake a day, only the first wakes being 2.
    const greets: Script = (_senses, decision) => (decision < 2 ? talk(2, "greet") : idling(LONG));
    const { world, sensed } = scripted(
      [being2(1, A), being2(2, B)],
      { 1: greets },
      {
        life: lawsWith({ speech: { wakesPerDay: 1 } }),
      },
    );
    runTo(world, 4);
    expect(sensed.get(2)?.map((senses) => senses.perceived.heard.length)).toEqual([0, 1]);
    expect(mindIn(world, 2)).toMatchObject({
      inbox: [greetingAt(3)],
      quota: { day: 0, woken: 1 },
    });
  });

  test("gets a relationship by a heard act alone, never seen, when it does not perceive the speaker", () => {
    // Attention 1: being 2 perceives being 3, beside it, and not being 1, two cells away.
    const { world } = scripted(
      [being2(1, A), being2(2, B), being2(3, THREE)],
      { 1: once(talk(2, "greet")) },
      {
        life: lawsWith({ perception: { attention: 1 } }),
      },
    );
    const events = runTo(world, 3);
    const relations = mindIn(world, 2).relations;
    expect(relations.find((held) => held.who === 1)).toEqual({
      id: 2,
      who: 1,
      f: 0,
      seen: 0,
      aff: 0,
      tr: 500,
      tn: 0,
      talk: 0,
      turns: 0,
    });
    expect(
      payloadsAt(events, 3, "mind.changed").find((p) => (p as { id: number }).id === 2),
    ).toMatchObject({
      related: [2],
    });
  });

  test("gets no relationship by an act it did not hear", () => {
    const weak = { ...being2(2, B), condition: "incapacitated" as const, health: 0 };
    const { world } = scripted(
      [being2(1, A), weak, being2(3, THREE)],
      { 1: once(talk(2, "greet")), 2: once(idling(1)) },
      {
        life: lawsWith({ perception: { attention: 1 } }),
      },
    );
    runTo(world, 4);
    expect(mindIn(world, 2).relations.map(({ who }) => who)).toEqual([3]);
  });
});

describe("a testimony", () => {
  test("keeps its speaker, tick, and act in the belief it supports and in the ledger", () => {
    const told = foodAt(9, 9, 2);
    const held = mindOf({ beliefs: [belief(1, { p: told, cr: 900, tn: 2, ex: 4 })], exposure: 2 });
    const believe: Script = (senses, decision) => {
      if (decision === 0 || senses.perceived.heard.length === 0) return idling(LONG);
      const next = senses.mind.next;
      return idling(LONG, {
        remember: [{ percept: { heard: 0 }, w: 600 }],
        believe: [{ p: { ...told, p: "t1.food-at" }, cr: 700, ev: [next], rule: "told" }],
      });
    };
    const { world } = scripted([being2(1, A, { mind: held }), being2(2, B)], {
      1: once(talk(2, "tell", 1)),
      2: believe,
    });
    const events = runTo(world, 3);
    // Uttered and delivered at tick 2, heard at tick 3.
    expect(payloadsAt(events, 2, "speech.uttered")).toEqual([
      { id: 1, to: 2, act: "tell", p: told, band: 2, cell: [...A] },
    ]);
    expect(payloadsAt(events, 2, "speech.delivered")).toEqual([{ id: 1, to: 2 }]);
    const hearer = mindIn(world, 2);
    const episode = hearer.episodes.find(({ kind }) => kind === "heard");
    expect(episode).toMatchObject({
      kind: "heard",
      t: 3,
      who: 1,
      act: "tell",
      cell: [...A],
      p: told,
      band: 2,
      tn: 2,
      ex: 6,
    });
    const formed = hearer.beliefs[0];
    expect(formed).toMatchObject({ who: 1, src: 2, ev: [episode?.id], tn: 2, ex: 6 });
    const changed = payloadsAt(events, 3, "mind.changed").find(
      (p) => (p as { id: number }).id === 2,
    );
    expect(changed).toMatchObject({
      encoded: [episode?.id],
      formed: [{ id: formed?.id, rule: "told" }],
    });
    const provenance = payloadsAt(events, 3, "mind.provenance").find(
      (p) => (p as { id: number }).id === 2,
    );
    expect(provenance).toMatchObject({
      records: expect.arrayContaining([
        { id: episode?.id, tn: 2, ex: 6, ev: [] },
        { id: formed?.id, tn: 2, ex: 6, ev: [episode?.id] },
      ]),
      exposure: 6,
    });
  });

  test("passed from A to B to C keeps its tn and ex", () => {
    // A at A holds a claim research injected: human-external, 2. C at FOUR is out of A's reach.
    const claim = foodAt(5, 5, 2);
    const heldA = mindOf({
      beliefs: [belief(1, { p: claim, cr: 900, tn: 2, ex: 0 })],
      exposure: 2,
    });
    const relay: Script = (senses) => {
      if (senses.perceived.heard.length === 0) return idling(LONG);
      const next = senses.mind.next;
      // Remember, believe citing it, and tell C the new belief at once.
      return talk(3, "tell", next + 1, {
        remember: [{ percept: { heard: 0 }, w: 600 }],
        believe: [{ p: { ...claim, p: "t1.food-at" }, cr: 900, ev: [next], rule: "told" }],
      });
    };
    const remember: Script = (senses) =>
      idling(
        LONG,
        senses.perceived.heard.length === 0
          ? undefined
          : { remember: [{ percept: { heard: 0 }, w: 600 }] },
      );
    const { world } = scripted([being2(1, A, { mind: heldA }), being2(2, B), being2(3, FOUR)], {
      1: once(talk(2, "tell", 1)),
      2: relay,
      3: remember,
    });
    // A's act ends at tick 2, and B, woken at tick 3, tells C, which hears it at tick 5.
    runTo(world, 4);
    const relayed = { ...claim, p: "t1.food-at" };
    expect(mindIn(world, 3)).toMatchObject({
      inbox: [{ who: 2, t: 4, cell: [...B], act: "tell", p: relayed, band: 2, tn: 2, ex: 2 }],
      exposure: 2,
    });
    runTo(world, 5);
    expect(mindIn(world, 3).episodes).toEqual([
      expect.objectContaining({ kind: "heard", who: 2, act: "tell", p: relayed, tn: 2, ex: 2 }),
    ]);
  });

  test("never tells the speaker whether it was heard: its records and senses are the same", () => {
    const run = (condition: "ok" | "incapacitated") => {
      const hearer = {
        ...being2(2, B),
        condition,
        health: condition === "ok" ? beings.NEED_MAX : 0,
      };
      const { world, sensed } = scripted([being2(1, A), hearer], {
        1: (_senses, decision) => (decision < 3 ? talk(2, "greet") : idling(LONG)),
      });
      const records = [1, 2, 3, 4, 5].map((tick) => {
        runTo(world, tick);
        return beingOf(world, 1);
      });
      return { records, senses: sensed.get(1) as Senses2[] };
    };
    const heard = run("ok");
    const unheard = run("incapacitated");
    expect(unheard.records).toEqual(heard.records);
    expect(unheard.senses).toEqual(heard.senses);
    expect(heard.senses).toHaveLength(4);
  });
});

describe("a hearer within reach", () => {
  test("is one the speaker perceived and stands within speech.range at the start of t", () => {
    const { world } = scripted([being2(1, A), being2(2, NEAR)], { 1: once(talk(2, "unknown")) });
    const events = runTo(world, 2);
    expect(payloadsAt(events, 2, "speech.delivered")).toEqual([{ id: 1, to: 2 }]);
    expect(mindIn(world, 2).inbox).toEqual([{ ...greetingAt(2), act: "unknown" }]);
  });
});

describe("the room of an inbox and the record a delivery writes", () => {
  test("gives each hearer of one chunk its message, and leaves the rest of the chunk as it was", () => {
    // Beings 1 and 2 greet beings 3 and 4, both idle, in the chunk of being 5, which hears nothing.
    const { world } = scripted(
      [being2(1, A), being2(2, NEAR), being2(3, B), being2(4, THREE), being2(5, FOUR)],
      { 1: once(talk(3, "greet")), 2: once(talk(4, "greet")) },
    );
    runTo(world, 1);
    const bystander = beingOf(world, 5);
    const events = runTo(world, 2);
    expect(eventsOfType(events, "speech.delivered").map(({ payload }) => payload)).toEqual([
      { id: 1, to: 3 },
      { id: 2, to: 4 },
    ]);
    expect(mindIn(world, 3).inbox).toEqual([greetingAt(2)]);
    expect(mindIn(world, 4).inbox).toEqual([greetingAt(2, 2, NEAR)]);
    expect(beingOf(world, 5)).toEqual(bystander);
    expect([3, 4].map((id) => beingOf(world, id).wake)).toEqual([3, 3]);
  });
});
