// The acceptance run's UI steps: what a person does in the window, driven over the Chrome DevTools protocol against the
// headless, offscreen app (cdp.ts): type in the composer and send, read the bot's reply in the conversation, pick a
// model, open Settings, change a setting and see it stay, and drag the window by its title area. Each step reads the
// real DOM of the real layer frames and the daemon's own state; none of them calls the core's methods for the app.
// The inputs are trusted input events (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), which the main process sees
// as the person's key presses and clicks: if one doesn't register with the send gate, it is this driver that is wrong,
// never the gate.
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginModule } from "../../packages/core/src/registry/build";
import type { Cdp } from "./cdp";
import type { CloverClient } from "./client";

export type UiStatus = "PASS" | "FAIL" | "BLOCKED";
export interface UiRow { name: string; status: UiStatus; detail: string }

export const UI_STEPS = [
  "the window drags by its title area",
  "a message typed in the composer is sent, and the bot's reply is shown",
  "the model picker lists models and a pick takes",
  "Settings opens with no part stopped",
  "a setting changed in Settings is still there when it is opened again",
  "the Dispatch pill sends: a message typed in the pill goes to its bot, and the bot's reply is shown",
  "a send that is refused says so by the composer, and the draft stays",
  "Alpha's tab is drawn by Alpha's own layout (its talk column)",
  "a pending tool card is drawn by the island (not empty, not one colour, no raw JSON), and idle surfaces stay quiet",
  "the island and the pill are clear outside their own shape (no backdrop box), in dark and light",
  "the composer's slash menu lists a plugin's command and runs it as you: its result shows by the composer, and the line never reaches the bot",
  "Theme chosen in Settings (Dark, Light, System) reaches every window: the main window's and a card page's computed scheme follow it, the island and the pill stay see-through",
  "the Plugins page installs a plugin from a folder (main's picker), its OK card pressed; its detail shows its tools; it is removed on its sealed card; the page's own calls without a click are refused",
  "a third-party plugin with UI and a prebuilt client, installed from a folder (its TSX client, importing React and the UI SDK, built first with them left to the layer's import map; no react shipped), renders in its own layer once OK'd; turned off in the Plugins page it leaves the window, and its layer's own connection to the core closes",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

interface Ctx {
  cdp: Cdp; rpc: CloverClient; reply: string; /** What the fake model provider has been asked, in order. */ requests(): { model?: string; lastUserText: string }[]; /** The app's own log file, <home>/logs/app.log, as text. */ appLog(): string;
  /** What the Settings step set, as the daemon keeps it (the upgrade's first half records it). */
  onSetting?(key: string, value: unknown): void;
  /** Runs a turn that raises a tool card, calls `inspect` with the card while it is pending, then presses its Approve in the window. */
  cardTurn?(inspect: (card: { id: string; kind: string }) => Promise<void>): Promise<void>;
  /** Waits for a pending card `match` picks, and presses its Approve in the window (the real way); its id. */
  pressCard?(what: string, match: (card: { id: string; kind: string; change?: string; pluginId?: string }) => boolean): Promise<string>;
  /** The core's UI settings as the daemon keeps them (<home>/settings/ui.json; `ui.settings` is the app role's, and the packaged run's connection is the CLI's). */
  uiSettings(): { appearance?: string };
  /** Sets the window's dark or light (the renders; the app follows a file the run writes). */
  setAppearance?(scheme: "dark" | "light" | "system"): void;
  /** The folder the test build's picker gives (CLOVER_TEST_PICK) and the plugin it holds. */
  pickFolder?: { path: string; id: string; name: string; tool: string };
}

/** The distinct colours in a PNG (8-bit RGB or RGBA, not interlaced: what `Page.captureScreenshot` gives), counting colours
 *  that cover at least `minShare` of the pixels, so a smooth edge doesn't make a one-colour fill look drawn. */
/** A PNG's rows of 8-bit pixels (RGB or RGBA, not interlaced: what `Page.captureScreenshot` gives). */
export function readPng(png: Buffer): { width: number; height: number; bpp: number; rows: Buffer[] } {
  const { inflateSync } = require("node:zlib") as typeof import("node:zlib");
  let w = 0, h = 0, depth = 0, type = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    if (kind === "IHDR") { w = png.readUInt32BE(at + 8); h = png.readUInt32BE(at + 12); depth = png[at + 16]!; type = png[at + 17]!; }
    if (kind === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6)) throw new Error(`a PNG this reader doesn't read (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const add = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i] = (line[i]! + add) & 255;
    }
    rows.push(line);
    prev = line;
  }
  return { width: w, height: h, bpp, rows };
}

export function distinctColours(png: Buffer, minShare = 0.002): { colours: number; width: number; height: number } {
  const { width: w, height: h, bpp, rows } = readPng(png);
  const counts = new Map<number, number>();
  for (const line of rows) for (let x = 0; x < w; x++) {
    const o = x * bpp;
    const key = bpp === 4 ? (line[o + 3]! << 24 | line[o]! << 16 | line[o + 1]! << 8 | line[o + 2]!) : (line[o]! << 16 | line[o + 1]! << 8 | line[o + 2]!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const floor = Math.max(1, Math.floor(w * h * minShare));
  return { colours: [...counts.values()].filter((n) => n >= floor).length, width: w, height: h };
}

/** The clover layer's documents (the shell, the sidebar and every part of the bundled tree share one). */
export async function treeDocs(cdp: Cdp): Promise<{ session: string; url: string; text: string }[]> {
  return (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/"));
}

async function inTree<T>(cdp: Cdp, expr: string): Promise<{ session: string; value: T } | undefined> {
  for (const d of await treeDocs(cdp)) {
    try {
      const value = (await cdp.evaluate(d.session, expr)) as T;
      if (value !== null && value !== undefined && value !== false) return { session: d.session, value };
    } catch { /* a frame that is going */ }
  }
  return undefined;
}

/** The composer's own document: the one that holds `.cl-composer` with its text box (the Dispatch pill has a text box too, so
 *  "the first text box" can be the pill's, depending on the order the frames attached). On a miss, what each tree document
 *  holds is dumped so the failure names the frame and buttons it saw. */
const COMPOSER_BOX = ".cl-composer textarea";
export async function composerDoc(cdp: Cdp): Promise<{ session: string; value: true } | undefined> {
  return inTree<boolean>(cdp, `!!document.querySelector('${COMPOSER_BOX}')`) as Promise<{ session: string; value: true } | undefined>;
}
/** The shell is drawing: its sidebar's title row is in a tree document (no bot or session needed, unlike the composer). */
export async function shellDoc(cdp: Cdp): Promise<{ session: string; value: boolean } | undefined> {
  return inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar__top')");
}
export async function dumpFrames(cdp: Cdp): Promise<string> {
  const out: string[] = [];
  for (const d of await treeDocs(cdp)) {
    const seen = await cdp.evaluate(d.session, "JSON.stringify({ composer: !!document.querySelector('.cl-composer'), boxes: document.querySelectorAll('textarea').length, buttons: [...document.querySelectorAll('button')].slice(0, 12).map((b) => b.getAttribute('aria-label') || (b.innerText || '').trim().slice(0, 20)) })").catch(() => "gone");
    out.push(`${d.url.slice(0, 60)} ${String(seen).slice(0, 300)}`);
  }
  return out.join(" || ");
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>, dump?: () => Promise<string>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) fail(`${what}: not within ${Math.round(ms / 1000)} s${dump === undefined ? "" : ` (frames: ${await dump().catch(() => "?")})`}`);
    await sleep(400);
  }
}

/** Text on screen of any tree document. */
export async function treeText(cdp: Cdp): Promise<string> {
  return (await Promise.all((await treeDocs(cdp)).map((d) => cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => "")))).join("\n");
}

const STOPPED = "This part stopped.";
const stoppedAnywhere = async (cdp: Cdp): Promise<boolean> => (await Promise.all((await cdp.documents()).map((d) => cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => "")))).some((t) => String(t).includes(STOPPED));

/** The window's ground under the sidebar's material, per scheme: `sidebar.solid` (the base theme's). Offscreen there is
 *  no desktop behind the window's vibrancy, so `sidebar.tint` (70% alpha) would composite over white and read as
 *  mid-grey; a render lays it over this opaque ground instead, as macOS shows it over the material. */
const RENDER_GROUND = { dark: { r: 0x20, g: 0x20, b: 0x20 }, light: { r: 0xf5, g: 0xf5, b: 0xf5 } } as const;

/** One picture of the app's window per scheme, at 1280x800, offscreen, into `dir`: `plugins-<name>-<scheme>.png`. */
export async function shootWindow(cdp: Cdp, dir: string, name: string, setAppearance?: (scheme: "dark" | "light" | "system") => void): Promise<string[]> {
  const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
  if (appRoot === undefined) return [];
  const out: string[] = [];
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, appRoot.session);
  for (const scheme of ["dark", "light"] as const) {
    setAppearance?.(scheme);
    for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
    // The ground under the app's root and the shell's own frame (the sidebar's material sits in it): a render-only
    // colour on their <html>, through the CSSOM (the default-background override doesn't reach under a headless capture's material).
    const shell = await shellDoc(cdp).catch(() => undefined);
    const g = RENDER_GROUND[scheme];
    for (const session of [appRoot.session, ...(shell !== undefined ? [shell.session] : [])]) {
      await cdp.evaluate(session, `(() => { document.documentElement.style.setProperty('background-color', 'rgb(${g.r}, ${g.g}, ${g.b})', 'important'); return true; })()`).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 1_500));
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, appRoot.session) as { data: string };
    writeFileSync(join(dir, `plugins-${name}-${scheme}.png`), Buffer.from(shot.data, "base64"));
    out.push(`plugins-${name}-${scheme}.png`);
  }
  return out;
}

/** Back to the window as it was: the system's scheme, its own size and ground. */
export async function unshootWindow(cdp: Cdp, setAppearance?: (scheme: "dark" | "light" | "system") => void): Promise<void> {
  const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
  setAppearance?.("system");
  if (appRoot !== undefined) {
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, appRoot.session).catch(() => undefined);
  }
  const shell = await shellDoc(cdp).catch(() => undefined);
  for (const session of [...(appRoot !== undefined ? [appRoot.session] : []), ...(shell !== undefined ? [shell.session] : [])]) {
    await cdp.evaluate(session, "(() => { document.documentElement.style.removeProperty('background-color'); return true; })()").catch(() => undefined);
  }
  for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [] }, d.session).catch(() => undefined);
}

/** The Plugins page as a new user sees it (the bundled plugins only), on the first app, once signed in and before
 *  anything is installed (before the sign-in the welcome dialog covers the window):
 *  the sidebar's Plugins entry, the Installed tab, a picture per scheme. A render, never a check: it can't fail a step. */
export async function renderNewUser(cdp: Cdp, dir: string, setAppearance?: (scheme: "dark" | "light" | "system") => void): Promise<string> {
  try {
    const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar')"));
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
    // The welcome guide (a core page over the window, opened on a start with no provider signed in) is left, as a
    // user signed in by now would: its "Skip for now" at the foot of its list, scrolled into view and clicked.
    const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
    if (appRoot !== undefined) {
      const skip = "[data-clover-welcome=skip]";
      await cdp.evaluate(appRoot.session, `(() => { document.querySelector('${skip}')?.scrollIntoView({ block: 'center' }); return true; })()`).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      const at = await cdp.centerOf(appRoot.session, skip).catch(() => undefined);
      if (at !== undefined) {
        await cdp.click(appRoot.session, at.x, at.y);
        await until("the welcome guide gone", 5_000, async () => ((await cdp.evaluate(appRoot.session, `!document.querySelector('${skip}')`).catch(() => false)) === true ? true : undefined)).catch(() => undefined);
      }
    }
    const click = async (selector: string, text: string) => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
        if (c !== undefined) { await cdp.click(d.session, c.x, c.y); return true; }
      }
      return false;
    };
    let open: unknown;
    for (let attempt = 0; attempt < 3 && open === undefined; attempt++) {
      await click(".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]", "Plugins");
      open = await until("the Plugins page's tabs", 8_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-plugin-index__tabs')")).catch(() => undefined);
    }
    if (open === undefined) return "the new user's render: the Plugins page didn't open";
    await click("[role=tab]", "Installed");
    await until("the installed list", 10_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-plugin-index__result')")).catch(() => undefined);
    const names = await inTree<string>(cdp, "[...document.querySelectorAll('.cl-plugin-index__result')].map((li) => li.querySelector('.cl-plugin-index__meta')?.textContent?.split(' · ')[0] ?? '?').join(', ')");
    const shot = await shootWindow(cdp, dir, "new-user", setAppearance);
    return `rendered ${shot.join(", ")} (installed: ${names?.value ?? "?"})`;
  } catch (err) {
    return `the new user's render failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await unshootWindow(cdp, setAppearance).catch(() => undefined);
  }
}

