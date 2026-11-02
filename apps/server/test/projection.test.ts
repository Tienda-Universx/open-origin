/**
 * The C0 projection of a world of beings (ADR 0026, "Projections and classification"; plan tests 9
 * and 11 in part): a being's public record holds exactly the registry's C0 members, field by field;
 * every C0 event type is projected or excluded with a reason; a chunk's records go out only when
 * their C0 bytes change, so C1 changes emit nothing; a being that crosses chunks leaves one and
 * enters the other in the same published tick; speech carries plain text or is left out and
 * counted; the clock is the calendar's; and projecting never changes the world.
 */
import { describe, expect, test } from "bun:test";
import { renderAct, type UtteredAct } from "@open-origin/agents";
import {
  beings,
  type Command,
  EngineError,
  type EngineEvent,
  readView,
  type StepResult,
  stateRoot,
  step,
  type World,
  worldgen,
} from "@open-origin/engine";
import { type BeingPublic, PlainText } from "@open-origin/protocol/public";
import { mindRuleset } from "../../../packages/agents/test/support/mind-ruleset.ts";
import {
  mindWorld,
  SUBJECT_SEEDS,
  SUBJECT_TICKS,
  subjectScript,
} from "../../../packages/agents/test/support/mind-subject.ts";
import { PREPARED } from "../../../packages/engine/test/support/beings-world.ts";
import { being2 } from "../../../packages/engine/test/support/beings2-world.ts";
import type { SuiteRuleset } from "../../../packages/engine/test/support/determinism-records.ts";
import { BEING_PUBLIC_SOURCES, checkedRecord, publicRecordOf } from "../src/projection/being.ts";
import { calendarClock } from "../src/projection/clock.ts";
import { C0_EVENT_DECISIONS, projectEvents } from "../src/projection/events.ts";
import { BeingsProjection, type ProjectionOptions } from "../src/projection/projection.ts";
import type { PublishedChunk, PublishedTick } from "../src/world/published.ts";
import type { CommandIntent } from "../src/world/source.ts";
import {
  canaryScript,
  canaryWorld,
  EAST,
  INJECTION_TICK,
  SITTER,
  WALKER,
  WEST,
} from "./support/canary-world.ts";
import { countingWorld } from "./support/counting-world.ts";

type ClassNode = beings.ClassNode;

/** The nodes of `node` at `path`: a segment names a member, or a kind; a member of every kind
 * resolves in each. */
function pathsAt(node: ClassNode, path: readonly string[], at = ""): [string, ClassNode][] {
  const [head, ...rest] = path;
  if (head === undefined) return [[at, node]];
  if (node.kinds !== undefined) {
    const kind = node.kinds.find((entry) => entry.kind === head);
    if (kind !== undefined) return pathsAt(kind.node, rest, `${at}/${head}`);
    return node.kinds.flatMap((entry) => pathsAt(entry.node, path, `${at}/${entry.kind}`));
  }
  const member = node.members?.find(({ name }) => name === head);
  return member === undefined ? [] : pathsAt(member.node, rest, `${at}/${head}`);
}

/** Every leaf of `node` reached only through C0 nodes: what the registry lets an observer see. */
function publicLeaves(node: ClassNode, at = ""): string[] {
  if (node.class !== "C0") return [];
  if (node.kinds !== undefined)
    return node.kinds.flatMap(({ kind, node: inner }) => publicLeaves(inner, `${at}/${kind}`));
  if (node.members !== undefined)
    return node.members.flatMap(({ name, node: inner }) => publicLeaves(inner, `${at}/${name}`));
  return [at];
}

/** The dotted names of every field of `record`, a BeingPublic. */
function fieldsOf(record: object): string[] {
  return Object.entries(record).flatMap(([name, value]) =>
    typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).map((inner) => `${name}.${inner}`)
      : [name],
  );
}

/** A being of beings@2 at `cell` doing `activity`. */
function doing(id: number, activity: beings.Activity): beings.Being2 {
  return { ...being2(id, [3, 4]), activity };
}

/** An activity of every kind: a talk that captured a tainted claim, a walk on its second step. */
const EAT: beings.Activity = { kind: "eat", start: 1, untilNutrition: 9, bites: 2 };
const TALK: beings.Activity = {
  kind: "talk",
  start: 1,
  to: 4,
  act: "tell",
  captured: { p: { p: "t1.secret", a: [{ n: 77 }] }, band: 1, tn: 2, ex: 5 },
};
const WALK: beings.Activity = { kind: "walk", start: 1, dirs: "02", ms: [10, 20], done: 1 };
const ACTIVITIES: readonly beings.Activity[] = [
  EAT,
  { kind: "idle", start: 1, ms: 5 },
  { kind: "sleep", untilRest: 9, forced: true },
  TALK,
  WALK,
];

