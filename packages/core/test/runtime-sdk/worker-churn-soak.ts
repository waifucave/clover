// A-M1 review S3: THE WORKER-CHURN SOAK, inside a real daemon process. Run by `worker-churn-soak.test.ts` in a
// child process (a Bun crash must show up as that child's exit status, never take the test runner down).
//
// Boots a daemon on a temp home with a fake model (no model calls), then:
//   1. CHURN: `rounds` code sessions one after another, each created, given one turn, and ended, so every
//      round spawns one Worker and terminates it, the pattern Bun 1.3.14's Worker use-after-free needs;
//   2. CONCURRENCY: `concurrent` code sessions live at once, each through one turn, to measure what one live
//      code session's Worker costs the daemon in resident memory.
// Prints one JSON line: the rounds completed, the RSS readings, and the per-session estimate.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@waifucave/clover-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon } from "../../src/daemon";

const rounds = Number(process.env["SOAK_ROUNDS"] ?? "80");
const concurrent = Number(process.env["SOAK_CONCURRENT"] ?? "8");

class Client {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  static async connect(socketPath: string): Promise<Client> {
    const c = new Client();
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
  async turnCompleted(sessionId: string, after: number, ms = 60_000): Promise<void> {
    const t0 = Date.now();
    while (!this.events.slice(after).some((e) => e.type === "turn_completed" && e.sessionId === sessionId)) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${sessionId}'s turn`);
      await Bun.sleep(10);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
const rss = (): number => { Bun.gc(true); return process.memoryUsage().rss; };

const home = mkdtempSync(join(tmpdir(), "clover-worker-soak-"));
const cwd = mkdtempSync(join(tmpdir(), "clover-worker-soak-cwd-"));
writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 3, provider: { model: "winter-test/echo" }, runtimes: { winterIdleTimeoutSec: 600 } }));
const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
const client = await Client.connect(daemon.socketPath);
await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "soak" });

async function oneTurn(): Promise<string> {
  const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "soak", mode: "code", model: "winter-test/echo", cwd, approvalPolicy: "auto" });
  await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
  const before = client.events.length;
  await client.call(METHODS.sessionSend, { sessionId, text: "hello" });
  await client.turnCompleted(sessionId, before);
  return sessionId;
}

const out: Record<string, unknown> = { rounds, concurrent };
try {
  const start = rss();
  // 1. churn: one Worker spawned and terminated per round.
  let completed = 0;
  for (let i = 0; i < rounds; i++) {
    const sid = await oneTurn();
    await daemon.clover.get(sid)?.end();
    completed++;
  }
  out["churnRounds"] = completed;
  out["liveAfterChurn"] = daemon.embedded.live().length;
  const afterChurn = rss();
  // 2. concurrency: `concurrent` live code sessions at once.
  const ids: string[] = [];
  for (let i = 0; i < concurrent; i++) ids.push(await oneTurn());
  const withLive = rss();
  out["liveDuring"] = daemon.embedded.live().length;
  for (const sid of ids) await daemon.clover.get(sid)?.end();
  await Bun.sleep(500);
  const afterEnd = rss();
  out["rssMb"] = { start: mb(start), afterChurn: mb(afterChurn), withLive: mb(withLive), afterEnd: mb(afterEnd) };
  out["perLiveCodeSessionMb"] = mb((withLive - afterChurn) / concurrent);
  out["retainedPerChurnRoundMb"] = mb((afterChurn - start) / Math.max(1, completed));
} finally {
  client.close();
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
process.exit(0);
