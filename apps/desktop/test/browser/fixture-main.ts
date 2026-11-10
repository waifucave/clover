// The browser module's CI fixture: an Electron main process that drives `createBrowserHost` the way the daemon and
// lane E's runtime will, against pages served on loopback, and writes what it saw as JSON. `../browser.test.ts`
// builds and runs it (CI only: it shows a window) and asserts on the result. Each step records ok/detail and never
// throws past itself, so one failure doesn't hide the rest.
import { app, BrowserWindow, clipboard, screen, session, webContents, type BaseWindow } from "electron";
import { createServer } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { BROWSER_WEBRTC_POLICY, createBrowserHost, isBrowserContents, isBrowserTab, PERSON_POLICY, type BrowserHost, type TabView } from "../../src/main/browser/index";
import type { AppTabEvent } from "../../src/main/browser/contract";

const out = process.env.CLOVER_BROWSER_TEST_OUT ?? "";
const preload = process.env.CLOVER_BROWSER_TEST_PRELOAD ?? "";
const html = process.env.CLOVER_BROWSER_TEST_HTML ?? "";
/** Set by the Windows scaling runs (`--force-device-scale-factor=<n>`): the fixture then checks what scale does. */
const wantScale = Number(process.env.CLOVER_BROWSER_TEST_SCALE ?? "") || undefined;
/** Set by the Wayland run: the session must really be Wayland, with no X server to fall back on. */
const wantWayland = process.env.CLOVER_BROWSER_TEST_WAYLAND === "1";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture page</title>
<style>body{margin:0;font:16px sans-serif} #p{position:fixed;left:20px;top:200px;margin:0;white-space:nowrap}</style></head><body>
<input id="field" style="position:fixed;left:20px;top:20px;width:300px">
<p id="p">select and copy this sentence</p>
<script>
  window.__t = { token: Math.random().toString(36).slice(2), ticks: 0, loads: (performance.getEntriesByType("navigation")[0] || {}).type || "?" };
  setInterval(() => { window.__t.ticks++; }, 50);
  window.addEventListener("message", (e) => { (window.__t.msgs ||= []).push(String(e.data)); });
</script></body></html>`;
const POPUP = `<!doctype html><html><head><title>Fixture popup</title></head><body>popup<script>
  try { window.opener && window.opener.postMessage("popup:hello", "*"); } catch (e) {}
  let n = 0; (function f(){ n++; document.title = "Fixture popup " + (n % 2); requestAnimationFrame(f); })();
