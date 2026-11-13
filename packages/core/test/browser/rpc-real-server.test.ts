import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_ERR, CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type PluginState, type WritableSocket } from "@waifucave/clover-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { createCloverServer } from "../../src/ipc/clover";
import { CloverTokens } from "../../src/auth/clover-tokens";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { DaemonPair } from "../../src/platform/pair/policy";
import { resolveEndpoint } from "../../src/platform/transport";
import { grantsInForce } from "../../src/contracts/plugin-registry";
import type { PeerFacts } from "../../src/platform/caller-probe";
import { BrowserService } from "../../src/browser";
import { browserRpcHandlers, hearsTabs } from "../../src/browser/rpc-handlers";
import { FakeApp } from "./fakes";
import { onDarwin } from "../helpers/darwin-only";

// The panel's `browser.*` calls over the daemon's real socket, the way its component's plugin layer makes them (role
// `layer`, `caller: { kind: "plugin", pluginId }`): through the role gate, the capability gate and the server's own
// dispatch, not a hand-built caller.

class Client {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly fromDaemon: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  static async connect(path: string): Promise<Client> {
    const c = new Client();
    c.socket = await Bun.connect({ unix: path, socket: {
      data(_s, chunk) {
        for (const line of c.decoder.push(chunk)) {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
          else if (msg.method) {
            c.fromDaemon.push(msg);
            if (msg.method === "app.ping") c.writer.enqueue(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
          }
        }
      },
      drain() { c.writer.onDrain(); },
      close() {},
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
    return this.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role, token, clientName: `test-${role}`, ...extra });
  }
  close(): void { this.socket.end(); }
}

const outside: PeerFacts = { pid: 4242, ancestors: [1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!onDarwin)("the Clover Browser panel's calls over the real socket", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const rec = (source: string, granted: string[]) => ({ enabled: true, state: "running" as PluginState, granted, source });
    const records: Record<string, any> = {
      "clover/browser-view": rec("bundled", ["browser"]),
      "clover/other": rec("bundled", ["browser"]),
      "acme/panel": rec("user", ["browser"]),
      "bare": rec("user", []),
    };
    const home = mkdtempSync(join(tmpdir(), "clover-browser-rpc-"));
    const store = new SessionStore(home);
    mkdirSync(join(home, "run"), { recursive: true });
    const socketPath = resolveEndpoint(join(home, "run")).path;
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    await authority.ensureTokens();
    const appToken = "a".repeat(43);
    const tokens = new CloverTokens({ appToken, verifyCli: (t) => authority.verify("harness", t) });
    const pair = new DaemonPair({
      now: () => Date.now(), after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
      startApp: async () => "started", stopDaemon: () => {}, tellAppQuit: () => {},
    }, { desktop: true, graceMs: 60_000 });
    const app = new FakeApp();
    const service = new BrowserService({ computer: "Studio", app: () => app });
    const clover = createCloverServer({
      tokens, processes: new (await import("../../src/auth/clover-caller")).SessionProcesses(), serverVersion: "test", deviceId: "d".repeat(32), pair, appToken, appPeer: "none",
      pluginCapabilities: (id: string) => grantsInForce(records[id]),
      hostPidOf: () => undefined, linkPid: () => 4242, probe: () => outside,
      handlers: browserRpcHandlers(() => service, (id) => records[id]?.source === "bundled"),
    });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, cloverConnections: clover });
    stop = () => { clover.dispose(); pair.dispose(); server.stop(); store.close(); };
    const appClient = await Client.connect(socketPath);
    await appClient.hello("app", appToken);
    const layerOf = async (pluginId: string) => {
      const { token } = (await appClient.request("layer.token", { pluginId })).result;
      const c = await Client.connect(socketPath);
      await c.hello("layer", token, { pluginId });
      return c;
    };
    return { app, service, clover, appClient, layerOf };
  }

  test("the bundled panel's layer lists and shows a bot's tab and takes it back; the app does too", async () => {
    const b = await boot();
    const botTab = await b.service.open({ kind: "user" }, { owner: { kind: "bot", bot: "alpha" }, url: "https://example.com/" });
    const panel = await b.layerOf("clover/browser-view");
    const listed = await panel.request("browser.tabs", { owner: { kind: "bot", bot: "alpha" } });
    expect(listed.result.tabs.map((t: { id: string }) => t.id)).toEqual([botTab.id]);
    const shown = await panel.request("browser.show", { id: botTab.id, view: "browser", viewport: { width: 800, height: 600 } });
    expect(shown.result.tab).toMatchObject({ place: "shown", view: "browser" });
    expect((await panel.request("browser.hide", { id: botTab.id })).result.tab).toMatchObject({ place: "headless" });
    // DevTools from the panel passes only the Browser's nine methods.
    const cdp = await panel.request("browser.cdp", { id: botTab.id, method: "Network.getAllCookies" });
    expect(cdp.error?.data).toMatchObject({ code: "method_refused" });
    expect((await b.appClient.request("browser.tabs", {})).result.tabs.length).toBe(1);
    panel.close();
  });

  test("another bundled component, a third-party one holding browser, and one without the capability are refused", async () => {
    const b = await boot();
    for (const id of ["clover/other", "acme/panel"]) {
      const c = await b.layerOf(id);
      for (const [m, p] of [["browser.tabs", {}], ["browser.open", { owner: { kind: "bot", bot: "alpha" } }]] as const) {
        const r = await c.request(m, p);
        expect(r.error?.code).toBe(CLOVER_ERR.ROLE_REFUSED);
      }
      c.close();
    }
    const bare = await b.layerOf("bare");
    expect((await bare.request("browser.tabs", {})).error?.code).toBe(CLOVER_ERR.CAPABILITY_REFUSED);
    bare.close();
  });

  test("tab_changed reaches the app and the panel's layer once each subscribed, and no other plugin's layer", async () => {
    const b = await boot();
    const panel = await b.layerOf("clover/browser-view");
    const other = await b.layerOf("clover/other");
    for (const c of [panel, other, b.appClient]) await c.request("events.subscribe", { areas: ["browser"] });
    const tab = { id: "tab_1", computer: "Studio", owner: { kind: "bot", bot: "alpha" }, partition: "persist:bot-alpha", url: "https://example.com/", title: "", place: "headless", viewport: { width: 1280, height: 800 }, loading: false, heldByUser: false };
    const sent = b.clover.coreEvent({ type: "tab_changed", tab } as never, { to: hearsTabs });
    await wait(100);
    const heard = (c: Client) => c.fromDaemon.filter((m) => m.method === "core.event" && m.params?.type === "tab_changed").length;
    expect([heard(panel), heard(other), heard(b.appClient)]).toEqual([1, 0, 1]);
    expect(sent).toBe(2);
    panel.close(); other.close();
  });
});
