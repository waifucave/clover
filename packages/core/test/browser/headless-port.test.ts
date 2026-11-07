// The headless browser's port semantics over a fake DevTools connection (no browser): what it sends, what it refuses,
// what it reports, and how it streams, with the flags, the profile names and the pipe's framing and timeouts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService } from "../../src/browser/service";
import { BrowserError, partitionFor } from "../../src/browser/policy";
import type { AddressPolicy, NetworkFilter } from "../../src/browser/network";
import type { AppTabEvent, StreamChunk, TabOwner } from "../../src/browser/contract";
import {
  CdpError, DISABLED_FEATURES, HeadlessBrowser, browserEnv, PipeConnection, headlessArgs, imageSize, profileDir, profileName,
  quoteWindowsArg, screencastSettings, splitFrames, type BrowserProcess, type CdpConnection, type CdpEvent, type LaunchSpec,
  type PipeTransport,
} from "../../src/browser/headless";

// -------------------------------------------------------------------------------------------------
// A fake browser: answers what the port asks, attaches each new page paused, and lets a test raise events.
// -------------------------------------------------------------------------------------------------

function png(width: number, height: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString("base64");
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

interface Call { method: string; params: Record<string, unknown>; sessionId?: string }

class FakeBrowser implements CdpConnection {
  readonly calls: Call[] = [];
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners: Array<(why: string) => void> = [];
  private n = 0;
  closed = false;
  closedByUs = false;
  shot = png(1280, 800);
  hang = new Set<string>();
  readonly targets = new Map<string, { url: string; title: string; sessionId: string }>();

  constructor(readonly spec: LaunchSpec, readonly id: number) {}

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) throw new CdpError("closed", `${method}: gone`);
    this.calls.push({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) });
    if (this.hang.has(method)) throw new CdpError("timeout", `${method} got no answer from the browser in 1 s`);
    switch (method) {
      case "Target.createTarget": {
        const targetId = `T${this.id}.${++this.n}`;
        const sessionId = `S${this.id}.${this.n}`;
        this.targets.set(targetId, { url: "about:blank", title: "about:blank", sessionId });
        // The browser attaches it (paused) around when it answers.
        queueMicrotask(() => this.emit("Target.attachedToTarget", { sessionId, waitingForDebugger: true, targetInfo: { targetId, type: "page", url: "about:blank", title: "" } }));
        return { targetId } as T;
      }
      case "Target.closeTarget": {
        const t = String(params.targetId);
        if (this.targets.delete(t)) queueMicrotask(() => this.emit("Target.targetDestroyed", { targetId: t }));
        return { success: true } as T;
      }
      case "Target.getTargetInfo": {
        const t = this.targets.get(String(params.targetId));
        return { targetInfo: { targetId: params.targetId, url: t?.url ?? "", title: t?.title ?? "" } } as T;
      }
      case "Page.captureScreenshot":
        return { data: this.shot } as T;
      case "Browser.getWindowForTarget":
        return { windowId: 7 } as T;
      default:
        return {} as T;
    }
  }

  /** A page of this browser opened a window of its own. */
  popup(openerId: string | undefined, url = "https://example.com/pop"): string {
    const targetId = `P${this.id}.${++this.n}`;
    const sessionId = `PS${this.id}.${this.n}`;
    this.targets.set(targetId, { url, title: "Pop", sessionId });
    this.emit("Target.attachedToTarget", { sessionId, waitingForDebugger: true, targetInfo: { targetId, type: "page", url, title: "Pop", ...(openerId ? { openerId } : {}) } });
    return targetId;
  }

  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    for (const l of [...this.listeners]) l({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (why: string) => void): void {
    this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.die("closed");
  }

  /** The process went (a crash, or a stalled pipe). */
  die(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners.splice(0)) l(why);
  }

  sent(method: string, sessionId?: string): Call[] {
    return this.calls.filter((c) => c.method === method && (sessionId === undefined || c.sessionId === sessionId));
  }
}

/** A network filter that names each policy's listener by its bits. */
function fakeNetwork(): NetworkFilter {
  return { proxyFor: async (p: AddressPolicy) => `socks5://127.0.0.1:${1000 + (p.loopback ? 1 : 0) + (p.privateNetworks ? 2 : 0) + (p.linkLocal ? 4 : 0)}` } as unknown as NetworkFilter;
}