</script></body></html>`;

interface Step { name: string; ok: boolean; detail: unknown; ms: number }
const steps: Step[] = [];
const reports: AppTabEvent[] = [];
const holds: string[] = [];
const menus: { selectionText: string; canCopy: boolean }[] = [];
const netLogs: string[] = [];
const netLog = (line: string): void => { if (netLogs.length < 200) netLogs.push(line); };

async function step(name: string, f: () => Promise<{ ok: boolean; detail?: unknown }>): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await Promise.race([f(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 45 s")), 45_000))]);
    steps.push({ name, ok: r.ok, detail: r.detail ?? null, ms: Date.now() - t0 });
  } catch (e) {
    steps.push({ name, ok: false, detail: `error: ${e instanceof Error ? e.message : String(e)}`, ms: Date.now() - t0 });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** rAF callbacks in one second, or what ran before 3 s passed (a page that never draws must not hang the step). */
const RAF_PER_SECOND = "new Promise(r => { let c = 0; const t0 = performance.now(); setTimeout(() => r(c), 3000); (function f(){ c++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(c); })(); })";
async function until<T>(f: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v !== undefined && v !== false) return v;
    await sleep(50);
  }
  return undefined;
}

function pngSize(b64: string): { w: number; h: number } {
  const b = Buffer.from(b64, "base64");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function evalIn(host: BrowserHost, id: string, expression: string): Promise<any> {
  const r = (await host.command(id, { kind: "cdp", method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })) as { result?: { value?: unknown } };
  return r.result?.value;
}

/** How many distinct colours a BGRA bitmap has, sampled (stops counting at 16). */
function distinctColours(bgra: Buffer): number {
  const seen = new Set<number>();
  for (let i = 0; i + 3 < bgra.length && seen.size < 16; i += 4 * 97) seen.add(bgra.readUInt32LE(i));
  return seen.size;
}

function visibleWindows(except: BaseWindow[]): number {
  return BrowserWindow.getAllWindows().filter((w) => w.isVisible() && !except.includes(w)).length;
}

async function main(): Promise<void> {
  // What lane E's guards would see: whether each webContents is the browser's, at the moment it is made.
  const created: { id: number; tab: boolean; contents: boolean }[] = [];
  app.on("web-contents-created", (_e, wc) => { created.push({ id: wc.id, tab: isBrowserTab(wc), contents: isBrowserContents(wc) }); });
  const server = createServer((req, res) => {
    const body = req.url?.startsWith("/popup") ? POPUP : PAGE;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  // The default session as lane E hardens the app's own (no spellchecker, nowhere to fetch a dictionary from), so the
  // net log below speaks for the browser's sessions alone.
  session.defaultSession.setSpellCheckerEnabled(false);
  try {
    session.defaultSession.setSpellCheckerLanguages([]);
    session.defaultSession.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
  } catch {
    // macOS: the system's spellchecker.
  }
  const appWindow = new BrowserWindow({ width: 1100, height: 760, show: true, webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false } });
  await appWindow.loadURL("data:text/html,<title>Clover</title><body style='margin:0;background:%23eee'></body>");
  const viewTarget = { window: appWindow, bounds: { x: 20, y: 40, width: 900, height: 600 } };
  let n = 0;
  const hostOpts = {
    computer: "ci",
    report: (events: AppTabEvent[]) => { reports.push(...events); },
    hold: (id: string) => { holds.push(id); },
    assets: { preload, html },
    newId: () => `tab_${++n}`,
    contextMenu: (_tab: TabView, params: Electron.ContextMenuParams, actions: { copy(): void }) => {
      menus.push({ selectionText: params.selectionText, canCopy: params.editFlags.canCopy });
      if (params.editFlags.canCopy) actions.copy();
    },
    // The fixture's pages are on loopback, which a bot's tab may not reach (R13): these hosts let bot "alpha" reach
    // its own machine, as the person's tabs may. The step below runs a host with the real policies.
    network: { policyFor: () => PERSON_POLICY, log: netLog },
  };
  const host = createBrowserHost({ ...hostOpts, screenReader: { override: false } });
  await host.start();
  host.setView("browser", viewTarget);
  const alpha = { kind: "bot" as const, bot: "alpha" };
  let tab!: TabView;
  let token = "";

  await step("a bot's tab opens offscreen, in its own partition, and puts no window on screen", async () => {
    tab = await host.open({ id: "tab_main", owner: alpha, url: `${origin}/page`, place: "headless" });
    token = (await until(() => evalIn(host, tab.id, "window.__t && window.__t.token"), 10_000)) ?? "";
    const size = await evalIn(host, tab.id, "innerWidth + 'x' + innerHeight");
    return { ok: token !== "" && tab.partition === "persist:bot-alpha" && size === "1280x800" && visibleWindows([appWindow]) === 0, detail: { partition: tab.partition, size, visible: visibleWindows([appWindow]) } };
  });

  await step("a hidden tab draws: its rAF runs and its picture is fresh, 1280×800", async () => {
    // Its first picture (a slow runner's first frames take seconds), then its rate once it runs.
    const t0 = Date.now();
    const first = await until(async () => {
      try {
        return (await host.command(tab.id, { kind: "screenshot", format: "png" })) as { data: string };
      } catch {
        return undefined;
      }
    }, 12_000);
    const firstPictureMs = Date.now() - t0;
    const raf = await evalIn(host, tab.id, RAF_PER_SECOND);
    const shot = (await host.command(tab.id, { kind: "screenshot", format: "png" })) as { data: string; width: number; height: number; contentAgeMs?: number };
    const px = pngSize(shot.data);
    // It runs at all; the rate (10 asked) is recorded, as a slow runner gives less (linux-arm64: 2).
    return { ok: first !== undefined && Number(raf) >= 2 && px.w === 1280 && px.h === 800 && (shot.contentAgeMs ?? 0) < 1000, detail: { firstPictureMs, rafPerSecond: raf, png: px, contentAgeMs: shot.contentAgeMs } };
  });

  await step("a JPEG picture comes from the newest frame", async () => {
    const shot = (await host.command(tab.id, { kind: "screenshot", format: "jpeg", quality: 70 })) as { data: string; width: number; height: number };
    return { ok: shot.width === 1280 && shot.height === 800 && shot.data.length > 100, detail: { width: shot.width, height: shot.height, bytes: shot.data.length } };
  });

  await step("DevTools: an allowed call works; a denied domain is refused in the app too", async () => {
    const two = await evalIn(host, tab.id, "1 + 1");
    let refused = "";
    try {
      await host.command(tab.id, { kind: "cdp", method: "Target.getTargets" });
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    return { ok: two === 2 && refused !== "", detail: { two, refused } };
  });

  await step("refused schemes never load: not by the API, not by the page", async () => {
    let apiRefused = false;
    try {
      await host.command(tab.id, { kind: "navigate", url: "file:///etc/hosts" });
    } catch {
      apiRefused = true;
    }
    await evalIn(host, tab.id, "location.href = 'file:///etc/hosts'; 1");
    await sleep(800);
    const url = await evalIn(host, tab.id, "location.href");
    return { ok: apiRefused && String(url).startsWith(origin), detail: { apiRefused, url } };
  });

  await step("shown in the view: laid out at the view's size, no reload, frames reach the viewport", async () => {
    const before = await evalIn(host, tab.id, "window.__t.ticks");
    await host.command(tab.id, { kind: "place", place: "shown", view: "browser", viewport: { width: 900, height: 600 } });
    const size = await until(async () => { const s = await evalIn(host, tab.id, "innerWidth + 'x' + innerHeight"); return s === "900x600" ? s : undefined; });
    const same = await evalIn(host, tab.id, "window.__t.token");
    // The page keeps running: its 50 ms timer ticks on.
    const after = await until(async () => { const t = await evalIn(host, tab.id, "window.__t.ticks"); return Number(t) > Number(before) ? t : undefined; }, 3000);
    return { ok: size === "900x600" && same === token && after !== undefined && visibleWindows([appWindow]) === 0, detail: { size, sameDocument: same === token, ticks: [before, after] } };
  });

  // The viewport's own page: the test sends the person's input to it, as the OS would.
  // Found once its page has committed (its URL is empty until then).
  const findViewport = (): Electron.WebContentsView | undefined =>
    appWindow.contentView.children.find((v) => (v as Electron.WebContentsView).webContents?.getURL().includes("browser-viewport")) as Electron.WebContentsView | undefined;
  let viewport: Electron.WebContentsView | undefined;
  const vin = (ev: Electron.MouseInputEvent | Electron.KeyboardInputEvent): void => viewport?.webContents.sendInputEvent(ev);
  const mod = process.platform === "darwin" ? "meta" : "control";

  await step("the viewport is in the app's window, at the frame, and draws the tab", async () => {
    viewport = await until(async () => {
      const v = findViewport();
      return v !== undefined && !v.webContents.isLoading() ? v : undefined;
    }, 10_000);
    if (viewport === undefined) return { ok: false, detail: { children: appWindow.contentView.children.map((v) => (v as Electron.WebContentsView).webContents?.getURL() ?? "?") } };
    const vp = viewport;
    // The person's keys reach the focused window's focused view, as the OS would send them (S7 §7.3 did the same).
    if (process.platform === "darwin") app.focus({ steal: true });
    appWindow.focus();
    vp.webContents.focus();
    // The tab's frames on its canvas: the viewport's own picture shows the page (text and a field), not one colour.
    const colours = await until(async () => {
      const img = await vp.webContents.capturePage();
      const n = distinctColours(img.toBitmap());
      return n > 2 ? n : undefined;
    }, 5000);
    const b = vp.getBounds();
    return { ok: colours !== undefined && b.x === viewTarget.bounds.x && b.y === viewTarget.bounds.y && b.width === viewTarget.bounds.width && b.height === viewTarget.bounds.height, detail: { bounds: b, colours } };
  });

  if (wantScale !== undefined) {
    await step(`at a display scale of ${wantScale}: the viewport draws at its frame's size and its page runs at that scale`, async () => {
      const vp = viewport;
      if (vp === undefined) return { ok: false, detail: "no viewport" };
      const display = screen.getPrimaryDisplay().scaleFactor;
      const img = await vp.webContents.capturePage();
      const pixels = img.toBitmap().length / 4;
      const b = vp.getBounds();
      const expected = b.width * b.height * wantScale * wantScale;
      const dpr = await vp.webContents.executeJavaScript("devicePixelRatio");
      const inner = await vp.webContents.executeJavaScript("innerWidth + 'x' + innerHeight");
      // The tab itself, shown at the frame: laid out in the frame's CSS pixels, whatever the scale.
      const tabInner = await evalIn(host, tab.id, "innerWidth + 'x' + innerHeight");
      const tabDpr = await evalIn(host, tab.id, "devicePixelRatio");
      return {
        ok: display === wantScale && dpr === wantScale && Math.abs(pixels - expected) / expected < 0.02 && inner === "900x600" && tabInner === "900x600",
        detail: { displayScale: display, viewportDpr: dpr, tabDpr, viewportInner: inner, tabInner, pictureSize: img.getSize(), pixels, expectedPixels: expected },
      };
    });
  }

  if (wantWayland) {
    await step("the run is on Wayland, with no X server: nothing of the app's is a visible window but its own", async () => {
      const sessionType = process.env.XDG_SESSION_TYPE;
      const display = process.env.DISPLAY ?? "";
      return { ok: sessionType === "wayland" && display === "" && (process.env.WAYLAND_DISPLAY ?? "") !== "", detail: { XDG_SESSION_TYPE: sessionType, DISPLAY: display, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, ozone: app.commandLine.getSwitchValue("ozone-platform"), visible: visibleWindows([appWindow]) } };
    });
  }

  await step("drag-selecting the page's text through the viewport selects it, and the person holds the tab", async () => {
    const r = (await evalIn(host, tab.id, "(() => { const b = document.getElementById('p').getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; })()")) as number[];
    const y = Math.round((r[1]! + r[3]!) / 2);
    const x0 = Math.round(r[0]! + 1), x1 = Math.round(r[2]! - 2);
    vin({ type: "mouseMove", x: x0, y });
    vin({ type: "mouseDown", x: x0, y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 10; i++) { vin({ type: "mouseMove", x: Math.round(x0 + ((x1 - x0) * i) / 10), y, modifiers: ["leftbuttondown"] }); await sleep(30); }
    vin({ type: "mouseUp", x: x1, y, button: "left", clickCount: 1 });
    const sel = await until(async () => { const s = await evalIn(host, tab.id, "String(getSelection())"); return String(s).includes("copy this") ? s : undefined; });
    return { ok: sel !== undefined && holds.includes(tab.id), detail: { selection: sel, holds } };
  });

  await step("copying with the copy key puts the selection on the clipboard", async () => {
    await clipboard.writeText("before");
    vin({ type: "keyDown", keyCode: "c", modifiers: [mod] });
    vin({ type: "keyUp", keyCode: "c", modifiers: [mod] });
    const got = await until(async () => { const c = await clipboard.readText(); return c !== "before" ? c : undefined; });
    return { ok: got === "select and copy this sentence", detail: { clipboard: got } };
  });

  await step("a right click brings the tab's menu, and its Copy copies", async () => {
    await clipboard.writeText("before");
    const r = (await evalIn(host, tab.id, "(() => { const b = document.getElementById('p').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()")) as number[];
    const x = Math.round(r[0]!), y = Math.round(r[1]!);
    vin({ type: "mouseDown", x, y, button: "right", clickCount: 1 });
    vin({ type: "mouseUp", x, y, button: "right", clickCount: 1 });
    const got = await until(async () => { const c = await clipboard.readText(); return c !== "before" ? c : undefined; });
    return { ok: menus.length > 0 && got === "select and copy this sentence", detail: { menus, clipboard: got } };
  });

  await step("typing through the viewport reaches the page's field", async () => {
    await evalIn(host, tab.id, "document.getElementById('field').focus(); 1");
    for (const ch of "hi") { vin({ type: "keyDown", keyCode: ch }); vin({ type: "char", keyCode: ch }); vin({ type: "keyUp", keyCode: ch }); }
    const v = await until(async () => { const s = await evalIn(host, tab.id, "document.getElementById('field').value"); return s === "hi" ? s : undefined; });
    return { ok: v === "hi", detail: { value: v } };
  });

  await step("the browser's webContents are its own from their making on, with its WebRTC policy, the network filter as their proxy and no spellchecker; the app's window's aren't", async () => {
    const tabWc = webContents.getAllWebContents().find((w) => isBrowserTab(w) && w.getURL().startsWith(`${origin}/page`));
    const ses = tabWc?.session;
    const proxy = ses !== undefined ? await ses.resolveProxy("https://example.com/") : undefined;
    const own = created.find((c) => c.id === appWindow.webContents.id);
    const others = created.filter((c) => c.id !== appWindow.webContents.id);
    const vp = viewport;
    const ok = tabWc !== undefined && own !== undefined && !own.contents && others.length >= 2 && others.every((c) => c.contents)
      && tabWc.getWebRTCIPHandlingPolicy() === BROWSER_WEBRTC_POLICY && /^SOCKS5 127\.0\.0\.1:\d+$/.test(proxy ?? "") && ses?.isSpellCheckerEnabled() === false
      && vp !== undefined && isBrowserContents(vp.webContents) && !isBrowserTab(vp.webContents) && vp.webContents.session.isSpellCheckerEnabled() === false;
    return { ok, detail: { created, webrtc: tabWc?.getWebRTCIPHandlingPolicy(), proxy, spellchecker: ses?.isSpellCheckerEnabled() } };
  });

  await step("hidden again: back to 1280×800, the same document", async () => {
    await host.command(tab.id, { kind: "place", place: "headless", viewport: { width: 1280, height: 800 } });
    const size = await until(async () => { const s = await evalIn(host, tab.id, "innerWidth + 'x' + innerHeight"); return s === "1280x800" ? s : undefined; });
    const same = await evalIn(host, tab.id, "window.__t.token");
    return { ok: size === "1280x800" && same === token, detail: { size, sameDocument: same === token } };
  });

  await step("resting: no frames, but a picture still comes (the compositor's copy)", async () => {
    await host.command(tab.id, { kind: "place", place: "resting", viewport: { width: 1280, height: 800 } });
    const shot = (await host.command(tab.id, { kind: "screenshot", format: "png" })) as { data: string };
    await host.command(tab.id, { kind: "place", place: "headless", viewport: { width: 1280, height: 800 } });
    const px = pngSize(shot.data);
    return { ok: px.w === 1280 && px.h === 800, detail: { png: px } };
  });

  await step("a page's alert never puts up a window", async () => {
    const before = visibleWindows([appWindow]);
    await evalIn(host, tab.id, "alert('hello'); confirm('sure?'); 1");
    await sleep(800);
    const after = visibleWindows([appWindow]);
    return { ok: before === 0 && after === 0, detail: { before, after } };
  });

  await step("a cross-site window the page opens becomes an offscreen tab of the same bot, opener kept", async () => {
    const count = reports.length;
    await evalIn(host, tab.id, `window.open('http://localhost:${port}/popup', 'p1', 'width=480,height=360'); 1`);
    const popup = await until(() => reports.slice(count).find((e) => e.kind === "changed" && e.tab.id !== tab.id && e.tab.url.includes("localhost")), 10_000);
    const msgs = await until(async () => { const m = await evalIn(host, tab.id, "(window.__t.msgs || []).join(',')"); return String(m).includes("popup:hello") ? m : undefined; });
    const id = popup && popup.kind === "changed" ? popup.tab.id : undefined;
    const shot = id !== undefined ? ((await host.command(id, { kind: "screenshot", format: "png" }).catch(() => undefined)) as { data: string } | undefined) : undefined;
    return { ok: id !== undefined && popup?.kind === "changed" && popup.tab.owner.kind === "bot" && msgs !== undefined && shot !== undefined && visibleWindows([appWindow]) === 0, detail: { id, msgs, picture: shot !== undefined } };
  });

  await step("a same-site window while the bot is alone opens as a new tab, without its opener", async () => {
    const count = reports.length;
    await evalIn(host, tab.id, `window.open('${origin}/popup?same', 'p2'); 1`);
    const popup = await until(() => reports.slice(count).find((e) => e.kind === "changed" && e.tab.url.includes("/popup?same")), 10_000);
    return { ok: popup !== undefined && visibleWindows([appWindow]) === 0, detail: { popup: popup?.kind === "changed" ? popup.tab.url : undefined } };
  });

  await step("closing a tab reports it closed", async () => {
    await host.command(tab.id, { kind: "close" });
    const closed = await until(() => reports.find((e) => e.kind === "closed" && e.id === tab.id));
    return { ok: closed !== undefined && !host.list().some((t) => t.id === tab.id), detail: { closed } };
  });

  // The hybrid: with a screen reader on, a NEW tab starts as a real view in the hidden host window.
  const reader = createBrowserHost({ ...hostOpts, newId: () => `tab_r${++n}`, screenReader: { override: true } });
  await reader.start();
  await step("with a screen reader on, a new tab is a real view in the hidden host window, and draws", async () => {
    const t = await reader.open({ id: "tab_reader", owner: alpha, url: `${origin}/page`, place: "headless" });
    const tok = await until(() => evalIn(reader, t.id, "window.__t && window.__t.token"), 10_000);
    const visibility = await evalIn(reader, t.id, "document.visibilityState");
    const raf = await evalIn(reader, t.id, RAF_PER_SECOND);
    const shot = (await reader.command(t.id, { kind: "screenshot", format: "png" })) as { data: string };
    const hostWindows = BrowserWindow.getAllWindows().length; // BaseWindows aren't listed; the host isn't a BrowserWindow
    // Once the host has taken its pixel away again (Linux), the page goes on drawing.
    await sleep(3200);
    const rafLater = await evalIn(reader, t.id, RAF_PER_SECOND);
    return { ok: tok !== undefined && Number(raf) >= 5 && Number(rafLater) >= 5 && pngSize(shot.data).w > 0, detail: { visibility, rafPerSecond: raf, rafLater, png: pngSize(shot.data), browserWindows: hostWindows } };
  });

  await step("the screen reader's tab shows in the view as a real view, with no reload", async () => {
    const before = await evalIn(reader, "tab_reader", "window.__t.token");
    reader.setView("browser", viewTarget);
    await reader.command("tab_reader", { kind: "place", place: "shown", view: "browser", viewport: { width: 900, height: 600 } });
    const size = await until(async () => { const s = await evalIn(reader, "tab_reader", "innerWidth + 'x' + innerHeight"); return s === "900x600" ? s : undefined; });
    const after = await evalIn(reader, "tab_reader", "window.__t.token");
    await reader.command("tab_reader", { kind: "place", place: "headless", viewport: { width: 1280, height: 800 } });
    const back = await until(async () => { const s = await evalIn(reader, "tab_reader", "innerWidth + 'x' + innerHeight"); return s === "1280x800" ? s : undefined; });
    return { ok: size === "900x600" && back === "1280x800" && before === after, detail: { size, back, sameDocument: before === after } };
  });

  // R13 with the real policies, under `--no-proxy-server` as the app runs (lane E): every tab's fixed proxy, the
  // network filter, still wins.
  const strict = createBrowserHost({ ...hostOpts, newId: () => `tab_s${++n}`, screenReader: { override: false }, network: { log: netLog } });
  await strict.start();
  await step("R13: a bot's tab reaches no loopback address, by number or by name; a coding session's does; neither reaches the metadata address (its proxy wins over --no-proxy-server)", async () => {
    // A refused load ends at once in an error page, so 4 s is plenty to see it stay refused. A load that should work
    // gets 20 s: the coding session's tab is the first in a new persistent partition, and on a busy Windows runner
    // that partition's first connection can take longer than 4 s (merge-group run 42377725559: no error, just late).
    const loaded = async (h: BrowserHost, id: string, ms = 4000) => (await until(() => evalIn(h, id, "window.__t ? 'page' : undefined"), ms)) === "page";
    const bot = await strict.open({ id: "tab_s_bot", owner: { kind: "bot", bot: "beta" }, url: `${origin}/page`, place: "headless" });
    const botByNumber = await loaded(strict, bot.id);
    await strict.command(bot.id, { kind: "navigate", url: `http://localhost:${port}/page` }).catch(() => undefined);
    const botByName = await loaded(strict, bot.id);
    const code = await strict.open({ id: "tab_s_code", owner: { kind: "session", session: "sess_fixture" }, url: `http://localhost:${port}/page`, place: "headless" });
    const codeLoopback = await loaded(strict, code.id, 20_000);
    const t0 = Date.now();
    await strict.command(code.id, { kind: "navigate", url: "http://169.254.169.254/latest/meta-data/" }).catch(() => undefined);
    const metadataUrl = await until(async () => { const u = String(await evalIn(strict, code.id, "location.href")); return u.includes("169.254.169.254") || u.startsWith("chrome-error") ? u : undefined; }, 4000);
    const metadataPage = await evalIn(strict, code.id, "document.body ? document.body.innerText.slice(0, 80) : ''");
    const refusedFast = Date.now() - t0 < 4000;
    const ok = !botByNumber && !botByName && codeLoopback && !String(metadataPage).includes("select and copy") && refusedFast;
    return { ok, detail: { botByNumber, botByName, codeLoopback, metadataUrl, metadataPage, refusedFast } };
  });

  // R14: the proxy setting, chained behind the filter, under `--no-proxy-server`. A local HTTP proxy plays the
  // person's proxy; "proxied.test" resolves (in the filter) to a public address, which only the proxy can reach (it
  // joins it to the fixture's server), and "nas.test" to a LAN address. No connection leaves this machine: a direct
  // dial to either address goes to a closed loopback port.
  const PUBLIC = "93.184.216.34";
  const LAN = "192.168.77.7";
  const asked: string[] = [];
  const proxyServer = createNetServer((client) => {
    client.on("error", () => undefined);
    let head = "";
    client.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.removeListener("data", onData);
      const target = /^CONNECT (\S+) HTTP/.exec(head)?.[1] ?? "";
      asked.push(target);
      const ip = target.slice(0, target.lastIndexOf(":"));
      if (ip !== PUBLIC && ip !== LAN) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const up = netConnect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = head.slice(end + 4);
        if (rest.length > 0) up.write(Buffer.from(rest, "latin1"));
        up.pipe(client);
        client.pipe(up);
      });
      up.on("error", () => client.destroy());
    });
  });
  await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (proxyServer.address() as AddressInfo).port;
  const direct: string[] = [];
  const proxied = createBrowserHost({
    ...hostOpts, newId: () => `tab_p${++n}`, screenReader: { override: false },
    network: {
      log: netLog,
      lookup: async (h: string) => (h === "proxied.test" ? [PUBLIC] : h === "nas.test" ? [LAN] : h === "localhost" ? ["127.0.0.1"] : []),
      dial: (p: number, ip: string) => {
        if (ip === PUBLIC) {
          direct.push(`${ip}:${p}`);
          return netConnect(1, "127.0.0.1");
        }
        if (ip === LAN) {
          // The LAN is reached directly, never through the proxy (owner's ruling on the #260 review): the "LAN" here is
          // the fixture's own server.
          direct.push(`${ip}:${p}`);
          return netConnect(port, "127.0.0.1");
        }
        return netConnect({ port: p, host: ip });
      },
    },
  });
  await proxied.start();
  // As above: 20 s for a load that should work, 4 s to see a refused one stay refused.
  const loadedP = async (id: string, ms = 4000) => (await until(() => evalIn(proxied, id, "window.__t ? 'page' : undefined"), ms)) === "page";
  const go = async (id: string, url: string, ms = 4000) => { await proxied.command(id, { kind: "navigate", url }).catch(() => undefined); return loadedP(id, ms); };
  let gamma: TabView | undefined;

  await step("R14: with an explicit proxy, a bot's tab loads a public name through it, the proxy asked for the checked address and never the name (under --no-proxy-server); the LAN and loopback stay refused", async () => {
    await proxied.configure({ proxy: { mode: "explicit", url: `http://127.0.0.1:${proxyPort}` }, lanBots: [] });
    gamma = await proxied.open({ id: "tab_p_gamma", owner: { kind: "bot", bot: "gamma" }, url: `http://proxied.test:${port}/page`, place: "headless" });
    const viaProxy = await loadedP(gamma.id, 20_000);
    const askedPublic = asked.includes(`${PUBLIC}:${port}`);
    const askedName = asked.some((a) => a.startsWith("proxied.test"));
    const lan = await go(gamma.id, `http://nas.test:${port}/page`);
    const loop = await go(gamma.id, `http://localhost:${port}/page`);
    const ok = viaProxy && askedPublic && !askedName && !lan && !loop && !asked.some((a) => a.startsWith(LAN)) && direct.length === 0;
    return { ok, detail: { viaProxy, asked: [...asked], lan, loop, direct: [...direct] } };
  });

  await step("the bot's LAN setting: its tabs reach the LAN directly (never through the proxy), still never loopback or the metadata address", async () => {
    if (gamma === undefined) return { ok: false, detail: "no tab" };
    await proxied.configure({ proxy: { mode: "explicit", url: `http://127.0.0.1:${proxyPort}` }, lanBots: ["gamma"] });
    const lan = await go(gamma.id, `http://nas.test:${port}/page`, 20_000);
    const askedLan = asked.includes(`${LAN}:${port}`);
    const loop = await go(gamma.id, `http://localhost:${port}/page`);
    const meta = await go(gamma.id, "http://169.254.169.254/latest/meta-data/");
    const ok = lan && !askedLan && direct.includes(`${LAN}:${port}`) && !direct.some((d) => d.startsWith(PUBLIC)) && !loop && !meta;
    return { ok, detail: { lan, askedLan, loop, meta, asked: [...asked], direct: [...direct] } };
  });

  await step("the proxy setting off: the next connection goes direct (the public address is never reached here), and the proxy is asked nothing more", async () => {
    if (gamma === undefined) return { ok: false, detail: "no tab" };
    await proxied.configure({ proxy: { mode: "off" }, lanBots: [] });
    const before = asked.length;
    const loaded = await go(gamma.id, `http://proxied.test:${port}/page?off`);
    const ok = !loaded && asked.length === before && direct.some((d) => d.startsWith(PUBLIC));
    return { ok, detail: { loaded, asked: [...asked], direct: [...direct] } };
  });

  await step("the filter takes connections only from the app's own network process: one from another process (this main process) is closed unanswered, and its ports are listed for lane C", async () => {
    const ports = proxied.filterPorts;
    const answered = await Promise.all(ports.slice(0, 3).map((p) => new Promise<string>((resolve) => {
      const s = netConnect(p, "127.0.0.1", () => s.write(Buffer.from([5, 1, 0])));
      const t = setTimeout(() => { s.destroy(); resolve("no answer"); }, 4000);
      s.on("data", (d: Buffer) => { clearTimeout(t); s.destroy(); resolve(`answered ${[...d].join(",")}`); });
      s.on("close", () => { clearTimeout(t); resolve("closed"); });
      s.on("error", () => { clearTimeout(t); resolve("closed"); });
    })));
    return { ok: ports.length >= 3 && answered.every((a) => a === "closed"), detail: { ports, answered } };
  });

  proxied.shutdown();
  proxyServer.close();
  strict.shutdown();
  reader.shutdown();
  host.shutdown();
  server.close();
  writeFileSync(out, JSON.stringify({ platform: process.platform, electron: process.versions.electron, steps, reports: reports.length, holds, netLogs }, null, 2));
}

app.on("window-all-closed", () => undefined);
void app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    writeFileSync(out, JSON.stringify({ fatal: e instanceof Error ? `${e.message}\n${e.stack}` : String(e), steps }));
  }
  // A clean quit, so the net log (`--log-net-log`) is written out whole; exit anyway if it hangs.
  setTimeout(() => app.exit(0), 5000).unref();
  app.quit();
});
