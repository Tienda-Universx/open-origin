import { readView } from "@open-origin/engine";
import { type Projector, WorldHost } from "../../src/world/host.ts";
import type { TickRecord } from "../../src/world/journal.ts";
import { PublicationGate } from "../../src/world/publication.ts";
import type { PublishedTick } from "../../src/world/published.ts";
import type { WorldSource } from "../../src/world/source.ts";
import { RecordingJournal } from "./journals.ts";

/** What a run published, and what its journal recorded (C3: checksums, commands, events). */
export type PublishedRun = {
  readonly published: readonly PublishedTick[];
  readonly records: readonly TickRecord[];
};

/**
 * Runs `ticks` ticks of `source` as the world plane does: a host steps it and hands each tick and
 * its projection by `projector` to a gate over a journal that acknowledges at once; the run ends
 * once the gate published every tick.
 */
export async function publishedRun(
  source: WorldSource,
  projector: Projector,
  ticks: number,
): Promise<PublishedRun> {
  const journal = new RecordingJournal();
  const gate = new PublicationGate({ journal, batchTicks: 5, boot: readView(source.world).tick });
  const host = new WorldHost({ source, projector, gate });
  const published: PublishedTick[] = [];
  gate.subscribe((tick) => {
    published.push(tick);
  });
  for (let tick = 0; tick < ticks; tick += 1) host.stepOnce();
  await gate.flush();
  if (host.halted !== undefined) throw new Error(`the run halted with ${host.halted.code}`);
  return { published, records: journal.batches.flatMap(({ records }) => records) };
}
