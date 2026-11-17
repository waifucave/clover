// The hello's release check over the daemon's real endpoint (RL; spec §3.1 "One release for everything"): a client behind
// the engine is refused and told which release it needs; one ahead is served the release door only; the same release
// is served as today; an `app` that names no release counts as behind; other roles aren't judged.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_ERR, MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/moss-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { createMossServer } from "../../src/ipc/moss";
import { MossTokens } from "../../src/auth/moss-tokens";
import { SessionProcesses } from "../../src/auth/moss-caller";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { resolveEndpoint } from "../../src/platform/transport";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { EngineReleaseHome } from "../../src/update/release-home";
import { ReleaseService } from "../../src/update/release-service";
import { UpdateGate } from "../../src/update/gate";

class Client {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  static async connect(path: string): Promise<Client> {
    const c = new Client();
    c.socket = await Bun.connect({ unix: path, socket: {
      data(_s, chunk) {
        for (const line of c.decoder.push(chunk)) {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
          else if (msg.method === "app.ping") c.writer.enqueue(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
        }
      },
      drain() { c.writer.onDrain(); },
    } });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  hello(role: string, token: string, extra: Record<string, unknown> = {}): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role, token, clientName: `test-${role}`, ...extra });
  }
  close(): void { this.socket.end(); }
}

const outside: PeerFacts = { pid: 4242, ancestors: [1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "moss-rl-hello-"));
  const store = new SessionStore(home);
  const socketPath = resolveEndpoint(join(home, "run")).path;
  mkdirSync(join(home, "run"), { recursive: true });
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  const legacy = await authority.ensureTokens();
  const appToken = "a".repeat(43);
  const releaseHome = new EngineReleaseHome({ home, engine: "1.2.0", clock: new FakeClock(), place: () => {} });
  const events: unknown[] = [];
  const service = new ReleaseService({ home: releaseHome, engine: { release: "1.2.0", path: "/engine" }, gate: new UpdateGate(), host: { stop() {} }, policy: { platform: "linux", profile: "dist", developerId: true, records: () => releaseHome.apps() }, homeDir: home, emit: (e) => events.push(e), restart() {} });
  const moss = createMossServer({
    tokens: new MossTokens({ appToken, verifyCli: (t) => authority.verify("harness", t) }), processes: new SessionProcesses(),
    serverVersion: "test", deviceId: "d".repeat(32), appToken, appPeer: "none", probe: () => outside, release: releaseHome,
    handlers: { "release.status": () => service.status() },
  });
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, mossConnections: moss });
  stop = () => { moss.dispose(); server.stop(); store.close(); };
  return { socketPath, appToken, legacy, moss };
}

test("the same release is served, and the hello says so", async () => {
  const b = await boot();
  const c = await Client.connect(b.socketPath);
  const r = await c.hello("app", b.appToken, { release: "1.2.0" });
  expect(r.result).toMatchObject({ release: { standing: "same", engine: "1.2.0" } });
  expect((await c.request("pair.status", {})).error).toBeUndefined();
  c.close();
});

test("a client behind is refused and told which release it needs; nothing of it is registered", async () => {
  const b = await boot();
  const c = await Client.connect(b.socketPath);
  const r = await c.hello("app", b.appToken, { release: "1.1.9" });
  expect(r.error).toMatchObject({ code: MOSS_ERR.RELEASE_REFUSED, data: { standing: "behind", engine: "1.2.0", client: "1.1.9", needs: "1.2.0" } });
  expect(b.moss.connections()).toEqual([]);
  c.close();
});

test("an app that names no release counts as behind; the CLI isn't judged", async () => {
  const b = await boot();
  const app = await Client.connect(b.socketPath);
  expect((await app.hello("app", b.appToken)).error).toMatchObject({ code: MOSS_ERR.RELEASE_REFUSED, data: { standing: "behind", needs: "1.2.0" } });
  const cli = await Client.connect(b.socketPath);
  const r = await cli.hello("cli", b.legacy.harness);
  expect(r.error).toBeUndefined();
  expect(r.result.release).toBeUndefined();
  app.close(); cli.close();
});

test("a client ahead reaches the release door only: its status, its bring and the release events", async () => {
  const b = await boot();
  const c = await Client.connect(b.socketPath);
  const r = await c.hello("app", b.appToken, { release: "1.3.0", surface: "code" });
  expect(r.result).toMatchObject({ release: { standing: "ahead", engine: "1.2.0" } });
  expect((await c.request("release.status", {})).result).toMatchObject({ engine: { release: "1.2.0" }, state: "current" });
  for (const method of ["pair.status", "session.list", "plugin.list", "card.list", "presence.report"]) {
    expect((await c.request(method, {})).error, method).toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
  }
  // It may subscribe to the release events and to nothing else.
  expect((await c.request("events.subscribe", { areas: ["release", "sessions", "approvals"] })).result).toEqual({ ok: true });
  const conn = b.moss.connections().find((x) => x.releaseDoor !== undefined)!;
  expect([...conn.areas]).toEqual(["release"]);
  c.close();
});
