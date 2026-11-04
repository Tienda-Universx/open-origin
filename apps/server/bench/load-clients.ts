/**
 * The clients process of the load benchmark (load.ts): WebSocket clients of the public listener, in
 * a process of their own, as plan §11 asks. Its one argument is a JSON object, `LoadPlan`.
 *
 * - **Load** (`clients` > 0): it opens the clients `ramp` a second; each subscribes to `chunks` once
 *   open. A client reads only the head of each frame: its UTF-8 bytes are counted, and a commit's
 *   tick is read with the wall-clock time it arrived, so the clients cost this process as little as
 *   possible. It prints `clients_open` once every client opened or failed, and `clients_synced`
 *   once every open client committed.
 * - **Sync** (`sync`): one client applies every message with the reference reducer; once its first
 *   commit arrived it subscribes to `chunks`, and it prints `sync_done` with the milliseconds and
 *   the bytes from that `subscribe` to the commit that shows every chunk.
 *
 * Commands, one per stdin line: `measure` forgets every receipt and byte counted so far; `report`
 * prints, per client, the bytes and the commits `[tick, ms]` since `measure`, and its close code;
 * `exit` closes every socket and exits with 0. Every line it prints is JSON.
 */
import {
  applyMessage,
  type ChunkCoord,
  type ClientState,
  initialClientState,
  PROTOCOL_ID,
  parseServerMessage,
} from "@open-origin/protocol/public";
import { wallMs } from "./report.ts";

/** What the driver asks of this process. */
export type LoadPlan = {
  readonly port: number;
  /** How many load clients to open, and how many a second; none in a sync run. */
  readonly clients: number;
  readonly ramp: number;
  readonly chunks: readonly ChunkCoord[];
  /** Whether this is a sync run: one client of the reducer subscribes to `chunks` once it committed. */
  readonly sync: boolean;
};

/** Writes one JSON line to stdout. */
const print = (entry: object) => process.stdout.write(`${JSON.stringify(entry)}\n`);

/** The head of every commit frame: its type comes first, then `seq`, then the tick. */
const COMMIT = /^\{"type":"commit","seq":\d+,"tick":(\d+),/;

/** A load client: the bytes it received, its commits as [tick, ms], and its close code. */
class LoadClient {
  bytes = 0;
  receipts: [number, number][] = [];
  committed = false;
  open = false;
  code: number | undefined;
  readonly socket: WebSocket;

  constructor(url: string, subscribe: string) {
    this.socket = new WebSocket(url, PROTOCOL_ID);
    this.socket.addEventListener("open", () => {
      this.open = true;
      this.socket.send(subscribe);
    });
    this.socket.addEventListener("message", (event) => this.#receive(event.data));
    this.socket.addEventListener("close", (event) => {
      this.code = event.code;
    });
  }

  #receive(data: unknown): void {
    const text = typeof data === "string" ? data : "";
    this.bytes += Buffer.byteLength(text, "utf8");
    const tick = COMMIT.exec(text)?.[1];
    if (tick === undefined) return;
    this.committed = true;
    this.receipts.push([Number(tick), wallMs()]);
  }

  /** Forgets what was counted so far. */
  reset(): void {
    this.bytes = 0;
    this.receipts = [];
  }
}

/** Opens `plan.clients` clients, `plan.ramp` a second, and reports when all opened and synced. */
function openLoad(plan: LoadPlan, url: string): LoadClient[] {
  const subscribe = JSON.stringify({ type: "subscribe", chunks: plan.chunks });
  const clients: LoadClient[] = [];
  const opener = setInterval(() => {
    clients.push(new LoadClient(url, subscribe));
    if (clients.length === plan.clients) clearInterval(opener);
  }, 1000 / plan.ramp);
  let opened = false;
  const watch = setInterval(() => {
    if (clients.length < plan.clients) return;
    const settled = clients.every((client) => client.open || client.code !== undefined);
    if (settled && !opened) {
      opened = true;
      print({ event: "clients_open", failed: clients.filter((client) => !client.open).length });
    }
    if (opened && clients.every((client) => client.committed || client.code !== undefined)) {
      clearInterval(watch);
      print({ event: "clients_synced" });
    }
  }, 50);
  return clients;
}

/**
 * The sync run: one client of the reducer, which subscribes to `chunks` once its first commit
 * arrived and reports the time and bytes until a commit shows all of them.
 */
function openSync(plan: LoadPlan, url: string): WebSocket {
  const socket = new WebSocket(url, PROTOCOL_ID);
  let state: ClientState = initialClientState();
  let asked: { readonly at: number; bytes: number; commits: number } | undefined;
  socket.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    const parsed = parseServerMessage(text);
    if (!parsed.ok) {
      print({ event: "sync_failed", code: parsed.code });
      return;
    }
    const applied = applyMessage(state, parsed.message);
    state = applied.state;
    if (asked !== undefined) asked.bytes += Buffer.byteLength(text, "utf8");
    if (applied.committed === undefined) return;
    if (asked === undefined) {
      asked = { at: wallMs(), bytes: 0, commits: 0 };
      socket.send(JSON.stringify({ type: "subscribe", chunks: plan.chunks }));
      return;
    }
    asked.commits += 1;
    if ((state.view?.chunks.size ?? 0) < plan.chunks.length) return;
    const { at, bytes, commits } = asked;
    print({ event: "sync_done", ms: wallMs() - at, bytes, commits, chunks: plan.chunks.length });
  });
  return socket;
}

/** Answers the driver's commands until stdin ends or `exit`; then `close` closes every socket. */
async function serve(clients: readonly LoadClient[], close: () => void): Promise<void> {
  for await (const line of console) {
    const command = line.trim();
    if (command === "measure") for (const client of clients) client.reset();
    if (command === "report") {
      const report = clients.map(({ bytes, receipts, code }) => ({ bytes, receipts, code }));
      print({ event: "clients_report", clients: report });
    }
    if (command === "exit") break;
  }
  close();
  process.stdout.write("", () => process.exit(0));
}

/** Runs the plan of this process's argument. */
async function main(): Promise<void> {
  const plan: LoadPlan = JSON.parse(process.argv[2] ?? "{}");
  const url = `ws://127.0.0.1:${plan.port}/ws`;
  const clients = plan.sync ? [] : openLoad(plan, url);
  const sync = plan.sync ? openSync(plan, url) : undefined;
  print({ event: "clients_started", pid: process.pid });
  await serve(clients, () => {
    sync?.close(1000);
    for (const client of clients) client.socket.close(1000);
  });
}

if (import.meta.main) await main();
