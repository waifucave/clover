// The Electron side of the browser's live gate (`browser-live-gate.ts`): a window you can see, the browser module
// driven the way the daemon will drive it, and a line protocol on stdin/stdout so the script can show and hide the
// bot's tab, open a tab while a screen reader is on, set the proxy and read what the page saw. It is built and started
// by the script, and only ever by the owner (it opens a window).
//
// stdin: one JSON command per line, `{ "id": 1, "cmd": "open" }`. stdout: one JSON answer per line, `{ "id": 1, "ok": true,
// "result": … }` or `{ "id": 1, "ok": false, "error": "…" }`, and `{ "log": "…" }` lines for the browser's own notes.
import { app, BrowserWindow, screen } from "electron";
import { createInterface } from "node:readline";
import { createBrowserHost, PERSON_POLICY, type BrowserHost, type BrowserProxySetting, type TabView } from "../src/main/browser/index";

const site = process.env.CLOVER_LIVE_SITE ?? "";
const preload = process.env.CLOVER_LIVE_PRELOAD ?? "";
const html = process.env.CLOVER_LIVE_HTML ?? "";

const say = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o)}\n`); };
const alpha = { kind: "bot" as const, bot: "alpha" };

async function main(): Promise<void> {
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, title: "Clover browser live gate", webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL("data:text/html;charset=utf-8,<title>Clover browser live gate</title><body style='margin:0;background:%23eee;font:14px system-ui'><div style='position:absolute;left:20px;top:10px'>The bot's tab shows below when the script says so.</div></body>");
  const viewTarget = { window: win, bounds: { x: 20, y: 40, width: 900, height: 600 } };
  let n = 0;
  const host: BrowserHost = createBrowserHost({
    computer: "live",
    report: () => undefined,
    assets: { preload, html },
    newId: () => `live_${++n}`,
    // The fixture site is on loopback; this is the person's own policy (as their own tabs have), not a bot's.
    network: { policyFor: () => PERSON_POLICY, log: (l: string) => say({ log: l }) },
  });
  await host.start();
  host.setView("browser", viewTarget);
  let tab: TabView | undefined;

  const evaluate = async (id: string, expression: string): Promise<unknown> => {
    const r = (await host.command(id, { kind: "cdp", method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })) as { result?: { value?: unknown } };
    return r.result?.value;
  };
  const need = (): TabView => {
    if (tab === undefined) throw new Error("no tab yet: open first");
    return tab;
  };

  const commands: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
    async open() {
      tab = await host.open({ id: "tab_live", owner: alpha, url: `${site}/page`, place: "headless" });
      return { tab, screenReaderOn: host.screenReaderOn };
    },
    async place(a) {
      const t = need();
      const place = a.place === "shown" ? "shown" : "headless";
      await host.command(t.id, place === "shown" ? { kind: "place", place, view: "browser", viewport: { width: 900, height: 600 } } : { kind: "place", place, viewport: { width: 1280, height: 800 } });
      return { place };
    },
    // A tab for the bot while the screen reader is on (or not): where it starts is the host's choice.
    async readerTab() {
      const t = await host.open({ id: `tab_reader_${++n}`, owner: alpha, url: `${site}/page`, place: "headless" });
      tab = t;
      return { tab: t, screenReaderOn: host.screenReaderOn };
    },
    async probe() {
      const t = need();
      return evaluate(t.id, "({ token: window.__t && window.__t.token, ticks: window.__t && window.__t.ticks, loads: window.__t && window.__t.loads, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, hz: window.__t && window.__t.hz })");
    },
    async display() {
      const d = screen.getPrimaryDisplay();
      return { scaleFactor: d.scaleFactor, size: d.size, displayFrequency: d.displayFrequency, screenReaderOn: host.screenReaderOn, ozone: app.commandLine.getSwitchValue("ozone-platform") || null };
    },
    async proxy(a) {
      await host.configure({ proxy: a.setting as BrowserProxySetting, lanBots: [] });
      return { ok: true };
    },
    async load(a) {
      const t = need();
      await host.command(t.id, { kind: "navigate", url: String(a.url) });
      await new Promise((r) => setTimeout(r, Number(a.waitMs ?? 8000)));
      return evaluate(t.id, "({ href: location.href, title: document.title })");
    },
    async quit() {
      setTimeout(() => { host.shutdown(); app.quit(); }, 100);
      return { ok: true };
    },
  };

  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg: { id?: number; cmd?: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const run = commands[msg.cmd ?? ""];
    if (run === undefined) { say({ id: msg.id, ok: false, error: `unknown command ${String(msg.cmd)}` }); return; }
    run(msg).then(
      (result) => say({ id: msg.id, ok: true, result }),
      (e: unknown) => say({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  });
  say({ ready: true, electron: process.versions.electron, platform: process.platform });
}

app.on("window-all-closed", () => app.quit());
void app.whenReady().then(main).catch((e: unknown) => { say({ fatal: String(e) }); app.exit(1); });
