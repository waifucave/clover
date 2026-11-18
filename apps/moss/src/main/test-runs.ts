// The test build's two runs (scripts/build.ts --test-build only; index.ts calls them behind the compile-time
// `__MOSS_TEST_BUILD__`, so a real build carries neither): the UI test's smoke (draw the window offscreen against the
// test's engine, write what it drew, quit) and the renders for the owner (scene by scene, light and dark, two sizes,
// PNGs). Both are headless: the window is offscreen and never shown, nothing takes the focus, nothing sounds.
import { app, nativeTheme, type BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConnection } from "./connection";
import type { MossEngine } from "./engine";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await what()) return true;
    await sleep(100);
  }
  return false;
}

/** What the page drew, read from its own DOM (names and counts only). */
const PROBE = `(() => {
  const q = (s) => document.querySelectorAll(s);
  return {
    origin: location.origin,
    node: typeof require !== "undefined" || typeof process !== "undefined",
    bridge: typeof window.moss,
    columns: [...q("[data-col]")].map((e) => e.getAttribute("data-col")),
    rows: q("[data-bot-row]").length,
    faces: q("canvas[data-face]").length,
    moods: [...q("[data-mood-words]")].map((e) => e.textContent),
    bubbles: q("[data-bubble]").length,
    attachments: q("[data-attachment]").length,
    cards: [...q("[data-card]")].map((e) => e.getAttribute("data-card-place")),
    cardFrames: q("iframe[data-card-frame]").length,
    composer: (q("[data-composer] textarea")[0] || {}).placeholder || null,
    panel: q("[data-col=panel] [data-routine]").length,
    picture: q("[data-picture] img").length,
    scripts: q("script").length,
  };
})()`;

