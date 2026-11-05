// A-M1 review S3: what the Worker soaks share (`worker-churn-soak.ts`, `worker-midturn-soak.ts`): a daemon on a
// temp home with a fake model (no model calls), an NDJSON client on its socket, and RSS readings.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@waifucave/clover-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";

export class SoakClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  static async connect(socketPath: string): Promise<SoakClient> {
    const c = new SoakClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) c.events.push(msg.params as SessionEvent);
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    const r = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => this.pending.set(id, resolve));
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result as T;
  }
  /** Resolves when an event matching `match` arrives for `sessionId` after index `after`. */
  async until(sessionId: string, after: number, match: (e: SessionEvent) => boolean, what: string, ms = 60_000): Promise<void> {
    const t0 = Date.now();
    while (!this.events.slice(after).some((e) => e.sessionId === sessionId && match(e))) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${sessionId}'s ${what}`);
      await Bun.sleep(10);
    }
  }
  async turnCompleted(sessionId: string, after: number, ms = 60_000): Promise<void> {
    await this.until(sessionId, after, (e) => e.type === "turn_completed", "turn", ms);
  }
  /** Drops the events read so far (a long soak would otherwise hold every one). */
  clearEvents(): void { this.events.length = 0; }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

export const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * One reading of the daemon process's memory after a full GC, three ways, because they are not the same number:
 *   psRss      `ps -o rss=`: the resident set, what the soaks' budgets are written against.
 *   footprint  macOS's `footprint` tool: phys_footprint, what Activity Monitor calls Memory (null off macOS).
 *   bunRss     Bun's `process.memoryUsage().rss`: the resident set up to Bun 1.4.2, but phys_footprint on macOS
 *              from Bun 1.4.3, so comparing it across a Bun upgrade compares two different measures.
 */
export interface MemoryReading {
  psRss: number;
  footprint: number | null;
  bunRss: number;
}

/** What each `MemoryReading` field measures, printed beside the readings so a report never mixes them up. */
export const MEMORY_LABELS = {
  psRss: "ps -o rss= (resident set)",
  footprint: "footprint -f bytes (macOS phys_footprint)",
  bunRss: "process.memoryUsage().rss (phys_footprint on macOS from Bun 1.4.3, resident set before)",
} as const;

function psRss(pid: number): number {
  const out = Bun.spawnSync(["/bin/ps", "-o", "rss=", "-p", String(pid)]).stdout.toString().trim();
  const kb = Number(out);
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`ps -o rss= gave ${JSON.stringify(out)} for pid ${pid}`);
  return kb * 1024;
}

function footprint(pid: number): number | null {
  if (process.platform !== "darwin") return null;
  const r = Bun.spawnSync(["/usr/bin/footprint", "-f", "bytes", "-p", String(pid)]);
  const m = /Footprint:\s*([\d,]+)\s*B\b/.exec(r.stdout.toString());
  return m === null ? null : Number(m[1]!.replace(/,/g, ""));
}

/** The daemon process's memory after a full GC (see `MemoryReading`). */
export function memory(): MemoryReading {
  Bun.gc(true);
  return { psRss: psRss(process.pid), footprint: footprint(process.pid), bunRss: process.memoryUsage().rss };
}

/** One field of several readings, in MB, keyed as the caller names them (`{ start: …, end: … }`). */
export function inMb(readings: Record<string, MemoryReading>, field: keyof MemoryReading): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, r] of Object.entries(readings)) out[k] = r[field] === null ? null : mb(r[field] as number);
  return out;
}

/** Every reading, side by side and labelled: `{ labels, bunVersion, psRss: {…}, footprint: {…}, bunRss: {…} }`. */
export function memoryReport(readings: Record<string, MemoryReading>): Record<string, unknown> {
  return { labels: MEMORY_LABELS, bunVersion: Bun.version, psRssMb: inMb(readings, "psRss"), footprintMb: inMb(readings, "footprint"), bunRssMb: inMb(readings, "bunRss") };
}

export interface SoakDaemon {
  daemon: RunningDaemon;
  client: SoakClient;
  home: string;
  cwd: string;
  stop(): Promise<void>;
}

/** A real daemon on a temp home whose default model is `model` (a `winter-test/…` double), with a harness client. */
export async function startSoakDaemon(name: string, model: string): Promise<SoakDaemon> {
  const home = mkdtempSync(join(tmpdir(), `clover-${name}-`));
  const cwd = mkdtempSync(join(tmpdir(), `clover-${name}-cwd-`));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model }, runtimes: { winterIdleTimeoutSec: 600 } }));
  const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
  const client = await SoakClient.connect(daemon.socketPath);
  await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: name });
  return {
    daemon,
    client,
    home,
    cwd,
    async stop() {
      client.close();
      await daemon.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
