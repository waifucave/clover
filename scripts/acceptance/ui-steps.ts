// The acceptance run's UI steps: what a person does in the window, driven over the Chrome DevTools protocol against the
// headless, offscreen app (cdp.ts): type in the composer and send, read the bot's reply in the conversation, pick a
// model, open Settings, change a setting and see it stay, and drag the window by its title area. Each step reads the
// real DOM of the real layer frames and the daemon's own state; none of them calls the core's methods for the app.
// The inputs are trusted input events (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), which the main process sees
// as the person's key presses and clicks: if one doesn't register with the send gate, it is this driver that is wrong,
// never the gate.
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseIpcLine } from "../../apps/desktop/src/main/ui/ipc-stats";
import type { Cdp } from "./cdp";
import type { CloverClient } from "./client";
import { BOT_PARTS_BOT, BOT_PARTS_CLIENT, BOT_PARTS_SETTINGS, FIELDS_IDS, writeBotParts } from "./manifest-fields-step";

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
  "a bot's question card (AskUserQuestion) takes a pressed option and Send answer in the window and the turn goes on with the answer; a turn that fails shows Try again on its error row; one click sends the same message again (the user's own, byte for byte), the turn completes, the button goes, and nothing was sent twice",
  "a third-party bot plugin that ships its own Live2D model (the placeholder's files) draws it on its stage, with no \"can't be shown\" note",
  "a third-party character renderer (the SDK's picture-swap example) installed from its folder: a bot plugin whose avatar format is its own draws its pictures on its stage",
  "a bot with a voice speaks its reply (the run's fixture voice, a tone): the app gets the pieces and makes frames, the picture-swap bot shows its talking picture while it speaks and Alpha's stage gets frames too; the stage's chip mutes at once and the next reply stays silent",
  "Alpha's tab shows the stock sidebar exactly as on a plain bot's tab (same rows, size and colours) and her own top bar; her toggle folds the stock sidebar and back, her panel control opens and closes the panel sheet; a plain bot's tab keeps the stock bar; more scoped wins: an all-bots composer style loses to Alpha's own on her tab and shows on the plain bot's",
  "a bot plugin changes one thing in its tab: a layout of a few lines that extends the stock tab stands its stage to the left of the transcript, wider, and a hide entry takes the composer's model button out of its tab only",
  "an idle app with Alpha's tab open stays cheap: the main process under a small CPU budget and the windows and main trading only a few messages a second, counted by channel",
  "a third-party media plugin page (the `files` capability) opens a generated video with the app's file picker (a token, never a path), plays it from the media URL with a range answered and one past the end refused, runs a WebAssembly module from its own folder, and gets a token from the save picker",
  "a third-party plugin fills the window's spots in Alpha's tab (composer.action, conversation.message, .extra, tool.result, the Dispatch pill's pill.target) and its page tries the UI SDK's hooks",
  "a plugin with a bot (the plug rule): its Browser panel replaces the stock one on its bot's tab only, and a replacement that doesn't draw gives way to the stock panel with a way to try again; its settings are on its bot's Edit page; the Plugins page's switch for its parts beside the bot is pressed and the bot is kept",
] as const;

/** A coding session in a folder of the run's user home, started when the run has none (`agent.start` as
 *  the app starts one); true when one is listed by `session.list`. Its folder: `alpha-code-work`. */