export async function runSmoke(o: { win: BrowserWindow; engine: MossEngine; file: string; log: (l: string) => void; logLines: string[]; connection: EngineConnection }): Promise<void> {
  const { win, engine } = o;
  const drew = await until(async () => {
    const v = engine.view();
    if (v.connection.kind !== "connected" || v.bots.length === 0) return false;
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll("[data-bot-row]").length`).catch(() => 0) as number;
    return n > 0;
  }, 30_000);
  // Open a bot and its side panel, as a person would: the three columns.
  await win.webContents.executeJavaScript(`window.__mossTest && window.__mossTest.go({ bot: ${JSON.stringify(process.env.MOSS_TEST_BOT ?? "")}, panel: true })`).catch(() => undefined);
  await until(async () => (await win.webContents.executeJavaScript(`document.querySelectorAll("[data-bubble]").length`).catch(() => 0) as number) > 0, 10_000);
  // The router's placements come after the presence report: wait until every card placed in this window is drawn with its
  // frame (a slow runner draws them a beat after the conversation).
  // Every card MOSS knows is placed (one placed early must not end the wait while another's placement is on its way), and
  // the window draws as many as are placed here, the same for two looks in a row.
  // The test may say how many cards its fixture places here (MOSS_TEST_CARDS): the wait holds for that many.
  const want = Number.parseInt(process.env.MOSS_TEST_CARDS ?? "1", 10) || 1;
  let last = -1;
  await until(async () => {
    const placed = engine.view().cards.length;
    if (placed < want) return false;
    const drawn = await win.webContents.executeJavaScript(`document.querySelectorAll("iframe[data-card-frame]").length`).catch(() => -1) as number;
    const settled = placed > 0 && drawn === placed && engine.unplacedCards() === 0 && placed === last;
    last = drawn === placed && engine.unplacedCards() === 0 ? placed : -1;
    return settled;
  }, 15_000);
  await sleep(800);
  const facts = await win.webContents.executeJavaScript(PROBE).catch((err: unknown) => ({ error: String(err) })) as Record<string, unknown>;
  const state = o.connection.state;
  const out = {
    ok: drew, ...facts,
    hello: state.kind === "connected" ? { surface: state.hello.surface ?? null, mountPoints: state.hello.mount?.points ?? null, release: state.hello.release ?? null } : { state: state.kind },
    view: engine.view(),
    placements: engine.placementsNow(),
    visibleWindows: win.isVisible() ? 1 : 0,
    name: app.getName(),
    log: o.logLines.slice(-80),
  };
  writeFileSync(o.file, JSON.stringify(out, null, 2));
  app.exit(0);
}

export interface Scene {
  name: string;
  go: Record<string, unknown>;
  /** Page script run once the scene has loaded (a press on Edit, a folder opened), then a beat for it to draw. */
  run?: string;
  /** A refusal line under this card, as main sends one when a press is refused. */
  said?: { card: string; words: string };
}

/** The scenes for the owner's renders (the brief's list). */
export const SCENES: readonly Scene[] = [
  // The conversation with its file and its own card whole (the strip has a scene of its own).
  { name: "conversation", go: { bot: "juniper", panel: false, strip: false } },
  { name: "strip", go: { bot: "kite", panel: false } },
  // Lane MA2's pages (the side panel, Plugins, Settings), written as `ma2-<scene>-<theme>-<size>.png`.
  { name: "ma2-panel", go: { bot: "juniper", panel: true } },
  { name: "ma2-plugins", go: { page: "plugins", strip: false } },
  { name: "ma2-settings-account", go: { page: "settings", strip: false } },
  { name: "ma2-settings-bot", go: { page: "settings", bot: "juniper", strip: false } },
  // What was built since: a long conversation scrolled up, a routine being edited, a bot's memory, the + flow, a refusal.
  // A running turn's one line: thinking, the browser, a file's name, a site's host.
  { name: "status-thinking", go: { bot: "maple", panel: false, strip: false } },
  { name: "status-file", go: { bot: "brook", panel: false, strip: false } },
  { name: "status-web", go: { bot: "ada", panel: false, strip: false } },
  { name: "long-scrolled", go: { bot: "maple", panel: false, strip: false }, run: `(() => { const m = document.querySelector(".messages"); m.scrollTop = Math.round(m.scrollHeight * 0.4); })()` },
  { name: "routine-edit", go: { bot: "juniper", panel: true, strip: false }, run: `document.querySelector("[data-routine-edit]").click()` },
  { name: "memory", go: { page: "settings", bot: "juniper", strip: false }, run: `(() => { document.querySelector("[data-memory-file] button").click(); setTimeout(() => document.querySelector("[data-settings=memory]").scrollIntoView({ block: "start" }), 300); })()` },
  { name: "new-bot", go: { bot: "juniper", panel: false, strip: false }, run: `(() => { document.querySelector('button[aria-label="New bot"]').click(); setTimeout(() => { const i = document.querySelector(".new-bot input"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "Sparrow"); i.dispatchEvent(new Event("input", { bubbles: true })); }, 300); })()` },
  { name: "card-refused", go: { bot: "juniper", panel: false, strip: false }, said: { card: "card_juniper_book", words: "Another window is covering the button: bring MOSS to the front, then press again." } },
];

/** The file a scene's picture goes to. */
export function sceneFile(scene: string, theme: string, size: string): string {
  return `${scene.startsWith("ma2-") ? "" : "moss-"}${scene}-${theme}-${size}.png`;
}

export const SIZES = [{ name: "usual", width: 1280, height: 820 }, { name: "narrow", width: 760, height: 820 }] as const;
/** The widths the layout measure covers: usual and narrow, just above the narrow breakpoint, and the window's minimum. */
const MEASURE_SIZES = [...SIZES, { name: "w1000", width: 1000, height: 820 }, { name: "w901", width: 901, height: 820 }, { name: "w640", width: 640, height: 480 }] as const;

/** Page script: adds classic scroll bars to this document, then lists what scrolls sideways (the page's own width too). */
const MEASURE = `(() => {
  if (!document.getElementById("__classic")) {
    const st = document.createElement("style");
    st.id = "__classic";
    st.textContent = "::-webkit-scrollbar { width: 15px; height: 15px; background: #888 } ::-webkit-scrollbar-thumb { background: #444 }";
    document.head.append(st);
  }
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\\s+/).join(".") : "");
  const over = [];
  for (const e of document.querySelectorAll("*")) {
    const cs = getComputedStyle(e);
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && e.scrollWidth > e.clientWidth && e.clientWidth > 0) {
      // The widest things inside it, so a failure names what is too wide.
      const box = e.getBoundingClientRect();
      const wide = [...e.querySelectorAll("*")].filter((c) => c.getBoundingClientRect().right > box.right + 1).slice(0, 4).map((c) => name(c) + " " + Math.round(c.getBoundingClientRect().width) + "px");
      over.push({ el: name(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, wide });
    }
  }
  const r = document.documentElement;
  const b = document.body;
  return { over, page: { scrollWidth: Math.max(r.scrollWidth, b.scrollWidth), clientWidth: r.clientWidth }, innerWidth: window.innerWidth };
})()`;

export async function runRender(o: { win: BrowserWindow; engine: MossEngine; dir: string; log: (l: string) => void; logLines: string[] }): Promise<void> {
  const { win, engine } = o;
  mkdirSync(o.dir, { recursive: true });
  const ready = await until(async () => {
    const v = engine.view();
    if (v.connection.kind !== "connected" || v.bots.length === 0) return false;
    return (await win.webContents.executeJavaScript(`document.querySelectorAll("[data-bot-row]").length`).catch(() => 0) as number) > 0;
  }, 30_000);
  const written: string[] = [];
  const measured: Record<string, unknown>[] = [];
  // A scene that opened a form or said a refusal leaves the window as it was found for the next one.
  const reset = async (scene: Scene): Promise<void> => {
    if (scene.run === undefined && scene.said === undefined) return;
    win.webContents.reload();
    await sleep(500);
    await until(async () => (await win.webContents.executeJavaScript(`document.querySelectorAll("[data-bot-row]").length`).catch(() => 0) as number) > 0, 15_000);
  };
  if (ready) {
    win.webContents.setFrameRate(30);
    // Layout does not depend on the colours: the measure looks at the light theme only.
    for (const theme of process.env.MOSS_RENDER_MEASURE === "1" ? ["light" as const] : ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      for (const size of process.env.MOSS_RENDER_MEASURE === "1" ? MEASURE_SIZES : SIZES) {
        win.setContentSize(size.width, size.height);
        // MOSS_RENDER_SCENES: a prefix to draw only some scenes (`ma2-`).
        const only = process.env.MOSS_RENDER_SCENES;
        for (const scene of SCENES.filter((x) => only === undefined || only === "" || x.name.startsWith(only))) {
          await win.webContents.executeJavaScript(`window.__mossTest && window.__mossTest.go(${JSON.stringify({ ...scene.go, calm: true })})`).catch(() => undefined);
          // Let the conversation load, the sealed card frames draw and the faces settle.
          await sleep(process.env.MOSS_RENDER_MEASURE === "1" ? 1_000 : 1_600);
          if (scene.run !== undefined) { await win.webContents.executeJavaScript(scene.run).catch((err: unknown) => o.log(`render: ${scene.name} script failed: ${String(err)}`)); await sleep(process.env.MOSS_RENDER_MEASURE === "1" ? 500 : 900); }
          if (scene.said !== undefined) { win.webContents.send("moss:card-said", scene.said.card, scene.said.words); await sleep(500); }
          if (process.env.MOSS_RENDER_MEASURE === "1") {
            // Layout, not a picture: with classic (always shown, space-taking) scroll bars styled onto this page only (never a
            // system setting), every scroll container that scrolls sideways, and the page itself, is reported.
            const m = await win.webContents.executeJavaScript(MEASURE).catch((err: unknown) => ({ error: String(err) })) as Record<string, unknown>;
            measured.push({ scene: scene.name, theme, size: size.name, ...m });
            await reset(scene);
            continue;
          }
          const image = await win.webContents.capturePage();
          const file = join(o.dir, sceneFile(scene.name, theme, size.name));
          writeFileSync(file, image.toPNG());
          written.push(file);
          o.log(`render: ${file} (${image.getSize().width}x${image.getSize().height})`);
          await reset(scene);
        }
      }
    }
  }
  if (process.env.MOSS_RENDER_MEASURE === "1") writeFileSync(join(o.dir, "measure.json"), JSON.stringify(measured, null, 2));
  writeFileSync(join(o.dir, "render-run.json"), JSON.stringify({ ok: ready, written, log: o.logLines.slice(-120) }, null, 2));
  app.exit(ready ? 0 : 1);
}
