// The headless shell for real (spec §12.1, "Where no app runs"): the pinned build installed into a temp folder (or
// `CLOVER_HEADLESS_DIR`, a CI cache), a bot's tab on a local fixture server, its pictures, the URL rule, the refused
// DevTools domains, the address policy through the real network filter (R13), a stream, a page's window, dialogs and
// permissions. Skipped unless CLOVER_HEADLESS_TESTS=1. The headless shell opens no window, so it may run on a
// developer's machine; in CI it runs on all four OSes (on Linux with unprivileged user namespaces allowed for
// Chromium's sandbox, as the app's tests).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BOT_POLICY, NetworkFilter, policyFor, type AddressPolicy } from "../../src/browser/network";
import { BrowserError, partitionFor } from "../../src/browser/policy";
import type { AppTabEvent, StreamChunk, TabOwner, TabView } from "../../src/browser/contract";
import { HeadlessBrowser, imageSize } from "../../src/browser/headless";
import { startBrowser } from "../../src/browser/daemon";
import type { BrowserEvent } from "../../src/browser/service";

const RUN = process.env.CLOVER_HEADLESS_TESTS === "1";
/** One install folder for the whole file (CI's cache when it gives one): the second describe reuses the first's
 *  install instead of downloading the shell again. */
let sharedDir: string | undefined;
const SHARED_DIR = (): string => (sharedDir ??= process.env.CLOVER_HEADLESS_DIR ?? mkdtempSync(join(tmpdir(), "clover-headless-")));
const T = 120_000;

/** A bot allowed loopback, so its tab can load the local fixture server: only the R13 checks use the real policies. */
const lab: TabOwner = { kind: "bot", bot: "lab" };
const alpha: TabOwner = { kind: "bot", bot: "alpha" };
const coding: TabOwner = { kind: "session", session: "sess_r13" };
let labPolicy: AddressPolicy = { loopback: true, privateNetworks: false, linkLocal: false };