async function ensureCodingSession(ctx: Ctx): Promise<boolean> {
  const rpc = ctx.rpc;
  const listed = async () => (await rpc.request<{ sessions: { kind?: string }[] }>("session.list", { kinds: ["agent", "coding"] }).catch(() => ({ sessions: [] }))).sessions.some((x) => x.kind === "coding");
  if (await listed()) return true;
  const computerName = (await rpc.request<{ computers: { name: string }[] }>("computer.list", {}).catch(() => ({ computers: [] }))).computers[0]?.name;
  if (ctx.home === undefined || computerName === undefined) return false;
  const dir = join(dirname(ctx.home), "alpha-code-work");
  mkdirSync(dir, { recursive: true });
  await rpc.request("agent.start", { backend: "clover-code", computer: computerName, root: `home/${computerName}/alpha-code-work` }, 60_000);
  return listed();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Failed extends Error {}
const fail = (m: string): never => { throw new Failed(m); };

interface Ctx {
  cdp: Cdp; rpc: CloverClient; reply: string; /** What the fake model provider has been asked, in order. */ requests(): { model?: string; lastUserText: string; answered?: string; toolResult?: { text: string; isError: boolean } }[]; /** The app's own log file, <home>/logs/app.log, as text. */ appLog(): string;
  /** What the Settings step set, as the daemon keeps it (the upgrade's first half records it). */
  onSetting?(key: string, value: unknown): void;
  /** Runs a turn that raises a tool card, calls `inspect` with the card while it is pending, then presses its Approve in the window. */
  cardTurn?(inspect: (card: { id: string; kind: string }) => Promise<void>): Promise<void>;
  /** Waits for a pending card `match` picks, and presses its Approve in the window (the real way); its id. */
  pressCard?(what: string, match: (card: { id: string; kind: string; change?: string; session?: string; pluginId?: string }) => boolean): Promise<string>;
  /** The run's daemon home (the plugins' data folders are under it, `plugin-data/<top>`), to seed and read what a removal with its data deletes. */
  home?: string;
  /** The core's UI settings as the daemon keeps them (<home>/settings/ui.json; `ui.settings` is the app role's, and the packaged run's connection is the CLI's). */
  uiSettings(): { appearance?: string };
  /** Sets the window's dark or light (the renders; the app follows a file the run writes). */
  setAppearance?(scheme: "dark" | "light" | "system"): void;
  /** Main presses a key chord in the window (`webContents.sendInputEvent`), from a file the build watches. */
  pressKey?(key: string, modifiers: string[]): void;
  /** The folder the test build's picker gives (CLOVER_TEST_PICK) and the plugin it holds. */
  pickFolder?: { path: string; id: string; name: string; tool: string };
  /** Only these window steps run (`--only-ui`), by their place in UI_STEPS; the others are skipped, not recorded. */
  only?: ReadonlySet<number>;
  /** Names the folder the test build's picker gives from now on (it reads its `.pick` file at each pick). */
  setPick?(folder: string): void;
  /** The folder the test build's picker gives a bot editor's avatar import (CLOVER_TEST_PICK_AVATAR): the stock model and a credit note. */
  avatarFolder?: string;
  /** The media plugin's pickers (CLOVER_TEST_PICK_FILES): the answers file, the generated test video it opens and the file it saves. */
  mediaPicks?: { answers: string; video: string; saved: string; folder: string };
  /** Lets the fake provider's turns `ACCEPTANCE-FAIL-<id>` succeed from now on (the Try again step). */
  healFake?(id: string): void;
  /** Runs the user's `clover-core app screenshot --window main --out <dir>` (the target's own CLI) into a fresh folder:
   *  its exit code, what it printed, and the folder. */
  appScreenshot?(): Promise<{ code: number; stdout: string; stderr: string; dir: string }>;
  /** Runs the user's `clover-core app <words>` (the target's own CLI): its exit code and what it printed. */
  appCli?(words: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
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
  // Alpha's own frames too (her controls): while her tab shows there is no stock bar, her controls are what the user presses; the stock sidebar is beside her tab, as on every tab.
  return (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/") || d.url.startsWith("clover-plugin://alpha"));
}

/** The window's own sidebar's items: the stock sidebar is beside every tab, Alpha's too (Bots doesn't offer a bot the sidebar). */
const SIDEBAR_ITEMS = ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]";

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
/** A failed row's evidence, where the run keeps renders (CLOVER_ACCEPT_RENDERS): the window's picture as it stood
 *  (`failed-step-<n>.png`; a window step's own number as `window-<n>`) and every document's address, words and buttons
 *  (`failed-step-<n>.txt`), the frames of plugins
 *  outside Clover's tree included. Returns a note for the row's detail, or "" when nothing was kept. Never throws. */
export async function failureShot(cdp: Cdp, n: number | string): Promise<string> {
  const dir = process.env.CLOVER_ACCEPT_RENDERS;
  if (!dir) return "";
  const kept: string[] = [];
  try {
    writeFileSync(join(dir, `failed-step-${n}.png`), await cdp.screenshot());
    kept.push(`failed-step-${n}.png`);
  } catch { /* no main window to capture */ }
  try {
    const lines: string[] = [];
    for (const d of await cdp.documents()) {
      const seen = await cdp.evaluate(d.session, "JSON.stringify({ text: (document.body ? document.body.innerText : '').slice(0, 3000), buttons: [...document.querySelectorAll('button, [role=tab]')].slice(0, 120).map((b) => b.getAttribute('aria-label') || (b.innerText || '').trim().slice(0, 30)), frames: document.querySelectorAll('iframe').length, html: document.body ? document.body.innerHTML.length : 0, scroll: [window.scrollY, document.documentElement.scrollHeight, window.innerHeight] })").catch(() => "gone");
      lines.push(`${d.url.slice(0, 120)} ${String(seen).slice(0, 8000)}`);
    }
    writeFileSync(join(dir, `failed-step-${n}.txt`), `${lines.join("\n")}\n`);
    kept.push(`failed-step-${n}.txt`);
  } catch { /* the window is gone */ }
  return kept.length === 0 ? "" : ` [kept: ${kept.join(", ")}]`;
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

/** A document's drawn text: `innerText`, plus the conversation rows that are drawn but scrolled out of view. A row off
 *  screen has its contents skipped by `content-visibility: auto` (the conversation's styles.css puts it on the row
 *  itself), and `innerText` leaves skipped contents out, so a count or an absence over the transcript would miss it.
 *  The row itself is not skipped (only what is inside it), so `checkVisibility({ contentVisibilityAuto: true })` is
 *  asked of its first child: false there, with the row itself drawn, means its contents were skipped, and the row is
 *  added back by its `textContent` (as is a row under a skipped ancestor). A row hidden for any other reason (a
 *  `display: none` tab, the row's own `checkVisibility()` false) stays out, as `innerText` keeps it. The first reader
 *  asked the row alone, which is never skipped itself: rows scrolled out stayed uncounted (rows 9 and 13's "3 to 3"). */
export const DRAWN_TEXT_JS = "(() => { const b = document.body; if (!b) return ''; let t = b.innerText; for (const u of document.querySelectorAll('.cl-conv__unit')) { if (typeof u.checkVisibility !== 'function' || !u.checkVisibility()) continue; const k = u.firstElementChild; const skipped = !u.checkVisibility({ contentVisibilityAuto: true }) || (k !== null && typeof k.checkVisibility === 'function' && !k.checkVisibility({ contentVisibilityAuto: true })); if (skipped) t += '\\n' + u.textContent; } return t; })()";

/** Text drawn in any tree document, rows scrolled out of view included (DRAWN_TEXT_JS). */
export async function treeText(cdp: Cdp): Promise<string> {
  return (await Promise.all((await treeDocs(cdp)).map((d) => cdp.evaluate(d.session, DRAWN_TEXT_JS).catch(() => "")))).join("\n");
}

/** How many of the fake provider's replies the text holds: one per reply bubble (each carries the marker once). */
export const replyCount = (text: string): number => (text.match(/ACCEPTANCE-REPLY-OK/g) ?? []).length;

/** A document's reply bubbles: in a conversation, its rows that hold the fake's marker, one each, whether in view or
 *  scrolled out (a row's `textContent` can hold its words more than once: a copy kept for its Copy button, a folded
 *  detail), and never a row hidden with its tab (`checkVisibility()` false); in any other document, the marker in its
 *  drawn text. Counting rows, not words, keeps a row that scrolls out from counting twice (the 4 -> 6 a text count gave). */
export function replyRowsJs(marker = "ACCEPTANCE-REPLY-OK", rowsOnly = false): string {
  return `(() => { const b = document.body; if (!b) return 0; const m = ${JSON.stringify(marker)}; const rows = [...document.querySelectorAll('.cl-conv__unit')]; if (rows.length === 0) return ${rowsOnly ? "0" : "b.innerText.split(m).length - 1"}; return rows.filter((u) => (typeof u.checkVisibility !== 'function' || u.checkVisibility()) && (u.textContent || '').includes(m)).length; })()`;
}
export const REPLY_ROWS_JS = replyRowsJs();

/** The reply bubbles in every tree document (REPLY_ROWS_JS): every reply's, or (`marker`) those holding one reply's own
 *  words; `rowsOnly` counts conversation rows alone, never a document's drawn text (the pill shows the latest reply). */
export async function replyRows(cdp: Cdp, marker?: string, rowsOnly = false): Promise<number> {
  const js = marker === undefined && !rowsOnly ? REPLY_ROWS_JS : replyRowsJs(marker, rowsOnly);
  return (await Promise.all((await treeDocs(cdp)).map(async (d) => Number(await cdp.evaluate(d.session, js).catch(() => 0)) || 0))).reduce((a, b) => a + b, 0);
}

const STOPPED = "This part stopped.";
const stoppedAnywhere = async (cdp: Cdp): Promise<boolean> => (await Promise.all((await cdp.documents()).map((d) => cdp.evaluate(d.session, DRAWN_TEXT_JS).catch(() => "")))).some((t) => String(t).includes(STOPPED));

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
export async function shootWindow(cdp: Cdp, dir: string, name: string, setAppearance?: (scheme: "dark" | "light" | "system") => void, width = 1280): Promise<string[]> {
  const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
  if (appRoot === undefined) return [];
  const out: string[] = [];
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false }, appRoot.session);
  for (const scheme of ["dark", "light"] as const) {
    setAppearance?.(scheme);
    for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
    await layGround(cdp, scheme);
    await new Promise((r) => setTimeout(r, 1_500));
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, appRoot.session) as { data: string };
    const file = `plugins-${name}${width === 1280 ? "" : `-w${width}`}-${scheme}.png`;
    writeFileSync(join(dir, file), Buffer.from(shot.data, "base64"));
    out.push(file);
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
    if (ctx.only !== undefined && !ctx.only.has(n)) return;
    try { record(n, "PASS", await run()); } catch (err) { const kept = await failureShot(cdp, `window-${n}`); record(n, err instanceof Failed ? "FAIL" : "FAIL", `${err instanceof Error ? err.message : String(err)}${kept}`); }
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
    // The stock sidebar is beside every tab, Alpha's too: its title row is pressed where the window shows it.
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
    // A press and move sent to the page also select what they cross (the sidebar's words, and her frames beside it); a real
    // drag of a title area is the system's and selects nothing, so the selection the synthetic one left is taken back.
    await cdp.evaluate(side.session, "(() => { getSelection()?.removeAllRanges(); return true; })()").catch(() => undefined);
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
    const replies = () => replyRows(cdp);
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
    // This turn's own reply, one bubble (its words carry the tag): another of Alpha's turns landing in the window meanwhile
    // (a routine's, a reply the daemon finished at its start) adds a bubble of its own, never one of this reply's.
    const after = await replies();
    const mine = await replyRows(cdp, `${ctx.reply} ${tag}`, true);
    if (mine !== 1) fail(`this turn's reply shows in ${mine} bubbles, not one (all reply bubbles ${before} -> ${after})`);
    const left = await cdp.evaluate(s, `document.querySelector('${COMPOSER_BOX}') ? document.querySelector('${COMPOSER_BOX}').value : ''`);
    if (String(left).length > 0) fail(`the draft is still in the text box after the send ("${String(left).slice(0, 40)}")`);
    return `the message ${tag} was sent from the composer and its own reply is on screen, in one bubble (all reply bubbles ${before} -> ${after})`;
  });

  // 2: the model picker.
  // The menu's model rows, and its Effort section's (the current model's levels; none for a model that takes no effort).
  const MODEL_ROWS = '[role=menu] [role=group]:not([aria-label="Effort"]) [role=menuitemradio]';
  const EFFORT_ROWS = '[role=menu] [role=group][aria-label="Effort"] [role=menuitemradio]';
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
      const r = await cdp.evaluate(pill.session, `JSON.stringify([...document.querySelectorAll('${MODEL_ROWS}')].map((e) => ({ t: (e.innerText || '').trim(), c: e.getAttribute('aria-checked') })))`);
      const list = JSON.parse(String(r)) as { t: string; c: string }[];
      return list.length > 0 ? list : undefined;
    }, async () => `pill: ${String(await cdp.evaluate(pill.session, "(() => { const b = document.querySelector('.cl-composer button[aria-label^=Model]'); return b ? 'expanded=' + b.getAttribute('aria-expanded') + ' menus=' + document.querySelectorAll('[role=menu]').length + ' radios=' + document.querySelectorAll('[role=menuitemradio]').length + ' items=' + document.querySelectorAll('[role=menuitem]').length + ' text=' + [...document.querySelectorAll('[role=menu]')].map((e) => e.innerText.slice(0, 80)).join('|') : 'gone'; })()").catch(() => "gone"))}`);
    if (items.length < 2) fail(`the picker lists ${items.length} model(s): ${items.map((i) => i.t).join(", ")}`);
    // Only the signed-in provider's models are listed first: the run's one stored key is Anthropic's.
    if (items.length > 100) fail(`the picker lists ${items.length} models up front: every provider's, signed in or not`);
    const other = items.findIndex((i) => i.c !== "true");
    // The menu scrolls inside its own box (the catalog is more than a thousand models): bring the row into view as a person would.
    const pick = await cdp.evaluate(pill.session, `(() => { const e = [...document.querySelectorAll('${MODEL_ROWS}')][${other}]; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
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
    // The effort: the menu offers the picked model's levels (the model list's own), and a pick is the bot's effort.
    const listed = await rpc.request<{ models: { id: string; efforts?: string[] }[] }>("models.list", {});
    const levels = listed.models.find((m) => m.id === now)?.efforts ?? [];
    let effortNote = `${now} takes no effort setting: no Effort section expected`;
    const again = await until("the model pill, for the effort", 10_000, () => cdp.centerOf(pill.session, ".cl-composer button[aria-label^=\"Model:\"]").catch(() => undefined));
    await cdp.click(pill.session, again.x, again.y);
    await until("the picker open again", 10_000, async () => (Number(await cdp.evaluate(pill.session, `document.querySelectorAll('${MODEL_ROWS}').length`)) > 0 ? true : undefined));
    const shown = JSON.parse(String(await cdp.evaluate(pill.session, `JSON.stringify([...document.querySelectorAll('${EFFORT_ROWS}')].map((e) => ({ t: (e.innerText || '').trim(), c: e.getAttribute('aria-checked') })))`))) as { t: string; c: string }[];
    if (shown.map((e) => e.t).join(",") !== levels.join(",")) fail(`the picker's Effort section shows [${shown.map((e) => e.t).join(", ")}] for ${now}, whose levels are [${levels.join(", ")}]`);
    if (levels.length > 1) {
      const at = shown.findIndex((e) => e.c !== "true");
      const row = await cdp.evaluate(pill.session, `(() => { const e = [...document.querySelectorAll('${EFFORT_ROWS}')][${at}]; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
      await cdp.click(pill.session, row.x, row.y);
      const want = shown[at]!.t;
      await until(`the bot's effort to be ${want}`, 15_000, async () => {
        const bot = (await rpc.request<{ bots: { model?: string; effort?: string }[] }>("bot.list", {})).bots[0];
        return bot?.effort === want && bot.model === now ? true : undefined;
      }, async () => `bot now: ${JSON.stringify((await rpc.request<{ bots: { model?: string; effort?: string }[] }>("bot.list", {})).bots[0])}`);
      effortNote = `the Effort section listed ${levels.join(", ")}; picked "${want}" and it is the bot's effort`;
    } else {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pill.session);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pill.session);
    }
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
    return `${items.length} models listed; picked "${picked}": the bot's model went from ${was} to ${now}; the label reads "${label}" and the next turn's request asked the provider for ${req.model}; ${effortNote}`;
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
    const replies = () => replyRows(cdp);
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
    // Its own reply in at most one conversation bubble (the pill itself shows it too); another turn's reply meanwhile is
    // not this step's.
    const after = await replies();
    const mine = await replyRows(cdp, `${ctx.reply} ${tag}`, true);
    if (mine > 1) fail(`this turn's reply shows in ${mine} conversation bubbles, not one (all reply bubbles ${before} -> ${after})`);
    return `the pill sent ${tag} by ${route} and its own reply is on screen${mine === 1 ? ", in one bubble" : ""} (all reply bubbles ${before} -> ${after})`;
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
      // Her tab with the window's own sidebar beside it, open and folded (her own toggle, the user's way), wide and narrow, in
      // each scheme: `alpha-tab-<wide|narrow>-<open|folded>-<light|dark>.png`. The sidebar is left open and the scheme the system's.
      const folded = async () => (await inTree<string>(cdp, "(() => { const w = document.querySelector('.cl-window'); return w ? String(w.dataset.collapsed === 'true') : null; })()"))?.value === "true";
      const fold = async (want: boolean) => {
        if ((await folded()) === want) return;
        const at = await until("her sidebar toggle", 20_000, async () => { for (const d of await treeDocs(cdp)) { const c = await cdp.centerOf(d.session, ".ac__btn", want ? "Hide the sidebar" : "Show the sidebar").catch(() => undefined); if (c !== undefined) return { session: d.session, c }; } return undefined; });
        await cdp.click(at.session, at.c.x, at.c.y);
        await until("the sidebar " + (want ? "folded" : "open"), 10_000, async () => ((await folded()) === want ? true : undefined));
      };
      try {
        for (const scheme of ["light", "dark"] as const) {
          ctx.setAppearance?.(scheme);
          for (const d of await cdp.documents()) await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, d.session).catch(() => undefined);
          await layGround(cdp, scheme);
          for (const side of ["open", "folded"] as const) {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, root!.session);
            await sleep(800);
            await fold(side === "folded");
            for (const [size, width] of [["wide", 1280], ["narrow", 700]] as const) {
              await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false }, root!.session);
              await sleep(3000);
              const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, root!.session) as { data: string };
              writeFileSync(join(renders, `alpha-tab-${size}-${side}-${scheme}.png`), Buffer.from(shot.data, "base64"));
            }
          }
        }
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, root!.session).catch(() => undefined);
        await fold(false).catch(() => undefined);
        await unshootWindow(cdp, ctx.setAppearance);
      }
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, root!.session).catch(() => undefined);
    }
    // The user's own look at the window (`clover-core app screenshot`, the owner's ask for 14d): the app's capture of its
    // main window, offscreen, with no window shown: a PNG of the window's size at its scale, more than a handful of colours.
    let shotSaid = "";
    if (ctx.appScreenshot !== undefined) {
      const r = await ctx.appScreenshot();
      if (r.code !== 0) fail(`clover-core app screenshot exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)} [packages/cli/src/app-cli.ts, packages/core/src/ipc/app-capture.ts, apps/desktop/src/main/capture.ts]`);
      let printed: { windows?: { name: string; drawn: boolean; visible: boolean; file?: string; scale: number; bounds: { width: number; height: number }; pixels?: { width: number; height: number }; reduced?: boolean; note?: string }[] };
      try { printed = JSON.parse(r.stdout); } catch { return fail(`clover-core app screenshot printed no JSON: ${r.stdout.slice(0, 200)}`); }
      const w = printed.windows?.find((x) => x.name === "main");
      if (w === undefined || printed.windows!.length !== 1) fail(`clover-core app screenshot listed ${JSON.stringify(printed.windows?.map((x) => x.name))}, not the main window alone`);
      if (!w!.drawn || w!.file === undefined) fail(`the main window wasn't drawn: ${w!.note ?? "no file"} [apps/desktop/src/main/capture.ts]`);
      if (w!.visible) fail("the main window says it is visible in a headless run");
      if (!w!.file!.startsWith(r.dir)) fail(`the PNG went to ${w!.file}, not into --out ${r.dir}`);
      const { colours, width, height } = distinctColours(readFileSync(w!.file!));
      // The page's pixels per point: the display's scale for a window on screen, 1 for an offscreen one (a headless run's);
      // half that when the picture was drawn smaller to fit. The height may lack a title bar the bounds hold.
      const fits = [1, w!.scale].map((k) => k / (w!.reduced ? 2 : 1)).some((k) => Math.abs(width - w!.bounds.width * k) <= 4 && height <= w!.bounds.height * k + 4 && height >= (w!.bounds.height - 40) * k);
      if (width < 600 || height < 400 || !fits) fail(`the main window's PNG is ${width}x${height}; its bounds are ${w!.bounds.width}x${w!.bounds.height} at scale ${w!.scale}`);
      if (colours < 6) fail(`the main window's PNG (${width}x${height}) has ${colours} colour(s): an empty or flat picture [apps/desktop/src/main/capture.ts]`);
      if (/window: shown while headless/.test(ctx.appLog())) fail("a window was shown while headless (the screenshot)");
      shotSaid = `; clover-core app screenshot drew main.png ${width}x${height} (bounds ${w!.bounds.width}x${w!.bounds.height} at scale ${w!.scale}), ${colours} colours, not visible, no window shown`;
    }
    // The user's navigation from a terminal (`clover-core app open`): Settings, then back to her tab, each by the route
    // the app's own sidebar uses, each shown; nothing is clicked, and no window is shown.
    if (ctx.appCli !== undefined) {
      const went: string[] = [];
      // Settings is a dialog over her tab: the shell says so (`dialog`), with the tab under it.
      for (const [to, kind, dialog] of [["settings", "bot", "settings"], ["bot:alpha", "bot", undefined]] as const) {
        const r = await ctx.appCli(["open", to]);
        let a: { shown?: boolean; reason?: string; where?: { tab?: { kind?: string; id?: string }; dialog?: string }; frames?: unknown[] };
        try { a = JSON.parse(r.stdout); } catch { return fail(`clover-core app open ${to} printed no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)} [packages/cli/src/app-cli.ts, apps/desktop/src/main/open.ts]`); }
        if (r.code !== 0 || a.shown !== true || a.where?.tab?.kind !== kind || a.where?.dialog !== dialog) fail(`clover-core app open ${to}: shown ${String(a.shown)}${a.reason ? ` (${a.reason})` : ""}, the window at ${JSON.stringify(a.where?.tab)}${a.where?.dialog ? ` under ${a.where.dialog}` : ""} [apps/desktop/src/main/open.ts]`);
        if (!Array.isArray(a.frames) || a.frames.length === 0) fail(`clover-core app open ${to} listed no frames`);
        went.push(`${to} shown (${a.frames!.length} frames)`);
      }
      const here = await ctx.appCli(["where"]);
      const at = (JSON.parse(here.stdout) as { where?: { tab?: { kind?: string; id?: string } } }).where?.tab;
      const over = (JSON.parse(here.stdout) as { where?: { dialog?: string } }).where?.dialog;
      if (at?.kind !== "bot" || at.id !== "alpha" || over !== undefined) fail(`clover-core app where says the window is at ${JSON.stringify(at)}${over ? ` under ${over}` : ""}, not Alpha's tab`);
      if (/window: shown while headless/.test(ctx.appLog())) fail("a window was shown while headless (app open)");
      shotSaid += `; clover-core app open ${went.join(", then ")}; app where: Alpha's tab; no window shown`;
    }
    return `Alpha's talk column is drawn, with the composer in it, on screen; the header says "${parts.header.replace(/\s+/g, " ")}" and the stage is ${parts.w}x${parts.h} with the avatar on a canvas (${parts.text})${shotSaid}`;
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
    let grantedPath = "";
    let grantSkipped = "";
    let labelsSaid = "";
    const appRoot = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
    const shoot = async (name: string) => {
      if (!renders || appRoot === undefined) return;
      // Wide, then narrow: the page's own width is the window's.
      rendered.push(...(await shootWindow(cdp, renders, name, ctx.setAppearance)));
      if (name === "installed" || name === "detail") rendered.push(...(await shootWindow(cdp, renders, name, ctx.setAppearance, 560)));
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
      // A file the user picked for it in its own page (main's register call, the app's role): a real file in a temp folder.
      // Packaged, the run's connection is the CLI's, which may not register a grant: that clause is then not driven.
      grantedPath = join(realpathSync(mkdtempSync(join(tmpdir(), "e7a-grant-"))), "notes.txt");
      writeFileSync(grantedPath, "a file the plugin may open\n");
      const grantToken = `grant:${crypto.randomUUID()}`;
      const granted = await rpc.request("plugin.grant.add", { pluginId: pick!.id, token: grantToken, path: grantedPath, kind: "file", access: "read" }).then(() => true, (err: unknown) => { grantSkipped = String((err as Error).message ?? err); return false; });
      if (!granted && grantSkipped === "") grantSkipped = "refused";
      // What each plugin brings, as small labels under its name: the row shows what the core derived from its contributions
      // (`plugin.get`'s `labels`: a bot's own plugin brings Bot, a plugin with a tool brings Tools), and the detail shows
      // the same; none of them names a kind of plugin.
      const rowLabels = async (name: string) => (await inTree<string>(cdp, `(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`Open ${name}`)}); const u = b && b.closest('li') ? b.closest('li').querySelector('.cl-plugin-index__labels') : null; return u ? JSON.stringify([...u.querySelectorAll('.cl-plugin-index__label')].map((e) => e.textContent)) : null; })()`))?.value;
      const wantLabels = async (id: string) => ((await rpc.request<{ plugin: { labels?: string[] } }>("plugin.get", { id })).plugin.labels ?? []);
      const pickWant = await wantLabels(pick!.id);
      if (!pickWant.includes("Tools")) fail(`${pick!.id} has a tool but the core's labels for it are ${JSON.stringify(pickWant)}`);
      const pickRow = await until(`${pick!.name}'s labels in its row`, 15_000, async () => rowLabels(pick!.name));
      if (pickRow !== JSON.stringify(pickWant)) fail(`${pick!.name}'s row shows ${pickRow}, the core derived ${JSON.stringify(pickWant)}`);
      const alphaWant = await wantLabels("alpha");
      const alphaRow = await rowLabels("Alpha");
      if (!alphaWant.includes("Bot") || alphaRow !== JSON.stringify(alphaWant)) fail(`Alpha's labels: the core derived ${JSON.stringify(alphaWant)} (a bot's own plugin brings Bot), her row shows ${alphaRow}`);
      if ([...pickWant, ...alphaWant].some((l) => /plugin|type|kind/i.test(l))) fail(`a label names a kind of plugin: ${[...pickWant, ...alphaWant].join(", ")}`);
      labelsSaid = `its row shows what it brings (${pickWant.join(", ")}) and Alpha's shows ${alphaWant.join(", ")}, both as the core derived them`;
      await clickText(`Open ${pick!.name}`, `button[aria-label=${JSON.stringify(`Open ${pick!.name}`)}]`, undefined);
      await waitText(`${pick!.name}'s detail with its tool`, pick!.tool);
      const detailLabels = await until("its detail's labels", 15_000, async () => (await inTree<string>(cdp, "(() => { const u = document.querySelector('.cl-plugin-index__detail > .cl-plugin-index__labels'); return u ? JSON.stringify([...u.querySelectorAll('.cl-plugin-index__label')].map((e) => e.textContent)) : null; })()"))?.value);
      if (detailLabels !== JSON.stringify(pickWant)) fail(`its detail shows ${detailLabels}, its row showed ${JSON.stringify(pickWant)}`);
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
    // The rest of the page's controls, each on a copy in a temp folder (never a repo fixture): a development folder, and an
    // adult plugin.
    // The controls below the fold (the Add tab's development folders, a detail's lower sections) are scrolled into view first: a
    // press at a point outside the window's view reaches nothing.
    const clickScrolled = async (what: string, selector: string, text: string | undefined, ms = 20_000) => {
      await until(what, ms, async () => {
        for (const d of await treeDocs(cdp)) {
          const done = await cdp.evaluate(d.session, `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text === undefined ? "els[0]" : `els.find((e) => (e.innerText || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)}))`}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`).catch(() => false);
          if (done === true) return true;
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await sleep(250);
      return clickText(what, selector, text, ms);
    };
    const pluginsPageControls = async (): Promise<string> => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "e7a-plugins-")));
      const makePlugin = (id: string, name: string, extra: Record<string, unknown>, server: Record<string, unknown>) => {
        const dir = join(base, id);
        mkdirSync(join(dir, "stdio"), { recursive: true });
        cpSync(join(import.meta.dir, "fixtures", "acceptance-page", "stdio", "server.mjs"), join(dir, "stdio", "server.mjs"));
        const manifest = { manifest: 1, id, name, description: "A copy the Plugins page's acceptance clause made in a temp folder.", version: "0.0.1", engines: { clover: "^1.0.0" }, ...extra,
          contributes: { mcpServers: { page: { type: "stdio", command: "bun", args: ["${plugin}/stdio/server.mjs"], tools: { PageProbe: "on-demand" }, ...server } } } };
        writeFileSync(join(dir, "clover.json"), JSON.stringify(manifest, null, 2));
        return dir;
      };
      const openAdd = async () => {
        await clickScrolled("the sidebar's Plugins entry", SIDEBAR_ITEMS, "Plugins");
        await clickScrolled("the Add tab", "[role=tab]", "Add");
      };
      const said: string[] = [];

      // (c) A development folder: Add tab → Choose a development folder… → Add as a development folder → its sealed card.
      const devId = "acceptance-dev";
      const devDir = makePlugin(devId, "Acceptance dev plugin", {}, {});
      ctx.setPick!(devDir);
      const devList = async () => (await rpc.request<{ folders: { path: string; pluginId?: string; addedAt: number; expiresAt: number; lastReloadAt?: number }[] }>("plugin.dev.list")).folders;
      const mine = async () => (await devList()).find((f) => f.path.endsWith(`/${devId}`));
      // The window's document can load again just after a plugin with a layer goes (the removal above), which wipes the page's
      // state, so the pick is made again until its Add button stands.
      const addLabel = `Add ${devId} as a development folder`;
      let standing = false;
      for (let attempt = 0; attempt < 3 && !standing; attempt++) {
        await openAdd();
        await clickScrolled("Choose a development folder…", "button", "Choose a development folder");
        standing = await until("the chosen development folder's Add button", 8_000, async () => ((await treeText(cdp)).includes(addLabel) ? true : undefined)).catch(() => false);
      }
      if (!standing) {
        const text = (await treeText(cdp)).replace(/\s+/g, " ");
        const at = text.indexOf("Development folders");
        fail(`${addLabel}: never shown after 3 picks | ${text.slice(0, 200)} | its Development folders part: ${text.slice(Math.max(0, at), at + 400)}`);
      }
      await clickScrolled(addLabel, "button", addLabel);
      const devCard = await ctx.pressCard!("its development folder card", (c) => c.kind === "change" && c.change === "dev-folder");
      const added = await until("the development folder listed", 30_000, async () => { const f = await mine(); return f?.pluginId === devId ? f : undefined; });
      const devState = await until(`${devId} running`, 30_000, async () => {
        const r = await rpc.request<{ plugin: { state: string; dev: boolean } }>("plugin.get", { id: devId }).catch(() => undefined);
        return r?.plugin.state === "running" ? r.plugin : undefined;
      });
      if (!devState.dev) fail("the development plugin isn't marked dev");
      await waitText("the folder in the Development folders list", devDir);
      // A saved file loads again with no card.
      const cardCount = async () => (await rpc.request<{ cards: { id: string }[] }>("card.list").catch(() => ({ cards: [] }))).cards.length;
      const cardsBefore = await cardCount();
      // The saved file is its manifest's description: the plugin's own record changes, with no card.
      const manifestPath = join(devDir, "clover.json");
      // One save is enough: the core's watch, and its catch-up look every 5 s for an event the OS drops, read it within about
      // 5 s plus the settle time. 20 s is the wait.
      const edited = "Edited by the acceptance clause while it was a development folder.";
      writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), description: edited }, null, 2));
      await until("the plugin's description loaded again from the one saved file", 20_000, async () => {
        const r = await rpc.request<{ plugin: { description?: string } }>("plugin.get", { id: devId }).catch(() => undefined);
        return r?.plugin.description === edited ? true : undefined;
      }, async () => {
        const r = await rpc.request<{ plugin: { state: string; reason?: string; description?: string; dev: boolean } }>("plugin.get", { id: devId }).catch((e: Error) => ({ plugin: { state: `gone: ${e.message}`, dev: false } }));
        return `after one save, plugin.get: state ${r.plugin.state}${"reason" in r.plugin && r.plugin.reason ? ` (${r.plugin.reason})` : ""}, dev ${r.plugin.dev}, description ${JSON.stringify(("description" in r.plugin ? r.plugin.description : "")?.slice(0, 80))}`;
      });
      const cardsAfter = await cardCount();
      if (cardsAfter > cardsBefore) fail("a saved file in the development folder raised a card");
      // The core reports the reload (`lastReloadAt`), and the page's list says "Loaded again".
      const reloaded = await until("plugin.dev.list's lastReloadAt", 15_000, async () => {
        const m = await mine();
        return m?.lastReloadAt !== undefined ? m : undefined;
      });
      await clickScrolled("the Installed tab, then the Add tab again", "[role=tab]", "Installed");
      await clickScrolled("the Add tab, again", "[role=tab]", "Add");
      await waitText("the list's Loaded again line", "Loaded again");
      const lineSaid = "its list says Loaded again";
      const savesSaid = "the one save was read";
      // Keep on for 24 hours…: a sealed card, pressed.
      await clickScrolled("Keep on for 24 hours…", "[data-dev-folder] button", "Keep on for 24 hours");
      const renewCard = await ctx.pressCard!("its renew card", (c) => c.kind === "change" && c.change === "dev-folder");
      await until("expiresAt later", 30_000, async () => (((await mine())?.expiresAt ?? 0) > reloaded.expiresAt ? true : undefined));
      await clickScrolled("the folder's Remove", "[data-dev-folder] button", "Remove");
      await until("the folder gone from plugin.dev.list", 30_000, async () => ((await mine()) === undefined ? true : undefined));
      said.push(`development folder: added through Add → Choose a development folder… on card ${devCard}, running as ${devId}, a saved file (its manifest) loaded it again with no card (plugin.get shows the new description, ${savesSaid}; ${lineSaid}), Keep on for 24 hours on card ${renewCard} moved expiresAt, Remove emptied plugin.dev.list`);

      // (d) An adult plugin.
      const adultId = "acceptance-adult";
      const adultDir = makePlugin(adultId, "Acceptance adult plugin", { adult: true, host: { entry: "host/index.ts", runtime: "bun", start: "chosen" } }, {});
      mkdirSync(join(adultDir, "host"), { recursive: true });
      writeFileSync(join(adultDir, "host", "index.ts"), "export async function start(): Promise<void> {}\nexport async function stop(): Promise<void> {}\n");
      const adultOf = async () => (await rpc.request<{ adultConfirmed?: boolean }>("plugin.list")).adultConfirmed === true;
      if (await adultOf()) fail("the home already holds an adult confirmation");
      await rpc.request("plugin.install", { source: { from: "folder", path: adultDir } }, 60_000);
      const adultCard = await ctx.pressCard!("its adult plugin's OK card", (c) => c.kind === "plugin-ok" && c.pluginId === adultId);
      await clickScrolled("the Installed tab", "[role=tab]", "Installed");
      await clickScrolled("Open Acceptance adult plugin", `button[aria-label=${JSON.stringify("Open Acceptance adult plugin")}]`, undefined);
      await waitText("the adult plugin's For adults section", "I am 18 or older");
      // The adult confirm.
      await clickScrolled("I am 18 or older", "button", "I am 18 or older");
      await until("plugin.list adultConfirmed true", 20_000, async () => ((await adultOf()) ? true : undefined));
      await until("the adult section gone", 15_000, async () => ((await treeText(cdp)).includes("I am 18 or older") ? undefined : true), () => dumpFrames(cdp));
      said.push(`adult: ${adultId} (adult:true, OK card ${adultCard}) showed the confirm until "I am 18 or older" was pressed (plugin.list adultConfirmed true)`);
      await clickScrolled("Remove…", "button", "Remove");
      await ctx.pressCard!("its removal card", (c) => c.kind === "change" && c.change === "plugin-remove" && (c.pluginId === undefined || c.pluginId === adultId));
      await until(`${adultId} removed`, 30_000, async () => ((await rpc.request("plugin.get", { id: adultId }).then(() => false, () => true)) ? true : undefined));
      rmSync(base, { recursive: true, force: true });
      return said.join("; ");
    };

    // Files it may open: the grant added above is listed on the detail; Take back removes it.
    let grantsSaid = `files it may open not driven here (${grantSkipped.slice(0, 80)})`;
    if (grantSkipped === "") {
      const grantList = async () => (await rpc.request<{ grants: { path: string }[] }>("plugin.grant.list", { pluginId: pick!.id })).grants;
      if (!(await grantList()).some((g) => g.path === grantedPath)) fail("the registered grant isn't in plugin.grant.list");
      await waitText("its file in Files it may open", grantedPath);
      await clickScrolled("Take back", "button", "Take back");
      await until("plugin.grant.list empty", 20_000, async () => ((await grantList()).length === 0 ? true : undefined), () => dumpFrames(cdp));
      await waitText("the none-picked line", "You haven't picked any file or folder for it.");
      grantsSaid = "its picked file listed under Files it may open and taken back (plugin.grant.list empty)";
    }
    // Its log view: the detail's "Its log" section shows what `plugin.logs` answers for it (the lines, or the note that it has none).
    const logLines = (await rpc.request<{ lines?: string[]; log?: string[] }>("plugin.logs", { id: pick!.id, lines: 200 }).catch(() => ({ lines: [] as string[] }))) as { lines?: string[]; log?: string[] };
    const wantLog = (logLines.lines ?? logLines.log ?? []).filter((l) => l.trim() !== "");
    await waitText("the detail's log section", "Its log");
    const logShown = await until("the log view's lines or its none-note", 15_000, async () => {
      const r = await inTree<string>(cdp, "(() => { const pre = document.querySelector('.cl-plugin-index__log'); if (pre) return 'lines:' + pre.textContent; const t = document.body.innerText; return t.includes('Its log') ? 'none' : null; })()");
      return r?.value;
    }, () => dumpFrames(cdp));
    if (wantLog.length > 0 && !(logShown.startsWith("lines:") && logShown.includes(wantLog[wantLog.length - 1]!.slice(0, 40)))) fail(`the log view shows ${JSON.stringify(logShown.slice(0, 120))}, not plugin.logs's last line ${JSON.stringify(wantLog[wantLog.length - 1]!.slice(0, 60))}`);
    if (wantLog.length === 0 && logShown.startsWith("lines:") && logShown.trim() !== "lines:") fail(`plugin.logs has no lines, but the log view shows ${JSON.stringify(logShown.slice(0, 120))}`);
    const logSaid = wantLog.length > 0 ? `its log view shows plugin.logs's lines (${wantLog.length}, the last one drawn)` : "its log view is drawn (no lines yet, the none note)";
    // Remove and delete its data… → its sealed card, pressed → gone, and its data folder (`<home>/plugin-data/<id>`, a marker the run put there) with it.
    const dataDir = ctx.home === undefined ? undefined : join(ctx.home, "plugin-data", pick!.id);
    if (dataDir !== undefined) { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, "marker.txt"), "the plugin's own data\n"); }
    await clickText("Remove and delete its data…", "button", "Remove and delete its data");
    const removeCard = await ctx.pressCard!("its removal card", (c) => c.kind === "change" && c.change === "plugin-remove");
    await until(`${pick!.id} removed`, 30_000, async () => ((await rpc.request("plugin.get", { id: pick!.id }).then(() => false, () => true)) ? true : undefined));
    if (dataDir !== undefined) await until("its data folder gone with it", 15_000, async () => (existsSync(dataDir) ? undefined : true), async () => `${dataDir} still holds ${JSON.stringify(readdirSync(dataDir))}`);
    const dataSaid = dataDir !== undefined ? "Remove and delete its data… pressed on its card, the plugin and its data folder gone" : "Remove and delete its data… pressed on its card, the plugin gone";
    const controls = ctx.setPick !== undefined ? await pluginsPageControls() : "development folders and adult not driven (no picker control)";
    return `installed ${pick!.id} from a picked folder (the page held a token and the name, never the path), its OK card ${okCard} pressed (now ${running}); the window's document loaded again for its layer and kept the Plugins page on its Add tab; the page's own calls with no click refused (${refusals.replace(/plugin\.|ui\./g, "").slice(0, 160)}…); its detail showed ${pick!.tool}; ${labelsSaid}, the detail the same; its icon ${iconSeen}; ${logSaid}; ${dataSaid} (card ${removeCard}); ${grantsSaid}; ${controls}${rendered.length > 0 ? `; rendered ${rendered.length} pictures` : ""}`;
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
      // The page's own reads: its `data-` attributes and its translated line, in whichever frame of its layer holds them.
      const pageRead = async (expr: string) => {
        for (const d of await layerDocs()) {
          const v = await cdp.evaluate(d.session, expr).catch(() => undefined);
          if (v !== undefined && v !== null && v !== "") return String(v);
        }
        return "";
      };
      const HELLO = "document.querySelector('[data-acceptance-ui=\"hello\"]')?.textContent ?? ''";
      // A translated string in the window (§5.5 "Translations"): the page's `t("acceptance-ui.hello")` reads in the app's
      // language. A German app shows the fixture's German line; back to English it shows the English one, with no restart.
      // (A packaged core's CLI-role connection can't set the app's language: the line then must be one of the two.)
      let translated = "";
      const setLanguage = (language: string) => rpc.request("ui.set", { patch: { language } }).catch(() => undefined).then((r) => r !== undefined);
      if (await setLanguage("de")) {
        await until("the page's line in German", 30_000, async () => ((await pageRead(HELLO)) === "Hallo aus dem Fixture" ? true : undefined), async () => `it reads ${JSON.stringify(await pageRead(HELLO))}`);
        await setLanguage("en");
        await until("the page's line in English again", 30_000, async () => ((await pageRead(HELLO)) === "Hello from the fixture" ? true : undefined), async () => `it reads ${JSON.stringify(await pageRead(HELLO))}`);
        translated = "its page's t() line read \"Hallo aus dem Fixture\" with the app in German and \"Hello from the fixture\" in English again, no restart";
      } else {
        const line = await pageRead(HELLO);
        if (line !== "Hallo aus dem Fixture" && line !== "Hello from the fixture") fail(`its page's t() line reads ${JSON.stringify(line)}, not one of its two strings`);
        translated = `its page's t() line read ${JSON.stringify(line)} (the app's language couldn't be set on this core)`;
      }
      // A command's default key (§5.4 `commands[].key`): the fixture's `ping` names mod+shift+y. The press is main's own
      // `sendInputEvent` in the window (CDP key events never reach the window's before-input-event, as the first runs showed),
      // which its before-input-event sees as a key press; main runs the command
      // as the user, its host half tells the page, and the page shows a count. A press before main has read the
      // commands' keys is lost, so it is pressed again until the page counts one.
      const keyShell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-window')"));
      let presses = 0;
      let pinged = "0";
      await until("its key to run its command", 40_000, async () => {
        pinged = await pageRead("document.querySelector('[data-acceptance-ui=\"main\"]')?.getAttribute('data-pinged') ?? ''");
        if (pinged !== "" && pinged !== "0") return true;
        presses += 1;
        if (ctx.pressKey === undefined) fail("this run can't press a key in the window");
        ctx.pressKey!("Y", [process.platform === "darwin" ? "meta" : "control", "shift"]);
        await sleep(1_500);
        return undefined;
      }, async () => `its page counts ${JSON.stringify(pinged)} after ${presses} press(es); the app's log: ${ctx.appLog().split("\n").filter((l) => l.includes("keys:")).slice(-3).join(" | ") || "no keys: line"}`);
      if (!ctx.appLog().includes(`keys: ${id}.ping ran from its key`)) fail(`its page counted a ping, but the app's log has no "keys: ${id}.ping ran from its key"`);
      const keyed = `its command ${id}.ping, bound to mod+shift+y, ran from a real key press in the window (${presses} press(es) until main had the key; its page counted ${pinged}); ${translated}`;
      // The Plugins page, the user's way: the sidebar's Plugins entry, Installed, its row's Open, Turn off.
      const shell = keyShell;
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, shell.session).catch(() => undefined);
      await sleep(300);
      await clickText("the sidebar's Plugins entry", SIDEBAR_ITEMS, "Plugins");
      await clickText("the Installed tab", "[role=tab]", "Installed");
      await clickText("Open Acceptance UI", `button[aria-label=${JSON.stringify("Open Acceptance UI")}]`, undefined);
      await clickText("Turn off", "button", "Turn off");
      await until(`${id} off`, 20_000, async () => ((await stateOf()) === "off" ? true : undefined));
      await until("its frames out of the window", 20_000, async () => ((await layerDocs()).length === 0 ? true : undefined), () => dumpFrames(cdp));
      await until("its layer's connection closed", 15_000, async () => (ctx.appLog().includes(`layers: ${id}'s layer connection closed`) ? true : undefined));
      summary13 = `${keyed}; ${id} installed from its folder as it is (a TSX client, no react shipped; built by the registry at load), OK'd on its card ${ok}, its page (opened from its sidebar button) in ${frames} frame(s) of its own layer, answered by the core; Turn off in the Plugins page: off, no frame of its layer left, and main closed its layer's connection`;
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
  // The bot editor's Avatar section is drawn by clover/character through `bot.editor.section`, which mounts a moment after the
  // editor itself: wait (bounded) for the section element inside the editor before anything reads its controls. When it never
  // comes the failure says so, not that a word is missing.
  const AVATAR_SECTION_MS = 10_000;
  const avatarSectionDrawn = async (how: string): Promise<void> => {
    try {
      await until(`the bot editor's Avatar section (${how})`, AVATAR_SECTION_MS, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-bot-editor:not(.cl-bot-editor--loading) .cl-avatar-section')").then((r) => (r?.value === true ? true : undefined), () => undefined), () => dumpFrames(cdp));
    } catch {
      fail(`the bot editor (${how}) opened, but its Avatar section (clover/character, bot.editor.section) never came within ${AVATAR_SECTION_MS / 1000} s`);
    }
  };
  const editorDrawn = async (how: string): Promise<string> => {
    await until(`the bot editor (${how})`, 30_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-bot-editor:not(.cl-bot-editor--loading)')").then((r) => (r?.value === true ? true : undefined), () => undefined), () => dumpFrames(cdp));
    await avatarSectionDrawn(how);
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
      await avatarSectionDrawn("Alpha's Edit button");
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
    // The bot asks a question (the fake calls AskUserQuestion): the card in the conversation shows its options; one is pressed and "Send answer"
    // pressed, in the window. The conversation part answers on its plugin's own connection (session.answer needs conversation.post, which its
    // OK lists), so the answer is accepted, the card shows it answered, and the turn goes on with that answer as the tool's result.
    const qTag = `ACCEPTANCE-ASK-${randomBytes(3).toString("hex").toUpperCase()}`;
    const choice = "Blue sky";
    const input = JSON.stringify({ questions: [{ question: `Which colour for ${qTag}?`, header: "Colour", multiSelect: false, options: [{ label: choice, description: "the first" }, { label: "Green leaf", description: "the second" }] }] });
    const qBox = await until("the composer's text box", 20_000, () => composerDoc(cdp), () => dumpFrames(cdp));
    await cdp.evaluate(qBox.session, `document.querySelector('${COMPOSER_BOX}').focus()`);
    await cdp.send("Input.insertText", { text: `ACCEPTANCE-CALL AskUserQuestion ${input}` }, qBox.session);
    await sleep(300);
    const qSend = await until("the send button", 10_000, () => cdp.centerOf(qBox.session, "button.cl-composer__send").catch(() => undefined));
    await cdp.click(qBox.session, qSend.x, qSend.y);
    const pending = await until("the question card, pending, in the conversation", 90_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const v = await cdp.evaluate(d.session, `(() => { const c = [...document.querySelectorAll('.cl-conv-question[data-state=pending]')].find((e) => e.textContent.includes(${JSON.stringify(qTag)})); return c ? true : null; })()`).catch(() => null);
        if (v === true) return d;
      }
      return undefined;
    }, async () => `requests: ${ctx.requests().slice(-3).map((r) => `${r.answered}:${r.lastUserText.slice(0, 60)}`).join(" | ")} || ${await dumpFrames(cdp)}`);
    const optSel = ".cl-conv-question[data-state=pending] .cl-conv-question__option";
    const optAt = await until("the first option on the card", 10_000, () => cdp.centerOf(pending.session, optSel, choice).catch(() => undefined));
    await cdp.click(pending.session, optAt.x, optAt.y);
    await sleep(300);
    const sendSel = ".cl-conv-question[data-state=pending] button.cl-conv-question__send";
    const sendAt = await until("an enabled Send answer", 10_000, async () => {
      const ok = await cdp.evaluate(pending.session, `(() => { const b = document.querySelector(${JSON.stringify(sendSel)}); return !!b && !b.disabled; })()`).catch(() => false);
      return ok === true ? await cdp.centerOf(pending.session, sendSel).catch(() => undefined) : undefined;
    });
    await cdp.click(pending.session, sendAt.x, sendAt.y);
    await until("the card answered and the turn gone on with the answer", 90_000, async () => {
      const failed = await cdp.evaluate(pending.session, `!!document.querySelector('.cl-conv-question__failed')`).catch(() => false);
      if (failed === true) return fail("the card said the answer didn't go through");
      return ctx.requests().some((r) => r.toolResult?.text.includes(choice) && r.lastUserText.length >= 0) && (await treeText(cdp)).includes("ACCEPTANCE-DONE") ? true : undefined;
    }, async () => `tool results: ${ctx.requests().slice(-3).map((r) => r.toolResult?.text.slice(0, 120)).join(" | ")}`);
    const asked = ctx.requests().filter((r) => r.lastUserText.includes(tag));
    return `the bot's question card (${qTag}) took a pressed option and "Send answer" in the window and the turn went on with "${choice}" as the tool's result (no "didn't go through"); a failed turn (${tag}) showed Try again on its error row; one click sent the same words again (the log holds two, equal byte for byte, ${sent[1]!.device ? "as the user's own message" : "as a user message"}), the next turn completed with its own reply, and the button is gone (${asked.length} request(s) reached the fake)`;
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
    type Counters = { pieces: number; frames: number; speaking: string[]; overlap: number };
    const counters = async (): Promise<Counters | undefined> => {
      const r = await inTree<string>(cdp, "(() => { const d = document.documentElement.dataset; return d.voicePieces === undefined ? null : JSON.stringify({ pieces: +d.voicePieces, frames: +(d.voiceFrames || 0), speaking: (d.voiceSpeaking || '').split(',').filter(Boolean), overlap: +(d.voiceOverlap || 0) }); })()");
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
      // A record of the player's counters as they change, for a failure's dump (who spoke when).
      const voiceDoc = await inTree<boolean>(cdp, "(() => { const e = document.documentElement; if (e.dataset.voicePieces === undefined) return null; if (window.__vq) return true; const t0 = Date.now(); window.__vq = []; const note = () => { const d = e.dataset; window.__vq.push([Date.now() - t0, +d.voicePieces, d.voiceSpeaking || '-', +(d.voiceOverlap || 0)].join(' ')); if (window.__vq.length > 400) window.__vq.shift(); }; note(); new MutationObserver(note).observe(e, { attributes: true }); return true; })()");
      const voiceRecord = async () => (voiceDoc === undefined ? "no record" : String(await cdp.evaluate(voiceDoc.session, "window.__vq ? window.__vq.join(' | ') : 'none'").catch(() => "?")).slice(-1500));
      // The player's document as one the user has used: its AudioContext starts only after the user's activation there
      // (a click in a third party's own frames, such as this bot's tab, gives it none), and a sound that can't start
      // would sit in a suspended context and sound later over the next.
      if (voiceDoc !== undefined) await cdp.send("Runtime.evaluate", { expression: "true", userGesture: true }, voiceDoc.session).catch(() => undefined);
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
      // Both bots' replies went through Clover Voice's one queue: never two at once on the player.
      if (quiet.overlap > 1) fail(`two bots sounded at once (data-voice-overlap ${quiet.overlap}); the player (ms pieces speaking overlap): ${await voiceRecord()}`);
      return `the fixture voice on ${botId} and Alpha (their user layers), spoken by Clover Voice: ${botId}'s reply came as ${after.pieces - before.pieces} piece(s) and ${after.frames - before.frames} frame(s), and its renderer showed ${shown.join(" → ")}; Alpha's as ${alphaAfter.pieces - alphaBefore.pieces} piece(s) and ${alphaAfter.frames - alphaBefore.frames} frame(s) while she spoke; never two bots at once (data-voice-overlap ${quiet.overlap}); muted by the stage's chip, the next reply sent no piece`;
    } finally {
      for (const id of voiced) await rpc.request("bot.setUserLayer", { id, patch: { voice: null } }).catch(() => undefined);
      for (const id of installed.reverse()) await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  });
  // 20: Alpha's tab under Bots' plug (the owner, November 14): the window's own sidebar beside her tab exactly as beside a plain
  // bot's (same rows, size and colours, not even tinted by her accent), her own top bar instead of the stock one, her toggle
  // folding the stock sidebar and back, her panel control opening the panel sheet; a plain bot's tab keeps the stock bar.
  // More scoped wins: a plugin's composer style for all bots loses to Alpha's own on her tab and shows on the plain bot's.
  // What the user presses are her own controls and the stock sidebar's rows; the shell's own document says the shape.
  await step(20, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const id = "acceptance-plain-bot";
    const name = "Acceptance Plain Bot";
    const everyId = "acceptance-every-composer";
    // The all-bots composer style: two tokens, one Alpha's own composer style (tab/pane.json) sets and one only her theme sets.
    const EVERY = { surface: "#E3EEFA", composer: "#CFE6D2" } as const;
    const parent = mkdtempSync(join(tmpdir(), "clover-plain-bot-"));
    const folder = join(parent, id);
    mkdirSync(join(folder, "bot"), { recursive: true });
    writeFileSync(join(folder, "bot", "instructions.md"), "You are a plain test bot.\n");
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id, name, description: "The acceptance run's plain bot: no layout of its own, so the stock window.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { bot: { name, instructions: "bot/instructions.md", model: { default: "anthropic/claude-sonnet-5-5", effort: "medium" } } },
    }));
    const everyFolder = join(parent, everyId);
    mkdirSync(everyFolder, { recursive: true });
    writeFileSync(join(everyFolder, "paint.json"), JSON.stringify({ theme: 1, name: "Every composer", tokens: { "color.surface": EVERY.surface, "composer.background": EVERY.composer } }));
    writeFileSync(join(everyFolder, "clover.json"), JSON.stringify({
      manifest: 1, id: everyId, name: "Acceptance Every Composer", description: "The acceptance run's style for every bot's composer: two tokens, nothing else.", version: "0.0.1", engines: { clover: "^1.0.0" },
      contributes: { ui: [{ spot: "composer", id: "paint", style: "paint.json" }] },
    }));
    const installed: string[] = [];
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
    // The window's own sidebar as drawn: its box, ground, rule and material, the tokens its content takes, and each row's
    // look but the two bots' (the selected one differs by design). Read with the pointer off the sidebar.
    const sidebarLook = async (): Promise<string> => {
      const shell = await until("the shell's document", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-window__sidebar')"));
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500, buttons: 0 }, shell.session).catch(() => undefined);
      await sleep(400);
      return String(await cdp.evaluate(shell.session, `(() => {
        const side = document.querySelector('.cl-window__sidebar'), content = document.querySelector('.cl-window__sidebar-content');
        const cs = (e) => getComputedStyle(e), r = side.getBoundingClientRect(), c = cs(side), k = cs(content);
        const skip = new Set(["Alpha", ${JSON.stringify(name)}]);
        const rows = [...document.querySelectorAll('.cl-sidebar__row')].filter((e) => e.getClientRects().length > 0).map((e) => {
          const words = (e.innerText || '').trim().split('\\n').map((l) => l.trim()).filter((l) => l !== '');
          const t = e.getAttribute('aria-label') || words.find((l) => l.length > 1) || words[0] || '';
          if (words.some((l) => skip.has(l)) || skip.has(t) || e.getAttribute('aria-current') === 'page') return null;
          const b = e.getBoundingClientRect(), x = cs(e);
          return [t, Math.round(b.left), Math.round(b.width), Math.round(b.height), x.color, x.backgroundColor, x.fontWeight, x.boxShadow].join('|');
        }).filter((x) => x !== null);
        return JSON.stringify({ box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], ground: c.backgroundColor, rule: c.borderRightColor + ' ' + c.borderRightWidth, material: c.backdropFilter,
          accent: k.getPropertyValue('--clover-color-accent').trim(), text: k.getPropertyValue('--clover-color-text').trim(), ink: k.color, rows });
      })()`));
    };
    const composerTokens = async () => {
      const v = await inTree<string>(cdp, `(() => { const el = [...document.querySelectorAll('.cl-composer')].find((e) => e.getClientRects().length > 0); if (!el) return null; const c = getComputedStyle(el); return JSON.stringify({ surface: c.getPropertyValue('--clover-color-surface').trim().toUpperCase(), composer: c.getPropertyValue('--clover-composer-background').trim().toUpperCase() }); })()`);
      return v === undefined ? undefined : (JSON.parse(v.value) as { surface: string; composer: string });
    };
    try {
      for (const [pid, dir] of [[id, folder], [everyId, everyFolder]] as const) {
        await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
        installed.push(pid);
        await ctx.pressCard!(`${pid}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === pid);
        await until(`${pid} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: pid }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      }
      await toAlpha();
      // 1. Alpha: her own top bar (no stock bar), and the window's own sidebar beside her tab, open.
      await until("Alpha's window shape", 20_000, async () => ((await win("w.dataset.barMode")) === "none" ? true : undefined), async () => `bar-mode ${await win("w.dataset.barMode")} || ${await dumpFrames(cdp)}`);
      if ((await win("!!document.querySelector('.cl-window__bar')")) !== "false") fail("Alpha's tab still shows the stock bar");
      if ((await win("w.hasAttribute('data-sidebar-mode')")) !== "false") fail(`the window still takes a sidebar mode from her theme (${await win("w.dataset.sidebarMode")})`);
      if ((await win("w.dataset.collapsed === 'true'")) === "true") fail("the window's sidebar rests folded on her tab");
      if ((await inTree<boolean>(cdp, "[...document.querySelectorAll('.cl-sidebar__row')].some((e) => e.getClientRects().length > 0)")) === undefined) fail("the stock sidebar isn't drawn beside Alpha's tab");
      const skin = (await win("w.dataset.skin || ''")) ?? "";
      const herSide = await sidebarLook();
      // Her room sizes itself by the window's width, read as `outerWidth` in her frame (less the sidebar beside her tab): it must be the window's own (the shell document's innerWidth), not the frame's.
      const outer = Number((await inTree<number>(cdp, "document.querySelector('.rm') ? window.outerWidth : null"))?.value ?? NaN);
      const inner = Number(await win("window.innerWidth"));
      if (!Number.isFinite(outer) || !Number.isFinite(inner) || Math.abs(outer - inner) > 40) fail(`outerWidth in her frame (${outer}) is not the window's width (${inner})`);
      // 2. Her toggle folds the window's own sidebar to its rail and opens it again (shell.setSidebar, given the state she read).
      const collapsed = async () => (await win("w.dataset.collapsed === 'true'")) === "true";
      await press("her sidebar toggle", ".ac__btn", "Hide the sidebar");
      await until("the stock sidebar folded", 10_000, async () => ((await collapsed()) && (await inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar[data-collapsed]')")) !== undefined ? true : undefined));
      const railWidth = Number(await win("Math.round(document.querySelector('.cl-window__sidebar').getBoundingClientRect().width)"));
      if (!(railWidth > 0 && railWidth <= 100)) fail(`the folded sidebar is ${railWidth} px wide, not the stock rail`);
      await press("her sidebar toggle again", ".ac__btn", "Show the sidebar");
      await until("the stock sidebar open again", 10_000, async () => (!(await collapsed()) && (await inTree<boolean>(cdp, "!!document.querySelector('.cl-sidebar:not([data-collapsed])')")) !== undefined ? true : undefined));
      // 2b. The figure's box (`avatar.box` and `avatar.watch`, `avatar.read`): her "Right now" bubble is placed from the box her stage's renderer
      // publishes (inline left/top, set only once a box is known), and moves when the box does: the window made a little narrower
      // changes the stage's box, and the bubble follows it; widened again, it comes back. With the sidebar folded so the window's
      // width leaves her the wide room the bubble and her stage tools show in.
      await press("her sidebar toggle (for the bubble)", ".ac__btn", "Hide the sidebar");
      await until("the stock sidebar folded", 10_000, async () => ((await collapsed()) ? true : undefined));
      const bubble = async () => (await inTree<string>(cdp, "(() => { const e = document.querySelector('.rm__say'); return e && e.getClientRects().length > 0 && e.style.top !== '' ? e.style.left + '|' + e.style.top : null; })()"))?.value;
      let boxSaid = "";
      let stageTools = "";
      try {
        const placedAt = await until("her bubble placed from the figure's box (avatar.box)", 60_000, () => bubble(), async () => `${(await inTree<string>(cdp, "document.querySelector('.rm') ? document.querySelector('.rm').dataset.size + ' ' + (document.querySelector('.rm__say') ? 'bubble ' + document.querySelector('.rm__say').getAttribute('style') : 'no bubble') : 'no room'"))?.value}`);
        const appTop = (await cdp.documents()).find((d) => d.url === "clover-core://app/");
        if (appTop === undefined) fail("no app document to resize");
        let movedTo = "";
        try {
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1240, height: 800, deviceScaleFactor: 1, mobile: false }, appTop!.session);
          movedTo = await until("her bubble moving with the box (avatar.watch)", 30_000, async () => { const v = await bubble(); return v !== undefined && v !== placedAt ? v : undefined; }, async () => `still ${await bubble()}`);
        } finally {
          // Back to the window's own size (the sidebar's look is compared at it below).
          await cdp.send("Emulation.clearDeviceMetricsOverride", {}, appTop!.session).catch(() => undefined);
        }
        const nums = (v: string | undefined) => (v ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
        const near = (v: string | undefined, w: string) => { const x = nums(v), y = nums(w); return x.length === y.length && x.length > 0 && x.every((n, i) => Math.abs(n - y[i]!) <= 8); };
        await until("her bubble back where it was (within a few px)", 30_000, async () => (near(await bubble(), placedAt) ? true : undefined), async () => `now ${await bubble()}, was ${placedAt}`);
        boxSaid = `her bubble was placed from the figure's box (${placedAt}), moved with it when the window narrowed (${movedTo}) and came back`;
        // 2c. Her stage tools (in her wide room, the sidebar folded): each is present; one that the figure's renderer can do opens its list (Expression, from the model's catalogue), the others say why not.
        const toolNames = (await inTree<string>(cdp, "(() => { const t = [...document.querySelectorAll('.rm__tool')]; return t.length ? JSON.stringify(t.map(e => e.getAttribute('aria-label') + ':' + (e.getAttribute('aria-disabled') ?? 'on'))) : null; })()"))?.value ?? "[]";
        if (!/Expression/.test(toolNames)) fail(`her stage tools are not drawn (${toolNames})`);
        stageTools = `her stage tools were drawn (${toolNames})`;
        if ((await inTree<boolean>(cdp, "!!document.querySelector('.rm__tool[aria-label=Expression]:not([aria-disabled])')")) !== undefined) {
          await press("her Expression tool", ".rm__tool", "Expression");
          await until("her expression list", 10_000, () => inTree<boolean>(cdp, "!!document.querySelector('.rm__list [role=menuitem]')"));
          await press("her Expression tool again", ".rm__tool", "Expression");
          stageTools += "; Expression opened a list of the model's own expressions";
        }
      } finally {
        if (await collapsed()) await press("her sidebar toggle (back open)", ".ac__btn", "Show the sidebar").catch(() => undefined);
      }
      // 3. Her panel control opens the panel sheet and closes it: the Browser panel, which the bundled browser view fills (her
      // Session control opens the slim column beside her conversation, not a panel).
      const control = "Browser";
      if ((await inTree<boolean>(cdp, "!!document.querySelector('.ac__act[aria-label=Browser]')")) === undefined) fail(`her controls offer no Browser panel (${(await inTree<string>(cdp, "JSON.stringify([...document.querySelectorAll('.ac__act')].map((e) => e.getAttribute('aria-label')))"))?.value ?? "no controls"})`);
      await press(`her ${control} control`, ".ac__act", control);
      await until("the panel sheet open", 10_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-chrome-panels .cl-panel')"), () => dumpFrames(cdp));
      await press(`her ${control} control again`, ".ac__act", control);
      await until("the panel sheet closed", 10_000, async () => ((await inTree<boolean>(cdp, "!!document.querySelector('.cl-chrome-panels .cl-panel')")) === undefined ? true : undefined));
      const panels = `her ${control} control opened the panel in her sheet and closed it`;
      // A coding session to go to, started before the next tab change (the window reads its session list on a tab change; the app starts one the same way); `session.list` is the door that lists it (`conversation.list` is a plugin-host call, not an RPC).
      const code = await ensureCodingSession(ctx);
      // 4. More scoped wins: her composer keeps her own look against the all-bots style.
      const herTokens = await until("her composer's tokens", 20_000, () => composerTokens(), () => dumpFrames(cdp));
      if (herTokens.surface === EVERY.surface) fail(`on Alpha's tab the all-bots composer style's color.surface (${EVERY.surface}) beat her own composer style's (tab/pane.json)`);
      if (herTokens.composer === EVERY.composer) fail(`on Alpha's tab the all-bots composer style's composer.background (${EVERY.composer}) beat her theme's`);
      // 5. A plain bot: the stock bar, the same sidebar, and the all-bots style on its composer.
      await press(`${name} in the sidebar`, SIDEBAR_ITEMS, name);
      await until("the stock bar back", 20_000, async () => ((await win("!!document.querySelector('.cl-window__bar') && w.dataset.barMode")) === "standard" ? true : undefined), async () => `${await win("w.dataset.barMode")} || ${await dumpFrames(cdp)}`);
      const plainSide = await sidebarLook();
      if (plainSide !== herSide) fail(`the sidebar beside Alpha's tab isn't the one beside a plain bot's:\n  hers  ${herSide}\n  plain ${plainSide}`);
      const plainTokens = await until("the plain bot's composer in the all-bots style", 20_000, async () => { const t = await composerTokens(); return t !== undefined && t.surface === EVERY.surface && t.composer === EVERY.composer ? t : undefined; }, async () => `its composer reads ${JSON.stringify(await composerTokens())}`);
      // 6. Back to Alpha by the sidebar's row: her chrome returns.
      await press("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha");
      await until("her chrome back", 20_000, async () => ((await win("w.dataset.barMode")) === "none" ? true : undefined));
      let side = "this run could not start a coding session, so her Code switch had nowhere to go (not pressed)";
      if (code) {
        await press("her Code switch", ".as__opt", "Code");
        await until("the stock bar on the Code side", 20_000, async () => ((await win("!!document.querySelector('.cl-window__bar') && w.dataset.barMode")) === "standard" ? true : undefined));
        side = "her Code switch brought the stock bar and sidebar";
        await press("Alpha in the stock sidebar", SIDEBAR_ITEMS, "Alpha");
      }
      const rows = (JSON.parse(herSide) as { rows: string[] }).rows.length;
      return `on Alpha's tab no stock bar (bar-mode none), her own controls, and the window's own sidebar beside it exactly as beside ${name}'s (box, ground, rule, material, its accent and text tokens and ${rows} rows the same; her skin "${skin}" reaches the bar and panels only); her toggle folded the stock sidebar to its ${railWidth} px rail and opened it again; ${boxSaid}; ${panels}; ${stageTools}; more scoped wins: her composer kept her own color.surface (${herTokens.surface}) and composer.background (${herTokens.composer}) against an all-bots style, which ${name}'s composer took (${plainTokens.surface}, ${plainTokens.composer}); ${name}'s tab kept the stock bar, and Alpha's brought her chrome back; ${side}`;
    } finally {
      for (const pid of installed.reverse()) await rpc.request("plugin.remove", { id: pid }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
      if ((await win("w.dataset.collapsed === 'true'").catch(() => undefined)) === "true") await press("her sidebar toggle (back open)", ".ac__btn", "Show the sidebar").catch(() => undefined);
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
      // Out of any dialog.
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
      // The core's side first: the bot's user layer holds the layout. Read with `bot.get`, which the run's connection may
      // call on a packaged core too (the CLI's role there; `plugin.ui` is the app's alone, so it was always refused).
      await until("the bot's user layer holding the user's layout", 10_000, async () => {
        const b = await rpc.request<{ bot: { userLayer: string[] } }>("bot.get", { id });
        return b.bot.userLayer.includes("layout") ? true : undefined;
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

  // 22: idle with Alpha's tab open. The app says every five seconds (CLOVER_IPC_STATS, the run sets it) what crossed between the
  // windows and the main process, by channel, and what each process cost; a quiet app is a cheap one. An owner's app once ran
  // the main process at half a core with nothing happening: this holds the idle one to a budget, printed in the row.
  await step(22, async () => {
    const IDLE_MS = 15_000, MAIN_MAX_PERCENT = 25, MESSAGES_MAX_PER_SECOND = 20; // measured idle: main about 7.5%, under 1 message a second
    if ((await inTree<boolean>(cdp, "!!document.querySelector('.ac')")) === undefined) {
      const at = await until("Alpha in the sidebar", 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, SIDEBAR_ITEMS, "Alpha").catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.click(at.session, at.c.x, at.c.y);
      await until("Alpha's own controls", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.ac')"), () => dumpFrames(cdp));
    }
    await sleep(6_000); // what opening her tab starts (her room's few ticks, the stage loading) is not idle
    const from = ctx.appLog().length;
    await sleep(IDLE_MS);
    const raw = ctx.appLog().slice(from).split("\n").filter((l) => l.startsWith("ipc: ") || l.includes(" ipc: "));
    const lines = raw.flatMap((l) => { const p = parseIpcLine(l); return p === undefined ? [] : [p]; });
    if (lines.length < 2) fail(`the app said ${lines.length} ipc line(s) in ${IDLE_MS / 1000} s (it says one every 5 s when CLOVER_IPC_STATS=1) [apps/desktop/src/main/ui/ipc-stats.ts]`);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // The main process is the one typed Browser; the windows' are Tab; the rest (GPU, utility) are told too.
    const by = (type: string) => mean(lines.map((l) => l.cpu.filter((c) => c.type === type).reduce((a, c) => a + c.percent, 0)));
    const main = by("Browser"), tabs = by("Tab"), gpu = by("GPU");
    const inRate = mean(lines.map((l) => l.inPerSecond)), outRate = mean(lines.map((l) => l.outPerSecond));
    const where = raw.slice(-1)[0] ?? "";
    const said = `main ${main.toFixed(1)}% of a core, windows ${tabs.toFixed(1)}% (all together), GPU ${gpu.toFixed(1)}%; ${inRate.toFixed(1)} messages/s in and ${outRate.toFixed(1)}/s out over ${lines.length} windows of 5 s [${where.slice(where.indexOf("ipc: "))}]`;
    if (main > MAIN_MAX_PERCENT) fail(`an idle app's main process used ${said} (at most ${MAIN_MAX_PERCENT}%)`);
    if (inRate + outRate > MESSAGES_MAX_PER_SECOND) fail(`an idle app's windows and main traded ${said} (at most ${MESSAGES_MAX_PER_SECOND} a second together; the line names the channels)`);
    return `idle ${IDLE_MS / 1000} s with Alpha's tab open: ${said}`;
  });

  // 23: a third-party media plugin (acceptance-media, `files`), installed from its folder: its page, opened from its sidebar
  // button, asks the app's file picker for a video (the test build answers from CLOVER_TEST_PICK_FILES, a generated file),
  // and gets a token, the name and the size, never the path. The page plays the video from the media URL (a range read
  // answered with 206 and its Content-Range, one past the end refused with 416; the `<video>` reads its size and length
  // from it), runs a WebAssembly module from its own folder, and its click on Save gets a token from the save picker. The
  // core keeps the grants for the plugin's host half (`plugin.grant.add`); a core without it is said in the app's log and
  // the page's tokens still work for the media URL.
  await step(23, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const picks = ctx.mediaPicks;
    if (picks === undefined) return fail("this run has no media picker answers");
    const id = "acceptance-media";
    const parent = mkdtempSync(join(tmpdir(), "clover-media-"));
    const folder = join(parent, id);
    cpSync(join(import.meta.dir, "fixtures", id), folder, { recursive: true });
    const layerDocs = async () => (await cdp.documents()).filter((d) => d.url.startsWith(`clover-plugin://${id}/`));
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
    const attr = async (name: string): Promise<string> => {
      for (const d of await layerDocs()) {
        const v = String(await cdp.evaluate(d.session, `document.querySelector('[data-acceptance-media="main"]')?.getAttribute(${JSON.stringify(`data-${name}`)}) ?? ''`).catch(() => ""));
        if (v !== "") return v;
      }
      return "";
    };
    const clickPage = async (what: string, step: string) => {
      for (const d of await layerDocs()) {
        const c = await cdp.centerOf(d.session, `[data-acceptance-media-step="${step}"]`, undefined).catch(() => undefined);
        if (c !== undefined) { await cdp.click(d.session, c.x, c.y); return; }
      }
      fail(`${what}: no button in the page`);
    };
    const installed = await rpc.request<{ id: string; state: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
    try {
      if (installed.id !== id) fail(`the fixture installed as ${installed.id}`);
      const ok = await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === id);
      await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
      // Its page, from its sidebar button (pressed again until it draws: a layer installed after the window loaded reloads the document).
      let lastPress = 0;
      await until("its page in a frame of its own layer", 60_000, async () => {
        if ((await attr("wasm")) !== "") return true;
        if (Date.now() - lastPress > 5_000) {
          lastPress = Date.now();
          await clickIn("its app button in the sidebar", SIDEBAR_ITEMS, "Acceptance media", 10_000).catch(() => undefined);
        }
        return undefined;
      }, () => dumpFrames(cdp));
      const wasm = await until("its WebAssembly module's answer", 20_000, async () => ((await attr("wasm")) !== "" ? await attr("wasm") : undefined));
      if (wasm !== "add(2,3)=5") fail(`the page's WebAssembly module said ${JSON.stringify(wasm)}, not add(2,3)=5 (the layer's policy refused it?)`);
      const worker = await until("its worker's answer", 10_000, async () => ((await attr("worker")) !== "" ? await attr("worker") : undefined));
      // The open picker: the click is the user's, the answer comes from the file the run wrote.
      await clickPage("the open button", "open");
      const opened = await until("the page's open result", 30_000, async () => ((await attr("open")) !== "" ? await attr("open") : undefined), async () => `the page says open=${JSON.stringify(await attr("open"))}; ${await dumpFrames(cdp)}`);
      if (!/^generated-testsrc\.webm \d+ read token$/.test(opened)) fail(`the open pick gave the page ${JSON.stringify(opened)}, not the generated video's name, size, read access and a token`);
      if (opened.includes(picks.video) || opened.includes("/")) fail(`the page was given a path: ${JSON.stringify(opened)}`);
      const size = Number(opened.split(" ")[1]);
      const range = await until("the media URL's range answer", 20_000, async () => ((await attr("range")) !== "" ? await attr("range") : undefined));
      if (range !== `206 bytes 0-9/${size} 10`) fail(`a range read of the media URL answered ${JSON.stringify(range)}, not 206 bytes 0-9/${size} 10`);
      const past = await until("the range past the end", 10_000, async () => ((await attr("past")) !== "" ? await attr("past") : undefined));
      if (past !== "416") fail(`a range past the end of the granted file answered ${past}, not 416`);
      const video = await until("the video's metadata", 20_000, async () => ((await attr("video")) !== "" ? await attr("video") : undefined));
      if (!/^64x48 1\.0s$/.test(video)) fail(`the <video> read ${JSON.stringify(video)} from the media URL, not 64x48 1.0s`);
      // `client.isolated`: the manifest asks, so the layer is cross-origin isolated and SharedArrayBuffer exists.
      const sab = await until("the page's isolation reading", 10_000, async () => ((await attr("sab")) !== "" ? await attr("sab") : undefined));
      if (sab !== "function/isolated=true") fail(`the page read ${JSON.stringify(sab)}, not function/isolated=true (client.isolated in its manifest)`);
      // `files.pickFolder`: the user's click, a token for the folder the harness named (never its path).
      await clickPage("the folder button", "folder");
      const folder = await until("the page's folder result", 30_000, async () => ((await attr("folder")) !== "" ? await attr("folder") : undefined), async () => `the page says folder=${JSON.stringify(await attr("folder"))}`);
      if (!/^media-fixture \w+ token$/.test(folder)) fail(`the folder pick gave the page ${JSON.stringify(folder)}, not the folder's name, its access and a token`);
      if (folder.includes("/")) fail(`the page was given a folder path: ${JSON.stringify(folder)}`);
      // `files.onDrop`: a file dropped on the page (a real drag from the DevTools input, which the preload reads as a trusted drop).
      for (const d of await layerDocs()) {
        const c = await cdp.centerOf(d.session, '[data-acceptance-media="main"]', undefined).catch(() => undefined);
        if (c === undefined) continue;
        const data = { items: [], files: [picks.video], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: c.x, y: c.y, data }, d.session);
        break;
      }
      const dropped = await until("the page's drop result", 20_000, async () => ((await attr("drop")) !== "" ? await attr("drop") : undefined), async () => `the page says drop=${JSON.stringify(await attr("drop"))}`);
      if (dropped !== "generated-testsrc.webm token") fail(`the drop gave the page ${JSON.stringify(dropped)}, not the file's name and a token`);
      // The save picker: one more click of the user's, a token for the one file.
      await clickPage("the save button", "save");
      const saved = await until("the page's save result", 30_000, async () => ((await attr("save")) !== "" ? await attr("save") : undefined), async () => `the page says save=${JSON.stringify(await attr("save"))}`);
      if (saved !== "export.bin write token") fail(`the save pick gave the page ${JSON.stringify(saved)}, not export.bin, write access and a token`);
      const log = ctx.appLog();
      const kept = !log.includes(`files: ${id}: the core keeps no grants yet`);
      // Its host half's use of the token (`files.stat` on `grant:<uuid>`, and `files.path` for the real path a program of
      // its own would take): the file's size and the real path's last part when the core keeps grants.
      const hostSaid = await until("its host half's answer about the token", 20_000, async () => ((await attr("host")) !== "" ? await attr("host") : undefined));
      if (kept && hostSaid !== `size ${size} file generated-testsrc.webm`) fail(`the host half's files.stat and files.path on the token said ${JSON.stringify(hostSaid)}, not size ${size} file generated-testsrc.webm`);
      // The Plugins page's "Files it may open" (the grants the pickers above made, listed on the detail with the real path, which the
      // user's own page may show) and Take back, pressed in the window: the files the plugin was given are listed, one is taken
      // back, and the list has one entry fewer. The window alone (`plugin.grant.*` is the app role's, not the packaged run's CLI's).
      await escape();
      await until("the sidebar's Plugins entry", 20_000, async () => {
        for (const d of await treeDocs(cdp)) { const c = await cdp.centerOf(d.session, SIDEBAR_ITEMS, "Plugins").catch(() => undefined); if (c !== undefined) { await cdp.click(d.session, c.x, c.y); return true; } }
        return undefined;
      }, () => dumpFrames(cdp));
      await clickIn("the Installed tab", "[role=tab]", "Installed");
      await clickIn("Open Acceptance media", `button[aria-label=${JSON.stringify("Open Acceptance media")}]`, undefined);
      const takeBack = `button[aria-label^="Take back "][aria-label$=${JSON.stringify(`/${picks.video.split("/").pop()}`)}]`;
      const shownGrants = async () => Number((await inTree<number>(cdp, `(() => { const n = document.querySelectorAll(${JSON.stringify(takeBack)}).length; return n > 0 ? n : null; })()`))?.value ?? 0);
      const grantsBefore = await until("its picked file under Files it may open", 20_000, async () => { const n = await shownGrants(); return n > 0 ? n : undefined; }, async () => `${(await treeText(cdp)).replace(/\s+/g, " ").slice(0, 300)}`);
      await clickIn("Take back on the video's grant", takeBack, undefined);
      await until("one grant fewer under Files it may open", 20_000, async () => ((await shownGrants()) === grantsBefore - 1 ? true : undefined), () => dumpFrames(cdp));
      const grantsSaid = `its Plugins page listed ${grantsBefore} grant(s) of the picked video under Files it may open (the real path, a token to the plugin) and Take back removed one (${grantsBefore - 1} left)`;
      return `${id} (files) installed from its folder, OK'd on its card ${ok}; its page ran a WebAssembly module from its own folder (${wasm}) and a blob worker (${worker}); the open picker gave it ${opened} (a token, never a path); the media URL answered a range with ${range} and past the end ${past}; the <video> read ${video} from it; the layer is cross-origin isolated (${sab}); the folder picker gave it ${folder}; a dropped file gave it ${dropped}; the save picker gave it ${saved}; the core ${kept ? `kept the grants (plugin.grant.add answered); the host half read the file's size through files.stat and its real path through files.path on the token (${hostSaid})` : "keeps no grants yet (plugin.grant.add not served by this core): the host half's use of a token is not exercised (it said ${hostSaid})"}; ${grantsSaid}`;
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // 24: a third-party plugin (the acceptance-window fixture, no bot of its own) fills the window's spots in Alpha's tab, each
  // drawn in its own layer: a composer.action button (pressed in the window), conversation.message keyed `user`,
  // conversation.message.extra under the messages, tool.result for its own tool (a read-only host tool the bot called),
  // and a pill.target the Dispatch pill lists, picked and sent to (its host handler got the words: read back through its
  // own command). Its page tries the UI SDK's hooks: useKept keeps a count across a remount, useDrag offers and claims text,
  // useMenu asks for a menu from a click, useOpen/useUserSend/useComposerHost are refused or absent for a third party,
  // useApprovals/useQuestions answer lists. The row passes in the cli role too: nothing here calls an app-only method.
  await step(24, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const id = "acceptance-window";
    const folder = join(import.meta.dir, "fixtures", id);
    const layerDocs = async () => (await cdp.documents()).filter((d) => d.url.startsWith(`clover-plugin://${id}/`));
    /** The first element `sel` matches in any of the plugin's frames: its session and its attributes. */
    const find = async (sel: string): Promise<{ session: string; attrs: Record<string, string>; text: string } | undefined> => {
      for (const d of await layerDocs()) {
        const v = await cdp.evaluate(d.session, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? JSON.stringify({ attrs: Object.fromEntries([...e.attributes].map((a) => [a.name, a.value])), text: e.textContent || "" }) : "" })()`).catch(() => undefined);
        if (typeof v === "string" && v !== "") return { session: d.session, ...(JSON.parse(v) as { attrs: Record<string, string>; text: string }) };
      }
      return undefined;
    };
    const waitFor = (what: string, sel: string, ms = 45_000) => until(what, ms, () => find(sel), () => dumpFrames(cdp));
    const press = async (what: string, sel: string) => {
      const at = await until(what, 20_000, async () => {
        for (const d of await layerDocs()) {
          const c = await cdp.centerOf(d.session, sel).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.click(at.session, at.c.x, at.c.y);
    };
    const openApp = async (label: string) => {
      await escape();
      const at = await until(`${label} in the sidebar`, 20_000, async () => {
        for (const d of await treeDocs(cdp)) {
          const c = await cdp.centerOf(d.session, SIDEBAR_ITEMS, label).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, async () => {
        const rows: string[] = [];
        for (const d of await treeDocs(cdp)) {
          const v = await cdp.evaluate(d.session, `[...document.querySelectorAll(${JSON.stringify(SIDEBAR_ITEMS)})].map((e) => { const b = e.getBoundingClientRect(); return (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 24) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height); }).join(' | ')`).catch(() => "");
          if (v) rows.push(String(v));
        }
        return `sidebar items: ${rows.join(" || ")}`;
      });
      await cdp.click(at.session, at.c.x, at.c.y);
      await sleep(600);
    };
    const botMain = async () => (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.mainSession ?? fail("no bot alpha");
    const installed = await rpc.request<{ id: string; state: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
    try {
      if (installed.id !== id) fail(`the fixture installed as ${installed.id}`);
      const ok = await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === id);
      await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state === "running") ? true : undefined));
      // A turn in Alpha's conversation that calls the plugin's tool; her tab is open while it runs.
      // Alpha's tab is the one open at the start of a window run; pressed again only when another tab is showing.
      if ((await find('[data-acceptance-window="composer"]')) === undefined) await openApp("Alpha").catch(() => undefined);
      const session = await botMain();
      const tag = `WINDOW-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
      await rpc.request("session.send", { id: session, message: { text: `ACCEPTANCE-CALL Window {"text":"${tag}"}`, clientMessageId: `window-${tag}` } }, 30_000);
      const carded = "a read-only tool of its own: it ran with no card";
      await until("the tool's result in the model's next request", 90_000, async () => ctx.requests().find((r) => r.toolResult?.text.includes(`acceptance-window-pong: ${tag}`)),
        async () => `${carded}; the provider's last requests: ${JSON.stringify(ctx.requests().slice(-3).map((r) => ({ said: r.lastUserText.slice(0, 80), answered: r.answered?.slice(0, 80), result: r.toolResult?.text.slice(0, 80) })))}`);
      // 1.83 composer.action: its button is in the composer of Alpha's tab, pressed in the window.
      await waitFor("its composer.action button in Alpha's composer", '[data-acceptance-window="composer"]');
      await press("its composer button", '[data-acceptance-window="composer"]');
      await until("its composer button's press counted", 15_000, async () => ((await find('[data-acceptance-window="composer"]'))?.attrs["data-pressed"] === "1" ? true : undefined));
      // 1.89 conversation.message keyed `user`: the user's message drawn by the plugin, with its text (conversation.read).
      const user = await until("its own user-message cell for the turn's message", 45_000, async () => {
        for (const d of await layerDocs()) {
          const v = await cdp.evaluate(d.session, `(() => [...document.querySelectorAll('[data-acceptance-window="user-message"]')].map((e) => e.getAttribute("data-text") || "").find((t) => t.includes(${JSON.stringify(tag)})) || "")()`).catch(() => "");
          if (typeof v === "string" && v !== "") return v;
        }
        return undefined;
      }, () => dumpFrames(cdp));
      // conversation.message.extra: an add-on under the messages, told each message's kind.
      const extra = await waitFor("its conversation.message.extra add-on", '[data-acceptance-window="extra"]');
      // tool.result keyed by its own tool: drawn by the plugin with the call's result.
      // (The run of calls is a row the user opens: its call shows the result through the spot once expanded.)
      if ((await find('[data-acceptance-window="tool-result"]')) === undefined) await clickIn("the tool run's row, to open it", ".cl-conv-tools button", "Window");
      const toolResult = await waitFor("its tool.result view of its own tool's call", '[data-acceptance-window="tool-result"]');
      if (toolResult.attrs["data-tool"] !== "mcp__acceptance-window-tools__Window") fail(`its tool.result cell was given ${JSON.stringify(toolResult.attrs["data-tool"])}`);
      if (!(toolResult.attrs["data-result"] ?? "").includes(tag)) fail(`its tool.result cell's call didn't carry the result (${(toolResult.attrs["data-result"] ?? "").slice(0, 120)})`);
      // Its probe under the user's message (in the plugin's own frame in Alpha's tab): the hooks.
      const page = await waitFor("its hooks probe under the user's message", '[data-acceptance-window="page"]');
      const attrOf = async (name: string) => (await find('[data-acceptance-window="page"]'))?.attrs[`data-${name}`] ?? "";
      await until("the hooks' first answers", 20_000, async () => ((await attrOf("approvals")) !== "" && (await attrOf("questions")) !== "" ? true : undefined), async () => `page said ${JSON.stringify((await find('[data-acceptance-window="page"]'))?.attrs)}`);
      const listsSaid = `useApprovals gave a list (${await attrOf("approvals")}), useQuestions gave a list (${await attrOf("questions")})`;
      if (Number.isNaN(Number(await attrOf("approvals"))) || Number.isNaN(Number(await attrOf("questions")))) fail(`the hooks gave no list: ${JSON.stringify(page.attrs)}`);
      const absent = [await attrOf("usersend"), await attrOf("composerhost")];
      if (absent.join(",") !== "undefined,undefined") fail(`useUserSend / useComposerHost for a third party's page should be undefined, were ${absent.join(", ")}`);
      // useKept: counted twice, the child remounted, the count is kept.
      await press("kept +1", '[data-acceptance-window="kept"]');
      await press("kept +1 again", '[data-acceptance-window="kept"]');
      await until("kept counted two", 10_000, async () => ((await find('[data-acceptance-window="kept"]'))?.attrs["data-count"] === "2" ? true : undefined));
      await press("remount", '[data-acceptance-window="remount"]');
      await sleep(600);
      const kept = (await find('[data-acceptance-window="kept"]'))?.attrs["data-count"];
      if (kept !== "2") fail(`useKept lost its count over a remount: ${String(kept)}`);
      // useDrag: offer then claim returns the text.
      await press("drag", '[data-acceptance-window="drag"]');
      const dragged = await until("the drag's claim", 15_000, async () => { const v = await attrOf("drag"); return v !== "" ? v : undefined; });
      if (dragged !== "claimed:acceptance-drag-text") fail(`useDrag offered text and claimed ${JSON.stringify(dragged)}`);
      // useMenu: asked from a click; the headless run has no menu to show and gives null (or the test pick).
      await press("menu", '[data-acceptance-window="menu"]');
      const menuSaid = await until("the menu's answer", 15_000, async () => { const v = await attrOf("menu"); return v !== "" ? v : undefined; });
      if (menuSaid.startsWith("refused:")) fail(`useMenu was refused after a click: ${menuSaid}`);
      // useOpen: the tree's own door; a third party's page is refused.
      await press("open", '[data-acceptance-window="open"]');
      const openSaid = await until("the open's answer", 15_000, async () => { const v = await attrOf("open"); return v !== "" ? v : undefined; });
      // The Dispatch pill: the plugin's target is listed in the target menu, picked, and the words typed reach its host handler.
      const PILL_BOX = "textarea.clp-input";
      const box = await until("the pill's text box", 30_000, () => inTree<boolean>(cdp, `!!document.querySelector('${PILL_BOX}')`), () => dumpFrames(cdp));
      const s = box.session;
      const widen = { width: 720, height: 220, deviceScaleFactor: 1, mobile: false };
      await cdp.send("Emulation.setDeviceMetricsOverride", widen, s).catch(async () => {
        const top = (await cdp.documents()).find((d) => d.url.includes("surface=pill"));
        if (top !== undefined) await cdp.send("Emulation.setDeviceMetricsOverride", widen, top.session);
      });
      await sleep(500);
      const pillPress = async (what: string, selector: string, text?: string) => {
        const at = await until(what, 15_000, async () => cdp.centerOf(s, selector, text).catch(() => undefined), async () => `the pill's target button: ${String(await cdp.evaluate(s, "(document.querySelector('[data-menu-toggle=targets]') || {outerHTML: 'none'}).outerHTML.slice(0, 260)").catch(() => '?'))}; the pill shows ${JSON.stringify(await cdp.evaluate(s, "[...document.querySelectorAll('button,[role=menuitemradio],[role=menu]')].map((e) => (e.getAttribute('role') || 'button') + ':' + (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30) + ':' + Math.round(e.getBoundingClientRect().width))").catch(() => "?"))}`);
        await cdp.click(s, at.x, at.y);
      };
      await pillPress("the pill's target button", "button[data-menu-toggle=targets]");
      await pillPress("the plugin's target in the pill's menu", "[role=menuitemradio]", "Acceptance window");
      await sleep(500);
      const words = `PILL-${tag}`;
      await cdp.evaluate(s, `(() => { const t = document.querySelector('${PILL_BOX}'); t.focus(); return true; })()`);
      await cdp.send("Input.insertText", { text: words }, s);
      await sleep(500);
      // The Send circle, pressed once it has come to rest where the growing pill puts it (as step 5 does).
      for (let i = 0; i < 20; i++) {
        const a1 = await cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined);
        await sleep(300);
        const a2 = await cdp.centerOf(s, "button.clp-circle[data-role=send]").catch(() => undefined);
        if (a1 !== undefined && a2 !== undefined && Math.abs(a1.x - a2.x) < 0.5 && Math.abs(a1.y - a2.y) < 0.5) break;
      }
      await pillPress("the pill's Send circle", "button.clp-circle[data-role=send]");
      const reported = await until("the target's host handler to have the words", 30_000, async () => {
        const r = await rpc.request<{ text?: string }>("command.run", { name: `${id}.report` }).catch(() => undefined);
        const said = JSON.stringify(r ?? {});
        return said.includes(words) ? said : undefined;
      }, async () => `the report says ${JSON.stringify(await rpc.request("command.run", { name: `${id}.report` }).catch((e) => String(e)))}`);
      // A plugin that is off is not a target: switched off, the pill's menu no longer lists it (and the daemon refuses a send to it).
      await rpc.request("plugin.setEnabled", { id, enabled: false }, 30_000);
      await until(`${id} off`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state === "off") ? true : undefined));
      await sleep(800);
      if ((await cdp.evaluate(s, "document.querySelectorAll('[role=menuitemradio]').length").catch(() => 0)) === 0) await pillPress("the pill's target button again", "button[data-menu-toggle=targets]");
      await sleep(600);
      const stillListed = await cdp.evaluate(s, "[...document.querySelectorAll('[role=menuitemradio]')].some((e) => (e.textContent || '').includes('Acceptance window'))").catch(() => undefined);
      const listed = await cdp.evaluate(s, "[...document.querySelectorAll('[role=menuitemradio]')].map((e) => (e.textContent || '').trim()).join(' | ')").catch(() => "?");
      if (stillListed !== false) fail(`the pill still lists the plugin as a target while it is off (menu: ${String(listed)})`);
      const offSaid = `switched off (plugin.setEnabled), the pill's menu no longer lists it (it lists: ${String(listed).slice(0, 80)})`;
      return `${id} installed from its folder, OK'd on its card ${ok}; in Alpha's tab it filled composer.action (its button pressed in the window), conversation.message keyed user (it drew ${JSON.stringify(user.slice(0, 40))}), the tool call's card (${carded}), conversation.message.extra (${extra.attrs["data-kind"]} under a message) and tool.result for ${toolResult.attrs["data-tool"]} (the call's result in its cell); the Dispatch pill listed its pill.target, a pick and the Send circle sent the words to its host handler (${reported.slice(0, 80)}); its probe: ${listsSaid}; useUserSend and useComposerHost are undefined for it; useKept kept 2 over a remount; useDrag offered text and claimed it; useMenu from a click answered ${menuSaid}; useOpen answered ${openSaid.slice(0, 80)}; ${offSaid}`;
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
    }
  });

  // 25: the plug rule in the window (the owner, November 14; design/plug-rule-2026-11-14.md). A plugin with a bot (lane B's
  // Juniper fixture: an island tab beside it, a Browser panel of its own, settings): on Juniper's tab its Browser panel replaces
  // the stock one, on Alpha's tab the stock one shows; Juniper's Edit page has a section of the plugin's settings headed with her
  // name (a switch pressed, read back from the daemon); the Plugins page's second switch (the parts beside the bot) is pressed and
  // the plugin keeps running with the bot kept. Then the same plugin with a Browser panel that never draws: after two seconds the
  // panel says so and shows Clover's own, and its button tries the bot's again.
  await step(25, async () => {
    if (ctx.pressCard === undefined) fail("this run can't press a card");
    const id = FIELDS_IDS.bot;
    const parent = mkdtempSync(join(tmpdir(), "clover-plug-app-"));
    const win = async (expr: string) => (await inTree<string>(cdp, `(() => { const w = document.querySelector('.cl-window'); return w ? String(${expr}) : null; })()`))?.value;
    const press = async (what: string, selector: string, text?: string, ms = 20_000) => {
      const at = await until(what, ms, async () => {
        for (const d of await treeDocs(cdp)) {
          await cdp.evaluate(d.session, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e) e.scrollIntoView({ block: "center" }); return true; })()`).catch(() => undefined);
          const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
          if (c !== undefined) return { session: d.session, c };
        }
        return undefined;
      }, () => dumpFrames(cdp));
      await cdp.click(at.session, at.c.x, at.c.y);
      await sleep(700);
    };
    const inTreeNow = async (expr: string) => (await inTree<boolean>(cdp, `!!(${expr})`)) !== undefined;
    const install = async (variant: keyof typeof BOT_PARTS_CLIENT, root: string) => {
      const folder = writeBotParts(root, "anthropic/claude-sonnet-5-5", { client: BOT_PARTS_CLIENT[variant], settings: BOT_PARTS_SETTINGS });
      const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
      if (r.id !== id) fail(`the fixture installed as ${r.id}`);
      await ctx.pressCard!("its OK card", (c) => c.kind === "plugin-ok" && c.pluginId === id);
      await until(`${id} running`, 30_000, async () => (((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state === "running") ? true : undefined));
    };
    const toTab = async (name: string) => {
      await escape();
      await press(`${name} in the sidebar`, SIDEBAR_ITEMS, name);
    };
    /** The bot's Browser panel on its own tab (the stock bar's toggle), opened. */
    const openBrowser = async () => {
      if (!(await inTreeNow("document.querySelector('.cl-panel__view[data-view=browser]')"))) await press("the Browser toggle", ".cl-panel-toggle[aria-label=\"Browser\"]");
      await until("the Browser panel open", 15_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-panel__view[data-view=browser]')"), () => dumpFrames(cdp));
    };
    /** Opens the panel and waits for `check`, again when a plugin installed after the window was served made it load again (its first
     *  layer's serving does, and the panel open at that moment closes: the app logs "loads again to frame a layer installed after it
     *  was served"). */
    const openUntil = async (what: string, check: () => Promise<boolean>) => {
      let last = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        await openBrowser().catch(() => undefined);
        try {
          await until(what, 12_000, async () => ((await check()) ? true : undefined));
          return;
        } catch (e) {
          last = String(e);
        }
      }
      const panel = await win("document.querySelector('.cl-panel__view[data-view=browser]')?.outerHTML.slice(0, 600) ?? 'no panel'");
      fail(`${what}: not within 4 tries (${last.slice(0, 120)}; the panel: ${panel}; frames: ${await dumpFrames(cdp)})`);
    };
    const layerHas = async (sel: string) => {
      for (const d of (await cdp.documents()).filter((x) => x.url.startsWith(`clover-plugin://${id}/`))) {
        if ((await cdp.evaluate(d.session, `!!document.querySelector(${JSON.stringify(sel)})`).catch(() => false)) === true) return true;
      }
      return false;
    };
    const renders = process.env.CLOVER_ACCEPT_RENDERS;
    const said: string[] = [];
    try {
      await install("drawing", join(parent, "a"));
      // 1. Juniper's tab: her Browser panel replaces the stock one.
      await toTab(BOT_PARTS_BOT);
      await openUntil("Juniper's own Browser panel drawn on her tab", () => layerHas("[data-juniper-browser]"));
      if (await inTreeNow("document.querySelector('[data-replaced-panel=browser][data-fell]')")) fail("Juniper's drawing Browser panel was swapped for the stock one");
      said.push("on Juniper's tab her own Browser panel replaced the stock one");
      // On Alpha's tab the stock one shows, with none of Juniper's inside her panel sheet.
      await toTab("Alpha");
      await until("Alpha's own controls", 20_000, () => inTree<boolean>(cdp, "!!document.querySelector('.ac')"), () => dumpFrames(cdp));
      if (!(await inTreeNow("document.querySelector('.cl-chrome-panels .cl-panel')"))) await press("her Browser control", ".ac__act", "Browser");
      await until("Alpha's panel sheet open", 15_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-chrome-panels .cl-panel')"), () => dumpFrames(cdp));
      if (await inTreeNow(`document.querySelector('.cl-chrome-panels [data-replaced-panel]') || document.querySelector('.cl-chrome-panels [data-clover-entry^="${id}#"]')`)) fail("Juniper's Browser panel is in Alpha's panel sheet (it replaces the panel on her own tab only)");
      await press("her Browser control again", ".ac__act", "Browser");
      said.push("on Alpha's tab the stock panel (none of hers)");
      // 2. Her Edit page: the plugin's settings as a section headed with her name; the switch pressed, read back from the daemon.
      await toTab(BOT_PARTS_BOT);
      await press("Edit Juniper", `[aria-label="Edit ${BOT_PARTS_BOT}"]`);
      await until("the settings section headed with her name", 20_000, () => inTree<boolean>(cdp, `!!document.querySelector('.cl-bot-editor__settings[data-bot-settings="${id}"]')`), () => dumpFrames(cdp));
      const heading = await win(`document.querySelector('.cl-bot-editor__settings-title')?.textContent`);
      if (heading !== BOT_PARTS_BOT) fail(`the section's heading is ${JSON.stringify(heading)}, not ${BOT_PARTS_BOT}`);
      if (!(await inTreeNow(`document.querySelector('.cl-bot-editor__settings [role=switch][aria-label="${BOT_PARTS_SETTINGS.loud.title}"]')`))) fail("the section has no switch for the plugin's per-bot setting");
      if (renders) await shootWindow(cdp, renders, "plug-app-edit-section", ctx.setAppearance);
      await press("the Speaks up switch", `.cl-bot-editor__settings [role=switch][aria-label="${BOT_PARTS_SETTINGS.loud.title}"]`);
      await until("the setting kept by the daemon", 20_000, async () => {
        const r = await rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id, bot: id }).catch(() => undefined);
        return r?.settings.find((x) => x.key === "loud")?.value === true ? true : undefined;
      });
      if (renders) await unshootWindow(cdp, ctx.setAppearance);
      said.push("her Edit page's section (her name) pressed a per-bot switch and the daemon has it");
      // 3. The Plugins page: the switch for the parts beside her bot, pressed; the plugin keeps running and she is kept.
      await escape();
      await press("the sidebar's Plugins entry", SIDEBAR_ITEMS, "Plugins");
      await until("the Plugins page", 15_000, () => inTree<boolean>(cdp, "!!document.querySelector('.cl-plugin-index__tabs')"), () => dumpFrames(cdp));
      await press("the Installed tab", "[role=tab]", "Installed");
      const toggle = `[role=switch][aria-label="Its parts beyond Acceptance Juniper's tab"]`;
      await until("the app-parts switch on its row", 20_000, () => inTree<boolean>(cdp, `!!document.querySelector('${toggle}')`), () => dumpFrames(cdp));
      if (renders) await shootWindow(cdp, renders, "plug-app-plugins-toggle", ctx.setAppearance);
      if (renders) await unshootWindow(cdp, ctx.setAppearance);
      await press("the app-parts switch", toggle);
      await until("its app parts off in the daemon, the plugin still running", 30_000, async () => {
        const r = await rpc.request<{ plugin: { state: string; parts?: { app?: { enabled?: boolean } } } }>("plugin.get", { id }).catch(() => undefined);
        return r?.plugin.state === "running" && r.plugin.parts?.app?.enabled === false ? true : undefined;
      }, async () => JSON.stringify(await rpc.request("plugin.get", { id }).catch(() => undefined)).slice(0, 300));
      const kept = (await rpc.request<{ bots: { id: string }[] }>("bot.list", {})).bots.some((b) => b.id === id);
      if (!kept) fail("the bot is gone after her app parts were switched off");
      if ((await inTree<boolean>(cdp, `document.querySelector('${toggle}')?.getAttribute('aria-checked') === 'false'`)) === undefined) fail("the switch doesn't show the parts off");
      await toTab(BOT_PARTS_BOT);
      said.push("the Plugins page's switch turned her parts beside the bot off, the plugin running, Juniper kept and her tab still there");
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
      // 4. A replacement that never draws: after two seconds the stock panel shows, the header says so, and the button tries again.
      await install("never", join(parent, "b"));
      await toTab(BOT_PARTS_BOT);
      const fellTitle = `${BOT_PARTS_BOT}'s browser panel didn't draw; showing Clover's.`;
      const fellNow = async () => (await win(`document.querySelector('.cl-panel__view[data-view=browser]')?.getAttribute('aria-label')`)) === fellTitle;
      await openUntil("the panel falling back to Clover's own", fellNow);
      if (!(await inTreeNow("document.querySelector('[data-replaced-panel=browser] [data-clover-entry^=\"clover/\"]')"))) fail("after the fall back the stock Browser panel isn't in the panel");
      await press("Try Juniper's again", ".cl-panel__text-button", `Try ${BOT_PARTS_BOT}'s again`);
      await until("the fall back again (her panel still doesn't draw)", 30_000, () => inTree<boolean>(cdp, `document.querySelector('.cl-panel__view[data-view=browser]')?.getAttribute('aria-label') === ${JSON.stringify(fellTitle)}`), () => dumpFrames(cdp));
      said.push("a Browser panel that never draws fell back to Clover's after 2 s with its header saying so, and Try again tried hers once more");
      if (/window: shown while headless/.test(ctx.appLog())) fail("a window was shown while headless");
      return said.join("; ");
    } finally {
      await rpc.request("plugin.remove", { id }).catch(() => undefined);
      rmSync(parent, { recursive: true, force: true });
      await escape().catch(() => undefined);
      await press("Alpha in the sidebar", SIDEBAR_ITEMS, "Alpha").catch(() => undefined);
    }
  });
}