/** The public record of the being `id` at the cell (3, 4), doing `activity`. */
function recordDoing(id: number, activity: BeingPublic["activity"]): BeingPublic {
  return { id, species: "s1", stage: "adult", born: 0, cell: [3, 4], activity };
}

/** The commands of `intents`, stamped for `tick`. */
function stamped(intents: readonly CommandIntent[], tick: number): Command[] {
  return intents.map((intent, seq) => ({ ...intent, applyTick: tick, seq }));
}

/** Steps `world` `ticks` times with `script`, projecting each tick; every result and record. */
function projected(
  world: World,
  script: readonly (readonly CommandIntent[])[],
  ticks: number,
  options: ProjectionOptions = {},
) {
  const projection = new BeingsProjection(world, options);
  const ticksRun: { result: StepResult; published: PublishedTick }[] = [];
  for (let tick = 1; tick <= ticks; tick += 1) {
    const result = step(world, stamped(script[tick - 1] ?? [], tick));
    ticksRun.push({ result, published: projection.project(result) });
  }
  return { projection, ticks: ticksRun };
}

/** The mind@1 subject and its script, the determinism suite's world. */
function subject() {
  const world = mindWorld(SUBJECT_SEEDS[0], mindRuleset() as unknown as SuiteRuleset, false);
  return { world, script: subjectScript() };
}

/** An event of the tick `tick`, as step reports it. */
function event(tick: number, seq: number, type: string, payload: EngineEvent["payload"]) {
  const cause = { kind: "system", name: "beings" } as const;
  const built: EngineEvent = { tick, seq, type, payload, cause };
  return built;
}

describe("the public record of a being", () => {
  test("maps every field to a C0 member of the registry, and every C0 member to a field", () => {
    const { BEING_CLASSES } = beings;
    const sources = Object.values(BEING_PUBLIC_SOURCES);
    for (const { path } of sources) {
      const reached = pathsAt(BEING_CLASSES, path);
      expect(reached.length).toBeGreaterThan(0);
      expect(reached.map(([, node]) => node.class)).toEqual(reached.map(() => "C0"));
    }
    // Every C0 leaf of a being is a field read as it is; the direction derives from a C0 walk.
    const read = sources
      .filter(({ derived }) => derived === undefined)
      .flatMap(({ path }) => pathsAt(BEING_CLASSES, path).map(([at]) => at));
    expect(read.sort()).toEqual(publicLeaves(BEING_CLASSES).sort());
    expect(publicLeaves(BEING_CLASSES)).toContain("/activity/talk/to");
  });

  test("emits exactly the fields the map names, over every kind of activity", () => {
    const records = ACTIVITIES.map((activity, index) =>
      checkedRecord(index + 1, publicRecordOf(doing(index + 1, activity))),
    );
    const emitted = new Set(records.flatMap(fieldsOf));
    expect([...emitted].sort()).toEqual(Object.keys(BEING_PUBLIC_SOURCES).sort());
  });

  test("copies the C0 members of a being of beings@2 or beings@1, and derives a walk's step", () => {
    const record = (being: beings.Being) => checkedRecord(being.id, publicRecordOf(being));
    expect(record(doing(1, TALK))).toEqual(recordDoing(1, { kind: "talk", to: 4, act: "tell" }));
    expect(record(doing(2, WALK))).toEqual(recordDoing(2, { kind: "walk", dir: 2 }));
    // A being of beings@1 has no mind and three traits: its record is the same shape.
    const { mind: _mind, traits: _traits, ...rest } = doing(3, EAT);
    const old: beings.Being = { ...rest, traits: { appetite: 9, sleepiness: 9, curiosity: 9 } };
    expect(record(old)).toEqual(recordDoing(3, { kind: "eat" }));
    // The record encodes in the schema's order, so equal content gives equal bytes.
    expect(JSON.stringify(record(doing(2, WALK)))).toBe(
      JSON.stringify(publicRecordOf(doing(2, WALK))),
    );
  });

  test("refuses a record the schema rejects, naming the being and fields, never values", () => {
    const odd = { ...doing(7, { kind: "idle", start: 1, ms: 5 }), stage: "zqchild" };
    expect(() => checkedRecord(7, publicRecordOf(odd))).toThrow(
      "the being 7 has no valid public record: stage (invalid_value)",
    );
    try {
      checkedRecord(7, publicRecordOf(odd));
    } catch (error) {
      expect(String(error)).not.toContain("zqchild");
    }
  });
});