export async function uiSteps(ctx: Ctx, record: (index: number, status: UiStatus, detail: string) => void): Promise<void> {
  const { cdp, rpc } = ctx;
  const step = async (n: number, run: () => Promise<string>) => {
    try { record(n, "PASS", await run()); } catch (err) { record(n, err instanceof Failed ? "FAIL" : "FAIL", err instanceof Error ? err.message : String(err)); }
  };

  // The shell is up when the composer is.
  const shellUp = await until("the shell to draw its composer", 90_000, () => composerDoc(cdp), () => dumpFrames(cdp)).catch((e: Error) => e);
  if (shellUp instanceof Error) {
    for (let n = 0; n < UI_STEPS.length; n++) record(n, "BLOCKED", `the window never drew its composer (${shellUp.message})`);
    return;
  }

  // 0: drag. A real press in the sidebar's top row (a title area: its CSS says `-webkit-app-region: drag`), a move and a
  // release, as the frame sees them. The window is offscreen, so its place isn't read from the page: the app's own log
  // (<home>/logs/app.log) says where the window went, from the position the window itself reports.
  await step(0, async () => {
    const side = await until("the sidebar's title row", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar__top')"));
    const area = await cdp.evaluate(side.session, "getComputedStyle(document.querySelector('.cl-sidebar__top')).getPropertyValue('-webkit-app-region')");
    if (area !== "drag") fail(`the sidebar's title row declares no drag region (${String(area)})`);
    const moved = () => ctx.appLog().split("\n").filter((l) => l.includes("window: moved by its title area"));
    const was = moved().length;
    const at = { x: 160, y: 20 };
    const press = (type: string, x: number, y: number, buttons: number) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, side.session);
    await press("mouseMoved", at.x, at.y, 0);
    await press("mousePressed", at.x, at.y, 1);
    for (let i = 1; i <= 6; i++) { await press("mouseMoved", at.x + i * 20, at.y + i * 10, 1); await sleep(40); }
    await press("mouseReleased", at.x + 120, at.y + 60, 0);
    const line = await until("the app's log of the window's move", 8_000, async () => (moved().length > was ? moved()[moved().length - 1] : undefined)).catch(() => undefined);
    if (line === undefined) fail(`dragging the title row (${at.x},${at.y}) by (120, 60) moved the window nowhere: the app logged no move`);
    // The line is the window's own position before and after (win.getPosition), so this is its bounds, moved by the drag.
    const m = /from \((-?\d+), (-?\d+)\) to \((-?\d+), (-?\d+)\)/.exec(line!);
    if (m === null) fail(`the app's log of the move is unreadable: ${line}`);
    const dx = Number(m![3]) - Number(m![1]), dy = Number(m![4]) - Number(m![2]);
    if (Math.abs(dx - 120) > 4 || Math.abs(dy - 60) > 4) fail(`the window moved by (${dx}, ${dy}), not the (120, 60) the cursor moved`);
    return `a drag of (120, 60) on the title row moved the window by (${dx}, ${dy}): ${line!.replace(/^\S+ /, "")}`;
  });

  // 1: send. A tag of this turn's own: the fake provider's reply carries it, so a reply from an earlier turn (step 3's) can't
  // pass, and the reply bubbles on screen are counted before and after.
  await step(1, async () => {
    const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    const replies = async () => ((await treeText(cdp)).match(/ACCEPTANCE-REPLY-OK/g) ?? []).length;
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    const s = box.session;
    const before = await replies();
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: `${tag} say hello from the window` }, s);
    await sleep(300);
    const typed = await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}').value`);
    if (!String(typed).includes(tag)) fail(`the text box shows "${String(typed).slice(0, 60)}" after typing`);
    // The send button, pressed as a person would.
    const btn = await cdp.centerOf(s, "button.cl-composer__send");
    if (btn === undefined) fail(`the composer has no Send button (frames: ${await dumpFrames(cdp)})`);
    await cdp.click(s, btn!.x, btn!.y);
    await until("this turn's own reply on screen", 150_000, async () => ((await treeText(cdp)).includes(`${ctx.reply} ${tag}`) ? true : undefined), () => dumpFrames(cdp));
    const after = await replies();
    if (after !== before + 1) fail(`the reply bubbles went from ${before} to ${after}, not by one`);
    const left = await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}') ? document.querySelector('${COMPOSER_BOX}').value : ''`);
    if (String(left).length > 0) fail(`the draft is still in the text box after the send ("${String(left).slice(0, 40)}")`);
    return `the message ${tag} was sent from the composer and its own reply is on screen (reply bubbles ${before} -> ${after})`;
  });

  // 2: the model picker.
  await step(2, async () => {
    const pill = await until("the model pill", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, ".cl-composer button[aria-label^=\"Model:\"]").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    }, () => dumpFrames(cdp));
    const before = await rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {});
    const was = before.bots[0]?.model;
    await cdp.click(pill.session, pill.c.x, pill.c.y);
    const items = await until("the picker's models", 15_000, async () => {
      const r = await cdp.evaluate(pill.session, "JSON.stringify([...document.querySelectorAll('[role=menuitemradio]')].map((e) => ({ t: (e.innerText || '').trim(), c: e.getAttribute('aria-checked') })))");
      const list = JSON.parse(String(r)) as { t: string; c: string }[];
      return list.length > 0 ? list : undefined;
    }, async () => `pill: ${String(await cdp.evaluate(pill.session, "(() => { const b = document.querySelector('.cl-composer button[aria-label^=Model]'); return b ? 'expanded=' + b.getAttribute('aria-expanded') + ' menus=' + document.querySelectorAll('[role=menu]').length + ' radios=' + document.querySelectorAll('[role=menuitemradio]').length + ' items=' + document.querySelectorAll('[role=menuitem]').length + ' text=' + [...document.querySelectorAll('[role=menu]')].map((e) => e.innerText.slice(0, 80)).join('|') : 'gone'; })()").catch(() => "gone"))}`);
    if (items.length < 2) fail(`the picker lists ${items.length} model(s): ${items.map((i) => i.t).join(", ")}`);
    // Only the signed-in provider's models are listed first: the run's one stored key is Anthropic's.
    if (items.length > 100) fail(`the picker lists ${items.length} models up front: every provider's, signed in or not`);
    const other = items.findIndex((i) => i.c !== "true");
    // The menu scrolls inside its own box (the catalog is more than a thousand models): bring the row into view as a person would.
    const pick = await cdp.evaluate(pill.session, `(() => { const e = [...document.querySelectorAll('[role=menuitemradio]')][${other}]; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    const room = await cdp.evaluate(pill.session, "innerHeight") as number;
    if (pick.y < 0 || pick.y > room) fail(`the picker's row can't be brought on screen (y ${Math.round(pick.y)} of ${room}): the menu doesn't scroll`);
    await cdp.click(pill.session, pick.x, pick.y);
    const now = await until("the bot's model to change", 15_000, async () => {
      const m = (await rpc.request<{ bots: { model?: string }[] }>("bot.list", {})).bots[0]?.model;
      return m !== undefined && m !== was ? m : undefined;
    });
    if (!now.startsWith("anthropic/")) fail(`the pick landed on ${now}, a provider with no key stored (the run's only key is Anthropic's)`);
    // The label says it at once, and the NEXT turn runs on the picked model (the fake provider's own request says which).
    const picked = items[other]!.t.split("\n")[0]!;
    const label = await until("the composer's label to say the pick", 10_000, async () => {
      const l = String(await cdp.evaluate(pill.session, "(document.querySelector('.cl-composer button[aria-label^=\"Model:\"]') || {}).ariaLabel || ''"));
      return l.includes(picked) ? l : undefined;
    }, async () => `label now: ${String(await cdp.evaluate(pill.session, "(document.querySelector('.cl-composer button[aria-label^=\"Model:\"]') || {}).ariaLabel || 'gone'").catch(() => "gone"))}; picked "${picked}"`);
    const tag = `MODEL-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    await cdp.evaluate(box.session, `document.querySelector('${COMPOSER_BOX}').focus()`);
    await cdp.send("Input.insertText", { text: `${tag} which model` }, box.session);
    await sleep(300);
    const send = await until("the send button", 10_000, () => cdp.centerOf(box.session, "button.cl-composer__send").catch(() => undefined));
    await cdp.click(box.session, send.x, send.y);
    const req = await until("the model request of this turn", 60_000, async () => ctx.requests().find((r) => r.lastUserText.includes(tag)));
    const wire = now.slice(now.indexOf("/") + 1);
    if (req.model !== wire) fail(`the pick (${now}) was not what the next turn ran on: the provider was asked for ${String(req.model)}`);
    return `${items.length} models listed; picked "${picked}": the bot's model went from ${was} to ${now}; the label reads "${label}" and the next turn's request asked the provider for ${req.model}`;
  });

  // 3: Settings opens.
  const settingsOpen = async (): Promise<{ session: string }> => {
    const before = cdp.console.length;
    const button = await until("the Settings button", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, "button[aria-label=Settings]").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    });
    await cdp.click(button.session, button.c.x, button.c.y);
    const page = await until("the Settings page", 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const has = await cdp.evaluate(d.session, "document.body.innerText.includes('Notifications') && document.body.innerText.includes('Appearance')").catch(() => false);
        if (has === true) return { session: d.session };
      }
      return undefined;
    });
    await sleep(800);
    if (await stoppedAnywhere(cdp)) fail(`"${STOPPED}" is on screen after opening Settings (${cdp.console.slice(before).filter((e) => e.level === "exception").map((e) => e.text.slice(0, 160)).join(" | ") || "no exception logged"})`);
    return page;
  };
  await step(3, async () => {
    const page = await settingsOpen();
    void page;
    return "Settings drew its sections and no part shows \"This part stopped.\"";
  });

  // 4: a setting sticks.
  await step(4, async () => {
    const readSwitch = async (): Promise<{ session: string; on: boolean }> => {
      const s = await until("the notifications switches", 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const r = await cdp.evaluate(d.session, "(() => { const el = [...document.querySelectorAll('[role=switch]')].find((e) => (e.getAttribute('aria-label') || '').includes('needs you')); return el ? el.getAttribute('aria-checked') : null; })()").catch(() => null);
          if (r !== null && r !== undefined) return { session: d.session, on: r === "true" };
        }
        return undefined;
      });
      return s;
    };
    // The Notifications section.
    const section = async (): Promise<void> => {
      const nav = await until("the Notifications entry", 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, "button, a, [role=tab], [role=link]", "Notifications").catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      });
      await cdp.click(nav.session, nav.c.x, nav.c.y);
    };
    await section();
    const first = await readSwitch();
    const sw = await cdp.centerOf(first.session, "[role=switch]", "needs you");
    if (sw === undefined) fail("no \"needs you\" switch in Notifications");
    await cdp.click(first.session, sw!.x, sw!.y);
    await sleep(1_500);
    const flipped = await readSwitch();
    if (flipped.on === first.on) fail(`the switch didn't flip (still ${first.on})`);
    // The daemon has it.
    const stored = await rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: "clover/settings" });
    const kept = stored.settings.find((s) => s.key === "notifications.needsYou")?.value;
    if (kept !== flipped.on) fail(`the daemon keeps notifications.needsYou = ${String(kept)}, the switch shows ${flipped.on}`);
    ctx.onSetting?.("notifications.needsYou", kept);
    // Leave Settings (the first sidebar item) and open it again.
    await settingsOpen();
    await section();
    const again = await readSwitch();
    if (again.on !== flipped.on) fail(`after opening Settings again the switch shows ${again.on}, not ${flipped.on}`);
    return `"When a bot needs you" went ${first.on} -> ${flipped.on}, the daemon keeps it, and it is ${again.on} after Settings is opened again`;
  });
  // 5: the Dispatch pill's own send, apart from the composer's. The pill is its own window with its own text box and its
  // own Send circle; a person types there and presses the circle. The same fake reply, with this turn's own tag.
  await step(5, async () => {
    const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    const PILL_BOX = "textarea.clp-input";
    const replies = async () => ((await treeText(cdp)).match(/ACCEPTANCE-REPLY-OK/g) ?? []).length;
    const box = await until("the pill's text box", 30_000, () => inTree<boolean>(cdp, `!!document.querySelector('${PILL_BOX}')`), () => dumpFrames(cdp));
    const s = box.session;
    const before = await replies();
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${PILL_BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: `${tag} say hello from the pill` }, s);
    await sleep(400);
    const typed = await cdp.evaluate(s, `document.querySelector('${PILL_BOX}').value`);
    if (!String(typed).includes(tag)) fail(`the pill's text box shows "${String(typed).slice(0, 60)}" after typing`);
    // The pill grows as the first words are typed (a spring), and the Send circle moves with it: it is pressed where it has
    // come to rest, as a person waits for it.
    let btn = await until("the pill's Send circle", 10_000, async () => cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined), () => dumpFrames(cdp));
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const now = await cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined);
      if (now !== undefined && Math.abs(now.x - btn.x) < 0.5 && Math.abs(now.y - btn.y) < 0.5) { btn = now; break; }
      if (now !== undefined) btn = now;
    }
    // The pill's window is sized by the pill itself as it grows: until it is wide enough, the circle's point is outside the page
    // and a press there reaches nothing. Pressed once the point holds the circle.
    const holdsCircle = async (): Promise<string> => String(await cdp.evaluate(s, `(() => { const c = document.querySelector("button.clp-circle[data-role=send]"); if (!c) return "no circle"; const r = c.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e && c.contains(e) ? "circle" : (e ? e.tagName : "outside the page (" + innerWidth + "x" + innerHeight + ")"); })()`).catch(() => "?"));
    let under = await holdsCircle();
    // A pill's window is resized by the pill as it grows, which waits for an animation frame; a hidden (headless) window has
    // none, so it stays at its resting size and the circle lies outside it. The page is given room to lay the circle in (the
    // press then lands on it, in the frame, as a person's would).
    if (under !== "circle") {
      const widen = { width: 720, height: 160, deviceScaleFactor: 1, mobile: false };
      // The pill's document may be a frame of the surface's own page (the command runs only on a top-level target).
      await cdp.send("Emulation.setDeviceMetricsOverride", widen, s).catch(async () => {
        const top = (await cdp.documents()).find((d) => d.url.includes("surface=pill"));
        if (top === undefined) fail("the pill's window has no page of its own to give room");
        await cdp.send("Emulation.setDeviceMetricsOverride", widen, top!.session);
      });
      await sleep(500);
      for (let i = 0; i < 20 && under !== "circle"; i++) {
        under = await holdsCircle();
        const now = await cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined);
        if (now !== undefined) btn = now;
        if (under !== "circle") await sleep(300);
      }
    }
    if (under !== "circle") fail(`the pill's Send circle (${btn.x}, ${btn.y}) never came to a point of the page: it holds ${under}`);
    const route = "the Send circle";
    const consoleFrom = cdp.console.length;
    await cdp.click(s, btn.x, btn.y);
    const sent = () => cdp.console.slice(consoleFrom).filter((e) => e.level === "exception" || e.level === "error" || e.level === "warning").map((e) => e.text.slice(0, 160)).join(" | ");
    await until("this turn's own reply on screen, from the pill's message", 40_000, async () => ((await treeText(cdp)).includes(`${ctx.reply} ${tag}`) ? true : undefined), async () => `${(await dumpFrames(cdp)).slice(0, 120)}; pill box now "${String(await cdp.evaluate(s, `document.querySelector('${PILL_BOX}').value`).catch(() => "?")).slice(0, 50)}"; console: ${sent()}; click at ${btn.x},${btn.y} over ${String(under)}`);
    const after = await replies();
    if (after !== before + 1) fail(`the reply bubbles went from ${before} to ${after}, not by one`);
    return `the pill sent ${tag} by ${route} and its own reply is on screen (reply bubbles ${before} -> ${after})`;
  });
  // 6: a refused send is not silent. A click the page makes itself (no key press or click of a person's behind it) is refused:
  // the composer keeps the draft and says so in a few words.
  await step(6, async () => {
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    const s = box.session;
    // The frame's own activation from the earlier steps has run out.
    await until("the composer frame to have no user activation", 15_000, async () => ((await cdp.evaluate(s, "navigator.userActivation.isActive")) === false ? true : undefined));
    const words = "ACCEPTANCE-REFUSED-DRAFT";
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: words }, s);
    await sleep(300);
    // Pressed by the page, not by a person.
    await cdp.evaluate(s, "document.querySelector('button.cl-composer__send').click()");
    const notice = await until("the composer's notice", 10_000, async () => {
      const t = await cdp.evaluate(s, "(document.querySelector('.cl-composer [data-notice=send]') || {}).textContent || ''");
      return String(t) !== "" ? String(t) : undefined;
    }, () => dumpFrames(cdp));
    const kept = String(await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}').value`));
    if (!kept.includes(words)) fail(`the draft is "${kept.slice(0, 40)}" after the refused send, not kept`);
    // Typing again takes the notice away; the draft is cleared so nothing is left to be sent by mistake.
    await cdp.send("Input.insertText", { text: "!" }, s);
    await sleep(300);
    const gone = String(await cdp.evaluate(s, "(document.querySelector('.cl-composer [data-notice=send]') || {}).textContent || ''"));
    if (gone !== "") fail(`the notice stays after typing ("${gone.slice(0, 40)}")`);
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.select(); return true; })()`);
    await cdp.send("Input.insertText", { text: "" }, s);
    return `a send the page made by itself was refused; the composer said "${notice.slice(0, 80)}", kept the draft, and the notice went on typing`;
  });
  // 7: the bot's own tab layout. Alpha ships tab/layout.json (an `.alpha-sheet` column holding the conversation and the composer);
  // the daemon's plugin view says it as `bot: { layout }`, and the app draws the tab from it.
  await step(7, async () => {
    const talk = await until("Alpha's own talk column", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('[class*=\"alpha-sheet\"]')"), () => dumpFrames(cdp));
    const inside = await cdp.evaluate(talk.session, "!!document.querySelector('[class*=\"alpha-sheet\"] .cl-composer')");
    if (inside !== true) fail("Alpha's talk column holds no composer");
    // The composer stays on screen under a conversation that has grown (the layout fills the window; the composer keeps its height).
    const box = await cdp.evaluate(talk.session, "(() => { const r = document.querySelector('[class*=\"alpha-sheet\"] .cl-composer').getBoundingClientRect(); return { bottom: Math.round(r.bottom), room: innerHeight, h: Math.round(r.height) }; })()") as { bottom: number; room: number; h: number };
    if (box.bottom > box.room || box.h < 40) fail(`Alpha's composer is off screen or squashed: bottom ${box.bottom} of ${box.room}, ${box.h} high`);
    // More than colours: the layout's header is Alpha's own (name and model), and its stage holds the avatar the manifest names
    // (the VRM's credit line, drawn on a canvas, not an empty box).
    let last = "";
    const parts = await until("Alpha's header and stage", 60_000, async () => {
      // The stage is drawn in the layout's own document; the header is Alpha's own part, in a frame of its own.
      const st = await cdp.evaluate(talk.session, "(() => { const st = document.querySelector('.cl-bot-stage'); if (!st) return null; const b = st.getBoundingClientRect(); return { canvas: st.querySelectorAll('canvas').length, w: Math.round(b.width), h: Math.round(b.height), text: (st.textContent || '').trim().slice(0, 120) }; })()") as { canvas: number; w: number; h: number; text: string } | null;
      // Alpha's own layer is its own origin (`clover-plugin://alpha/`), so it is looked for in every document.
      let head: { value: string } | undefined;
      for (const d of await cdp.documents()) {
        if (!d.url.startsWith("clover-plugin://alpha/")) continue;
        const text = await cdp.evaluate(d.session, "(() => { const h = document.querySelector('.ah'); return h ? (h.textContent || '') : ''; })()").catch(() => "");
        if (typeof text === "string" && text !== "") head = { value: text };
      }
      last = `stage ${JSON.stringify(st)}, header ${head === undefined ? "missing" : JSON.stringify(head.value.slice(0, 60))}`;
      return st !== null && head !== undefined && st.canvas > 0 && !/can't be shown/.test(st.text) ? { ...st, header: head.value } : undefined;
    }, async () => `${last} || ${await dumpFrames(cdp)}`);
    if (!parts.header.includes("Alpha")) fail(`Alpha's header says "${parts.header}"`);
    const heldModel = (await rpc.request<{ bots: { model?: string }[] }>("bot.list", {})).bots[0]?.model ?? "";
    const wire = heldModel.slice(heldModel.indexOf("/") + 1);
    if (wire === "" || !parts.header.includes(wire)) fail(`Alpha's header says "${parts.header}", but the bot's model is ${heldModel} (a pick in step 10 must show in it)`);
    if (parts.w < 300 || parts.h < 200) fail(`Alpha's stage is ${parts.w}x${parts.h}, not the 260-620 wide column the layout declares`);
    const renders = process.env.CLOVER_ACCEPT_RENDERS;
    if (renders) {
      // Step 4 left Settings open over the tab: close it the way a person does, for the picture.
      const closer = await inTree<boolean>(cdp, "!!document.querySelector('button[aria-label=\"Close settings\"]')");
      if (closer !== undefined) {
        const c = await cdp.centerOf(closer.session, 'button[aria-label="Close settings"]');
        if (c !== undefined) await cdp.click(closer.session, c.x, c.y);
        await sleep(1500);
      }
      const root = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
      for (const [name, width] of [["alpha-tab-wide.png", 1280], ["alpha-tab-narrow.png", 700]] as const) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false }, root!.session);
        await sleep(3000);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, root!.session) as { data: string };
        writeFileSync(join(renders, name), Buffer.from(shot.data, "base64"));
      }
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, root!.session);
    }
    return `Alpha's talk column is drawn, with the composer in it, on screen; the header says "${parts.header.replace(/\s+/g, " ")}" and the stage is ${parts.w}x${parts.h} with the avatar on a canvas (${parts.text})`;
  });

  // 8: a pending tool card. The island draws it (the app provides the sealed kit: an island without it drew nothing, a
  // black box, and the 2 s fallback fired with the raw input). While the card is pending the island holds frames for
  // the card's own fields, the picture is not one flat fill, and no sealed text shows raw JSON. Idle surfaces stay quiet
  // (the app's own log counts its surface requests).
  await step(8, async () => {
    if (ctx.cardTurn === undefined) return fail("no card turn can run here (the run has no plugin tool turn to press)");
    const IDLE_MS = 5_000, IDLE_MAX = 3;
    const count = () => (ctx.appLog().match(/surface: a request/g) ?? []).length;
    const before = count();
    await sleep(IDLE_MS);
    const idle = count() - before;
    if (idle > IDLE_MAX) fail(`${idle} surface requests in ${IDLE_MS / 1000} s with nothing happening (at most ${IDLE_MAX}) [apps/desktop/src/layer/clover/hosts.tsx coalesced, plugins/clover/plugins/island/src/ui/IslandSurface.tsx]`);
    let said = "";
    await ctx.cardTurn(async (card) => {
      // The island's own part draws in a frame of the island's surface page; its card is the element that carries the card's id.
      const surfacePage = await until("the island's surface page", 20_000, async () => (await cdp.documents()).find((d) => /[?&]surface=island/.test(d.url)), undefined);
      const dumpIsland = async () => `island surface text: "${surfacePage.text.slice(0, 120)}"`;
      const frames = await until(`the island to place the ${card.kind} card's sealed frames`, 20_000, async () => {
        for (const d of await cdp.documents()) {
          if (!d.url.startsWith("clover-plugin://clover/")) continue;
          const n = Number(await cdp.evaluate(d.session, `document.querySelectorAll('[data-clover-card="${card.id}"] iframe[data-clover-sealed]').length`).catch(() => 0));
          if (n >= 3) return n;
        }
        return undefined;
      }, dumpIsland);
      const mine = (await cdp.documents()).filter((d) => d.url.startsWith(`clover-sealed://card/${encodeURIComponent(card.id)}/`));
      const words = mine.filter((d) => decodeURIComponent(d.url).includes("/field:")).map((d) => d.text).join(" ").trim();
      if (words === "") fail(`the island's card frames hold no words (${frames} frames, ${mine.length} sealed documents)`);
      // The line names the file the core resolved and sealed into the card, whole (its folder and its name), never only a name.
      const got = await rpc.request<{ card: { fields?: { paths?: { code?: string } } } }>("card.get", { id: card.id }).catch(() => undefined);
      const resolved = got?.card.fields?.paths?.code?.split("\n")[0];
      if (resolved !== undefined && resolved !== "") {
        const tail = resolved.split("/").slice(-2).join("/");
        if (!words.includes(tail)) fail(`the island's line doesn't name the resolved file (${tail}): "${words.replace(/\s+/g, " ").slice(0, 160)}"`);
      }
      // An "always" on the card says how far it reaches: the thing, the bot and the computers, from the stored rule.
      if (!/Always allow: .* for \S.* on .* only\./.test(words.replace(/\s+/g, " "))) fail(`the island's card doesn't say what "Always allow" would store: "${words.replace(/\s+/g, " ").slice(-200)}"`);
      const raw = /"(?:old_string|new_string|file_path|content)"\s*:|\\n/.exec(words);
      if (raw !== null) fail(`the island's card shows raw JSON: "${words.slice(Math.max(0, raw.index - 20), raw.index + 40).replace(/\n/g, " ")}"`);
      // The picture of the island: more than one colour in it (a black or empty rectangle is one), measured over the whole
      // page the app drew (the island's window, which is transparent outside the card).
      await sleep(600);
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png" }, surfacePage.session)) as { data: string };
      const { colours, width, height } = distinctColours(Buffer.from(shot.data, "base64"));
      if (colours < 3) fail(`the island's picture (${width}x${height}) has ${colours} colour(s): an empty or one-colour card [plugins/clover/plugins/island/src/ui/CardContent.tsx, apps/desktop/src/layer/clover/hosts.tsx APP_KIT]`);
      said = `${frames} sealed frames, words "${words.replace(/\s+/g, " ").slice(0, 70)}", ${colours} colours in a ${width}x${height} picture; idle ${idle} surface requests in ${IDLE_MS / 1000} s`;
    });
    if (/window: shown while headless/.test(ctx.appLog())) fail("a window was shown while headless");
    return said === "" ? fail("the card turn ended with no card inspected") : said;
  });

  // 9: the island and the pill, at idle, paint only their own shape. Each surface page is captured with its default
  // background cleared, so a pixel nothing painted has alpha 0 (up to 8 of 255, a dither, counts as none: a soft shadow
  // is not none, which is why the pill and the island draw no drop shadow); the four corners must be clear, and no more than three
  // quarters of the window may be painted (an iframe whose colour scheme differs from its document's gets an opaque canvas:
  // the dark box that sat behind both). In dark and in light, whatever the machine is set to.
  await step(9, async () => {
    await sleep(1_500);
    const said: string[] = [];
    try {
      for (const scheme of ["dark", "light"] as const) {
        for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
        await sleep(500);
        for (const surface of ["island", "pill"] as const) {
          const page = (await cdp.documents()).find((d) => new RegExp(`[?&]surface=${surface}`).test(d.url));
          if (page === undefined) { fail(`the ${surface}'s surface page isn't there`); continue; }
          await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, page.session);
          const shot = (await cdp.send("Page.captureScreenshot", { format: "png" }, page.session)) as { data: string };
          const png = readPng(Buffer.from(shot.data, "base64"));
          if (png.bpp !== 4) fail(`the ${surface}'s picture has no alpha channel (${scheme})`);
          const alpha = (x: number, y: number) => png.rows[y]![x * 4 + 3]!;
          const corners = [alpha(0, 0), alpha(png.width - 1, 0), alpha(0, png.height - 1), alpha(png.width - 1, png.height - 1)];
          let painted = 0;
          for (const row of png.rows) for (let x = 0; x < png.width; x++) if (row[x * 4 + 3]! > 8) painted++;
          const share = painted / (png.width * png.height);
          if (corners.some((a) => a > 8) || share > 0.75) fail(`the ${surface} paints outside its own shape in ${scheme} (${png.width}x${png.height}, corner alphas ${corners.join("/")}, ${(share * 100).toFixed(0)}% of the window painted) [apps/desktop/src/core/root.css, plugins/clover/plugins/${surface}]`);
          said.push(`${surface} ${scheme} ${(share * 100).toFixed(0)}%`);
        }
      }
    } finally {
      for (const d of await cdp.documents()) {
        await cdp.send("Emulation.setEmulatedMedia", { features: [] }, d.session).catch(() => undefined);
        if (/[?&]surface=/.test(d.url)) await cdp.send("Emulation.setDefaultBackgroundColorOverride", {}, d.session).catch(() => undefined);
      }
    }
    return `clear outside their own shape: ${said.join(", ")} of the window painted`;
  });

  // 10: the slash menu. A / in the composer lists the installed echo plugin's command with its plugin's name; the line
  // `/say <tag>` and a click on the command run it (the click is the user's gesture): the result row says the handler
  // heard the tag from the user, the box is empty, and neither the fake model nor the conversation got the tag.
  await step(10, async () => {
    const tag = `SLASH-${randomBytes(4).toString("hex").toUpperCase()}`;
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    const s = box.session;
    const asked = ctx.requests().length;
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${COMPOSER_BOX}'); t.focus(); t.select(); return true; })()`);
    await cdp.send("Input.insertText", { text: "/" }, s);
    const listShown = async () => String(await cdp.evaluate(s, "(document.querySelector('.cl-composer__slash') || {}).innerText || 'no list'").catch(() => "gone")).replace(/\s+/g, " ").slice(0, 300);
    const rows = await until("the slash menu's echo command", 15_000, async () => {
      const r = JSON.parse(String(await cdp.evaluate(s, "JSON.stringify([...document.querySelectorAll('.cl-composer__slash [role=option]')].map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()))"))) as string[];
      return r.some((t) => t.startsWith("/say") && t.includes("Acceptance echo")) ? r : undefined;
    }, listShown);
    await cdp.send("Input.insertText", { text: `say ${tag}` }, s);
    await sleep(300);
    const item = await cdp.centerOf(s, ".cl-composer__slash-item", "/say");
    if (item === undefined) fail(`the menu has no /say row after typing (${await listShown()})`);
    await cdp.click(s, item!.x, item!.y);
    const result = await until("the command's result by the composer", 20_000, async () => {
      const r = (await cdp.evaluate(s, "(() => { const e = document.querySelector('.cl-composer__slash-result'); return e ? { t: (e.innerText || '').replace(/\\s+/g, ' ').trim(), refused: e.hasAttribute('data-refused') } : null; })()")) as { t: string; refused: boolean } | null;
      return r !== null && r !== undefined ? r : undefined;
    }, listShown);
    if (result.refused) fail(`the command was refused: ${result.t}`);
    if (!result.t.includes(`acceptance-echo-said: ${tag} (by user)`)) fail(`the result row reads "${result.t.slice(0, 120)}", not the handler's answer to the user`);
    const left = String(await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}').value`));
    if (left !== "") fail(`the line is still in the box after the run ("${left.slice(0, 40)}")`);
    // Nothing of it reached the bot: no model request carries the tag, nor the conversation's history.
    await sleep(1_500);
    if (ctx.requests().slice(asked).some((r) => r.lastUserText.includes(tag))) fail("the line reached the model");
    const bots = await rpc.request<{ bots: { id: string; mainSession?: string }[] }>("bot.list", {});
    const main = bots.bots[0]?.mainSession;
    if (main !== undefined) {
      const h = await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: main, limit: 200 });
      if (JSON.stringify(h.events).includes(tag)) fail("the line is in the bot's conversation");
    }
    return `the menu listed ${rows.length} command(s), /say among them with its plugin's name; a click ran it: "${result.t.slice(0, 120)}"; the box is empty and neither the model nor the conversation got ${tag}`;
  });

  // 11: the Theme choice. Chosen in Settings the user's way (the segmented Dark / Light / System in Appearance), it is the
  // core's `appearance`, and the app's main process applies it to `nativeTheme.themeSource`, so every window's
  // `prefers-color-scheme` follows without a restart. Read while a card is pending (a card page is one more window to
  // check): the main window's tree, the island's and the pill's pages and the card's sealed documents all say the same;
  // the island and the pill stay see-through in each. System goes back to the OS's value, and a page that is emulated
  // (the OS cannot be flipped headless) follows the emulation under it.
  await step(11, async () => {
    if (ctx.cardTurn === undefined) return fail("no card turn can run here (the run has no plugin tool turn to press)");
    const darkOf = async (session: string) => (await cdp.evaluate(session, "window.matchMedia('(prefers-color-scheme: dark)').matches").catch(() => undefined)) as boolean | undefined;
    const schemes = async (cardId: string): Promise<{ main?: boolean; seen: { what: string; dark: boolean }[] }> => {
      const seen: { what: string; dark: boolean }[] = [];
      let main: boolean | undefined;
      for (const d of await cdp.documents()) {
        const what = d.url.startsWith(`clover-sealed://card/${encodeURIComponent(cardId)}/`) ? "card page" : /[?&]surface=(island|pill)/.test(d.url) ? `${/surface=island/.test(d.url) ? "island" : "pill"} page` : d.url.startsWith("clover-plugin://clover/") ? "main window" : d.url.startsWith("clover-core://") ? "core page" : undefined;
        if (what === undefined) continue;
        const dark = await darkOf(d.session);
        if (dark === undefined) continue;
        seen.push({ what, dark });
        if (what === "main window") main = dark;
      }
      return { ...(main === undefined ? {} : { main }), seen };
    };
    const choose = async (word: "Dark" | "Light" | "System") => {
      const nav = await until("Appearance in Settings", 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, "button, a, [role=tab], [role=link]", "Appearance").catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      });
      await cdp.click(nav.session, nav.c.x, nav.c.y);
      const radio = await until(`the ${word} choice`, 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, "[role=radio]", word).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      });
      await cdp.click(radio.session, radio.c.x, radio.c.y);
    };
    const shape = async (surface: "island" | "pill", scheme: string): Promise<string> => {
      const page = (await cdp.documents()).find((d) => new RegExp(`[?&]surface=${surface}`).test(d.url));
      if (page === undefined) return fail(`the ${surface}'s surface page isn't there (${scheme})`);
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, page.session);
      try {
        const shot = (await cdp.send("Page.captureScreenshot", { format: "png" }, page.session)) as { data: string };
        const png = readPng(Buffer.from(shot.data, "base64"));
        if (png.bpp !== 4) fail(`the ${surface}'s picture has no alpha channel (${scheme})`);
        const alpha = (x: number, y: number) => png.rows[y]![x * 4 + 3]!;
        const corners = [alpha(0, 0), alpha(png.width - 1, 0), alpha(0, png.height - 1), alpha(png.width - 1, png.height - 1)];
        let painted = 0;
        for (const row of png.rows) for (let x = 0; x < png.width; x++) if (row[x * 4 + 3]! > 8) painted++;
        const share = painted / (png.width * png.height);
        if (corners.some((a) => a > 8) || share > 0.75) fail(`the ${surface} paints outside its own shape with the theme chosen as ${scheme} (corner alphas ${corners.join("/")}, ${(share * 100).toFixed(0)}% painted) [apps/desktop/src/core/root.css]`);
        return `${surface} ${(share * 100).toFixed(0)}%`;
      } finally {
        await cdp.send("Emulation.setDefaultBackgroundColorOverride", {}, page.session).catch(() => undefined);
      }
    };
    // Each choice is made in Settings with nothing pending (a turn's card takes the window over); the windows and the
    // surface pages follow at once, and then a card raised AFTER the choice draws its page in the same scheme.
    const parts: string[] = [];
    let os: boolean | undefined;
    const cardAgrees = async (dark: boolean, word: string): Promise<string> => {
      let note = "";
      await ctx.cardTurn!(async (card) => {
        const got = await until(`the ${word} card page`, 20_000, async () => {
          const r = await schemes(card.id);
          return r.seen.some((x) => x.what === "card page") ? r : undefined;
        });
        const wrong = got.seen.filter((x) => x.dark !== dark);
        if (wrong.length > 0) fail(`with ${word} chosen, ${wrong.map((x) => x.what).join(", ")} read ${dark ? "light" : "dark"} (${JSON.stringify(got.seen)})`);
        note = `${got.seen.filter((x) => x.what === "card page").length} card page doc(s)`;
      });
      return note;
    };
    for (const word of ["Dark", "Light", "System"] as const) {
      await settingsOpen();
      if (os === undefined) {
        os = (await schemes("")).main;
        if (os === undefined) fail("the main window's scheme can't be read");
      }
      const dark = word === "Dark" ? true : word === "Light" ? false : os!;
      await choose(word);
      const got = await until(`every window to follow ${word}`, 15_000, async () => {
        const r = await schemes("");
        return r.main === dark && r.seen.length >= 3 && r.seen.every((x) => x.dark === dark) ? r : undefined;
      }, async () => JSON.stringify(await schemes("")));
      const kept = await until(`the daemon to keep appearance ${word.toLowerCase()}`, 10_000, async () => (ctx.uiSettings().appearance === word.toLowerCase() ? word.toLowerCase() : undefined), async () => JSON.stringify(ctx.uiSettings())).catch(() => ctx.uiSettings().appearance);
      if (kept !== word.toLowerCase()) fail(`the daemon keeps appearance ${String(kept)}, not ${word.toLowerCase()}`);
      const shapes = word === "System" ? [] : [await shape("island", word), await shape("pill", word)];
      const card = await cardAgrees(dark, word);
      parts.push(`${word}: ${got.seen.length} windows ${dark ? "dark" : "light"}, ${card}${shapes.length > 0 ? ` (${shapes.join(", ")} painted)` : ""}`);
    }
    // System follows what is under it: a page emulated dark and light moves with it, and clearing it goes back to the OS's value.
    const doc = (await treeDocs(cdp))[0];
    if (doc === undefined) fail("no tree document to emulate in");
    for (const v of ["dark", "light"] as const) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] }, doc!.session);
      const d = await darkOf(doc!.session);
      if (d !== (v === "dark")) fail(`with System chosen and the page emulated ${v}, it reads ${d === true ? "dark" : "light"}`);
    }
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }, doc!.session);
    parts.push(`System follows an emulated OS value (dark, light) and returns to ${os ? "dark" : "light"}`);
    const said = parts.join("; ");
    return said;
  });

  // 12: the Plugins page, the user's way: Settings → Plugins → the plugin manager; Add → Choose a folder… (main's own
  // picker, which the test build answers with CLOVER_TEST_PICK) → Install; its OK card pressed in the window; Installed →
  // Open shows its tools; Remove… raises the removal card, pressed; and the page's own calls, made with no click of the
  // user's, are refused by the door.
  await step(12, async () => {
    const pick = ctx.pickFolder;
    if (ctx.pressCard === undefined || pick === undefined) fail("this run can't press a card or has no folder for the picker");
    const clickText = async (what: string, selector: string, text: string | undefined, ms = 20_000) => {
      const at = await until(what, ms, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.click(at.session, at.c.x, at.c.y);
      return at.session;
    };
    const waitText = (what: string, text: string, ms = 30_000) => until(what, ms, async () => ((await treeText(cdp)).includes(text) ? true : undefined), () => dumpFrames(cdp));
    // The sidebar's Plugins entry (a dialog an earlier step left open is closed first: Escape, as a person would).
    const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar')"));
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
    await sleep(500);
    let page: { session: string; value: boolean } | undefined;
    for (let attempt = 0; attempt < 3 && page === undefined; attempt++) {
      await clickText("the sidebar's Plugins entry", ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]", "Plugins");
      page = await until("the Plugins page's tabs", 8_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-plugin-index__tabs')")).catch(() => undefined);
    }
    if (page === undefined) fail(`the Plugins page didn't open from the sidebar (frames: ${await dumpFrames(cdp)})`);
    await clickText("the Add tab", "[role=tab]", "Add");
    await clickText("Choose a folder…", "button", "Choose a folder");
    await waitText("the chosen folder's name", `Chosen: ${pick!.path.split("/").pop()}`);
    const shownPath = await cdp.evaluate(page!.session, `document.body.innerText.includes(${JSON.stringify(pick!.path)})`);
    if (shownPath === true) fail("the page shows the picked folder's path: it should hold only a token and the name");
    const reloads = () => (ctx.appLog().match(/layers: \S+ loads again to frame a layer installed after it was served/g) ?? []).length;
    const reloadsBefore = reloads();
    // The document showing now is marked, so the check after the install reads the one loaded again, never this one.
    await cdp.evaluate(page!.session, "window.__acceptanceServedBefore = true");
    await clickText("the chosen folder's Install", "button", `Install ${pick!.path.split("/").pop()}`);
    const okCard = await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === pick!.id);
    const running = await until(`${pick!.id} approved`, 30_000, async () => {
      const r = await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: pick!.id }).catch(() => undefined);
      return r !== undefined && r.plugin.state !== "found" ? r.plugin.state : undefined;
    });
    // Its status-bar line is drawn by its own layer, which the window's document wasn't served to frame: the document
    // loads again, and the user is still where they were (the Plugins page, its Add tab), not on the first page.
    await until("the window's document loaded again for its layer", 30_000, async () => (reloads() > reloadsBefore ? true : undefined));
    await until("its status line, drawn by its own layer", 30_000, async () => ((await cdp.documents()).some((d) => d.url.startsWith(`clover-plugin://${pick!.id}/`)) ? true : undefined), () => dumpFrames(cdp));
    const kept = await until("the Plugins page in the document loaded again", 15_000, () => inTree<string>(cdp,
      "window.__acceptanceServedBefore === true || !document.querySelector('.cl-plugin-index__tabs') ? null : (document.querySelector('.cl-plugin-index [role=tab][aria-selected=true]')?.textContent ?? '(none)')"), () => dumpFrames(cdp));
    if (kept.value.trim() !== "Add") fail(`after the reload the Plugins page shows the ${kept.value} tab, not the Add tab the user was on`);
    const stale = await inTree<boolean>(cdp, "window.__acceptanceServedBefore === true");
    if (stale !== undefined) await until("the document served before out of the window", 10_000, async () => ((await inTree<boolean>(cdp, "window.__acceptanceServedBefore === true")) === undefined ? true : undefined), () => dumpFrames(cdp));
    page = { session: kept.session, value: true };

    // The door: the page's own calls with no click of the user's are refused, nothing reaches the core.
    const refusals = await cdp.evaluate(page!.session, `(async () => {
      const part = document.querySelector('.cl-plugin-index')?.closest('[data-clover-part]');
      const mount = part?.getAttribute('data-clover-part');
      if (!mount) return 'no mount';
      const tryCall = (m, p) => window.cloverLayer.api(mount, m, p).then(() => m + ': went through', (e) => m + ': ' + String(e && e.message || e));
      return [
        await tryCall('plugin.install', { source: { from: 'folder', path: ${JSON.stringify(pick!.path)} } }),
        await tryCall('plugin.remove', { id: ${JSON.stringify(pick!.id)} }),
        await tryCall('ui.pick', { kind: 'folder' }),
        await tryCall('ui.secret', { id: ${JSON.stringify(pick!.id)}, key: 'x' }),
      ].join(' | ');
    })()`) as string;
    if (/went through|no mount/.test(refusals)) fail(`the page's own calls without a click weren't all refused: ${refusals}`);
    if (!/only right after the user's own key press or click/.test(refusals)) fail(`the page's own calls were refused, but not for want of a click: ${refusals.slice(0, 300)}`);
    const still = await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: pick!.id }).catch(() => undefined);
    if (still === undefined) fail(`${pick!.id} is gone after the page's refused calls`);

    // The renders (CLOVER_ACCEPT_RENDERS, --renders): each tab, then the detail and the app's own key dialog, at 1280,
    // dark and light, offscreen.
    const renders = process.env.CLOVER_ACCEPT_RENDERS;
    const rendered: string[] = [];
    let iconSeen = "";
    const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
    const shoot = async (name: string) => {
      if (!renders || appRoot === undefined) return;
      rendered.push(...(await shootWindow(cdp, renders, name, ctx.setAppearance)));
    };
    try {
      if (renders) {
        for (const [tab, name] of [["Installed", "installed"], ["Add", "add"], ["Updates", "updates"], ["Find plugins", "find"], ["Indexes", "indexes"]] as const) {
          await clickText(`the ${tab} tab`, "[role=tab]", tab);
          await sleep(1_500);
          await shoot(name);
        }
      }
      // Installed → Open: its tools. The row's Open says "Open"; its name is in its accessible name.
      await clickText("the Installed tab", "[role=tab]", "Installed");
      // Its own icon, decoded as a 16×16 picture in its row: running with a part of its own, it comes by its view's
      // picture route (`/_t/`); off or waiting for its OK it would come by the picture-only route (`/_icon/`, the
      // plugin-icon tests).
      iconSeen = await until(`${pick!.name}'s icon in its row`, 15_000, async () => {
        const r = await inTree<string>(cdp, `(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`Open ${pick!.name}`)}); const img = b?.closest('li')?.querySelector('img'); return img && img.complete && img.naturalWidth > 0 ? img.getAttribute('src') + ' ' + img.naturalWidth + 'x' + img.naturalHeight : ''; })()`);
        return r?.value ? r.value : undefined;
      }, async () => {
        // What the row holds, and what the route answers this document.
        const seen = await inTree<string>(cdp, `(async () => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`Open ${pick!.name}`)}); const li = b?.closest('li'); if (!li) return ''; let fetched = ''; try { const r = await fetch('/_icon/' + encodeURIComponent(${JSON.stringify(pick!.id)})); fetched = r.status + ' ' + (r.headers.get('content-type') ?? ''); } catch (e) { fetched = 'fetch failed: ' + e; } return 'row: ' + li.innerHTML.slice(0, 600) + ' | fetch: ' + fetched; })()`);
        return seen?.value ?? (await dumpFrames(cdp));
      });
      await clickText(`Open ${pick!.name}`, `button[aria-label=${JSON.stringify(`Open ${pick!.name}`)}]`, undefined);
      await waitText(`${pick!.name}'s detail with its tool`, pick!.tool);
      if (renders) {
        await shoot("detail");
        // Its key: the app's own dialog (a core page over the window), never a field on the page.
        await clickText("its key's Enter key…", "button", "Enter key");
        await until("the app's key dialog", 15_000, async () => ((await cdp.evaluate(appRoot!.session, "!!document.querySelector('[data-clover-key-field]')").catch(() => false)) === true ? true : undefined));
        await shoot("key-dialog");
        const close = await cdp.centerOf(appRoot!.session, ".clover-page__close");
        if (close !== undefined) await cdp.click(appRoot!.session, close.x, close.y);
        await sleep(800);
      }
    } finally {
      if (appRoot !== undefined && renders) await unshootWindow(cdp, ctx.setAppearance);
    }
    // Remove… → its sealed card, pressed → gone.
    await clickText("Remove…", "button", "Remove");
    const removeCard = await ctx.pressCard!("its removal card", (c) => c.kind === "change" && c.change === "plugin-remove");
    await until(`${pick!.id} removed`, 30_000, async () => ((await rpc.request("plugin.get", { id: pick!.id }).then(() => false, () => true)) ? true : undefined));
    return `installed ${pick!.id} from a picked folder (the page held a token and the name, never the path), its OK card ${okCard} pressed (now ${running}); the window's document loaded again for its layer and kept the Plugins page on its Add tab; the page's own calls with no click refused (${refusals.replace(/plugin\.|ui\./g, "").slice(0, 160)}…); its detail showed ${pick!.tool}; its icon ${iconSeen}; removed on its sealed card ${removeCard}${rendered.length > 0 ? `; rendered ${rendered.length} pictures` : ""}`;
  });

  // 13: a third-party plugin with UI (the acceptance-ui fixture), installed from a folder: its client is TSX that
  // imports React and the UI SDK, and the folder ships no react, since each layer's import map serves them. The registry
  // doesn't build a TypeScript client at load yet, so the step builds it first, as the plugin's own bundler would, with
  // the registry's builder (React and the UI SDK left as bare imports) into a copy of the folder. OK'd on its card, its
  // page, opened from its sidebar app button, renders in a frame of its own layer and asks the core once (its layer's
  // own connection). Turned off in the
  // Plugins page (Installed → Open → Turn off): its frames leave the window and main closes its layer's connection.
  // Then it is removed.
  await step(13, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const id = "acceptance-ui";
    const source = join(import.meta.dir, "fixtures", id);
    if (existsSync(join(source, "node_modules"))) fail(`the fixture ships a node_modules; it must lean on the layer's import map`);
    const copy = mkdtempSync(join(tmpdir(), "clv-acc-ui-"));
    const folder = join(copy, id);
    cpSync(source, folder, { recursive: true });
    const built = await buildPluginModule({ entry: join(folder, "client", "index.tsx"), outFile: join(folder, "client", "index.js"), side: "client" });
    if (!built.imports.includes("react") || !built.imports.includes("@waifucave/clover-plugin-sdk/ui")) fail(`the built client doesn't import React and the UI SDK from the layer (${built.imports.join(", ")})`);
    rmSync(join(folder, "client", "index.tsx"));
    const manifest = JSON.parse(readFileSync(join(folder, "clover.json"), "utf8")) as { client: { entry: string } };
    manifest.client.entry = "client/index.js";
    writeFileSync(join(folder, "clover.json"), JSON.stringify(manifest, null, 2));
    const layerDocs = async () => (await cdp.documents()).filter((d) => d.url.startsWith(`clover-plugin://${id}/`));
    const stateOf = async () => (await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state;
    const clickText = async (what: string, selector: string, text: string | undefined, ms = 20_000) => {
      const at = await until(what, ms, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.click(at.session, at.c.x, at.c.y);
    };
    let summary13 = "";
    const installed = await rpc.request<{ id: string; state: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
    try {
      if (installed.id !== id) fail(`the fixture installed as ${installed.id}`);
      const ok = await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === id);
      await until(`${id} running`, 30_000, async () => ((await stateOf()) === "running" ? true : undefined));
      // Its page, opened from its sidebar app button, drawn by its own layer from the TSX client, having asked the core.
      // The window's document loads again to frame a layer installed after it was served, which resets the route, so a
      // press that lands before that reload is pressed again.
      let lastPress = 0;
      let lastAsked = "";
      await until("its page in a frame of its own layer, answered by the core", 45_000, async () => {
        for (const d of await layerDocs()) {
          const asked = String(await cdp.evaluate(d.session, "document.querySelector('[data-acceptance-ui=\"main\"]')?.getAttribute('data-asked') ?? ''").catch(() => ""));
          if (asked === "asked") return true;
          if (asked !== "") lastAsked = asked;
        }
        if ((await layerDocs()).length === 0 && Date.now() - lastPress > 5_000) {
          lastPress = Date.now();
          await clickText("its app button in the sidebar", ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]", "Acceptance UI", 10_000).catch(() => undefined);
        }
        return undefined;
      }, async () => `its page says ${JSON.stringify(lastAsked || "nothing")}; ${await dumpFrames(cdp)}`);
      await until("its layer's connection", 15_000, async () => (ctx.appLog().includes(`layers: ${id}'s layer connected to the core`) ? true : undefined));
      const frames = (await layerDocs()).length;
      // The Plugins page, the user's way: the sidebar's Plugins entry, Installed, its row's Open, Turn off.
      const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar')"));
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
      await sleep(300);
      await clickText("the sidebar's Plugins entry", ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]", "Plugins");
      await clickText("the Installed tab", "[role=tab]", "Installed");
      await clickText("Open Acceptance UI", `button[aria-label=${JSON.stringify("Open Acceptance UI")}]`, undefined);
      await clickText("Turn off", "button", "Turn off");
      await until(`${id} off`, 20_000, async () => ((await stateOf()) === "off" ? true : undefined));
      await until("its frames out of the window", 20_000, async () => ((await layerDocs()).length === 0 ? true : undefined), () => dumpFrames(cdp));
      await until("its layer's connection closed", 15_000, async () => (ctx.appLog().includes(`layers: ${id}'s layer connection closed`) ? true : undefined));
      summary13 = `${id} installed from a folder (its TSX client built to bare ${built.imports.join(", ")}, no react shipped), OK'd on its card ${ok}, its page (opened from its sidebar button) in ${frames} frame(s) of its own layer, answered by the core; Turn off in the Plugins page: off, no frame of its layer left, and main closed its layer's connection`;
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(copy, { recursive: true, force: true });
    }
    // Only a plugin that no longer shows UI loses its connection: no part of the bundled tree's was closed by a reload
    // (it would lose its subscriptions each time).
    const churned = ctx.appLog().split("\n").filter((l) => /layers: clover(\/[^']*)?'s layer connection closed/.test(l));
    if (churned.length > 0) fail(`a reload closed the bundled tree's connections too: ${churned.slice(0, 3).join(" | ")}`);
    return `${summary13}; no connection of the bundled tree's closed`;
  });
}
