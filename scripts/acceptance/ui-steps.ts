// The acceptance run's UI steps: what a person does in the window, driven over the Chrome DevTools protocol against the
// headless, offscreen app (cdp.ts): type in the composer and send, read the bot's reply in the conversation, pick a
// model, open Settings, change a setting and see it stay, and drag the window by its title area. Each step reads the
// real DOM of the real layer frames and the daemon's own state; none of them calls the core's methods for the app.
// The inputs are trusted input events (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), which the main process sees
// as the person's key presses and clicks: if one doesn't register with the send gate, it is this driver that is wrong,
// never the gate.
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  "a third-party plugin with UI installed from its folder as it is (a TSX client importing React and the UI SDK, no react shipped) renders in its own layer once OK'd, its client built by the registry at load; turned off in the Plugins page it leaves the window, and its layer's own connection to the core closes",
  "the bot editor opens the user's way, from Alpha's Edit button and from Settings → Bots → Edit, and draws its controls",
  "the bot editor imports a model the user picked: Choose avatar… (main's picker) → Import and use; no path on the page, the model's own credit note shown and on her header, and her stage draws it",
  "a turn that fails shows Try again on its error row; one click sends the same message again (the user's own, byte for byte), the turn completes, the button goes, and nothing was sent twice",
  "a third-party bot plugin that ships its own Live2D model (the placeholder's files) draws it on its stage, with no \"can't be shown\" note",
  "a third-party character renderer (the SDK's picture-swap example) installed from its folder: a bot plugin whose avatar format is its own draws its pictures on its stage",
  "a bot with a voice speaks its reply (the run's fixture voice, a tone): the app gets the pieces and makes frames, the picture-swap bot shows its talking picture while it speaks and Alpha's stage gets frames too; the stage's chip mutes at once and the next reply stays silent",
  "Alpha's tab reshapes the window: no stock bar, her own controls and sidebar; her toggle folds the sidebar to the rail and back, her panel control (when a plugin fills a panel) opens and closes the panel sheet; a plain bot's tab brings the stock bar and sidebar back, and so does the Code side",
  "a bot plugin changes one thing in its tab: a layout of a few lines that extends the stock tab stands its stage to the left of the transcript, wider, and a hide entry takes the composer's model button out of its tab only",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

interface Ctx {
  cdp: Cdp; rpc: CloverClient; reply: string; /** What the fake model provider has been asked, in order. */ requests(): { model?: string; lastUserText: string; answered?: string }[]; /** The app's own log file, <home>/logs/app.log, as text. */ appLog(): string;
  /** What the Settings step set, as the daemon keeps it (the upgrade's first half records it). */
  onSetting?(key: string, value: unknown): void;
  /** Runs a turn that raises a tool card, calls `inspect` with the card while it is pending, then presses its Approve in the window. */
  cardTurn?(inspect: (card: { id: string; kind: string }) => Promise<void>): Promise<void>;
  /** Waits for a pending card `match` picks, and presses its Approve in the window (the real way); its id. */
  pressCard?(what: string, match: (card: { id: string; kind: string; change?: string; session?: string; pluginId?: string }) => boolean): Promise<string>;
  /** The core's UI settings as the daemon keeps them (<home>/settings/ui.json; `ui.settings` is the app role's, and the packaged run's connection is the CLI's). */
  uiSettings(): { appearance?: string };
  /** Sets the window's dark or light (the renders; the app follows a file the run writes). */
  setAppearance?(scheme: "dark" | "light" | "system"): void;
  /** The folder the test build's picker gives (CLOVER_TEST_PICK) and the plugin it holds. */
  pickFolder?: { path: string; id: string; name: string; tool: string };
  /** The folder the test build's picker gives a bot editor's avatar import (CLOVER_TEST_PICK_AVATAR): the stock model and a credit note. */
  avatarFolder?: string;
  /** Lets the fake provider's turns `ACCEPTANCE-FAIL-<id>` succeed from now on (the Try again step). */
  healFake?(id: string): void;
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
  // Alpha's own frames too (her controls, her sidebar): while her tab shows there is no stock bar or sidebar, her controls and sidebar are what the user presses.
  return (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/") || d.url.startsWith("clover-plugin://alpha"));
}

/** The sidebar's items: the stock sidebar's, or Alpha's own sidebar's rows while her tab shows. */
const SIDEBAR_ITEMS = ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link], .as__row";

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
  return inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar__top, .as')");
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

/** The ground under the app's root and the shell's own frame (the sidebar's material sits in it), for a render: a
 *  render-only colour on their <html>, through the CSSOM (the default-background override doesn't reach under a
 *  headless capture's material). Without it a part with no background of its own (the stock conversation, the
 *  sidebar's 70% tint) shows the offscreen window's white, in dark mode too. `unshootWindow` takes it away. */
export async function layGround(cdp: Cdp, scheme: "dark" | "light"): Promise<void> {
  const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
  const shell = await shellDoc(cdp).catch(() => undefined);
  const g = RENDER_GROUND[scheme];
  for (const session of [...(appRoot !== undefined ? [appRoot.session] : []), ...(shell !== undefined ? [shell.session] : [])]) {
    await cdp.evaluate(session, `(() => { document.documentElement.style.setProperty('background-color', 'rgb(${g.r}, ${g.g}, ${g.b})', 'important'); return true; })()`).catch(() => undefined);
  }
}