describe.skipIf(!RUN)("the headless shell, for real", () => {
  const dir = SHARED_DIR();
  const events: AppTabEvent[] = [];
  const chunks: { stream: string; chunk: StreamChunk }[] = [];
  const names: string[] = [];
  const logs: string[] = [];
  const secret = join(mkdtempSync(join(tmpdir(), "clover-headless-file-")), "secret.txt");
  writeFileSync(secret, "FILE-MARKER-7f3a");
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let network: NetworkFilter;
  let browser: HeadlessBrowser;
  let n = 0;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: pathToFileURL(secret).href } });
        if (url.pathname === "/frame") return html(`<title>Frame</title><iframe src="${pathToFileURL(secret).href}"></iframe><a id="a" href="${pathToFileURL(secret).href}">x</a>`);
        if (url.pathname === "/opener") return html(`<title>Opener</title><button id="b" onclick="window.open('/popup')">open</button>`);
        if (url.pathname === "/popup") return html(`<title>Popup</title><p>POPUP</p>`);
        return html(`<title>Fixture</title><p id="m">LOOPBACK-MARKER</p>`);
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    network = new NetworkFilter({
      lookup: async (host) => {
        names.push(host);
        return (await import("node:dns/promises")).lookup(host, { all: true, verbatim: true }).then((a) => a.map((x) => x.address));
      },
    });
    browser = new HeadlessBrowser({
      dir,
      computer: "Server",
      network,
      report: (e) => events.push(...e),
      streamData: (stream, chunk) => chunks.push({ stream, chunk }),
      policyFor: (owner) => (owner.kind === "bot" && owner.bot === "lab" ? labPolicy : policyFor(owner)),
      log: (l) => logs.push(l),
      newId: () => `pop_${++n}`,
      idleMs: 2_000,
    });
  });

  afterAll(async () => {
    await browser?.shutdown();
    await network?.close();
    server?.stop(true);
  });

  async function waitFor<T>(what: string, get: () => T | undefined, ms = 20_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v !== undefined && v !== false) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}; logs: ${logs.slice(-5).join(" | ")}`);
      await Bun.sleep(50);
    }
  }

  const evaluate = async (id: string, expression: string): Promise<unknown> => {
    const r = (await browser.command(id, { kind: "cdp", method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })) as { result: { value?: unknown } };
    return r.result.value;
  };
  const lastView = (id: string): TabView | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "changed" && e.tab.id === id) return e.tab;
    }
    return undefined;
  };
  const loaded = (id: string, title: string) => waitFor(`${id} to load ${title}`, () => {
    const v = lastView(id);
    return v !== undefined && v.title === title && !v.loading ? v : undefined;
  });

  test("installs the pinned build, opens a bot's tab on the fixture, in the bot's own profile", async () => {
    const view = await browser.open({ id: "t1", owner: lab, url: `${base}/`, place: "headless" });
    expect(view).toMatchObject({ id: "t1", owner: lab, partition: partitionFor(lab), place: "headless", viewport: { width: 1280, height: 800 }, computer: "Server" });
    const done = await loaded("t1", "Fixture");
    expect(done.url).toBe(`${base}/`);
    expect(await evaluate("t1", "document.getElementById('m').textContent")).toBe("LOOPBACK-MARKER");
    expect(await evaluate("t1", "innerWidth + 'x' + innerHeight + '@' + devicePixelRatio")).toBe("1280x800@1");
    expect(existsSync(join(dir, "profiles", "bot-lab"))).toBe(true);
  }, T);

  test("screenshots are 1280×800 in each format", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const shot = (await browser.command("t1", { kind: "screenshot", format })) as { data: string; width: number; height: number; format: string; takenAt: number };
      expect(shot).toMatchObject({ format, width: 1280, height: 800 });
      expect(imageSize(Buffer.from(shot.data, "base64"))).toEqual({ width: 1280, height: 800 });
    }
  }, T);

  test("a refused scheme never loads: not by DevTools, a redirect, a frame or a link", async () => {
    await expect(browser.command("t1", { kind: "navigate", url: pathToFileURL(secret).href })).rejects.toThrow();
    const nav = (await browser.command("t1", { kind: "cdp", method: "Page.navigate", params: { url: pathToFileURL(secret).href } })) as { errorText?: string };
    expect(nav.errorText).toBe("net::ERR_BLOCKED_BY_CLIENT");
    expect(String(await evaluate("t1", "document.documentElement.innerText"))).not.toContain("FILE-MARKER");
    await browser.command("t1", { kind: "cdp", method: "Page.navigate", params: { url: `${base}/redirect` } });
    await Bun.sleep(500);
    expect(String(await evaluate("t1", "location.href + document.documentElement.innerText"))).not.toContain("FILE-MARKER");
    await browser.command("t1", { kind: "navigate", url: `${base}/frame` });
    await loaded("t1", "Frame");
    await evaluate("t1", "document.getElementById('a').click()");
    await Bun.sleep(500);
    expect(String(await evaluate("t1", "location.href"))).not.toStartWith("file:");
    expect(logs.some((l) => l.includes("refused a file: request"))).toBe(true);
  }, T);

  test("Target, Browser and Storage are refused on the tab's session, and the browser stays up", async () => {
    for (const method of ["Target.getTargets", "Browser.close", "Storage.clearDataForOrigin", "Target.createTarget", "DOM.setFileInputFiles"]) {
      const err = await browser.command("t1", { kind: "cdp", method }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(BrowserError);
      expect((err as BrowserError).code).toBe("method_refused");
    }
    const shot = (await browser.command("t1", { kind: "screenshot", format: "jpeg" })) as { width: number };
    expect(shot.width).toBe(1280);
  }, T);

  test("R13: a bot's tab can't reach loopback through the filter, a coding session's can", async () => {
    const byName = `http://localhost:${server.port}/`;
    await browser.open({ id: "bot", owner: alpha, url: `${base}/`, place: "headless" });
    await waitFor("the bot's tab to settle", () => lastView("bot")?.loading === false && lastView("bot"));
    expect(String(await evaluate("bot", "document.documentElement.innerText"))).not.toContain("LOOPBACK-MARKER");
    await browser.command("bot", { kind: "navigate", url: byName });
    await Bun.sleep(300);
    await waitFor("the bot's tab to settle", () => lastView("bot")?.loading === false && lastView("bot"));
    expect(String(await evaluate("bot", "document.documentElement.innerText"))).not.toContain("LOOPBACK-MARKER");
    expect(policyFor(alpha)).toEqual(BOT_POLICY);

    await browser.open({ id: "code", owner: coding, url: `${base}/`, place: "headless" });
    await loaded("code", "Fixture");
    await browser.command("code", { kind: "navigate", url: byName });
    await waitFor("the session's tab by name", () => lastView("code")?.url === byName && !lastView("code")!.loading && lastView("code"));
    expect(await evaluate("code", "document.getElementById('m')?.textContent")).toBe("LOOPBACK-MARKER");
    expect(existsSync(join(dir, "profiles", partitionFor(coding).slice("persist:".length)))).toBe(true);
    // Nothing of the browser's own reached out: every name the filter was asked for is the fixture's.
    expect([...new Set(names)].filter((h) => h !== "localhost")).toEqual([]);
  }, T);

  test("a stream gives its config, then JPEG frames, and ends when stopped", async () => {
    await browser.command("t1", { kind: "navigate", url: `${base}/` });
    await loaded("t1", "Fixture");
    await browser.command("t1", { kind: "stream", stream: "s1", on: true, maxKbps: 4000 });
    await evaluate("t1", "document.body.style.background = 'rgb(200, 30, 30)'; new Promise((r) => requestAnimationFrame(() => r(1)))");
    const frame = await waitFor("a frame", () => chunks.find((c) => c.stream === "s1" && c.chunk.kind === "frame"));
    expect(chunks.find((c) => c.stream === "s1")!.chunk).toEqual({ kind: "config", codec: "jpeg", width: 1280, height: 800, codecString: "jpeg" });
    if (frame.chunk.kind !== "frame") throw new Error("not a frame");
    expect([frame.chunk.data[0], frame.chunk.data[1]]).toEqual([0xff, 0xd8]);
    expect(frame.chunk.key).toBe(true);
    expect(imageSize(frame.chunk.data)).toEqual({ width: 1280, height: 800 });
    // The frames never reach the API as DevTools events.
    expect(events.some((e) => e.kind === "cdp" && e.method === "Page.screencastFrame")).toBe(false);
    const before = chunks.length;
    await browser.command("t1", { kind: "stream-control", stream: "s1", keyframe: true, kbps: 600 });
    await waitFor("the key frame again", () => chunks.slice(before).find((c) => c.chunk.kind === "frame"));
    await browser.command("t1", { kind: "stream", stream: "s1", on: false });
    expect(chunks.at(-1)).toEqual({ stream: "s1", chunk: { kind: "ended", reason: "stopped" } });
  }, T);

  test("dialogs are answered at once, permissions are denied, and a page's window becomes a tab of the same bot", async () => {
    expect(await evaluate("t1", "alert('hi'); confirm('sure?') ? 'yes' : 'no'")).toBe("no");
    expect(events.some((e) => e.kind === "cdp" && e.id === "t1" && e.method === "Page.javascriptDialogOpening")).toBe(true);
    for (const name of ["geolocation", "notifications", "camera", "microphone"]) {
      expect(await evaluate("t1", `navigator.permissions.query({ name: '${name}' }).then((s) => s.state)`)).toBe("denied");
    }
    await browser.command("t1", { kind: "navigate", url: `${base}/opener` });
    await loaded("t1", "Opener");
    await evaluate("t1", "window.open('/popup'); 1");
    const popup = await waitFor("the page's window as a tab", () => events.find((e): e is Extract<AppTabEvent, { kind: "changed" }> => e.kind === "changed" && e.tab.id.startsWith("pop_") && e.tab.title === "Popup"));
    expect(popup.tab.owner).toEqual(lab);
    expect(popup.tab.partition).toBe(partitionFor(lab));
    expect((await browser.list()).map((t) => t.id)).toContain(popup.tab.id);
    // The page closes its own window: closed by the page.
    await evaluate(popup.tab.id, "window.close(); 1");
    await waitFor("the window's close", () => events.find((e) => e.kind === "closed" && e.id === popup.tab.id && e.by === "page"));
  }, T);

  test("a changed policy restarts the profile with its new proxy, and its tabs reopen at their addresses", async () => {
    labPolicy = { ...BOT_POLICY };
    const reopened = await browser.refreshPolicies();
    expect(reopened).toContain("t1");
    await waitFor("t1 to reopen", () => lastView("t1")?.url === `${base}/opener` && !lastView("t1")!.loading && lastView("t1")).catch((e) => { throw new Error(`${e}; last: ${JSON.stringify(lastView("t1"))}`); });
    // Its new proxy is a bot's: the fixture on loopback no longer loads.
    expect(await evaluate("t1", "document.getElementById('b') === null")).toBe(true);
    await browser.command("t1", { kind: "close" });
    await waitFor("t1's close", () => events.find((e) => e.kind === "closed" && e.id === "t1" && e.by === "user"));
    expect((await browser.list()).map((t) => t.id)).not.toContain("t1");
  }, T);
});

