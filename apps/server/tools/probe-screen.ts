/**
 * What the terminal probe (probe.ts) prints: one screen per commit, built from the reference
 * reducer's state and what the last commits brought, every line of it passed through `sanitize`.
 *
 * Nothing the server sends reaches the terminal raw. The protocol already refuses text that is not
 * plain text (ADR 0026), so a correct server never sends a control character; the probe does not
 * rely on that: `sanitize` writes every code point a terminal would read as something other than
 * a visible character as its `\u{…}` notation, so no server can clear the screen, move the cursor,
 * set a title, or reorder a line with a bidirectional control. A backslash is doubled, so the
 * notation of an escaped code point never reads the same as text that spells it out.
 */
import {
  type BeingPublic,
  type ChunkCoord,
  type ClientState,
  type FeedItem,
  FORBIDDEN_CODE_POINTS,
} from "@open-origin/protocol/public";

/** Whether `point` is a lone surrogate, which a terminal's encoder would turn into U+FFFD. */
const isSurrogate = (point: number) => point >= 0xd800 && point <= 0xdfff;

/**
 * Whether a terminal could read `point` as something other than a visible character: a control
 * (C0, DEL, C1, which start every ANSI escape sequence), a line or paragraph separator, a
 * bidirectional control, an invisible character (FORBIDDEN_CODE_POINTS), or a lone surrogate.
 */
function isUnsafe(point: number): boolean {
  if (isSurrogate(point)) return true;
  return FORBIDDEN_CODE_POINTS.some(([first, last]) => point >= first && point <= last);
}

/**
 * `text` as the probe prints it: every unsafe code point (isUnsafe) written as `\u{XXXX}`, its
 * hexadecimal in capitals, and every backslash doubled. Visible characters, markup such as
 * `<script>` among them, are kept as they are: a terminal shows them as text.
 */
export function sanitize(text: string): string {
  let shown = "";
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (character === "\\") shown += "\\\\";
    else if (isUnsafe(point)) shown += `\\u{${point.toString(16).toUpperCase()}}`;
    else shown += character;
  }
  return shown;
}

/** An item of speech as the screen reads it: plain values, whatever their schema's brand. */
export type ShownSpeech = {
  readonly at: ChunkCoord;
  readonly speech: {
    readonly tick: number;
    readonly speaker: number;
    readonly to: number;
    readonly act: string;
    readonly text: string;
  };
};

/** The probe's link to the server. */
export type Link = "connecting" | "open" | "waiting";

/** What a screen shows. */
export type ScreenInput = {
  readonly url: string;
  readonly link: Link;
  readonly state: ClientState;
  /** The speech and the feed of the last commits, oldest first. */
  readonly speech: readonly ShownSpeech[];
  readonly feed: readonly FeedItem[];
  readonly counts: {
    readonly commits: number;
    readonly anomalies: number;
    readonly errors: number;
    readonly badFrames: number;
    readonly resyncs: number;
    readonly reconnects: number;
  };
  /** The code of the last `error` the server sent, if any. */
  readonly lastError: string | undefined;
};

/** The most rows each list of the screen shows; the rest are counted. */
export const ROWS = 16;

/** The compass name of each direction, by its index (protocol.md, "BeingPublic"). */
const COMPASS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"] as const;

const at = ([x, y]: readonly [number, number]) => `${x},${y}`;

/** A being's activity, in words. */
function activityOf(activity: BeingPublic["activity"]): string {
  if (activity.kind === "walk") return `walk ${COMPASS[activity.dir] ?? activity.dir}`;
  if (activity.kind === "talk") return `talk to #${activity.to} (${activity.act})`;
  return activity.kind;
}

const beingLine = (being: BeingPublic) =>
  `  #${being.id}  ${being.species}  ${being.stage}  born ${being.born}  cell ${at(being.cell)}  ${activityOf(being.activity)}`;

/** A feed item, in words. */
function feedLine(item: FeedItem): string {
  if (item.kind === "arrival")
    return `  t${item.tick}  arrival  #${item.being} ${item.species} in ${at(item.chunk)}`;
  if (item.kind === "death") return `  t${item.tick}  death  #${item.being} in ${at(item.chunk)}`;
  return `  t${item.tick}  greeting  #${item.from} to #${item.to} in ${at(item.chunk)}`;
}

const speechLine = ({ at: chunk, speech }: ShownSpeech) =>
  `  t${speech.tick}  #${speech.speaker} to #${speech.to}  ${speech.act}  in ${at(chunk)}  "${speech.text}"`;

/** The last ROWS of `lines`, after a count of those left out. */
function capped(title: string, lines: readonly string[], fromEnd = false): string[] {
  if (lines.length <= ROWS) return [`${title} (${lines.length}):`, ...lines];
  const kept = fromEnd ? lines.slice(-ROWS) : lines.slice(0, ROWS);
  return [`${title} (${lines.length}, ${lines.length - ROWS} not shown):`, ...kept];
}

/** The header: the link, the world, and the clock of the last commit. */
function header({ url, link, state }: ScreenInput): string[] {
  const { connection, view, world, stale } = state;
  const lines = [`open-origin probe  ${url}  ${link}${stale ? "  (view stale)" : ""}`];
  if (connection !== undefined) {
    const reason = world.reason === undefined ? "" : `: ${world.reason}`;
    lines.push(`world ${connection.worldId}  ${connection.durability}  ${world.state}${reason}`);
  }
  if (view !== undefined) {
    const { tick, day, dayPermille } = view.clock;
    lines.push(`tick ${tick}  day ${day}  ${dayPermille}/1000 of the day`);
  }
  return lines;
}

/** The visible chunks and their beings, and the followed being. */
function viewLines({ state }: ScreenInput): string[] {
  const { view } = state;
  if (view === undefined) return ["no view yet"];
  const chunks = [...view.chunks.values()];
  const beings = chunks
    .flatMap((chunk) => [...chunk.beings.values()])
    .toSorted((a, b) => a.id - b.id);
  const followed = view.followed === null ? "nothing" : beingLine(view.followed).trim();
  return [
    `following: ${followed}`,
    ...capped(
      "chunks",
      chunks.map((chunk) => `  ${at(chunk.at)}  v${chunk.v}  ${chunk.beings.size} beings`),
    ),
    ...capped("beings", beings.map(beingLine)),
  ];
}

/** The lines of a screen, before they are sanitized. */
function screenLines(input: ScreenInput): string[] {
  const { counts, state } = input;
  const trimmed = state.trimmed.length === 0 ? "none" : state.trimmed.map(at).join(" ");
  return [
    ...header(input),
    ...viewLines(input),
    ...capped("speech", input.speech.map(speechLine), true),
    ...capped("feed", input.feed.map(feedLine), true),
    `left out by the view's limit: ${trimmed}`,
    `errors from the server: ${counts.errors}${input.lastError === undefined ? "" : `, the last ${input.lastError}`}`,
    `commits ${counts.commits}  anomalies ${counts.anomalies}  bad frames ${counts.badFrames}  resyncs ${counts.resyncs}  reconnects ${counts.reconnects}`,
  ];
}

/** The screen of `input`: each line sanitized, so nothing the server sent can act on the terminal. */
export function renderScreen(input: ScreenInput): string {
  return screenLines(input).map(sanitize).join("\n");
}