function setup(opts: { policyFor?: (o: TabOwner) => AddressPolicy; idleMs?: number } = {}) {
  const browsers: FakeBrowser[] = [];
  const events: AppTabEvent[] = [];
  const chunks: { stream: string; chunk: StreamChunk }[] = [];
  let installs = 0;
  let pops = 0;
  const dir = mkdtempSync(join(tmpdir(), "clover-headless-port-"));
  const headless = new HeadlessBrowser({
    dir,
    computer: "Server",
    network: fakeNetwork(),
    report: (e) => events.push(...e),
    streamData: (stream, chunk) => chunks.push({ stream, chunk }),
    install: async () => {
      installs++;
      return { bin: "/opt/headless/chrome-headless-shell" };
    },
    launch: async (spec) => {
      const b = new FakeBrowser(spec, browsers.length + 1);
      browsers.push(b);
      return b;
    },
    newId: () => `pop_${++pops}`,
    callMs: 1000,
    ...(opts.policyFor ? { policyFor: opts.policyFor } : {}),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return { headless, browsers, events, chunks, dir, flush, installs: () => installs };
}

const alpha: TabOwner = { kind: "bot", bot: "alpha" };
const luna: TabOwner = { kind: "bot", bot: "pack/luna" };

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof BrowserError ? e.code : (e as Error).message;
  }
  return "not refused";
}

// -------------------------------------------------------------------------------------------------

describe("profiles and flags", () => {
  test("a profile is named as the app's partition is, without persist:", () => {
    expect(profileName(alpha)).toBe("bot-alpha");
    expect(profileName(luna)).toBe("bot-pack--luna");
    expect(profileName({ kind: "user" })).toBe("user");
    expect(profileName({ kind: "plugin", plugin: "clover/browser-view" })).toBe("plugin-clover--browser-view");
    expect(profileName({ kind: "session", session: "sess_1" })).toBe(partitionFor({ kind: "session", session: "sess_1" }).slice("persist:".length));
    expect(profileName({ kind: "session", session: "sess_1" })).toMatch(/^session-[0-9a-f]{32}$/);
    expect(() => profileName({ kind: "bot", bot: "../x" })).toThrow(BrowserError);
    expect(profileDir("/h/browser", alpha)).toBe(join("/h/browser", "profiles", "bot-alpha"));
  });

  test("the switches: the filter as a fixed proxy with loopback through it, no lookups of its own, nothing that phones home, 1280×800", () => {
    const args = headlessArgs({ profile: "/h/browser/profiles/bot-alpha", proxy: "socks5://127.0.0.1:4242" });
    expect(args).toContain("--user-data-dir=/h/browser/profiles/bot-alpha");
    expect(args).toContain("--proxy-server=socks5://127.0.0.1:4242");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
    expect(args).toContain("--window-size=1280,800");
    expect(args).toContain("--force-device-scale-factor=1");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    for (const flag of ["--no-first-run", "--disable-extensions", "--disable-component-update", "--disable-background-networking", "--disable-sync", "--disable-breakpad", "--disable-crash-reporter", "--disable-field-trial-config", "--no-pings", "--disable-domain-reliability"]) {
      expect(args).toContain(flag);
    }
    const features = args.find((a) => a.startsWith("--disable-features="))!;
    for (const f of ["Translate", "MediaRouter", "DialMediaRouteProvider", "OptimizationHints", "AutofillServerCommunication", "CertificateTransparencyComponentUpdater"]) expect(features.split("=")[1]!.split(",")).toContain(f);
    expect(DISABLED_FEATURES.length).toBeGreaterThan(10);
    // Never a port, never the system's proxy or WPAD, never unsandboxed.
    for (const a of args) {
      expect(a).not.toMatch(/^--(remote-debugging-port|no-sandbox|proxy-auto-detect|proxy-pac-url|no-proxy-server|winhttp-proxy-resolver)/);
    }
    // The proxy rules pass as they come (they may become per-scheme), but never empty or with spaces.
    expect(headlessArgs({ profile: "/p", proxy: "socks5=socks5://127.0.0.1:1;https=socks5://127.0.0.1:2" })).toContain("--proxy-server=socks5=socks5://127.0.0.1:1;https=socks5://127.0.0.1:2");
    expect(() => headlessArgs({ profile: "/p", proxy: "" })).toThrow();
    expect(() => headlessArgs({ profile: "/p", proxy: "socks5://a b" })).toThrow();
  });

  test("the browser's environment: a home of its own, and none of the daemon's own variables", () => {
    const env = browserEnv("/h/browser", { PATH: "/usr/bin", HOME: "/Users/me", ANTHROPIC_API_KEY: "sk-test", GITHUB_TOKEN: "t", TMPDIR: "/tmp/x", LANG: "en_US.UTF-8" });
    expect(env).toEqual({
      HOME: join("/h/browser", "home"), XDG_CONFIG_HOME: join("/h/browser", "home", ".config"), XDG_CACHE_HOME: join("/h/browser", "home", ".cache"),
      XDG_DATA_HOME: join("/h/browser", "home", ".local", "share"), PATH: "/usr/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp/x",
    });
  });

  test("Windows command lines quote as CommandLineToArgvW reads them", () => {
    expect(quoteWindowsArg("--flag=1")).toBe("--flag=1");
    expect(quoteWindowsArg("C:\\Program Files\\x.exe")).toBe('"C:\\Program Files\\x.exe"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1")).toBe('"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"');
  });

  test("a stream's bitrate sets its JPEG quality and frame skip", () => {
    expect(screencastSettings(undefined)).toEqual({ quality: 70, everyNthFrame: 1 });
    let last = { quality: 101, everyNthFrame: 0 };
    for (const kbps of [20000, 8000, 4000, 2000, 1000, 500, 100]) {
      const s = screencastSettings(kbps);
      expect(s.quality).toBeLessThanOrEqual(last.quality);
      expect(s.everyNthFrame).toBeGreaterThanOrEqual(last.everyNthFrame);
      last = s;
    }
    expect(screencastSettings(100)).toEqual({ quality: 30, everyNthFrame: 6 });
  });

  test("a picture's size is read from its own header", () => {
    expect(imageSize(Buffer.from(png(1280, 800), "base64"))).toEqual({ width: 1280, height: 800 });
    expect(imageSize(jpeg(1280, 800))).toEqual({ width: 1280, height: 800 });
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(799, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 1280, height: 800 });
    expect(imageSize(Buffer.from("not a picture at all, not at all"))).toBeUndefined();
  });
});