describe.skipIf(!RUN)("the daemon's browser where no app runs, for real", () => {
  test("startBrowser: the headless shell drives tabs through the service, and its filter takes only the shell's own connections", async () => {
    const dir = SHARED_DIR();
    const home = mkdtempSync(join(tmpdir(), "clover-daemon-browser-"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => html(`<title>Daemon</title><p>DAEMON-MARKER</p>`) });
    const logs: string[] = [];
    const events: BrowserEvent[] = [];
    const browser = startBrowser({
      computer: "Server", home, headless: true, log: (l) => logs.push(l), emit: (e) => events.push(e),
      // The install the tests above made (or CI's cache); and a bot allowed loopback, for the fixture.
      headlessOptions: { dir, policyFor: (owner, lan) => (owner.kind === "bot" && owner.bot === "lab" ? { loopback: true, privateNetworks: false, linkLocal: false } : policyFor(owner, lan)) },
    });
    try {
      const tab = await browser.service.open({ kind: "user" }, { owner: lab, url: `http://127.0.0.1:${server.port}/` });
      // Wait on the condition, not a guess: the shell's own report that the page loaded (the filter's owner lookups
      // can take Windows seconds on a loaded runner). A DevTools call sent while the page is still committing can go
      // unanswered, so the page is read only once it has loaded, and a read that fails is tried again.
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !events.some((e) => e.type === "tab_changed" && e.tab.id === tab.id && e.tab.title === "Daemon" && !e.tab.loading)) await Bun.sleep(100);
      let text = "";
      while (Date.now() < deadline && !text.includes("DAEMON-MARKER")) {
        const r = (await browser.service.cdp({ kind: "user" }, tab.id, "Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }).catch(() => undefined)) as { result?: { value?: string } } | undefined;
        text = r?.result?.value ?? "";
        if (!text.includes("DAEMON-MARKER")) await Bun.sleep(250);
      }
      expect(`${text} ${JSON.stringify(events.filter((e) => e.type === "tab_changed").slice(-3))}`).toContain("DAEMON-MARKER");
      // This test's own process is not the shell's: its connection to the filter is closed unanswered.
      const ports = browser.filterPorts();
      expect(ports.length).toBeGreaterThanOrEqual(3);
      const answer = await new Promise<string>((resolve) => {
        const s = require("node:net").connect(ports[0], "127.0.0.1", () => s.write(Buffer.from([5, 1, 0])));
        // The same lookups decide this connection: it is answered or closed once they finish, however long that takes.
        const t = setTimeout(() => { s.destroy(); resolve("no answer"); }, 45_000);
        s.on("data", () => { clearTimeout(t); s.destroy(); resolve("answered"); });
        s.on("close", () => { clearTimeout(t); resolve("closed"); });
        s.on("error", () => { clearTimeout(t); resolve("closed"); });
      });
      expect(`${answer} ${logs.join(" | ")}`).toStartWith("closed");
    } finally {
      await browser.shutdown();
      server.stop(true);
    }
  }, 300_000);
});

function html(body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