describe("the events of a tick", () => {
  test("decides every event type the registry classifies C0, and only those", () => {
    const c0 = beings.EVENT_CLASSES.filter(({ class: cls }) => cls === "C0").map(
      ({ type }) => type,
    );
    expect(Object.keys(C0_EVENT_DECISIONS).sort()).toEqual(c0.sort());
    const projectedTypes = Object.entries(C0_EVENT_DECISIONS)
      .filter(([, { decision }]) => decision === "projected")
      .map(([type]) => type);
    expect(projectedTypes).toEqual(["being.died", "being.spawned", "speech.uttered"]);
    for (const { reason } of Object.values(C0_EVENT_DECISIONS))
      expect(reason.length).toBeGreaterThan(9);
  });

  test("feeds an arrival and a death with their tick and chunk, and reads no other event", () => {
    const events = [
      event(5, 0, "being.spawned", { id: 9, species: "s1", cell: [40, -2], traits: 1187 }),
      event(5, 1, "being.ate", { id: 9, units: 25 }),
      event(5, 2, "mind.provenance", { id: 9, records: [], exposure: 6 }),
      event(5, 3, "being.died", { id: 4, cell: [-1, 64] }),
    ];
    const { speech, feed, omitted } = projectEvents(5, events, renderAct);
    expect(feed).toEqual([
      { kind: "arrival", tick: 5, being: 9, species: "s1", chunk: [1, -1] },
      { kind: "death", tick: 5, being: 4, chunk: [-1, 2] },
    ]);
    expect([speech, omitted]).toEqual([[], 0]);
  });
});