describe("the pipe", () => {
  function fakePipe() {
    const written: string[] = [];
    let onData: (c: Uint8Array) => void = () => undefined;
    let onClose: (why: string) => void = () => undefined;
    let open = true;
    const pipe: PipeTransport = {
      write: (b) => { if (!open) return false; written.push(new TextDecoder().decode(b)); return true; },
      onData: (l) => { onData = l; },
      onClose: (l) => { onClose = l; },
      close: () => { open = false; },
    };
    let resolveExit!: (v: { code: number | null; signal: string | null }) => void;
    let killed = 0;
    const proc: BrowserProcess = { pid: 1, exited: new Promise((r) => (resolveExit = r)), kill: () => { killed++; }, stderrTail: () => "" };
    return { pipe, proc, written, feed: (s: string) => onData(new TextEncoder().encode(s)), close: (why: string) => onClose(why), exit: () => resolveExit({ code: 1, signal: null }), killed: () => killed };
  }

  test("messages are NUL-framed, split across reads or several to a read", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    let r = splitFrames([], enc('{"a":1}\0{"b"'));
    expect(r.messages.map((m) => new TextDecoder().decode(m))).toEqual(['{"a":1}']);
    r = splitFrames(r.rest, enc(':2}\0{"c":3}\0'));
    expect(r.messages.map((m) => new TextDecoder().decode(m))).toEqual(['{"b":2}', '{"c":3}']);
    expect(r.rest).toEqual([]);
  });

  test("answers find their calls, events reach listeners, errors are the browser's", async () => {
    const f = fakePipe();
    const conn = new PipeConnection(f.proc, f.pipe);
    const events: CdpEvent[] = [];
    conn.on((e) => events.push(e));
    const a = conn.send("Page.navigate", { url: "https://x.test/" }, "S1");
    expect(JSON.parse(f.written[0]!.slice(0, -1))).toEqual({ id: 1, method: "Page.navigate", params: { url: "https://x.test/" }, sessionId: "S1" });
    expect(f.written[0]!.endsWith("\0")).toBe(true);
    const b = conn.send("Nope.nope");
    f.feed('{"method":"Page.loadEventFired","params":{"timestamp":1},"sessionId":"S1"}\0{"id":2,"error":{"code":-32601,"message":"no such method"}}\0{"id":1,"result":{"frameId":"F"}}\0');
    expect(await a).toEqual({ frameId: "F" });
    await expect(b).rejects.toThrow("no such method");
    expect(events).toEqual([{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" }]);
  });

  test("a call times out; a browser that then answers nothing at all is stopped, and every call fails at once", async () => {
    const f = fakePipe();
    const conn = new PipeConnection(f.proc, f.pipe, { pingMs: 50 });
    const why: string[] = [];
    conn.onClose((w) => why.push(w));
    const err = await conn.send("Page.captureScreenshot", {}, "S1", 50).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect((err as CdpError).kind).toBe("timeout");
    await Bun.sleep(120);
    expect(f.killed()).toBeGreaterThan(0);
    expect(why[0]).toContain("stalled");
    expect(conn.closed).toBe(true);
    await expect(conn.send("Page.reload")).rejects.toThrow("stalled");
  });

  test("a slow call alone isn't a stall while the browser still answers", async () => {
    const f = fakePipe();
    const conn = new PipeConnection(f.proc, f.pipe, { pingMs: 200 });
    await conn.send("Page.navigate", {}, "S1", 30).catch(() => undefined);
    // The ping (id 2) is answered: the browser is alive.
    f.feed('{"id":2,"result":{}}\0');
    await Bun.sleep(60);
    expect(f.killed()).toBe(0);
    expect(conn.closed).toBe(false);
  });

  test("the process exiting fails what's in flight", async () => {
    const f = fakePipe();
    const conn = new PipeConnection(f.proc, f.pipe);
    const p = conn.send("Page.reload", {}, "S1");
    f.exit();
    await expect(p).rejects.toThrow("exited");
    expect(conn.closed).toBe(true);
  });
});

describe("HeadlessBrowser as the core's AppTabPort", () => {
  test("open: one browser per profile, started through the filter's proxy for its owner, set up before any page runs", async () => {
    const { headless, browsers, events, flush, installs, dir } = setup();
    const view = await headless.open({ id: "t1", owner: alpha, url: "https://example.com/", place: "headless" });
    expect(view).toMatchObject({ id: "t1", owner: alpha, partition: "persist:bot-alpha", computer: "Server", place: "headless", viewport: { width: 1280, height: 800 }, heldByUser: false, url: "https://example.com/", loading: true });
    expect(browsers.length).toBe(1);
    const b = browsers[0]!;
    expect(b.spec.bin).toBe("/opt/headless/chrome-headless-shell");
    // A bot's policy: no loopback (R13).
    expect(b.spec.args).toContain("--proxy-server=socks5://127.0.0.1:1000");
    expect(b.spec.args).toContain(`--user-data-dir=${join(dir, "profiles", "bot-alpha")}`);
    expect(b.spec.env?.HOME).toBe(join(dir, "home"));
    // The URL rule, downloads and auto-attach come before the first page.
    const order = b.calls.map((c) => c.method);
    expect(order.indexOf("Fetch.enable")).toBeLessThan(order.indexOf("Target.createTarget"));
    expect(b.sent("Fetch.enable")[0]!.params).toEqual({ patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    expect(b.sent("Fetch.enable")[0]!.sessionId).toBeUndefined();
    expect(b.sent("Browser.setDownloadBehavior")[0]!.params).toEqual({ behavior: "deny" });
    expect(b.sent("Browser.setPermission").map((c) => (c.params.permission as { name: string }).name)).toContain("geolocation");
    expect(b.sent("Target.setAutoAttach")[0]!.params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(b.sent("Target.createTarget")[0]!.params).toEqual({ url: "about:blank", width: 1280, height: 800 });
    // On the tab's own session: set up, then let run, then navigated.
    const tabCalls = b.calls.filter((c) => c.sessionId === "S1.1").map((c) => c.method);
    expect(tabCalls.slice(0, 4)).toEqual(["Page.enable", "Page.setInterceptFileChooserDialog", "Runtime.runIfWaitingForDebugger", "Page.navigate"]);
    await headless.open({ id: "t2", owner: alpha, place: "headless" });
    expect(browsers.length).toBe(1);
    await headless.open({ id: "t3", owner: { kind: "session", session: "sess_1" }, place: "headless" });
    expect(browsers.length).toBe(2);
    // A coding session's policy: loopback (R13).
    expect(browsers[1]!.spec.args).toContain("--proxy-server=socks5://127.0.0.1:1001");
    // The install is checked again before each start.
    expect(installs()).toBe(2);
    await flush();
    expect(events.some((e) => e.kind === "changed" && e.tab.id === "t1")).toBe(true);
    expect((await headless.list()).map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
  });

  test("open refuses: a shown tab (no view here), a refused URL, a bad owner, an id in use", async () => {
    const { headless, browsers } = setup();
    expect(await refused(headless.open({ id: "t1", owner: alpha, place: "shown" }))).toContain("no view");
    expect(await refused(headless.open({ id: "t1", owner: alpha, url: "file:///etc/passwd", place: "headless" }))).toContain("doesn't open");
    expect(await refused(headless.open({ id: "t1", owner: { kind: "bot", bot: "../x" }, place: "headless" }))).toBe("bad_owner");
    expect(browsers.length).toBe(0);
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    expect(await refused(headless.open({ id: "t1", owner: alpha, place: "headless" }))).toContain("already");
  });

  test("the URL rule holds in the browser for every request: refused schemes fail, web requests go on; a bot's own interception is its own", async () => {
    const { headless, browsers, events, flush } = setup();
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    const b = browsers[0]!;
    b.emit("Fetch.requestPaused", { requestId: "r1", request: { url: "file:///etc/passwd" }, resourceType: "Document" });
    b.emit("Fetch.requestPaused", { requestId: "r2", request: { url: "https://example.com/a.js" }, resourceType: "Script" });
    b.emit("Fetch.requestPaused", { requestId: "r3", request: { url: "chrome://settings" } });
    b.emit("Fetch.requestPaused", { requestId: "r4", request: { url: "clover-plugin://x/y" } });
    expect(b.sent("Fetch.failRequest").map((c) => c.params)).toEqual([
      { requestId: "r1", errorReason: "BlockedByClient" }, { requestId: "r3", errorReason: "BlockedByClient" }, { requestId: "r4", errorReason: "BlockedByClient" },
    ]);
    expect(b.sent("Fetch.continueRequest").map((c) => c.params)).toEqual([{ requestId: "r2" }]);
    for (const c of [...b.sent("Fetch.failRequest"), ...b.sent("Fetch.continueRequest")]) expect(c.sessionId).toBeUndefined();
    // A request paused by the bot's own `Fetch.enable` on its tab is the bot's to answer: forwarded, not answered here.
    b.emit("Fetch.requestPaused", { requestId: "mine", request: { url: "https://example.com/" } }, "S1.1");
    await flush();
    expect(b.sent("Fetch.continueRequest").length).toBe(1);
    expect(events.some((e) => e.kind === "cdp" && e.method === "Fetch.requestPaused")).toBe(true);
    // And it can't send one on to a refused address.
    expect(await refused(headless.command("t1", { kind: "cdp", method: "Fetch.continueRequest", params: { requestId: "mine", url: "file:///etc/passwd" } }))).toBe("url_refused");
    expect(await refused(headless.command("t1", { kind: "navigate", url: "file:///etc/passwd" }))).toContain("doesn't open");
  });

  test("DevTools calls pass the allow list again, on the tab's own session only: Target, Browser and Storage never reach the pipe", async () => {
    const { headless, browsers } = setup();
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    const b = browsers[0]!;
    const before = b.calls.length;
    for (const method of ["Target.getTargets", "Target.createTarget", "Target.attachToTarget", "Browser.close", "Browser.setDownloadBehavior", "Storage.clearDataForOrigin", "SystemInfo.getInfo", "DOM.setFileInputFiles", "Page.setDownloadBehavior", "Network.setCookies", "Emulation.setDeviceMetricsOverride"]) {
      expect(await refused(headless.command("t1", { kind: "cdp", method }))).toBe("method_refused");
    }
    expect(b.calls.length).toBe(before);
    await headless.command("t1", { kind: "cdp", method: "Runtime.evaluate", params: { expression: "1" } });
    expect(b.calls.at(-1)).toEqual({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "S1.1" });
  });

  test("events: only the allow list's reach the API; dialogs are answered at once; titles and loads are reported", async () => {
    const { headless, browsers, events, flush } = setup();
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    const b = browsers[0]!;
    await flush();
    events.length = 0;
    b.emit("Network.requestWillBeSent", { requestId: "1" }, "S1.1");
    b.emit("Target.targetInfoChanged", { targetInfo: { targetId: "T1.1", url: "https://example.com/", title: "Example" } });
    b.emit("Page.javascriptDialogOpening", { type: "confirm", message: "sure?" }, "S1.1");
    b.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "S1.1");
    b.emit("Some.unknownEvent", {}, "S1.1");
    b.emit("Page.loadEventFired", {}, "S9.9"); // another session: not this tab's
    await flush();
    expect(b.sent("Page.handleJavaScriptDialog").map((c) => [c.params.accept, c.sessionId])).toEqual([[false, "S1.1"], [true, "S1.1"]]);
    const cdp = events.filter((e) => e.kind === "cdp").map((e) => (e as { method: string }).method);
    expect(cdp).toEqual(["Network.requestWillBeSent", "Page.javascriptDialogOpening", "Page.javascriptDialogOpening"]);
    expect(events.find((e) => e.kind === "changed")).toMatchObject({ tab: { id: "t1", url: "https://example.com/", title: "Example" } });
    // A title the target didn't announce is asked for when the page loads.
    b.targets.get("T1.1")!.title = "Later title";
    b.emit("Page.frameStartedLoading", { frameId: "T1.1" }, "S1.1");
    b.emit("Page.frameStoppedLoading", { frameId: "T1.1" }, "S1.1");
    await Bun.sleep(5);
    await flush();
    expect(events.filter((e) => e.kind === "changed").at(-1)).toMatchObject({ tab: { title: "Later title", loading: false } });
  });

  test("a page's window becomes a tab of the same owner, set up and reported", async () => {
    const { headless, browsers, events, flush } = setup();
    await headless.open({ id: "t1", owner: luna, place: "headless" });
    const b = browsers[0]!;
    b.popup("T1.1");
    b.popup(undefined, "https://example.com/noopener");
    await Bun.sleep(5);
    await flush();
    const changed = events.filter((e) => e.kind === "changed" && e.tab.id.startsWith("pop_")).map((e) => (e as { tab: { id: string; owner: TabOwner; partition: string; url: string } }).tab);
    expect(changed.map((t) => t.id).sort()).toEqual(["pop_1", "pop_2"]);
    for (const t of changed) {
      expect(t.owner).toEqual(luna);
      expect(t.partition).toBe("persist:bot-pack--luna");
    }
    expect(b.sent("Runtime.runIfWaitingForDebugger").map((c) => c.sessionId)).toEqual(["S1.1", "PS1.2", "PS1.3"]);
  });

  test("closing: by command (user), by the page, by a crash; a dead browser closes its tabs as crashed and the next open starts it again", async () => {
    const { headless, browsers, events, chunks, flush } = setup();
    await headless.open({ id: "a", owner: alpha, place: "headless" });
    await headless.open({ id: "b", owner: alpha, place: "headless" });
    await headless.open({ id: "c", owner: alpha, place: "headless" });
    await headless.open({ id: "d", owner: alpha, place: "headless" });
    await headless.open({ id: "other", owner: luna, place: "headless" });
    const b = browsers[0]!;
    await headless.command("a", { kind: "close" });
    expect(b.sent("Target.closeTarget")[0]!.params).toEqual({ targetId: "T1.1" });
    b.emit("Target.targetDestroyed", { targetId: "T1.2" });
    b.emit("Target.targetCrashed", { targetId: "T1.3", status: "crashed" });
    await headless.command("d", { kind: "stream", stream: "s", on: true });
    b.die("the browser exited (SIGSEGV)");
    await flush();
    const closed = events.filter((e) => e.kind === "closed");
    expect(closed).toEqual([
      { kind: "closed", id: "a", by: "user" }, { kind: "closed", id: "b", by: "page" }, { kind: "closed", id: "c", by: "crash" }, { kind: "closed", id: "d", by: "crash" },
    ]);
    expect(chunks.at(-1)).toEqual({ stream: "s", chunk: { kind: "ended", reason: "failed", message: "the browser exited (SIGSEGV)" } });
    expect((await headless.list()).map((t) => t.id)).toEqual(["other"]);
    expect(await refused(headless.command("d", { kind: "screenshot", format: "png" }))).toContain("no tab");
    await headless.open({ id: "e", owner: alpha, place: "headless" });
    expect(browsers.length).toBe(3);
  });

  test("screenshots: the tab's size, read from the picture; a wrong-sized one is refused; one that never comes reports a stall and fails", async () => {
    const { headless, browsers, events, flush } = setup();
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    const b = browsers[0]!;
    const shot = (await headless.command("t1", { kind: "screenshot", format: "jpeg", quality: 60 })) as Record<string, unknown>;
    expect(shot).toMatchObject({ format: "jpeg", width: 1280, height: 800, contentAgeMs: 0 });
    expect(typeof shot.takenAt).toBe("number");
    expect(b.sent("Page.captureScreenshot").at(-1)!.params).toMatchObject({ format: "jpeg", quality: 60 });
    expect(b.sent("Page.captureScreenshot").at(-1)!.sessionId).toBe("S1.1");
    await headless.command("t1", { kind: "screenshot", format: "png", quality: 60 });
    expect(b.sent("Page.captureScreenshot").at(-1)!.params.quality).toBeUndefined();
    b.shot = png(1000, 700);
    expect(await refused(headless.command("t1", { kind: "screenshot", format: "png" }))).toContain("not the tab's 1280×800");
    b.hang.add("Page.captureScreenshot");
    expect(await refused(headless.command("t1", { kind: "screenshot", format: "png" }))).toContain("no picture");
    await flush();
    expect(events.some((e) => e.kind === "stalled" && e.id === "t1")).toBe(true);
  });

  test("place: shown is refused, resting is recorded, another size resizes the tab's window", async () => {
    const { headless, browsers, events, flush } = setup();
    await headless.open({ id: "t1", owner: alpha, place: "resting" });
    expect((await headless.list())[0]!.place).toBe("resting");
    expect(await refused(headless.command("t1", { kind: "place", place: "shown", view: "browser", viewport: { width: 800, height: 600 } }))).toContain("no view");
    await headless.command("t1", { kind: "place", place: "headless", viewport: { width: 1000, height: 700 } });
    expect(browsers[0]!.sent("Browser.setWindowBounds")[0]!.params).toEqual({ windowId: 7, bounds: { width: 1000, height: 700 } });
    await headless.command("t1", { kind: "place", place: "headless" });
    await flush();
    expect(events.filter((e) => e.kind === "changed").at(-1)).toMatchObject({ tab: { place: "headless", viewport: { width: 1280, height: 800 } } });
  });

  test("streams: a JPEG config, then each frame acked and handed on, never as a DevTools event; bitrate, key frames, stop and close", async () => {
    const { headless, browsers, events, chunks, flush } = setup();
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    const b = browsers[0]!;
    expect(await refused(headless.command("t1", { kind: "stream", stream: "s1", on: true, codecs: ["h264", "vp8"] }))).toContain("JPEG");
    await headless.command("t1", { kind: "stream", stream: "s1", on: true, maxKbps: 1000 });
    expect(chunks[0]).toEqual({ stream: "s1", chunk: { kind: "config", codec: "jpeg", width: 1280, height: 800, codecString: "jpeg" } });
    expect(b.sent("Page.startScreencast")[0]!).toMatchObject({ params: { format: "jpeg", quality: 50, everyNthFrame: 3, maxWidth: 1280, maxHeight: 800 }, sessionId: "S1.1" });
    const frame = jpeg(1280, 800);
    b.emit("Page.screencastFrame", { data: frame.toString("base64"), sessionId: 42, metadata: { timestamp: 1.5 } }, "S1.1");
    expect(b.sent("Page.screencastFrameAck")[0]!).toEqual({ method: "Page.screencastFrameAck", params: { sessionId: 42 }, sessionId: "S1.1" });
    expect(chunks[1]).toEqual({ stream: "s1", chunk: { kind: "frame", key: true, timestamp: 1_500_000, data: new Uint8Array(frame) } });
    // While it streams, the screencast is the port's.
    expect(await refused(headless.command("t1", { kind: "cdp", method: "Page.stopScreencast" }))).toBe("method_refused");
    await headless.command("t1", { kind: "stream-control", stream: "s1", kbps: 8000, keyframe: true });
    expect(b.sent("Page.startScreencast")[1]!.params).toMatchObject({ quality: 80, everyNthFrame: 1 });
    expect(chunks.at(-1)!.chunk).toMatchObject({ kind: "frame", key: true, data: new Uint8Array(frame) });
    expect(await refused(headless.command("t1", { kind: "stream-control", stream: "nope", keyframe: true }))).toContain("isn't streaming");
    await headless.command("t1", { kind: "stream", stream: "s1", on: false });
    expect(chunks.at(-1)).toEqual({ stream: "s1", chunk: { kind: "ended", reason: "stopped" } });
    await headless.command("t1", { kind: "stream", stream: "s2", on: true });
    await headless.command("t1", { kind: "close" });
    expect(chunks.at(-1)).toEqual({ stream: "s2", chunk: { kind: "ended", reason: "closed" } });
    await flush();
    expect(events.some((e) => e.kind === "cdp" && e.method.startsWith("Page.screencast"))).toBe(false);
  });

  test("refreshPolicies: a profile whose policy changed starts again with the new proxy, its tabs reopened at their addresses", async () => {
    let lan = false;
    const { headless, browsers, events, flush } = setup({ policyFor: (o) => ({ loopback: false, privateNetworks: o.kind === "bot" && o.bot === "alpha" && lan, linkLocal: false }) });
    await headless.open({ id: "t1", owner: alpha, url: "https://example.com/a", place: "headless" });
    await headless.open({ id: "t2", owner: luna, place: "headless" });
    expect(await headless.refreshPolicies()).toEqual([]);
    lan = true;
    expect(await headless.refreshPolicies()).toEqual(["t1"]);
    expect(browsers[0]!.closedByUs).toBe(true);
    expect(browsers.length).toBe(3);
    expect(browsers[2]!.spec.args).toContain("--proxy-server=socks5://127.0.0.1:1002");
    expect(browsers[2]!.sent("Page.navigate")[0]!.params).toEqual({ url: "https://example.com/a" });
    await flush();
    expect(events.filter((e) => e.kind === "changed" && e.tab.id === "t1").at(-1)).toMatchObject({ tab: { url: "https://example.com/a" } });
    expect(events.some((e) => e.kind === "closed")).toBe(false);
    expect((await headless.list()).map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    await headless.command("t1", { kind: "screenshot", format: "png" });
  });

  test("a profile with no tabs stops after it idles; shutdown stops them all", async () => {
    const { headless, browsers } = setup({ idleMs: 10 });
    await headless.open({ id: "t1", owner: alpha, place: "headless" });
    await headless.open({ id: "t2", owner: luna, place: "headless" });
    await headless.command("t1", { kind: "close" });
    await Bun.sleep(40);
    expect(browsers[0]!.closedByUs).toBe(true);
    expect(browsers[1]!.closedByUs).toBe(false);
    await headless.shutdown();
    expect(browsers[1]!.closedByUs).toBe(true);
    expect(await refused(headless.open({ id: "t3", owner: alpha, place: "headless" }))).toContain("shut down");
  });

  test("the core's BrowserService drives it as it drives the app", async () => {
    const { headless, browsers } = setup();
    const service = new BrowserService({ computer: "Server", app: () => headless });
    const bot = { kind: "agent", bot: "alpha" } as const;
    const tab = await service.open(bot, { owner: alpha, url: "https://example.com/" });
    expect(tab).toMatchObject({ owner: alpha, partition: "persist:bot-alpha", computer: "Server", place: "headless" });
    const shot = await service.screenshot(bot, tab.id, { format: "png" });
    expect(shot).toMatchObject({ width: 1280, height: 800 });
    expect(await refused(service.cdp(bot, tab.id, "Target.getTargets"))).toBe("method_refused");
    expect(await refused(service.show({ kind: "user" }, tab.id, "browser", { width: 800, height: 600 }))).toBe("app_failed");
    await service.close(bot, tab.id);
    expect(browsers[0]!.sent("Target.closeTarget").length).toBe(1);
  });
});