/** One picture of the app's window per scheme, at 1280x800, offscreen, into `dir`: `plugins-<name>-<scheme>.png`. */
export async function shootWindow(cdp: Cdp, dir: string, name: string, setAppearance?: (scheme: "dark" | "light" | "system") => void): Promise<string[]> {
  const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
  if (appRoot === undefined) return [];
  const out: string[] = [];
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, appRoot.session);
  for (const scheme of ["dark", "light"] as const) {
    setAppearance?.(scheme);
    for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
    await layGround(cdp, scheme);
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
    const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-window')"));
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
      await click(SIDEBAR_ITEMS, "Plugins");
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
    // Alpha's tab has no stock bar or sidebar (her own are drawn by her plugin), so the stock title row is shown from a page of the shell's own:
    // her sidebar's Plugins row (a page of the shell's own, with the stock chrome; Settings is a dialog over her tab), the user's way, then back to her tab by the stock sidebar's Alpha row.
    const alphaSide = await inTree<boolean>(cdp, "!!document.querySelector('.as')");
    if (alphaSide !== undefined) {
      const gear = await until("Alpha's sidebar Plugins row", 20_000, async () => { for (const d of await treeDocs(cdp)) { const c = await cdp.centerOf(d.session, ".as__row", "Plugins").catch(() => undefined); if (c !== undefined) return { d, c }; } return undefined; }, () => dumpFrames(cdp));
      await cdp.click(gear.d.session, gear.c.x, gear.c.y);
    }
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
    if (alphaSide !== undefined) {
      // Back to her tab through the stock sidebar's own Alpha row: her chrome returns (her controls draw).
      const row = await until("the stock sidebar's Alpha row", 20_000, async () => { for (const d of await treeDocs(cdp)) { const c = await cdp.centerOf(d.session, ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]", "Alpha").catch(() => undefined); if (c !== undefined) return { d, c }; } return undefined; }, () => dumpFrames(cdp));
      await cdp.click(row.d.session, row.c.x, row.c.y);
      await until("Alpha's own controls drawn again", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.ac')"), () => dumpFrames(cdp));
    }
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
        const text = await cdp.evaluate(d.session, "(() => { const h = document.querySelector('.ac'); const m = document.querySelector('.rm__status'); return (h ? (h.textContent || '') : '') + ' ' + (m ? m.getAttribute('title') || '' : ''); })()").catch(() => "");
        if (typeof text === "string" && text.trim() !== "") head = { value: `${head?.value ?? ""} ${text}`.trim() };
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
    const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-window')"));
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
    await sleep(500);
    let page: { session: string; value: boolean } | undefined;
    for (let attempt = 0; attempt < 3 && page === undefined; attempt++) {
      await clickText("the sidebar's Plugins entry", SIDEBAR_ITEMS, "Plugins");
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
      // Each probe answers null in a document without the row: `inTree` takes the first answer that isn't, so an empty
      // string from another tree document (whichever attached first) would hide the Plugins page's.
      iconSeen = await until(`${pick!.name}'s icon in its row`, 15_000, async () => {
        const r = await inTree<string>(cdp, `(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`Open ${pick!.name}`)}); const img = b?.closest('li')?.querySelector('img'); return img && img.complete && img.naturalWidth > 0 ? img.getAttribute('src') + ' ' + img.naturalWidth + 'x' + img.naturalHeight : null; })()`);
        return r?.value ? r.value : undefined;
      }, async () => {
        // What the row holds, and what the route answers this document.
        const seen = await inTree<string>(cdp, `(async () => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`Open ${pick!.name}`)}); const li = b?.closest('li'); if (!li) return null; let fetched = ''; try { const r = await fetch('/_icon/' + encodeURIComponent(${JSON.stringify(pick!.id)})); fetched = r.status + ' ' + (r.headers.get('content-type') ?? ''); } catch (e) { fetched = 'fetch failed: ' + e; } return 'row: ' + li.innerHTML.slice(0, 600) + ' | fetch: ' + fetched; })()`);
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

  // 13: a third-party plugin with UI (the acceptance-ui fixture), installed from its folder as it is: its client is TSX
  // that imports React and the UI SDK, and the folder ships no react, since each layer's import map serves them. OK'd on
  // its card, the registry builds its client at load (registry/client-builds.ts), and its page, opened from its sidebar
  // app button, renders in a frame of its own layer from that module and asks the core once (its layer's own
  // connection). Turned off in the Plugins page (Installed → Open → Turn off): its frames leave the window and main
  // closes its layer's connection. Then it is removed.
  await step(13, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const id = "acceptance-ui";
    const folder = join(import.meta.dir, "fixtures", id);
    if (existsSync(join(folder, "node_modules"))) fail(`the fixture ships a node_modules; it must lean on the layer's import map`);
    if (!existsSync(join(folder, "client", "index.tsx")) || existsSync(join(folder, "client", "index.js"))) fail("the fixture's client must be its TSX source alone");
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
        let page = false;
        for (const d of await layerDocs()) {
          const asked = String(await cdp.evaluate(d.session, "document.querySelector('[data-acceptance-ui=\"main\"]')?.getAttribute('data-asked') ?? ''").catch(() => ""));
          if (asked === "asked") return true;
          if (asked !== "") {
            lastAsked = asked;
            page = true;
          }
        }
        // Pressed again while its page isn't drawn: its sidebar badge is a frame of the same layer, so a layer document
        // alone doesn't mean the page opened.
        if (!page && Date.now() - lastPress > 5_000) {
          lastPress = Date.now();
          await clickText("its app button in the sidebar", SIDEBAR_ITEMS, "Acceptance UI", 10_000).catch(() => undefined);
        }
        return undefined;
      }, async () => `its page says ${JSON.stringify(lastAsked || "nothing")}; ${await dumpFrames(cdp)}`);
      await until("its layer's connection", 15_000, async () => (ctx.appLog().includes(`layers: ${id}'s layer connected to the core`) ? true : undefined));
      const frames = (await layerDocs()).length;
      // The Plugins page, the user's way: the sidebar's Plugins entry, Installed, its row's Open, Turn off.
      const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-window')"));
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
      await sleep(300);
      await clickText("the sidebar's Plugins entry", SIDEBAR_ITEMS, "Plugins");
      await clickText("the Installed tab", "[role=tab]", "Installed");
      await clickText("Open Acceptance UI", `button[aria-label=${JSON.stringify("Open Acceptance UI")}]`, undefined);
      await clickText("Turn off", "button", "Turn off");
      await until(`${id} off`, 20_000, async () => ((await stateOf()) === "off" ? true : undefined));
      await until("its frames out of the window", 20_000, async () => ((await layerDocs()).length === 0 ? true : undefined), () => dumpFrames(cdp));
      await until("its layer's connection closed", 15_000, async () => (ctx.appLog().includes(`layers: ${id}'s layer connection closed`) ? true : undefined));
      summary13 = `${id} installed from its folder as it is (a TSX client, no react shipped; built by the registry at load), OK'd on its card ${ok}, its page (opened from its sidebar button) in ${frames} frame(s) of its own layer, answered by the core; Turn off in the Plugins page: off, no frame of its layer left, and main closed its layer's connection`;
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
    }
    // Only a plugin that no longer shows UI loses its connection: no part of the bundled tree's was closed by a reload
    // (it would lose its subscriptions each time).
    const churned = ctx.appLog().split("\n").filter((l) => /layers: clover(\/[^']*)?'s layer connection closed/.test(l));
    if (churned.length > 0) fail(`a reload closed the bundled tree's connections too: ${churned.slice(0, 3).join(" | ")}`);
    return `${summary13}; no connection of the bundled tree's closed`;
  });

  // 14: the bot editor, the user's way, both routes: Alpha's own Edit button (the pencil in her header), and Settings → Bots →
  // Edit Alpha. Each time the editor is drawn: its heading, name, model and avatar controls are on screen.
  const clickIn = async (what: string, selector: string, text: string | undefined, ms = 20_000) => {
    const at = await until(what, ms, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    }, () => dumpFrames(cdp));
    await cdp.click(at.session, at.c.x, at.c.y);
  };
  const escape = async () => {
    const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-window')"));
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
    await sleep(400);
  };
  const editorDrawn = async (how: string): Promise<string> => {
    const seen = await until(`the bot editor (${how})`, 30_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const r = await cdp.evaluate(d.session, `(() => {
          const e = document.querySelector('.cl-bot-editor:not(.cl-bot-editor--loading)');
          if (!e) return undefined;
          const t = e.innerText;
          return JSON.stringify({ heading: /Edit Alpha/.test(t), name: !!e.querySelector('input[aria-label=Name]'), model: !!e.querySelector('select[aria-label=Model]'), choose: /Choose avatar/.test(t), back: /Back to the bot/.test(t) });
        })()`).catch(() => undefined);
        if (typeof r === "string") return r;
      }
      return undefined;
    }, () => dumpFrames(cdp));
    const got = JSON.parse(seen) as Record<string, boolean>;
    const missing = Object.entries(got).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) fail(`the bot editor (${how}) opened but lacks: ${missing.join(", ")}`);
    return how;
  };
  await step(14, async () => {
    await escape();
    // Route 1: Alpha in the sidebar, then the pencil in her header.
    await clickIn("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha");
    await clickIn("Alpha's Edit button", 'button[aria-label="Edit Alpha"]', undefined);
    const one = await editorDrawn("Alpha's Edit button");
    await clickIn("Back to the bot", "button", "Back to the bot");
    // Route 2: Settings (the sidebar's gear), the Bots section of the Settings window (the sidebar has a Bots entry too), Edit Alpha.
    await clickIn("the Settings button", "button[aria-label=Settings]", undefined);
    await clickIn("the Settings window's Bots section", "button.cl-settings__section", "Bots");
    await clickIn("Edit Alpha in Settings", '[class*=cl-settings__] button[aria-label="Edit Alpha"]', undefined);
    const two = await editorDrawn("Settings → Bots → Edit");
    await clickIn("Back to the bot", "button", "Back to the bot");
    return `the bot editor drew its heading, name, model and avatar controls from ${one} and from ${two}`;
  });

  // 15: the picker, on the editor: Choose avatar… (main's own picker, which the test build answers with
  // CLOVER_TEST_PICK_AVATAR: a copy of the stock model with a credit note, never anyone's own) → the name shows, never the
  // path → Import and use → imported, the model's own note shown under the avatar, and it is her avatar (the core's `user:`
  // copy); her header shows the note, and her stage fetches the model from the core's own `/_a/` folder. Her avatar is put
  // back to the plugin's own after.
  await step(15, async () => {
    const id = "alpha";
    const picked = ctx.avatarFolder;
    if (picked === undefined) fail("this run has no model folder for the picker");
    const waitText = (what: string, text: string, ms = 30_000) => until(what, ms, async () => ((await treeText(cdp)).includes(text) ? true : undefined), () => dumpFrames(cdp));
    const avatarOf = async () => (await rpc.request<{ bots: { id: string; avatar?: { src: string; credit?: string }; userLayer: string[] }[] }>("bot.list", {})).bots.find((b) => b.id === id);
    try {
      await escape();
      await clickIn("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha");
      await clickIn("Alpha's Edit button", 'button[aria-label="Edit Alpha"]', undefined);
      await waitText("the bot editor's avatar row", "Choose avatar");
      await clickIn("Choose avatar…", "button", "Choose avatar…");
      const name = picked!.split("/").pop()!;
      await waitText("the picked name", `Picked: ${name}`);
      const page = await treeText(cdp);
      if (page.includes(picked!) || page.includes("/Users/") || page.includes("/private/")) fail("the page shows the picked model's path: it should hold only a token and the name");
      await clickIn("Import and use", "button", "Import and use");
      // The format's name as its renderer declares it (clover/live2d's `avatar.formats` entry).
      await waitText("the import's result", "Imported a Live2D (Cubism) model");
      await waitText("the model's own note under the avatar", "From the model's own notes");
      const view = await until("her avatar from the core's own folder", 20_000, async () => {
        const b = await avatarOf();
        return b !== undefined && b.userLayer.includes("avatar") && b.avatar?.src.startsWith(`/_a/${id}/`) ? b : undefined;
      });
      if (!/credit the acceptance suite/.test(view.avatar?.credit ?? "")) fail(`the core's avatar listing has no credit note (${JSON.stringify(view.avatar)})`);
      const text = await treeText(cdp);
      // The note sits in the editor's text box (the user's to change or clear).
      const boxed = await until("the note in the editor's text box", 10_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const v = await cdp.evaluate(d.session, `document.querySelector('textarea[aria-label="Credit note"]')?.value ?? null`).catch(() => null);
          if (typeof v === "string") return v;
        }
        return undefined;
      });
      if (!boxed.includes("credit the acceptance suite")) fail(`the note isn't in the editor's text box under the avatar (${boxed.slice(0, 80)})`);
      if (/\/Users\/|\/private\//.test(text)) fail("a path is on screen after the import");
      // The picture (--renders): the editor with the pick's result and the model's own note, dark and light.
      if (process.env.CLOVER_ACCEPT_RENDERS) await shootWindow(cdp, process.env.CLOVER_ACCEPT_RENDERS, "bot-editor-avatar-import", ctx.setAppearance);
      const result = text.match(/Imported a Live2D \(Cubism\) model \([^)]*\)/)?.[0] ?? "";
      // Her tab: the header shows the note, and the stage fetches the model from the core's own folder.
      await clickIn("Back to the bot", "button", "Back to the bot");
      // Her header is her own layer's part (her plugin's document, not the bundled tree's).
      await until("her header's credit line", 30_000, async () => {
        for (const d of await cdp.documents()) {
          const v = await cdp.evaluate(d.session, `document.querySelector('.rm__credit')?.textContent ?? null`).catch(() => null);
          if (typeof v === "string" && v.includes("credit the acceptance suite")) return true;
        }
        return undefined;
      }, () => dumpFrames(cdp));
      // Her stage draws the imported model: its stage box (in the layout's own document) holds a canvas and no "can't be shown".
      // (The page's resource timeline can't see a custom-scheme fetch, so the drawn stage is what is read.)
      let stage = "";
      await until("her stage drawing the imported model", 45_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const st = await cdp.evaluate(d.session, "(() => { const st = document.querySelector('.cl-bot-stage'); if (!st) return null; const b = st.getBoundingClientRect(); return JSON.stringify({ canvas: st.querySelectorAll('canvas').length, w: Math.round(b.width), h: Math.round(b.height), text: (st.textContent || '').trim().slice(0, 100), format: st.dataset.format || '', live2d: st.querySelectorAll('.clvl-avatar').length, vrm: st.querySelectorAll('.clvr-avatar').length }); })()").catch(() => null);
          if (typeof st !== "string") continue;
          const o = JSON.parse(st) as { canvas: number; w: number; h: number; text: string; format: string; live2d: number; vrm: number };
          stage = st;
          // The renderer of the imported format is the one mounted (a VRM canvas of the plugin's own model would also have a canvas).
          if (o.format === "live2d" && o.live2d > 0 && o.vrm === 0 && o.canvas > 0 && o.w > 100 && o.h > 100 && !/can't be shown|placeholder model/.test(o.text)) return true;
        }
        return undefined;
      }, async () => `${stage} || ${await dumpFrames(cdp)}`);
      const stageSaid = (JSON.parse(stage) as { w: number; h: number; text: string });
      return `Choose avatar… showed only the name (${name}); Import and use said "${result}"; the model's own note is under the avatar and on her header; her avatar is the core's copy (${view.avatar!.src.replace(/m-[^/]*/, "m-…")}) and her stage (${stageSaid.w}x${stageSaid.h}) draws it on a canvas${stageSaid.text ? ` (${stageSaid.text})` : ""}`;
    } finally {
      await rpc.request("bot.setUserLayer", { id, patch: { avatar: null } }).catch(() => undefined);
    }
  });

  // 16: Try again. A turn the fake provider fails (ACCEPTANCE-FAIL-<id>: a 400 nothing retries) ends in an error; the
  // conversation's error row offers "Try again"; the fake is let to answer; ONE click sends the user's own message again
  // (main reads the log; the page names only the session), the turn completes with its own reply, the button is gone,
  // and the log holds exactly two of the user's messages with the same words (byte for byte) and nothing else sent.
  await step(16, async () => {
    if (ctx.healFake === undefined) fail("this run has no way to let the fake provider's failing turn succeed");
    const tag = `ACCEPTANCE-FAIL-${randomBytes(4).toString("hex").toUpperCase()}`;
    const words = `${tag} say hello again,  with my  spacing`;
    const bot = (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha");
    if (bot === undefined) fail("no bot alpha");
    const log = async () => (await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: bot!.mainSession, limit: 500 })).events;
    const mine = (events: Record<string, unknown>[]) => events.filter((e) => e.type === "user_message" && typeof e.text === "string" && e.text.includes(tag));
    await escape();
    await clickIn("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha");
    const box = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    await cdp.evaluate(box.session, `document.querySelector('${COMPOSER_BOX}').focus()`);
    await cdp.send("Input.insertText", { text: words }, box.session);
    await sleep(300);
    const send = await until("the send button", 10_000, () => cdp.centerOf(box.session, "button.cl-composer__send").catch(() => undefined));
    await cdp.click(box.session, send.x, send.y);
    const errorShown = () => until("the error row's Try again on screen", 90_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const c = await cdp.centerOf(d.session, ".cl-conv-note[data-tone=error] button.cl-conv-note__retry", "Try again").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    }, async () => `${(await log()).slice(-6).map((e) => `${String(e.type)}${e.stopReason ? `:${String(e.stopReason)}` : ""}`).join(" ")} || ${await dumpFrames(cdp)}`);
    const button = await errorShown();
    const first = await log();
    const failedAt = first.filter((e) => e.type === "turn_completed").at(-1);
    if (mine(first).length !== 1) fail(`the log holds ${mine(first).length} of the user's message before the click, not 1`);
    if (failedAt?.stopReason !== "error") fail(`the last turn ended as ${String(failedAt?.stopReason)}, not an error`);
    ctx.healFake!(tag.replace("ACCEPTANCE-FAIL-", ""));
    // As a person would: the row is brought into view, and the click lands on what is there then.
    const retrySel = ".cl-conv-note[data-tone=error] button.cl-conv-note__retry";
    await cdp.evaluate(button.session, `(() => { const b = [...document.querySelectorAll('${retrySel}')].at(-1); if (b) b.scrollIntoView({ block: "center" }); return !!b; })()`);
    await sleep(400);
    const there = await cdp.centerOf(button.session, retrySel, "Try again");
    if (there === undefined) fail("Try again went from the screen before the click");
    const top = await cdp.evaluate(button.session, `(() => { const b = [...document.querySelectorAll('${retrySel}')].at(-1); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(${there!.x}, ${there!.y}); return JSON.stringify({ hit: !!e && (e === b || b.contains(e)), y: Math.round(r.top), room: innerHeight, disabled: b.disabled, over: e ? e.className || e.tagName : null }); })()`);
    const seenAt = JSON.parse(String(top)) as { hit: boolean; y: number; room: number; disabled: boolean; over: string | null };
    if (!seenAt.hit) fail(`the click would land on something else (${JSON.stringify(seenAt)})`);
    await cdp.click(button.session, there!.x, there!.y);
    await until("the turn's own reply on screen", 150_000, async () => ((await treeText(cdp)).includes(`${ctx.reply} ${tag}`) ? true : undefined), async () => `log: ${(await log()).slice(-8).map((e) => `${String(e.type)}${e.stopReason ? `:${String(e.stopReason)}` : ""}${typeof e.text === "string" ? `(${e.text.slice(0, 40)})` : ""}`).join(" ")}; the fake answered ${ctx.requests().filter((r) => r.lastUserText.includes(tag)).map((r) => r.answered).join(",") || "nothing"} || ${await dumpFrames(cdp)}`);
    const after = await log();
    const sent = mine(after);
    if (sent.length !== 2) fail(`the log holds ${sent.length} of the user's message after Try again, not 2`);
    if (sent[1]!.text !== sent[0]!.text || !String(sent[0]!.text).includes("again,  with my  spacing")) fail(`the message sent again is not the first, byte for byte (${JSON.stringify(sent[0]!.text)} then ${JSON.stringify(sent[1]!.text)})`);
    const ends = after.filter((e) => e.type === "turn_completed").map((e) => String(e.stopReason));
    if (ends.at(-1) !== "end_turn" || ends.at(-2) !== "error") fail(`the turns ended ${ends.slice(-3).join(", ")}, not an error then a completed turn`);
    const stale = await cdp.centerOf(button.session, ".cl-conv-note__retry").catch(() => undefined);
    if (stale !== undefined || (await treeText(cdp)).includes("Try again")) fail("Try again is still on screen after the turn completed");
    const asked = ctx.requests().filter((r) => r.lastUserText.includes(tag));
    return `a failed turn (${tag}) showed Try again on its error row; one click sent the same words again (the log holds two, equal byte for byte, ${sent[1]!.device ? "as the user's own message" : "as a user message"}), the next turn completed with its own reply, and the button is gone (${asked.length} request(s) reached the fake)`;
  });
  // 17: a bot plugin of its own with its own Live2D model in its assets (the placeholder generator's files, copied into a temp
  // folder), installed from that folder. Its tab's stage draws the model: the model's JSON files are served to that bot, so the
  // avatar frame shows its canvas and no "can't be shown" note.
  await step(17, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const stock = ctx.avatarFolder;
    if (stock === undefined) return fail("this run has no stock model folder");
    const id = "acceptance-avatar-bot";
    const name = "Acceptance Avatar Bot";
    const parent = mkdtempSync(join(tmpdir(), "clover-avatar-bot-"));
    const folder = join(parent, id); // a plugin's folder is named for its id
    mkdirSync(folder);
    mkdirSync(join(folder, "assets", "live2d"), { recursive: true });
    mkdirSync(join(folder, "bot"), { recursive: true });
    mkdirSync(join(folder, "tab"), { recursive: true });
    for (const f of ["alpha.model3.json", "alpha.moc3", "alpha.png"]) cpSync(join(stock, f), join(folder, "assets", "live2d", f));
    writeFileSync(join(folder, "bot", "instructions.md"), "You are a test bot.\n");
    writeFileSync(join(folder, "tab", "layout.json"), JSON.stringify({ layout: 1, root: { stack: [{ spot: "conversation", grow: 1 }, { spot: "bot.stage", grow: 1 }], grow: 1 } }));
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id, name, description: "The acceptance run's bot with its own Live2D model.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { bot: { name, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" }, avatar: { file: "assets/live2d/alpha.model3.json", format: "live2d" }, layout: "tab/layout.json" } },
    }));
    try {
      const installed = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
      if (installed.id !== id) fail(`the fixture installed as ${installed.id}`);
      const ok = await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === id);
      await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      await escape();
      let lastPress = 0;
      const seen = await until("its stage drawing the model", 60_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const r = await cdp.evaluate(d.session, "(() => ({ canvas: !!document.querySelector('.clvl-canvas'), refused: (document.body.innerText || '').includes(\"can't be shown\") }))()").catch(() => undefined) as { canvas: boolean; refused: boolean } | undefined;
          if (r?.refused) fail("the stage says the avatar can't be shown");
          if (r?.canvas) return true;
        }
        if (Date.now() - lastPress > 6_000) {
          lastPress = Date.now();
          await clickIn(`${name} in the sidebar`, SIDEBAR_ITEMS, name, 5_000).catch(() => undefined);
        }
        return undefined;
      }, () => dumpFrames(cdp));
      return `${id} (a bot plugin shipping its own Live2D model, the placeholder's files) installed from its folder, OK card ${ok} pressed; its stage drew the model's canvas (${seen}), with no "can't be shown" note`;
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  });
  // 18: the format is a plugin's own. The SDK's picture-swap example (a character renderer) is installed from its folder; then a bot
  // plugin whose avatar format is `pngtuber` (the example's sample model copied beside it) is installed, and its stage draws the
  // renderer's pictures: the model's JSON and pictures were served to that bot because the renderer declared them. The mouth waits
  // for the app's speech feed to reach a third-party frame (not asserted here).
  await step(18, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const exampleDir = resolve(import.meta.dir, "..", "..", "packages", "plugin-sdk", "examples", "example-pngtuber");
    const botId = "acceptance-pngtuber-bot";
    const name = "Acceptance Picture Bot";
    const parent = mkdtempSync(join(tmpdir(), "clover-pngtuber-bot-"));
    const folder = join(parent, botId);
    mkdirSync(join(folder, "model"), { recursive: true });
    mkdirSync(join(folder, "bot"), { recursive: true });
    mkdirSync(join(folder, "tab"), { recursive: true });
    cpSync(join(exampleDir, "sample-model"), join(folder, "model"), { recursive: true });
    writeFileSync(join(folder, "bot", "instructions.md"), "You are a test bot.\n");
    writeFileSync(join(folder, "tab", "layout.json"), JSON.stringify({ layout: 1, root: { stack: [{ spot: "conversation", grow: 1 }, { spot: "bot.stage", grow: 1 }], grow: 1 } }));
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: botId, name, description: "The acceptance run's bot with a community-format avatar.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { bot: { name, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" }, avatar: { file: "model/sunny.pngtuber.json", format: "pngtuber" }, layout: "tab/layout.json" } },
    }));
    const installed: string[] = [];
    try {
      for (const [dir, id] of [[exampleDir, "example-pngtuber"], [folder, botId]] as const) {
        const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
        if (r.id !== id) fail(`${id} installed as ${r.id}`);
        installed.push(id);
        await ctx.pressCard!(`${id}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === id);
        await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      }
      await escape();
      // The renderer is a third-party part: its frame is its own layer's document (clover-plugin://example-pngtuber/), never
      // one of the clover tree's, so it is looked for among every document, not the tree's.
      const rendererDocs = async () => (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://example-pngtuber/"));
      const PROBE = "(() => { const e = document.querySelector('[data-pngtuber]'); const img = e && e.querySelector('img'); return e ? { state: e.getAttribute('data-pngtuber'), loaded: !!img && img.complete && img.naturalWidth > 0, src: img ? img.getAttribute('src') : null } : null; })()";
      const allDocs = async () => (await cdp.documents()).map((d) => d.url.slice(0, 60)).join(" | ");
      let lastPress = 0;
      const first = await until("its stage drawing the renderer's picture", 60_000, async () => {
        for (const d of await rendererDocs()) {
          const r = await cdp.evaluate(d.session, PROBE).catch(() => undefined) as { state: string; loaded: boolean; src: string | null } | null | undefined;
          if (r?.state === "broken") fail("the renderer says the picture set can't be shown");
          if (r?.loaded) return { session: d.session, ...r };
        }
        if (Date.now() - lastPress > 6_000) {
          lastPress = Date.now();
          await clickIn(`${name} in the sidebar`, SIDEBAR_ITEMS, name, 5_000).catch(() => undefined);
        }
        return undefined;
      }, async () => `${await dumpFrames(cdp)} || every document: ${await allDocs()}`);
      // What the stage shows for a while (the bot is quiet: the idle picture, and the renderer's own blink every few seconds).
      const states = new Map<string, string>();
      for (const end = Date.now() + 7_000; Date.now() < end; await sleep(80)) {
        const r = await cdp.evaluate(first.session, PROBE).catch(() => undefined) as { state: string; loaded: boolean; src: string | null } | null | undefined;
        if (r?.loaded && !states.has(r.state)) states.set(r.state, (r.src ?? "").split("/").pop() ?? "");
      }
      if (!states.has("idle")) fail(`the quiet bot's stage never showed the idle picture (${[...states.keys()].join(", ") || "nothing"})`);
      if (states.has("talk")) fail("the quiet bot's stage showed the talk picture");
      const shown = [...states.entries()].map(([s, f]) => `${s} (${f})`).join(", ");
      return `the picture-swap renderer installed from its folder (OK card pressed), then ${botId} (avatar format pngtuber, the example's sample model): its stage, the renderer's own frame (${first.src?.split("/").pop()}), drew the renderer's pictures, served by what the renderer declared; over 7 s quiet it showed ${shown}`;
    } finally {
      for (const id of installed.reverse()) await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  });
  // 19: a bot's voice (§6.6). The run's fixture voice (scripts/acceptance/fixtures/acceptance-voice: a generated tone, no key, no
  // network) is installed from its folder and set as the voice of a picture-swap bot and of Alpha, the user's way (their user
  // layers). A turn of each: the core speaks the reply (`voice.play` pieces), the shell's player counts them and makes frames (the
  // test build's counters on its root: data-voice-pieces, data-voice-frames, data-voice-speaking), the picture-swap renderer shows
  // its talking picture while the bot speaks, and Alpha's stage gets frames. Then the stage's chip mutes (the app's one mute,
  // `voice.speakReplies`, through the stage's `ui.set`): the next reply plays nothing, at once, with no restart.
  await step(19, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const voiceDir = resolve(import.meta.dir, "fixtures", "acceptance-voice");
    const exampleDir = resolve(import.meta.dir, "..", "..", "packages", "plugin-sdk", "examples", "example-pngtuber");
    const botId = "acceptance-voice-bot";
    const name = "Acceptance Voice Bot";
    const parent = mkdtempSync(join(tmpdir(), "clover-voice-bot-"));
    const folder = join(parent, botId);
    for (const d of ["model", "bot", "tab"]) mkdirSync(join(folder, d), { recursive: true });
    cpSync(join(exampleDir, "sample-model"), join(folder, "model"), { recursive: true });
    writeFileSync(join(folder, "bot", "instructions.md"), "You are a test bot.\n");
    writeFileSync(join(folder, "tab", "layout.json"), JSON.stringify({ layout: 1, root: { stack: [{ spot: "conversation", grow: 1 }, { spot: "bot.stage", grow: 1 }], grow: 1 } }));
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: botId, name, description: "The acceptance run's bot that speaks.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { bot: { name, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" }, avatar: { file: "model/sunny.pngtuber.json", format: "pngtuber" }, layout: "tab/layout.json" } },
    }));
    const VOICE = { provider: "acceptance-voice", voice: "tone" };
    const installed: string[] = [];
    const voiced: string[] = [];
    type Counters = { pieces: number; frames: number; speaking: string[] };
    const counters = async (): Promise<Counters | undefined> => {
      const r = await inTree<string>(cdp, "(() => { const d = document.documentElement.dataset; return d.voicePieces === undefined ? null : JSON.stringify({ pieces: +d.voicePieces, frames: +(d.voiceFrames || 0), speaking: (d.voiceSpeaking || '').split(',').filter(Boolean) }); })()");
      return r === undefined ? undefined : JSON.parse(r.value) as Counters;
    };
    const mainOf = async (id: string) => (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === id)?.mainSession ?? fail(`no bot ${id}`);
    /** One turn of a bot's main conversation; resolves when its reply is in the log. `providerCard`: the turn first asks
     *  the user before it spends the provider the bot's plugin chose (`bot-provider`, a third party's model choice:
     *  packages/core/src/bots/provider-consent.ts), and its Approve is pressed in the window, as the user would. */
    const turn = async (bot: string, words: string, providerCard = false) => {
      const session = await mainOf(bot);
      const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
      await rpc.request("session.send", { id: session, message: { text: `${words} ${tag}`, clientMessageId: `voice-${tag}` } }, 30_000);
      if (providerCard) await ctx.pressCard!(`${bot}'s provider card (its plugin chose its model)`, (c) => c.kind === "change" && c.change === "bot-provider" && (c.session === undefined || c.session === session));
      await until(`${bot}'s reply`, 120_000, async () => {
        const events = (await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: session, limit: 200 })).events;
        return events.some((e) => e.type === "assistant_message" && typeof e.text === "string" && e.text.includes(tag)) ? true : undefined;
      });
    };
    const openTab = async (label: string) => {
      await escape();
      await clickIn(`${label} in the sidebar`, SIDEBAR_ITEMS, label);
      await sleep(500);
    };
    try {
      for (const [dir, id] of [[voiceDir, "acceptance-voice"], [exampleDir, "example-pngtuber"], [folder, botId]] as const) {
        const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
        if (r.id !== id) fail(`${id} installed as ${r.id}`);
        installed.push(id);
        await ctx.pressCard!(`${id}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === id);
        await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      }
      for (const id of [botId, "alpha"]) {
        await rpc.request("bot.setUserLayer", { id, patch: { voice: VOICE } });
        voiced.push(id);
      }

      // The picture-swap bot: its stage drawn, a watcher in the renderer's frame keeps every picture state it shows.
      await openTab(name);
      // The renderer is a third-party part: its frame is its own layer's document (clover-plugin://example-pngtuber/),
      // never one of the clover tree's (as row 26 finds it).
      const frame = await until("the picture-swap renderer's frame", 60_000, async () => {
        for (const d of (await cdp.documents()).filter((x) => x.url.startsWith("clover-plugin://example-pngtuber/"))) {
          if (await cdp.evaluate(d.session, "!!document.querySelector('[data-pngtuber]')").catch(() => false)) return { session: d.session };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.evaluate(frame.session, "(() => { const e = document.querySelector('[data-pngtuber]'); window.__voiceSeen = [e.getAttribute('data-pngtuber')]; new MutationObserver(() => window.__voiceSeen.push(e.getAttribute('data-pngtuber'))).observe(e, { attributes: true, attributeFilter: ['data-pngtuber'] }); return true; })()");
      const before = await until("the shell's voice counters", 20_000, counters);
      // A third party's bot: its first turn asks once for the provider its plugin chose (Notes keeper's does too).
      await turn(botId, "Say something.", true);
      const after = await until("the reply's speech counted and its frames made", 30_000, async () => {
        const c = await counters();
        return c !== undefined && c.pieces > before.pieces && c.frames > before.frames ? c : undefined;
      }, async () => `${JSON.stringify(await counters())}; ${ctx.appLog().split("\n").filter((l) => /voice/i.test(l)).slice(-5).join(" | ")}`);
      const shown = await until("the talking picture, then idle again", 20_000, async () => {
        const seen = (await cdp.evaluate(frame.session, "JSON.stringify(window.__voiceSeen || [])").catch(() => "[]")) as string;
        const states = JSON.parse(seen) as string[];
        return states.includes("talk") && states.at(-1) !== "talk" ? states : undefined;
      }, async () => String(await cdp.evaluate(frame.session, "JSON.stringify(window.__voiceSeen || [])").catch(() => "?")));

      // Alpha: her stage gets frames while she speaks.
      await openTab("Alpha");
      const alphaBefore = (await counters())!;
      let alphaSpoke = false;
      const alphaTurn = turn("alpha", "Say something too.");
      const alphaAfter = await until("Alpha's speech counted and its frames made", 150_000, async () => {
        const c = await counters();
        if (c?.speaking.includes("alpha")) alphaSpoke = true;
        return c !== undefined && c.pieces > alphaBefore.pieces && c.frames > alphaBefore.frames && alphaSpoke && !c.speaking.includes("alpha") ? c : undefined;
      }, async () => JSON.stringify(await counters()));
      await alphaTurn;

      // The chip mutes at once: the next reply plays nothing.
      await clickIn("the stage's mute chip", "button.cl-bot-stage__chip", undefined);
      await until("the chip saying it is muted", 10_000, () => inTree<boolean>(cdp, "document.querySelector('button.cl-bot-stage__chip')?.getAttribute('data-voice') === 'muted'"));
      const muted = (await counters())!;
      await turn("alpha", "Stay quiet.");
      await sleep(3_000);
      const quiet = (await counters())!;
      if (quiet.pieces !== muted.pieces) fail(`muted, the next reply still sent ${quiet.pieces - muted.pieces} piece(s)`);
      await clickIn("the stage's chip again (unmute)", "button.cl-bot-stage__chip", undefined);
      return `the fixture voice on ${botId} and Alpha (their user layers): ${botId}'s reply came as ${after.pieces - before.pieces} piece(s) and ${after.frames - before.frames} frame(s), and its renderer showed ${shown.join(" → ")}; Alpha's as ${alphaAfter.pieces - alphaBefore.pieces} piece(s) and ${alphaAfter.frames - alphaBefore.frames} frame(s) while she spoke; muted by the stage's chip, the next reply sent no piece`;
    } finally {
      for (const id of voiced) await rpc.request("bot.setUserLayer", { id, patch: { voice: null } }).catch(() => undefined);
      for (const id of installed.reverse()) await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  });
  // 20: the window reshaped by Alpha's tab, and the stock chrome back on every other tab. The shell's own document says the shape
  // (`data-bar-mode`, `data-sidebar-mode`, `data-collapsed`); what the user presses are Alpha's own controls and sidebar rows.
  await step(20, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const id = "acceptance-plain-bot";
    const name = "Acceptance Plain Bot";
    const parent = mkdtempSync(join(tmpdir(), "clover-plain-bot-"));
    const folder = join(parent, id);
    mkdirSync(join(folder, "bot"), { recursive: true });
    writeFileSync(join(folder, "bot", "instructions.md"), "You are a plain test bot.\n");
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id, name, description: "The acceptance run's plain bot: no layout of its own, so the stock window.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { bot: { name, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" } } },
    }));
    const win = async (expr: string) => (await inTree<string>(cdp, `(() => { const w = document.querySelector('.cl-window'); return w ? String(${expr}) : null; })()`))?.value;
    const press = async (what: string, selector: string, text?: string, ms = 20_000) => {
      const at = await until(what, ms, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.click(at.session, at.c.x, at.c.y);
      await sleep(900);
    };
    const toAlpha = async () => {
      await escape();
      if ((await inTree<boolean>(cdp, "!!document.querySelector('.ac')")) === undefined) await press("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha");
      await until("Alpha's own controls", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.ac')"), () => dumpFrames(cdp));
    };
    try {
      await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
      await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === id);
      await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      await toAlpha();
      // 1. Alpha: no stock bar, her sidebar and controls drawn by her plugin's frames.
      await until("Alpha's window shape", 20_000, async () => ((await win("w.dataset.barMode")) === "none" ? true : undefined), async () => `bar-mode ${await win("w.dataset.barMode")} || ${await dumpFrames(cdp)}`);
      if ((await win("!!document.querySelector('.cl-window__bar')")) !== "false") fail("Alpha's tab still shows the stock bar");
      if ((await win("w.dataset.sidebarMode")) !== "none") fail(`Alpha's tab does not drop the window's sidebar for her own dock (${await win("w.dataset.sidebarMode")})`);
      if ((await inTree<boolean>(cdp, "!!document.querySelector('.as')")) === undefined) fail("Alpha's own sidebar is not drawn");
      // Her room sizes itself by the window's width, read as `outerWidth` in her frame: it must be the window's own (the shell document's innerWidth), not the frame's.
      const outer = Number((await inTree<number>(cdp, "document.querySelector('.as') ? window.outerWidth : null"))?.value ?? NaN);
      const inner = Number(await win("window.innerWidth"));
      console.log(`outerWidth in her frame ${outer}, the window's innerWidth ${inner}`);
      if (!Number.isFinite(outer) || !Number.isFinite(inner) || Math.abs(outer - inner) > 40) fail(`outerWidth in her frame (${outer}) is not the window's width (${inner})`);
      if ((await inTree<boolean>(cdp, "[...document.querySelectorAll('.cl-sidebar__row')].some((e) => e.getClientRects().length > 0)")) !== undefined) fail("the stock sidebar shows beside Alpha's own");
      // 2. Her toggle folds the sidebar to the rail and opens it again (whichever it rests as in this window's width first).
      const collapsed = async () => (await win("w.dataset.collapsed === 'true'")) === "true";
      const startCollapsed = await collapsed();
      await press("her sidebar toggle", ".ac__btn", startCollapsed ? "Show the sidebar" : "Hide the sidebar");
      await until("the sidebar flipping", 10_000, async () => ((await collapsed()) !== startCollapsed ? true : undefined));
      const rail = (await inTree<boolean>(cdp, "!!document.querySelector('.as[data-rail]')")) !== undefined;
      if (rail === startCollapsed) fail("her sidebar's rows did not follow the fold (rail and full rows)");
      await press("her sidebar toggle again", ".ac__btn", startCollapsed ? "Hide the sidebar" : "Show the sidebar");
      await until("the sidebar back", 10_000, async () => ((await collapsed()) === startCollapsed ? true : undefined));
      // 3. Her panel control, when a plugin fills a panel a bot tab can open (none does in a tree with no browser panel: then she offers none).
      const offered = (await inTree<boolean>(cdp, "!!document.querySelector('.ac__act[aria-label=Browser]')")) !== undefined;
      let panels = "no plugin fills a panel a bot tab can open in this tree, so her controls offer none";
      if (offered) {
        await press("her Browser control", ".ac__act", "Browser");
        await until("the panel sheet open", 10_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-chrome-panels .cl-panel')"));
        await press("her Browser control again", ".ac__act", "Browser");
        await until("the panel sheet closed", 10_000, async () => ((await inTree<boolean>(cdp, "!!document.querySelector('.cl-chrome-panels .cl-panel')")) === undefined ? true : undefined));
        panels = "her Browser control opened the panel in her sheet and closed it";
      }
      // 3b. Her stage tools: each is present; one that the figure's renderer can do opens its list (Expression, from the model's catalogue), the others say why not.
      const toolNames = (await inTree<string>(cdp, "(() => { const t = [...document.querySelectorAll('.rm__tool')]; return t.length ? JSON.stringify(t.map(e => e.getAttribute('aria-label') + ':' + (e.getAttribute('aria-disabled') ?? 'on'))) : null; })()"))?.value ?? "[]";
      if (!/Expression/.test(toolNames)) fail(`her stage tools are not drawn (${toolNames})`);
      let stageTools = `her stage tools were drawn (${toolNames})`;
      if ((await inTree<boolean>(cdp, "!!document.querySelector('.rm__tool[aria-label=Expression]:not([aria-disabled])')")) !== undefined) {
        await press("her Expression tool", ".rm__tool", "Expression");
        await until("her expression list", 10_000, () => inTree<boolean>(cdp, "!!document.querySelector('.rm__list [role=menuitem]')"));
        await press("her Expression tool again", ".rm__tool", "Expression");
        stageTools += "; Expression opened a list of the model's own expressions";
      }
      // 4. A plain bot: the stock bar and the stock sidebar are back.
      await press(`${name} in her sidebar`, ".as__row", name);
      await until("the stock bar back", 20_000, async () => ((await win("!!document.querySelector('.cl-window__bar') && w.dataset.barMode")) === "standard" ? true : undefined), async () => `${await win("w.dataset.barMode")} || ${await dumpFrames(cdp)}`);
      if ((await inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar__row')")) === undefined) fail("the plain bot's tab has no stock sidebar");
      if ((await inTree<boolean>(cdp, "!!document.querySelector('.as')")) !== undefined) fail("Alpha's sidebar is still drawn on a plain bot's tab");
      // 5. Back to Alpha (her chrome returns), then the Code side when this run has a coding session (the stock chrome returns on it too).
      await press("Alpha in the stock sidebar", SIDEBAR_ITEMS, "Alpha");
      await until("her chrome back", 20_000, async () => ((await win("w.dataset.barMode")) === "none" ? true : undefined));
      const code = (await rpc.request<{ sessions: { kind?: string }[] }>("conversation.list", {}).catch(() => ({ sessions: [] }))).sessions.some((x) => x.kind === "coding");
      let side = "this run has no coding session, so her Code switch had nowhere to go (not pressed)";
      if (code) {
        await press("her Code switch", ".as__opt", "Code");
        await until("the stock bar on the Code side", 20_000, async () => ((await win("!!document.querySelector('.cl-window__bar') && w.dataset.barMode")) === "standard" ? true : undefined));
        side = "her Code switch brought the stock bar and sidebar";
        await press("Alpha in the stock sidebar", SIDEBAR_ITEMS, "Alpha");
      }
      return `on Alpha's tab no stock bar (bar-mode none) and the stock sidebar absent, her own sidebar and controls drawn; her toggle folded the sidebar to the rail and back; ${panels}; ${stageTools}; ${name}'s tab brought the stock bar and sidebar back, and Alpha's brought her chrome back; ${side}`;
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
      await toAlpha().catch(() => undefined);
    }
  });

  // 21: changing one thing, the owner's questions. A bot plugin whose `tab/layout.json` extends the stock tab and states
  // three changes (the tab a row, so the stage stands to the left of the transcript; the stage wider; the bot's header
  // at the top of the transcript's column), with one `ui` entry that hides the composer's model button (a keyed
  // `composer.action`) in its own tab and one that takes another plugin's Pin button out of its header (a list spot's
  // hide, by `target`). A second plugin, not the bot's, rearranges that tab with a layout patch: the header moves to
  // just above the composer, in a row of its own that its CSS nudges up 6 px. The user switches that patch off in the
  // bot editor (the header goes back), sets a layout of their own in the user layer (the tab a column) and resets it.
  // Its stage shows the placeholder's Live2D model. Rendered wide and narrow, light and dark, with CLOVER_ACCEPT_RENDERS.
  await step(21, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const stock = ctx.avatarFolder;
    if (stock === undefined) return fail("this run has no stock model folder");
    const id = "acceptance-layout-patch";
    const moverId = "acceptance-layout-mover";
    const name = "Acceptance Layout Patch";
    const parent = mkdtempSync(join(tmpdir(), "clover-layout-patch-"));
    const folder = join(parent, id);
    const moverFolder = join(parent, moverId);
    cpSync(resolve(import.meta.dir, "fixtures", id), folder, { recursive: true });
    cpSync(resolve(import.meta.dir, "fixtures", moverId), moverFolder, { recursive: true });
    mkdirSync(join(folder, "assets", "live2d"), { recursive: true });
    for (const f of ["alpha.model3.json", "alpha.moc3", "alpha.png"]) cpSync(join(stock, f), join(folder, "assets", "live2d", f));
    const cls = (c: string) => `clv-${id}__${c}`;
    const nudgeCls = `clv-${moverId}__nudge`;
    // The talk column's own children, in order: where the header (and its nudge row) and the composer are.
    const MEASURE = `(() => {
      const tab = document.querySelector('.${cls("tab")}'); const stage = document.querySelector('.${cls("stage")}'); const talk = document.querySelector('.${cls("talk")}');
      if (!tab || !stage || !talk) return null;
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      const modelButton = [...talk.querySelectorAll('button.cl-composer__pill')].some((b) => (b.getAttribute('aria-label') || '').startsWith('Model:'));
      const kids = [...talk.children];
      const at = (sel) => kids.findIndex((k) => k.matches(sel) || !!k.querySelector(sel));
      const nudge = talk.querySelector('.${nudgeCls}');
      return { tab: r(tab), stage: r(stage), talk: r(talk), row: getComputedStyle(tab).flexDirection, canvas: !!stage.querySelector('.clvl-canvas'), composer: !!talk.querySelector('textarea'), modelButton,
        header: at('.cl-bot-header'), composerAt: at('textarea'), kids: kids.length, nudged: nudge ? getComputedStyle(nudge).transform : null,
        inNudge: nudge ? !!nudge.querySelector('.cl-bot-header') : false, buttons: talk.querySelector('.cl-bot-header') ? talk.querySelector('.cl-bot-header').querySelectorAll('iframe').length : -1 };
    })()`;
    type Box = { x: number; y: number; w: number; h: number };
    type Measured = { tab: Box; stage: Box; talk: Box; row: string; canvas: boolean; composer: boolean; modelButton: boolean; header: number; composerAt: number; kids: number; nudged: string | null; inNudge: boolean; buttons: number };
    const installed: string[] = [];
    const before = await rpc.request<{ lists?: unknown[] }>("ui.settings", {}).catch(() => undefined);
    let lastPress = 0;
    const shows = async <T,>(bot: string, expr: string, what: string, ok: (m: T) => boolean, ms = 60_000) => (await until(what, ms, async () => {
      const m = await inTree<T>(cdp, expr);
      if (m !== undefined && ok(m.value)) return m;
      if (Date.now() - lastPress > 6_000) {
        lastPress = Date.now();
        await clickIn(`${bot} in the sidebar`, SIDEBAR_ITEMS, bot, 5_000).catch(() => undefined);
      }
      return undefined;
    }, () => dumpFrames(cdp))).value;
    const tabShows = (what: string, ok: (m: Measured) => boolean, ms = 60_000) => shows<Measured>(name, MEASURE, what, (m) => m.canvas && m.composer && ok(m), ms);
    // A switch in the bot editor, brought into view (the rows are below its fold), pressed, and seen to flip.
    const flip = async (label: string, to: boolean) => {
      const sw = `button[role=switch][aria-label="${label}"]`;
      await until(`the switch "${label}"`, 30_000, () => inTree<boolean>(cdp, `document.querySelector('${sw}')?.getAttribute('aria-checked') === '${!to}'`), () => dumpFrames(cdp));
      await inTree<boolean>(cdp, `(() => { const e = document.querySelector('${sw}'); if (!e) return false; e.scrollIntoView({ block: "center" }); return true; })()`);
      await sleep(300);
      await clickIn(`the switch "${label}"`, sw, undefined);
      await until(`the switch "${label}", ${to ? "on" : "off"}`, 20_000, () => inTree<boolean>(cdp, `document.querySelector('${sw}')?.getAttribute('aria-checked') === '${to}'`), () => dumpFrames(cdp));
    };
    // The plain bot: no layout of its own; the mover places its top-bar Edit button just above the composer, and
    // takes its conversation out.
    const plainId = "acceptance-layout-plain";
    const plainName = "Acceptance Layout Plain";
    const plainFolder = join(parent, plainId);
    mkdirSync(join(plainFolder, "bot"), { recursive: true });
    writeFileSync(join(plainFolder, "bot", "instructions.md"), "You are a plain test bot.\n");
    writeFileSync(join(plainFolder, "clover.json"), JSON.stringify({
      manifest: 1, id: plainId, name: plainName, description: "The acceptance run's plain bot: no layout of its own; another plugin rearranges its tab.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { bot: { name: plainName, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" } } },
    }, null, 2));
    const PLAIN = `(() => {
      const tab = document.querySelector('.clv-${plainId}__tab'); const talk = document.querySelector('.clv-${plainId}__talk');
      if (!tab || !talk) return null;
      const kids = [...talk.children]; const nudge = talk.querySelector('.${nudgeCls}');
      const edit = 'button[aria-label="Edit ${plainName}"]';
      return { kids: kids.length, nudgeAt: nudge ? kids.findIndex((k) => k === nudge || k.contains(nudge)) : -1, composerAt: kids.findIndex((k) => !!k.querySelector('textarea')),
        editInTab: nudge ? nudge.querySelectorAll(edit).length : 0, edits: document.querySelectorAll(edit).length, conv: !!tab.querySelector('.cl-conv'), nudged: nudge ? getComputedStyle(nudge).transform : null };
    })()`;
    type Plain = { kids: number; nudgeAt: number; composerAt: number; editInTab: number; edits: number; conv: boolean; nudged: string | null };
    try {
      for (const [pid, dir] of [[id, folder], [plainId, plainFolder], [moverId, moverFolder]] as const) {
        const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
        if (r.id !== pid) fail(`the fixture installed as ${r.id}`);
        installed.push(pid);
        await ctx.pressCard!(`${pid}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === pid);
        await until(`${pid} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: pid }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      }
      // Out of any dialog (on Alpha's own tab there is no stock sidebar to find: nothing to close then).
      await escape().catch(() => undefined);
      // The bot's layout and the mover's patch: the header just above the composer, in the mover's row, nudged 6 px up.
      await tabShows("its tab arranged by its layout and the mover's patch, the model on its stage", (m) => m.inNudge && m.buttons >= 1 && (m.nudged ?? "").includes("-6"));
      await sleep(1_500);
      const m = await tabShows("its tab, settled", () => true, 10_000);
      if (m.stage.x + m.stage.w > m.talk.x + 1) fail(`the stage isn't to the left of the transcript (${JSON.stringify(m)})`);
      const share = m.stage.w / m.tab.w;
      if (m.stage.w < 279 || share < 0.36 || share > 0.48) fail(`the stage is ${m.stage.w} px of a ${m.tab.w} px tab (${Math.round(share * 100)}%), not about 42%`);
      if (Math.abs(m.stage.h - m.talk.h) > 2) fail(`the stage and the transcript aren't side by side (heights ${m.stage.h} and ${m.talk.h})`);
      if (m.modelButton) fail("the composer in its tab still shows the model button its hide entry takes out");
      if (!(m.header === m.composerAt - 1 && m.header > 0)) fail(`the header isn't just above the composer (header at ${m.header}, composer at ${m.composerAt} of ${m.kids})`);
      if (m.nudged !== "matrix(1, 0, 0, 1, 0, -6)") fail(`the mover's row isn't nudged 6 px up (transform ${m.nudged})`);
      if (m.buttons !== 1) fail(`the header shows ${m.buttons} of the mover's buttons; the bot's list hide takes Pin out, so Wave alone`);
      const rendered: string[] = [];
      const renders = process.env.CLOVER_ACCEPT_RENDERS;
      const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
      if (renders && appRoot !== undefined) {
        try {
          for (const [label, width] of [["wide", 1280], ["narrow", 900]] as const) {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false }, appRoot.session);
            for (const scheme of ["light", "dark"] as const) {
              ctx.setAppearance?.(scheme);
              for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
              await layGround(cdp, scheme);
              await sleep(1_500);
              const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, appRoot.session) as { data: string };
              const file = `layout-patch-${label}-${scheme}.png`;
              writeFileSync(join(renders, file), Buffer.from(shot.data, "base64"));
              rendered.push(file);
            }
          }
        } finally {
          await unshootWindow(cdp, ctx.setAppearance);
        }
      }
      // The user, in the bot editor: switches the mover's patch off (the header goes back to the top of the transcript),
      // and shows the Pin button the bot's plugin hid (both header buttons then).
      await clickIn(`${name}'s Edit button`, `button[aria-label="Edit ${name}"]`, undefined);
      await flip("Acceptance Layout Mover rearranges this tab", false);
      await flip("Show Pin", true);
      await clickIn("Back to the bot", ".cl-bot-editor button", "Back to the bot");
      const off = await tabShows("its tab with the mover's patch off and Pin shown: the header back on top, both buttons in it", (x) => x.header === 0 && !x.inNudge && x.buttons === 2, 30_000);
      // The user's own layout (the user layer's `layout`), last: the tab a column, the stage above the transcript; Reset.
      const userLayout = JSON.stringify({ layout: 1, extends: "bot", changes: [{ set: ".tab", as: "column" }] });
      const set = await rpc.request<{ applied?: boolean }>("bot.setUserLayer", { id, patch: { layout: userLayout } });
      if (set.applied !== true) fail(`the user layer's layout wasn't applied (${JSON.stringify(set)})`);
      // The core's side first: the bot's view hands the app the user's layout.
      await until("plugin.ui handing over the user's layout", 10_000, async () => {
        const views = await rpc.request<{ plugins: { pluginId: string; bot?: { userLayout?: string } }[] }>("plugin.ui", {}).catch(() => undefined);
        return views?.plugins.find((p) => p.pluginId === id)?.bot?.userLayout === userLayout ? true : undefined;
      });
      const mine = await tabShows("its tab with the user's own layout: a column", (x) => x.row === "column" && x.stage.y + x.stage.h <= x.talk.y + 2, 30_000);
      await rpc.request("bot.setUserLayer", { id, patch: { layout: null } });
      await tabShows("its tab after Reset: a row again", (x) => x.row === "row", 30_000);
      // The owner's exact example on the plain bot: its top-bar Edit button just above its composer, nudged, and gone from
      // the bar; the patch also took the conversation out. The way back from that tab: its Edit button, then the switch.
      const p0 = await shows<Plain>(plainName, PLAIN, "the plain bot's tab: the Edit button above the composer, no conversation", (x) => x.editInTab === 1 && (x.nudged ?? "").includes("-6"));
      if (!(p0.nudgeAt === p0.composerAt - 1)) fail(`the Edit button isn't just above the composer (row at ${p0.nudgeAt}, composer at ${p0.composerAt} of ${p0.kids})`);
      if (p0.edits !== 1) fail(`the plain bot's Edit button shows ${p0.edits} times; placed in the tab, it leaves the bar`);
      if (p0.conv) fail("the plain bot's tab still draws the conversation its patch removes");
      await clickIn("the plain bot's Edit button, in its tab", `.${nudgeCls} button[aria-label="Edit ${plainName}"]`, undefined);
      await flip("Acceptance Layout Mover rearranges this tab", false);
      await clickIn("Back to the bot", ".cl-bot-editor button", "Back to the bot");
      const p1 = await shows<Plain>(plainName, PLAIN, "the plain bot's tab with the patch off: the conversation drawn, the Edit button back in the bar", (x) => x.conv && x.editInTab === 0 && x.nudgeAt === -1 && x.edits === 1, 30_000);
      // Its hide is its own tab's: Alpha's composer keeps the model button.
      await escape().catch(() => undefined);
      await clickIn("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha");
      await until("Alpha's composer with its model button", 20_000, () => inTree<boolean>(cdp, "[...document.querySelectorAll('button.cl-composer__pill')].some((b) => (b.getAttribute('aria-label') || '').startsWith('Model:'))"), () => dumpFrames(cdp));
      return `${id} (tab/layout.json: extends the stock tab, 3 changes; two hide entries) and ${moverId} (a patch to that tab, its own CSS) installed from their folders: its stage ${m.stage.w} px (${Math.round(share * 100)}% of the ${m.tab.w} px tab) stands left of the transcript (${m.talk.w} px), the model drawn on it; the header moved to just above the composer (child ${m.header} of ${m.kids}) in the mover's row, ${m.nudged}; one of the mover's two header buttons (Pin hidden by the bot's list hide); no model button in its composer, Alpha's keeps hers; in the bot editor the mover switched off and Pin shown again: the header back on top (child ${off.header}) with ${off.buttons} buttons; on ${plainId} (no layout of its own) the top-bar Edit button sat just above the composer (row ${p0.nudgeAt}, composer ${p0.composerAt}), ${p0.nudged}, once in the window, with the conversation removed; pressed there, its editor switched the patch off and the conversation came back (${p1.edits} Edit button, in the bar); the user's own layout made the tab a column (stage ${mine.stage.h} px over the transcript) and Reset made it a row again${rendered.length > 0 ? `; rendered ${rendered.join(", ")}` : ""}`;
    } finally {
      await rpc.request("bot.setUserLayer", { id, patch: { layout: null } }).catch(() => undefined);
      if (before?.lists !== undefined) await rpc.request("ui.set", { patch: { lists: before.lists } }).catch(() => undefined);
      for (const pid of installed.reverse()) await rpc.request("plugin.remove", { id: pid }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  });
}
