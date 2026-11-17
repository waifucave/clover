// The hello's release check over the daemon's real endpoint (RL; spec §3.1 "One release for everything"): a client behind
// the engine is refused and told which release it needs; one ahead is served the release door only; the same release
// is served as today; an `app` that names no release counts as behind; other roles aren't judged.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_ERR, MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/moss-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { createMossServer, MossRpcError } from "../../src/ipc/moss";
import { MossTokens } from "../../src/auth/moss-tokens";
import { SessionProcesses } from "../../src/auth/moss-caller";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { resolveEndpoint } from "../../src/platform/transport";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { EngineReleaseHome } from "../../src/update/release-home";
import { ReleaseService, releaseHandlers } from "../../src/update/release-service";
import { UpdateGate } from "../../src/update/gate";
import { DaemonPair } from "../../src/platform/pair/policy";

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

async function boot(pair?: DaemonPair) {
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
    serverVersion: "test", deviceId: "d".repeat(32), appToken, appPeer: "none", probe: () => outside, release: releaseHome, ...(pair ? { pair } : {}),
    handlers: releaseHandlers(service, { error: (code, message) => new MossRpcError(code, message) }),
  });
  const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, mossConnections: moss });
  stop = () => { moss.dispose(); server.stop(); store.close(); };
  return { socketPath, appToken, legacy, moss, home, releaseHome };
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

test("an app ahead of the engine is kept out of the surface door: it holds no host slot, doesn't draw the island, doesn't make the working copy leave", async () => {
  const b = await boot();
  const live = await Client.connect(b.socketPath);
  expect((await live.hello("app", b.appToken, { release: "1.2.0", surface: "host" })).result.release.standing).toBe("same");
  expect(b.moss.surfaces.door.live().map((l) => l.surface)).toEqual(["host"]);
  const ahead = await Client.connect(b.socketPath);
  // An ahead host: served the door, though a live host holds the one slot.
  const r = await ahead.hello("app", b.appToken, { release: "1.3.0", surface: "host" });
  expect(r.error).toBeUndefined();
  expect(r.result.release).toEqual({ standing: "ahead", engine: "1.2.0" });
  expect(b.moss.surfaces.door.live().map((l) => l.connId).length).toBe(1);
  // The same-release copy was never told to quit for the newer one, and the inert one reports no presence.
  expect((await ahead.request("presence.report", {})).error?.code).toBe(MOSS_ERR.ROLE_REFUSED);
  // It doesn't hear the router's card events: only the `release` area is open to it.
  const sub = await ahead.request("events.subscribe", { areas: ["surfaces", "approvals", "release"] });
  expect(sub.error).toBeUndefined();
  live.close();
  ahead.close();
});

// MOSS (apps/moss, `surface: "moss"`) is judged by the same check as MOSS Code, and its record is the engine's for it.
test("MOSS's hello is judged like MOSS Code's: behind refused, none counts as behind, same served, ahead the release door only", async () => {
  const b = await boot();
  const behind = await Client.connect(b.socketPath);
  expect((await behind.hello("app", b.appToken, { surface: "moss", release: "1.1.9" })).error).toMatchObject({ code: MOSS_ERR.RELEASE_REFUSED, data: { standing: "behind", needs: "1.2.0" } });
  const none = await Client.connect(b.socketPath);
  expect((await none.hello("app", b.appToken, { surface: "moss" })).error).toMatchObject({ code: MOSS_ERR.RELEASE_REFUSED, data: { standing: "behind" } });
  expect(b.moss.connections()).toEqual([]);
  const same = await Client.connect(b.socketPath);
  expect((await same.hello("app", b.appToken, { surface: "moss", release: "1.2.0" })).result).toMatchObject({ surface: "moss", release: { standing: "same" } });
  same.close();
  const ahead = await Client.connect(b.socketPath);
  expect((await ahead.hello("app", b.appToken, { surface: "moss", release: "1.3.0" })).result).toMatchObject({ release: { standing: "ahead" } });
  expect((await ahead.request("pair.status", {})).error).toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
  behind.close(); none.close(); ahead.close();
});

test("MOSS's record: the engine keeps it for the connection's own program, under apps/moss.json, and an ahead MOSS can only bring from the one it wrote itself", async () => {
  const b = await boot();
  const bundle = join(b.home, "MOSS.app");
  mkdirSync(bundle, { recursive: true });
  const c = await Client.connect(b.socketPath);
  await c.hello("app", b.appToken, { surface: "moss", release: "1.2.0" });
  // Another program's record is refused: the program is the connection's, never the call's.
  expect((await c.request("release.record", { program: "code", bundlePath: bundle, release: "1.2.0", carries: { engine: true, host: false } })).error).toBeDefined();
  expect(existsSync(join(b.home, "apps", "code.json"))).toBe(false);
  expect((await c.request("release.record", { program: "moss", bundlePath: bundle, release: "1.2.0", carries: { engine: true, host: false } })).result).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(b.home, "apps", "moss.json"), "utf8"))).toMatchObject({ program: "moss", release: "1.2.0", bundlePath: bundle });
  c.close();
  // Ahead: release.record is not on the door, so a MOSS ahead of the engine must have written its record before it dialled.
  const ahead = await Client.connect(b.socketPath);
  await ahead.hello("app", b.appToken, { surface: "moss", release: "1.3.0" });
  expect((await ahead.request("release.record", { program: "moss", bundlePath: bundle, release: "1.3.0", carries: { engine: true, host: false } })).error).toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
  expect((await ahead.request("release.bring", { release: "1.3.0", bundlePath: bundle })).error).toBeDefined();
  ahead.close();
});

// S1 (the pair): an app ahead of the engine is open and waiting, so the pair's start-up start must not bring up another.
function fakePair() {
  const timers: Array<() => void> = [];
  const starts: string[] = [];
  const pair = new DaemonPair({
    now: () => 0, after: (_ms, fn) => { timers.push(fn); return () => {}; },
    async startApp(why) { starts.push(why); return "started"; }, tellAppQuit() {}, stopDaemon() {},
  }, { desktop: true });
  pair.start();
  return { pair, starts, fire: async () => { for (const f of timers.splice(0)) f(); await Promise.resolve(); await Promise.resolve(); } };
}

test("an app ahead of the engine is held by the pair: nothing is started through the OS while it waits, and its leaving starts nothing", async () => {
  const f = fakePair();
  const b = await boot(f.pair);
  const c = await Client.connect(b.socketPath);
  expect((await c.hello("app", b.appToken, { surface: "code", release: "1.3.0" })).result).toMatchObject({ release: { standing: "ahead" } });
  await f.fire(); // the start-up grace runs out with only the ahead app there
  expect(f.starts).toEqual([]);
  expect(f.pair.status().appConnected).toBe(false);
  c.close();
  await Bun.sleep(50);
  await f.fire();
  expect(f.starts).toEqual([]);
});

test("(the control) the same pair with no app at all starts one when the grace runs out", async () => {
  const f = fakePair();
  await boot(f.pair);
  await f.fire();
  expect(f.starts).toEqual(["boot"]);
});

test("a MOSS app ahead isn't MOSS Code's pair app: it doesn't hold the pair's start of MOSS Code", async () => {
  const f = fakePair();
  const b = await boot(f.pair);
  const c = await Client.connect(b.socketPath);
  await c.hello("app", b.appToken, { surface: "moss", release: "1.3.0" });
  await f.fire();
  expect(f.starts).toEqual(["boot"]);
  c.close();
});