describe("the C0 projection of a world", () => {
  test("emits a record only when its C0 bytes change: a change of C1 alone emits nothing", () => {
    const { ticks } = projected(canaryWorld(), canaryScript(), 40);
    const at = (tick: number) => ticks[tick - 1] as (typeof ticks)[number];
    // The injection changes the sitter's mind, and its wake the next tick its activity's start.
    expect(at(INJECTION_TICK).result.changedChunks).toEqual(["2,-1"]);
    expect(at(INJECTION_TICK).result.events.map(({ type }) => type)).toContain("mind.injected");
    expect(at(INJECTION_TICK + 1).result.changedChunks).toEqual(["2,-1"]);
    expect([at(INJECTION_TICK).published.chunks, at(INJECTION_TICK + 1).published.chunks]).toEqual([
      [],
      [],
    ]);
    // Over the run the engine wrote chunks far more often than anything public changed.
    const written = ticks.filter(({ result }) => result.changedChunks.length > 0).map(tickOf);
    const emitted = ticks.filter(({ published }) => published.chunks.length > 0).map(tickOf);
    expect(emitted).toEqual([1, 6, 11, 16, 21, 26, 31, 36]);
    expect(written.length).toBeGreaterThan(2 * emitted.length);
    // The sitter's record never changes, so it never goes out; only the walker's does.
    const upserted = ticks.flatMap(({ published }) =>
      published.chunks.flatMap(({ upsert }) => upsert.map(({ id }) => id)),
    );
    expect(new Set(upserted)).toEqual(new Set([WALKER]));
    expect(upserted).not.toContain(SITTER);
  });

  test("lists a crossing being as gone from one chunk and upserted in the other, same tick", () => {
    const { ticks } = projected(canaryWorld(), canaryScript(), 11);
    const walker = (cell: readonly [number, number], dir: number): BeingPublic => ({
      id: WALKER,
      species: "s1",
      stage: "adult",
      born: 0,
      cell: [cell[0], cell[1]],
      activity: { kind: "walk", dir },
    });
    const chunks = (tick: number): readonly PublishedChunk[] =>
      ticks[tick - 1]?.published.chunks ?? [];
    expect(chunks(6)).toEqual([
      { at: [2, -1], v: 6, upsert: [], gone: [WALKER] },
      { at: [3, -1], v: 6, upsert: [walker(EAST, 4)], gone: [] },
    ]);
    expect(chunks(11)).toEqual([
      { at: [2, -1], v: 11, upsert: [walker(WEST, 0)], gone: [] },
      { at: [3, -1], v: 11, upsert: [], gone: [WALKER] },
    ]);
  });

  test("gives speech the plain text speech@1 renders, in the speaker's chunk, and a greeting per greet", () => {
    const { world, script } = subject();
    const { ticks, projection } = projected(world, script, SUBJECT_TICKS);
    const utterances = ticks.flatMap(({ result }) =>
      result.events.filter(({ type }) => type === "speech.uttered").map(withTick),
    );
    const speech = ticks.flatMap(({ published }) => published.speech);
    expect(speech.length).toBe(utterances.length);
    expect(speech.length).toBeGreaterThan(3);
    speech.forEach(({ at, speech: item }, index) => {
      const { tick, payload } = utterances[index] as { tick: number; payload: UtteredAct };
      const { text, ...rest } = item;
      expect(rest).toEqual({ tick, speaker: payload.id, to: payload.to, act: payload.act });
      expect(String(text)).toBe(renderAct(payload));
      expect(at).toEqual([
        worldgen.chunkOfCell(payload.cell[0]),
        worldgen.chunkOfCell(payload.cell[1]),
      ]);
      expect(PlainText.safeParse(text).success).toBe(true);
    });
    expect(speech.map(({ speech: item }) => item.act)).toContain("tell");
    const greetings = ticks.flatMap(({ published }) => published.feed);
    const greets = speech.filter(({ speech: item }) => item.act === "greet");
    expect(greetings).toEqual(
      greets.map(({ at, speech: item }) => ({
        kind: "greeting",
        tick: item.tick,
        from: item.speaker,
        to: item.to,
        chunk: at,
      })),
    );
    expect(projection.omittedSpeech).toBe(0);
  });

  test("leaves out and counts speech whose text is not plain, and still feeds its greeting", () => {
    const { world, script } = subject();
    const bidi = String.fromCodePoint(0x20_2e);
    const hostile = (uttered: UtteredAct) => `<b>${renderAct(uttered)}${bidi}</b>`;
    const { ticks, projection } = projected(world, script, SUBJECT_TICKS, { render: hostile });
    const utterances = ticks.flatMap(({ result }) =>
      result.events.filter(({ type }) => type === "speech.uttered"),
    );
    expect(utterances.length).toBeGreaterThan(3);
    expect(ticks.flatMap(({ published }) => published.speech)).toEqual([]);
    expect(projection.omittedSpeech).toBe(utterances.length);
    const feed = ticks.flatMap(({ published }) => published.feed);
    expect(feed.map(({ kind }) => kind)).toEqual(feed.map(() => "greeting"));
    expect(feed.length).toBe(utterances.filter(({ payload }) => isGreet(payload)).length);
    expect(JSON.stringify(ticks.map(({ published }) => published))).not.toContain(bidi);
  });

  test("carries the calendar's clock, and never the seconds of a tick or the day's length", () => {
    const clock = calendarClock(PREPARED, 12);
    // The test genesis has days of 1,200 simulated seconds: 100 ticks of 12 seconds.
    expect([0, 1, 50, 99, 100, 150, 1234].map(clock)).toEqual([
      { tick: 0, day: 0, dayPermille: 0 },
      { tick: 1, day: 0, dayPermille: 10 },
      { tick: 50, day: 0, dayPermille: 500 },
      { tick: 99, day: 0, dayPermille: 990 },
      { tick: 100, day: 1, dayPermille: 0 },
      { tick: 150, day: 1, dayPermille: 500 },
      { tick: 1234, day: 12, dayPermille: 340 },
    ]);
    const { ticks } = projected(canaryWorld(), canaryScript(), 3);
    expect(ticks.map(({ published }) => published.clock)).toEqual([1, 2, 3].map(clock));
    expect(Object.keys(ticks[0]?.published ?? {})).toEqual([
      "tick",
      "clock",
      "chunks",
      "speech",
      "feed",
    ]);
  });

  test("never changes the world: its state root, its chunks, and its trail stay the same", () => {
    const projectedWorld = canaryWorld();
    const plain = canaryWorld();
    const projection = new BeingsProjection(projectedWorld);
    const script = canaryScript();
    for (let tick = 1; tick <= 12; tick += 1) {
      const result = step(projectedWorld, stamped(script[tick - 1] ?? [], tick));
      const root = stateRoot(projectedWorld);
      projection.project(result);
      expect(stateRoot(projectedWorld)).toBe(root);
      expect(result.checksum).toBe(step(plain, stamped(script[tick - 1] ?? [], tick)).checksum);
    }
    expect(readView(projectedWorld).chunkKeys()).toEqual(readView(plain).chunkKeys());
  });

  test("freezes what it publishes, and refuses a tick out of order or a world without beings", () => {
    const world = canaryWorld();
    const projection = new BeingsProjection(world);
    const result = step(world, []);
    const published = projection.project(result);
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(published)).toBe(true);
    expect(published.chunks.length).toBeGreaterThan(0);
    expect(() => projection.project(result)).toThrow(
      "the projection is at tick 1 and cannot project tick 1",
    );
    expect(() => new BeingsProjection(countingWorld(9))).toThrow(EngineError);
  });
});

/** The tick of a projected tick. */
function tickOf({ result }: { result: StepResult }): number {
  return result.tick;
}

/**
 * A speech.uttered event, its tick and its payload, which is an act as renderAct reads it: the
 * engine builds it so (utteredPayload in packages/engine/src/beings/speech.ts).
 */
function withTick({ tick, payload }: EngineEvent): { tick: number; payload: UtteredAct } {
  return { tick, payload: payload as unknown as UtteredAct };
}

/** Whether the payload of a speech.uttered is a greet. */
function isGreet(payload: EngineEvent["payload"]): boolean {
  return typeof payload === "object" && "act" in payload && payload.act === "greet";
}
