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
/** The daemon process's resident memory after a full GC. */
export const rss = (): number => { Bun.gc(true); return process.memoryUsage().rss; };

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
