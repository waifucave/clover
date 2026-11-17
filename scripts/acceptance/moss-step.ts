// The `moss` unit (lane MA): MOSS, the bots app (apps/moss), from source, headless (offscreen, muted, nothing on the
// screen), against the real engine on the run's temp home with the bots as engine data (`MOSS_BOT_SOURCE=records`). Each
// row proves what a person sees in MOSS's own window, driven through its DevTools port with trusted input (clicks, typed
// text): no fake engine, no test-only call into MOSS's main process. What MOSS needs of a test build is three seams,
// compiled out of a real one: its window drawn offscreen (a headless window paints nothing, and a card's visibility
// reading would never say it shows), a file that says whether its window is in front (a headless window is never the
// focused one), and its answer key kept in a file beside the run's throwaway keychain (so the run can sign with it, as an
// attacker holding MOSS's key would, and MOSS registers the same key after a restart).
//
// Its rows run in order on one home, one engine and one MOSS: the list (Alpha offered by default), a message and its
// reply, the approval card (refused without a press, refused signed as MOSS Code, taken on a real press), the card
// placed off MOSS while it isn't in front, the side panel's live picture and routines, the Plugins page's tool setting,
// a bot's instructions edited in Settings, making bots (the person's and a bot's MakeBot), and archive and bring back.
// Kept apart from run.ts: run.ts gives it the run's helpers (`MossUnitCtx`) and records its rows.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { instructionsEditRule, LEVELS, programCardAnswerSigningInput } from "../../packages/protocol/src/index";
import { answerKeyStatement } from "../../packages/core/src/devices/registry";
import { Cdp } from "./cdp";
import type { MossClient } from "./client";
import type { FakeProvider } from "./fake-anthropic";
import type { Status } from "./steps";

export const MOSS_LIST_STEP = "MOSS (the bots app) on a fresh home where only MOSS has run (no MOSS Code, no single answer key) and the bots are engine data: its list shows Alpha, offered by default (the move's record), with her face and her mood in words, and only the engine's bots";
export const MOSS_MESSAGE_STEP = "MOSS: a message typed and sent in Alpha's conversation reaches her one conversation (the record's main session), and her reply is drawn there as text; markup in a message stays text";
export const MOSS_CARD_STEP = "MOSS: an approval card from Alpha's turn is drawn in her conversation in MOSS's window by the router; an answer with no press of the person's is refused by MOSS, one signed as MOSS Code with MOSS's key is refused by the engine, and a real press on its sealed Approve is taken, signed with MOSS's own registered key (program moss) on a computer with no other answer key";
export const MOSS_AWAY_STEP = "MOSS not in front: the router places Alpha's next card off MOSS's window (the engine's card.placement) and MOSS draws none; in front again, the card comes back into her conversation and a press there answers it";
export const MOSS_PANEL_STEP = "MOSS's side panel: Alpha's live picture from her tool, watch only (a click on it reaches nothing), with the publisher's name, and her routines; the plugin that publishes it added behind its OK card, pressed in MOSS's strip";
export const MOSS_TOOLS_STEP = "MOSS's Plugins page: a plugin's tool set off there is off in the engine's tool.permissions, and Alpha's next turn isn't offered it (it was before)";
export const MOSS_INSTRUCTIONS_STEP = "MOSS's Settings: Alpha's instructions shown as they are now, edited in place and saved by the person with no card (instructionsEditRule: the person's own edit is free); her next turn is given them";
export const MOSS_MAKE_STEP = "MOSS: a bot made from the list's + (the person's bot.create, on a model chosen there from the ones the person has set up) opens on its own conversation and answers; that bot's MakeBot raises the person's OK card in MOSS naming the maker, and once pressed the new bot is listed, made by it";
export const MOSS_EDITOR_STEP = "MOSS's Settings, a bot's own page (the bot editor, MOSS Code's old rows 14 and 15): its name, model and instructions edited there are kept: the engine's record has them, the list shows the new name, and the page opened again shows all three";
export const MOSS_TRY_AGAIN_STEP = "MOSS: a turn that fails in Alpha's conversation shows Try again; one press sends the same words once more (session.resend), the next turn completes, and the button goes";
export const MOSS_ARCHIVE_STEP = "MOSS's Settings: a bot archived leaves the list and is listed under Archived bots; brought back, it is in the list again with its conversation whole";
export const MOSS_LONG_STEP = "MOSS: a long conversation the home already holds (a bot whose one conversation has 20,000 events, as the upgrade's copy brings the owner's): it opens on its latest page, scrolling up with the wheel reads the pages before it from the engine with the message under the eye kept in place, and the oldest message is reached by scrolling; its first paint and its page loads are timed";
export const MOSS_ROUTINE_RUN_STEP = "MOSS's side panel: Run now on Alpha's routine starts it at once (routine.runNow, the person's press), its run is in routine.runs, and its result is drawn in her conversation";
export const MOSS_ROUTINE_PAUSE_STEP = "MOSS's side panel: Pause on Alpha's routine pauses it (routine.edit: its file says paused, the engine lists it paused, Run now is off); Resume runs it again on its schedule (the file's paused taken out)";
export const MOSS_ROUTINE_EDIT_STEP = "MOSS's side panel: Edit on Alpha's routine shows what it does as its file has it now (routine.get) and saves a new name, schedule and instructions to its file (routine.edit); a routine above the computer's level waits for its OK card, pressed in MOSS, and an edit to it raises the card again, pressed in MOSS";
export const MOSS_MEMORY_STEP = "MOSS's Settings, a bot's own page: its memory folder's files listed as the engine serves them (memory.list), and a file opened shows its text as text (memory.read), read only";
export const MOSS_ROUTINE_FAIL_STEP = "MOSS's side panel: a routine whose run fails (Run now on Alpha's routine, its model's call refused) shows in her conversation that it failed and why, marked as a failure";
export const MOSS_DROP_STEP = "MOSS's composer: a file dropped on it is said plainly (MOSS sends pictures only, with the paperclip) and nothing is sent";
export const MOSS_BOTH_KEYS_STEP = "MOSS beside MOSS Code on one computer: with MOSS Code's own answer key registered too, MOSS still answers its card with its own key (program moss), and MOSS Code's connection can't answer a card MOSS draws, even signed with MOSS Code's own key";

/** The unit's rows, in the order it runs them. */
export const MOSS_STEPS: readonly string[] = [MOSS_LIST_STEP, MOSS_MESSAGE_STEP, MOSS_CARD_STEP, MOSS_AWAY_STEP, MOSS_PANEL_STEP, MOSS_TOOLS_STEP, MOSS_INSTRUCTIONS_STEP, MOSS_MAKE_STEP, MOSS_EDITOR_STEP, MOSS_TRY_AGAIN_STEP, MOSS_ARCHIVE_STEP, MOSS_LONG_STEP, MOSS_ROUTINE_RUN_STEP, MOSS_ROUTINE_PAUSE_STEP, MOSS_ROUTINE_EDIT_STEP, MOSS_MEMORY_STEP, MOSS_ROUTINE_FAIL_STEP, MOSS_DROP_STEP, MOSS_BOTH_KEYS_STEP];

/** The unit's daemon: the bots as engine data (lane MC1 makes it the default; until then the unit sets it). */
export const MOSS_ENV: Readonly<Record<string, string>> = { MOSS_BOT_SOURCE: "records" };

interface CardSeen { id: string; hash: string; kind: string; bot?: string; session?: string; options: { id: string; kind: string; remember?: string }[]; fields?: unknown }
type Placement = { kind: "conversation" | "strip"; program: string; window: string } | { kind: "island" } | { kind: "elsewhere" };
interface RecordView { id: string; name: string | { en: string }; mainSession: string; model?: string; madeBy: { kind: string; id?: string } }

/** What run.ts gives the unit. */
export interface MossUnitCtx {
  root: string;
  home: string;
  userHome: string;
  logs: string;
  fake: FakeProvider;
  /** The run's environment for a child (its temp home, profile, keychain service and file). */
  env(): Record<string, string>;
  startChild(name: string, cmd: string, args: string[], env: Record<string, string>): { proc: ChildProcess; log: string };
  endChild(proc: ChildProcess): Promise<boolean>;
  alive(proc: ChildProcess): boolean;
  until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined> | T | undefined, everyMs?: number): Promise<T>;
  fail(detail: string): never;
  readLog(path: string): string;
  /** The run's own connection: the `app` role with MOSS's surface, so the home sees no MOSS Code hello (a home where only
   *  MOSS has run); it reports no presence and draws nothing. */
  driver(): Promise<{ client: MossClient; result: Record<string, unknown> }>;
  /** A new connection in the `app` role with these hello fields; the run closes it at its end (not before: today's engine
   *  stops when the newest app connection goes, the pair's rule until the background host's lane). */
  helloAs(extra: Record<string, unknown>): Promise<{ client: MossClient; result: Record<string, unknown> }>;
  freePort(): number;
  /** MOSS built from this checkout (a test build): its Electron and the app folder. */
  mossApp(): { exe: string; args: string[] };
  record(name: string, status: Status, detail: string): void;
  statusOf(err: unknown): Status;
  why(err: unknown): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The fake provider's directive to call a tool (workshop-step.ts `callText`'s form, kept here so the step table that
 *  lists these rows imports nothing of the window steps). */
const callText = (tool: string, input: Record<string, unknown>): string => `ACCEPTANCE-CALL ${tool} ${JSON.stringify(input).replace(/ACCEPTANCE-/g, "ACCEPTANCE\\u002D")}`;
const nameOf = (n: string | { en: string }) => (typeof n === "string" ? n : n.en);

/** Runs the unit's rows; each records its own result, and a row that can't start (MOSS never came up) records why. */
export async function mossUnit(x: MossUnitCtx): Promise<void> {
  let app: { proc: ChildProcess; log: string } | undefined;
  let cdp: Cdp | undefined;
  let c: MossClient | undefined;
  const front = join(x.root, "moss-front");
  const keyFile = join(x.root, "moss-answer-key");
  const done = new Set<string>();
  let shown: MossWindow | undefined;
  const row = async (name: string, run: () => Promise<string>): Promise<void> => {
    done.add(name);
    try {
      x.record(name, "PASS", await run());
    } catch (err) {
      // What MOSS's window showed at the failure, in words, for the table, and its picture and page errors in the kept logs.
      const seen = shown === undefined ? "" : await shown.eval<string>("(document.querySelector('.middle')?.innerText ?? document.body.innerText).replace(/\\s+/g, ' ').slice(0, 240)").catch((e: unknown) => `(the page didn't answer: ${String((e as Error)?.message ?? e).slice(0, 80)})`);
      const shot = shown === undefined ? "" : await shown.failureShot(x.logs, MOSS_STEPS.indexOf(name) + 1).catch(() => "");
      x.record(name, x.statusOf(err), `${x.why(err)}${seen !== "" ? ` [MOSS showed: ${seen}]` : ""}${shot}`);
    }
  };
  try {
    const d = await x.driver();
    c = d.client;
    const device = String(d.result.device);
    await c.request("events.subscribe", { areas: ["sessions", "approvals", "bots", "surfaces"] }).catch(() => undefined);
    writeFileSync(front, "front");
    const port = x.freePort();
    const built = x.mossApp();
    const env = {
      ...x.env(),
      MOSS_USER_DATA: join(x.root, "moss-user-data"),
      MOSS_TEST_DEBUG: "1",
      MOSS_TEST_ANSWER_KEY: keyFile,
      MOSS_TEST_MAIN_FRONT_FILE: front,
    };
    app = x.startChild("moss-app", built.exe, [...built.args, "--mute-audio", "--moss-headless", `--remote-debugging-port=${port}`], env);
    await x.until("MOSS's DevTools port", 120_000, async () => {
      if (!x.alive(app!.proc)) x.fail(`MOSS exited (${app!.proc.exitCode ?? app!.proc.signalCode}): ${x.readLog(app!.log).trim().split("\n").slice(-4).join(" | ").slice(0, 400)}`);
      try { cdp = await Cdp.connect(port); return true; } catch { return undefined; }
    }, 500);
    const w = new MossWindow(x, cdp!, app.log);
    await w.main();
    shown = w;
    const s: UnitState = { x, c, w, device, front, keyFile, appLog: app.log };
    await row(MOSS_LIST_STEP, () => listRow(s));
    await row(MOSS_MESSAGE_STEP, () => messageRow(s));
    await row(MOSS_CARD_STEP, () => cardRow(s));
    await row(MOSS_AWAY_STEP, () => awayRow(s));
    await row(MOSS_PANEL_STEP, () => panelRow(s));
    await row(MOSS_TOOLS_STEP, () => toolsRow(s));
    await row(MOSS_INSTRUCTIONS_STEP, () => instructionsRow(s));
    await row(MOSS_MAKE_STEP, () => makeRow(s));
    await row(MOSS_EDITOR_STEP, () => editorRow(s));
    await row(MOSS_TRY_AGAIN_STEP, () => tryAgainRow(s));
    await row(MOSS_ARCHIVE_STEP, () => archiveRow(s));
    await row(MOSS_LONG_STEP, () => longRow(s));
    await row(MOSS_ROUTINE_RUN_STEP, () => routineRunRow(s));
    await row(MOSS_ROUTINE_PAUSE_STEP, () => routinePauseRow(s));
    await row(MOSS_ROUTINE_EDIT_STEP, () => routineEditRow(s));
    await row(MOSS_MEMORY_STEP, () => memoryRow(s));
    await row(MOSS_ROUTINE_FAIL_STEP, () => routineFailRow(s));
    await row(MOSS_DROP_STEP, () => dropRow(s));
    // Last: it registers MOSS Code's key, so the home is no longer one where only MOSS has run.
    await row(MOSS_BOTH_KEYS_STEP, () => bothKeysRow(s));
  } catch (err) {
    const why = `MOSS couldn't be started and driven: ${x.why(err)}`;
    for (const name of MOSS_STEPS) if (!done.has(name)) x.record(name, x.statusOf(err), why);
  } finally {
    cdp?.close();
    c?.close();
    if (app !== undefined) await x.endChild(app.proc);
  }
}

interface UnitState {
  x: MossUnitCtx;
  c: MossClient;
  w: MossWindow;
  device: string;
  front: string;
  keyFile: string;
  appLog: string;
  /** The tag of the plugin the panel row added, for the tools row. */
  feedPlugin?: string;
  /** The bot the make row made, for the archive row. */
  made?: string;
  /** The routine Alpha made in the panel row, for the routine rows. */
  routine?: { id: string; name: string };
}

/** MOSS's window through its DevTools port: its own page (`moss-app://app/`) and the sealed card frames in it. */
class MossWindow {
  private session: string | undefined;
  constructor(private readonly x: MossUnitCtx, readonly cdp: Cdp, private readonly log: string) {}

  /** The window's own page, once it has drawn. */
  async main(): Promise<string> {
    if (this.session !== undefined) return this.session;
    const doc = await this.x.until("MOSS's window (moss-app://app/) drawn", 60_000, async () => (await this.cdp.documents()).find((d) => d.url.startsWith("moss-app://app/")), 300);
    this.session = doc.session;
    return doc.session;
  }

  /** The window's picture and its pages' errors at a failure, into the run's logs; a note naming them. */
  async failureShot(dir: string, n: number): Promise<string> {
    const r = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, await this.main());
    const file = join(dir, `moss-row-${n}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    const errors = this.cdp.console.filter((e) => e.level === "exception" || e.level === "error").slice(-4).map((e) => `${e.url.slice(0, 40)}: ${e.text.slice(0, 160)}`);
    return ` (picture: logs/moss-row-${n}.png${errors.length > 0 ? `; page errors: ${errors.join(" | ")}` : ""})`;
  }

  async eval<T = unknown>(js: string): Promise<T> {
    return (await this.cdp.evaluate(await this.main(), js)) as T;
  }

  /** Waits for a page expression to be truthy (JSON-able); its value. */
  async waitFor<T = unknown>(what: string, js: string, ms = 30_000): Promise<T> {
    return this.x.until(what, ms, async () => {
      const v = await this.eval<T>(js).catch(() => undefined);
      return v === null || v === undefined || v === false || v === "" ? undefined : v;
    }, 250);
  }

  /** A trusted click on the first element matching `selector` (or holding `text`), as a person's. */
  async click(selector: string, text?: string): Promise<void> {
    const s = await this.main();
    const at = await this.x.until(`the window's ${selector}${text !== undefined ? ` "${text}"` : ""}`, 20_000, () => this.cdp.centerOf(s, selector, text), 250);
    await this.cdp.click(s, at.x, at.y);
    await sleep(150);
  }

  /** Types into a field the way the keyboard does (focused by a click, its old text selected, the new text inserted). */
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.(); return true; })()`);
    await this.cdp.send("Input.insertText", { text }, await this.main());
    await sleep(150);
  }

  /** The sealed frame MOSS drew for a card in its window, by the card's id. */
  async cardFrame(cardId: string, ms = 30_000): Promise<{ session: string; url: string; text: string }> {
    const prefix = `moss-sealed://card/${encodeURIComponent(cardId)}/own`;
    return this.x.until(`the card ${cardId}'s sealed frame in MOSS's window`, ms, async () => (await this.cdp.documents()).find((d) => d.url.startsWith(prefix)), 300);
  }

  /** Presses the card's Approve in MOSS's window for real: the pointer comes in, the page's own gate says ready (its
   *  visibility reading, its second), then a trusted click; MOSS's main process judges and signs. What MOSS logged. */
  async pressApprove(cardId: string): Promise<string> {
    const doc = await this.cardFrame(cardId);
    const sel = ".seal-button[data-kind=approve]:not([data-remember])";
    const tried: string[] = [];
    // A card grows to its own height once its frame draws, and a list that scrolls may move under it: the person waits
    // for it to settle, scrolls the button into view and presses; a press the page read as covered is made again.
    for (let attempt = 0; attempt < 3; attempt++) {
      let last = -1;
      await this.x.until("the card's frame at its own height", 10_000, async () => {
        const h = await this.eval<number>(`document.querySelector('iframe[data-card-frame=${JSON.stringify(cardId)}]')?.getBoundingClientRect().height ?? -1`);
        const steady = h > 0 && h === last;
        last = h;
        return steady ? true : undefined;
      }, 300).catch(() => undefined);
      const inFrame = await this.x.until("the card's Approve button", 15_000, () => this.cdp.centerOf(doc.session, sel), 250);
      await this.eval(`((id, y) => {
        const f = document.querySelector('iframe[data-card-frame="' + id + '"]');
        if (!f) return false;
        let p = f.parentElement;
        while (p && !(p.scrollHeight > p.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
        if (!p) return true;
        const pr = p.getBoundingClientRect(), fr = f.getBoundingClientRect();
        p.scrollTop += (fr.top + y) - (pr.top + pr.height / 2);
        return true;
      })(${JSON.stringify(cardId)}, ${inFrame.y})`);
      await sleep(400);
      const btn = await this.x.until("the card's Approve button", 15_000, () => this.cdp.centerOf(doc.session, sel), 250);
      const from = this.x.readLog(this.log).length;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y, button: "none", buttons: 0 }, doc.session).catch(() => undefined);
      await this.x.until("the sealed page's ready-to-answer mark", 15_000, async () => ((await this.cdp.evaluate(doc.session, "document.body.dataset.ready ?? 'none'").catch(() => "gone")) === "yes" ? true : undefined), 100);
      await sleep(200);
      await this.cdp.click(doc.session, btn.x, btn.y);
      const said = await this.x.until(`MOSS's answer for the card ${cardId}`, 15_000, () => {
        const text = this.x.readLog(this.log).slice(from);
        if (text.includes(`sealed: answer accepted for ${cardId}`)) return "accepted";
        if (new RegExp(`sealed: press on ${cardId}: (covered|no-pointer|opening)`).test(text)) return /sealed: press on \S+: (\S+)/.exec(text.split("\n").reverse().find((l) => l.includes(`press on ${cardId}`)) ?? "")?.[1] ?? "again";
        return /sealed: answer refused \([^\n]*/.exec(text)?.[0];
      }, 200);
      if (said === "accepted") return "accepted";
      if (said === "covered" || said === "no-pointer" || said === "opening") { tried.push(said); continue; }
      this.x.fail(`the press on the card's Approve in MOSS: ${said}`);
    }
    return this.x.fail(`the card's Approve in MOSS read as ${tried.join(", ")} at each of 3 presses`);
  }
}

async function records(c: MossClient): Promise<RecordView[]> {
  return (await c.request<{ bots: RecordView[] }>("bot.records", {})).bots;
}

async function alpha(c: MossClient): Promise<RecordView> {
  const a = (await records(c)).find((b) => b.id === "alpha");
  if (a === undefined) throw new Error("bot.records lists no Alpha");
  return a;
}

async function pending(c: MossClient): Promise<CardSeen[]> {
  return (await c.request<{ cards: CardSeen[] }>("card.list", {})).cards;
}

async function placementOf(c: MossClient, id: string): Promise<Placement | undefined> {
  const r = await c.request<{ placements: { card: string; place: Placement }[] }>("card.placement", { ids: [id] });
  return r.placements.find((p) => p.card === id)?.place;
}

const placeWords = (p: Placement | undefined) => (p === undefined ? "unplaced" : p.kind === "conversation" || p.kind === "strip" ? `${p.kind} of ${p.program}/${p.window}` : p.kind);

/** A new pending card (not in `before`), as the engine lists it. */
async function newCard(s: UnitState, before: ReadonlySet<string>, what: string, match: (c: CardSeen) => boolean = () => true, ms = 90_000): Promise<CardSeen> {
  return s.x.until(what, ms, async () => (await pending(s.c)).find((k) => !before.has(k.id) && match(k)), 300);
}

async function cardIds(c: MossClient): Promise<Set<string>> {
  return new Set((await pending(c)).map((k) => k.id));
}

/** Opens a bot's conversation in MOSS (its row in the list) and waits until it is the one shown. */
async function openBot(s: UnitState, id: string, name: string): Promise<void> {
  await s.w.click(`[data-bot-row=${JSON.stringify(id)}]`);
  await s.w.waitFor(`${name}'s conversation open in MOSS`, `!!document.querySelector(${JSON.stringify(`main.conversation[aria-label="${name}'s conversation"]`)})`);
}

/** Types a message in the shown conversation's composer and presses Send, as the person does. */
async function sendInMoss(s: UnitState, name: string, text: string): Promise<void> {
  const field = `textarea[aria-label="Message ${name}"]`;
  await s.w.type(field, text);
  await s.w.click("button.send");
  await s.w.waitFor("the composer emptied after the send", `(() => { const e = document.querySelector(${JSON.stringify(field)}); return e !== null && e.value === ""; })()`, 15_000)
    .catch(async () => s.x.fail(`MOSS didn't send: ${await s.w.eval<string>("document.querySelector('.composer__why')?.textContent ?? 'no reason shown'")}`));
}

/** A bot bubble holding `text`, drawn in the shown conversation. */
async function botSaid(s: UnitState, text: string, ms = 120_000): Promise<string> {
  return s.w.waitFor(`a reply holding "${text.slice(0, 40)}" drawn in MOSS`, `[...document.querySelectorAll('.bubble--bot')].map((b) => b.textContent).find((t) => t.includes(${JSON.stringify(text)})) ?? null`, ms);
}

/** A turn the person starts in MOSS: the message sent from the composer, every card the turn raises for that session
 *  approved with a real press where MOSS draws it, until a new reply holding `reply` is drawn. The cards' kinds. */
async function turnInMoss(s: UnitState, name: string, session: string, text: string, reply: string, ms = 150_000): Promise<{ said: string; cards: string[] }> {
  const before = await cardIds(s.c);
  const from = await s.w.eval<number>("document.querySelectorAll('.bubble--bot').length");
  await sendInMoss(s, name, text);
  const cards: string[] = [];
  const seen = new Set<string>();
  const said = await s.x.until(`${name}'s reply holding "${reply.slice(0, 30)}" after "${text.slice(0, 30)}"`, ms, async () => {
    for (const k of await pending(s.c)) {
      if (before.has(k.id) || seen.has(k.id) || k.session !== session) continue;
      seen.add(k.id);
      await s.w.pressApprove(k.id);
      cards.push(k.kind);
    }
    const texts = await s.w.eval<string[]>(`[...document.querySelectorAll('.bubble--bot')].slice(${from}).map((b) => b.textContent)`);
    return texts.find((t) => t.includes(reply));
  }, 500);
  return { said, cards };
}

const tag = (what: string) => `ACCEPTANCE-TAG-MOSS${what.toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;

// ── the rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function listRow(s: UnitState): Promise<string> {
  const a = await s.x.until("Alpha as a record (bot.records)", 60_000, async () => (await records(s.c).catch(() => [])).find((b) => b.id === "alpha"), 500);
  // The unit's home is one this engine made (its own fresh one, or the run's shared one): no plugin bot was ever in it, so
  // Alpha is the default bot (`default`); only a home that had the old plugin Alpha gets her by the move (`move`).
  if (a.madeBy.kind !== "default") s.x.fail(`Alpha's record says it was made by ${JSON.stringify(a.madeBy)}, not by default (a home this engine made, with no plugin bot in it)`);
  const row = await s.w.waitFor<{ name: string; mood: string; face: boolean; n: number }>("Alpha's row in MOSS's list", `(() => {
    const r = document.querySelector('[data-bot-row="alpha"]');
    if (!r) return null;
    return { name: r.querySelector('.row__name')?.textContent ?? '', mood: r.querySelector('.mood, .row__line')?.textContent ?? '', face: !!r.querySelector('canvas, svg, [data-face]'), n: document.querySelectorAll('[data-bot-row]').length };
  })()`, 60_000);
  if (row.name !== nameOf(a.name)) s.x.fail(`Alpha's row is named "${row.name}", not "${nameOf(a.name)}"`);
  if (!row.face) s.x.fail("Alpha's row draws no face");
  if (!/Idle|Listening|Thinking|Working|Needs you|Stuck|Done|Asleep/.test(row.mood)) s.x.fail(`Alpha's row says no mood in words: "${row.mood}"`);
  const all = await records(s.c);
  if (row.n !== all.length) s.x.fail(`MOSS lists ${row.n} bot(s), the engine has ${all.length} record(s)`);
  const shows = await s.w.waitFor<string>("Alpha's conversation open by itself", `document.querySelector('main.conversation')?.getAttribute('aria-label') ?? null`);
  if (shows !== `${nameOf(a.name)}'s conversation`) s.x.fail(`MOSS opened "${shows}", not Alpha's conversation`);
  return `bot.records: ${all.map((b) => `${b.id} (made by ${b.madeBy.kind})`).join(", ")}; MOSS lists ${row.n}: Alpha with her face and "${row.mood.trim().slice(0, 40)}", her conversation open by itself`;
}

async function messageRow(s: UnitState): Promise<string> {
  const a = await alpha(s.c);
  await openBot(s, "alpha", "Alpha");
  const t = tag("MSG");
  const text = `hello Alpha <b>bold?</b> ${t}`;
  await sendInMoss(s, "Alpha", text);
  const said = await botSaid(s, `ACCEPTANCE-REPLY-OK ${t}`);
  const mine = await s.w.eval<{ text: string; html: boolean } | null>(`(() => { const b = [...document.querySelectorAll('.bubble--user')].find((x) => x.textContent.includes(${JSON.stringify(t)})); return b ? { text: b.textContent, html: b.querySelector('b') !== null } : null; })()`);
  if (mine === null) s.x.fail("the person's own message isn't drawn in her conversation");
  if (mine!.html || !mine!.text.includes("<b>bold?</b>")) s.x.fail(`the message's markup was drawn as markup, not text: ${JSON.stringify(mine)}`);
  const page = await s.c.request<{ session: string; events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 200 });
  if (page.session !== a.mainSession) s.x.fail(`bot.conversation is session ${page.session}, not her record's main session ${a.mainSession}`);
  if (!page.events.some((e) => e.type === "user_message" && (e.text ?? "").includes(t))) s.x.fail("the message isn't in her conversation's events");
  if (!page.events.some((e) => e.type === "assistant_message" && (e.text ?? "").includes(t))) s.x.fail("her reply isn't in her conversation's events");
  return `sent from MOSS's composer (a click on Send), in her main session ${a.mainSession}; her reply "${said.slice(0, 60)}" drawn; the message's <b> drawn as text`;
}

/** The card's Approve option. */
function approveOf(card: CardSeen): string {
  const o = card.options.find((x) => x.kind === "approve" && x.remember !== "always") ?? card.options.find((x) => x.kind === "approve");
  if (o === undefined) throw new Error(`the ${card.kind} card has no Approve`);
  return o.id;
}

/** MOSS's own answer key, from the run's kept file (pkcs8 DER, base64). */
function mossKey(file: string) {
  if (!existsSync(file)) throw new Error("MOSS kept no answer key in the run's file (MOSS_TEST_ANSWER_KEY)");
  return createPrivateKey({ key: Buffer.from(readFileSync(file, "utf8").trim(), "base64"), format: "der", type: "pkcs8" });
}

async function cardRow(s: UnitState): Promise<string> {
  const a = await alpha(s.c);
  await openBot(s, "alpha", "Alpha");
  const before = await cardIds(s.c);
  await sendInMoss(s, "Alpha", "ACCEPTANCE-WRITE");
  const card = await newCard(s, before, "the Write's approval card", (k) => k.session === a.mainSession);
  const place = await s.x.until("the router's place for the card", 20_000, async () => {
    const p = await placementOf(s.c, card.id);
    return p?.kind === "conversation" ? p : undefined;
  }, 300).catch(async () => s.x.fail(`the router placed the card ${placeWords(await placementOf(s.c, card.id))}, not in Alpha's conversation in MOSS`));
  if (place.kind !== "conversation" || place.program !== "moss" || place.window !== "main") s.x.fail(`the card is placed ${placeWords(place)}, not in MOSS's window`);
  const frame = await s.w.cardFrame(card.id);
  const inConversation = await s.w.eval<boolean>(`!!document.querySelector('.messages [data-card=${JSON.stringify(card.id)}] iframe')`);
  if (!inConversation) s.x.fail("MOSS drew the card, but not in her conversation");
  const option = approveOf(card);

  // 1. No press of the person's: the frame's own script answers (and says its button was seen); MOSS refuses it.
  const logFrom = s.x.readLog(s.appLog).length;
  const scripted = await s.w.cdp.evaluate(frame.session, `(async () => { try { window.mossSealed.fresh(true, 5); return JSON.stringify(await window.mossSealed.answer(${JSON.stringify(option)})); } catch (e) { return 'threw ' + e.message; } })()`);
  const refusedLine = await s.x.until("MOSS's refusal of the answer with no press", 10_000, () => /sealed: answer refused \([^\n]*/.exec(s.x.readLog(s.appLog).slice(logFrom))?.[0], 200)
    .catch(() => s.x.fail(`MOSS logged no refusal for the scripted answer (it returned ${String(scripted).slice(0, 120)})`));
  if (!/no press/.test(refusedLine)) s.x.fail(`MOSS refused the scripted answer, but not for want of a press: ${refusedLine}`);
  if (!(await cardIds(s.c)).has(card.id)) s.x.fail("the card was answered by the scripted answer");
  // The person reads why beside the card, in plain words.
  const saidBeside = await s.w.waitFor<string>("the refusal's words beside the card", `document.querySelector(${JSON.stringify(`[data-card="${card.id}"] [data-card-said]`)})?.textContent ?? null`, 10_000);

  // 2. Signed as MOSS Code: MOSS's own key over MOSS Code's signing input, sent on a MOSS connection (the run's own):
  //    the engine refuses it, and the card waits on. (MOSS Code's own connection and key: the last row.)
  const key = mossKey(s.keyFile);
  const at = Date.now();
  const signature = sign(null, Buffer.from(programCardAnswerSigningInput({ program: "code", id: card.id, hash: card.hash, option, at })), key).toString("base64");
  const proof = { via: "device", device: s.device, at, signature, program: "code" };
  const asCode = await s.c.request<{ accepted: boolean; reason?: string }>("card.answer", { id: card.id, hash: card.hash, option, proof });
  if (asCode.accepted) s.x.fail("the engine took an answer signed as MOSS Code for a card MOSS draws");
  if (!(await cardIds(s.c)).has(card.id)) s.x.fail("the card was answered by an answer signed as MOSS Code");

  // 3. The real press, in her conversation.
  await s.w.pressApprove(card.id);
  await s.x.until("the card answered", 15_000, async () => ((await cardIds(s.c)).has(card.id) ? undefined : true), 300);
  // The overlap check ran for the press (the OS's window list read, MOSS's own windows only in a headless run).
  const overlap = /overlap: the OS window list (read|wasn't read) for a press \([^)\n]*\)/.exec(s.x.readLog(s.appLog))?.[0];
  if (process.platform === "darwin" && (overlap === undefined || !overlap.includes("list read"))) s.x.fail(`the overlap check didn't read the OS's window list for the press: ${overlap ?? "MOSS said nothing of it"}`);
  // MOSS's key is the one the engine holds for the `moss` program on this device.
  const pub = Buffer.from(createPublicKeyRaw(key)).toString("base64");
  const keys = readFileSync(join(s.x.home, "devices", "program-keys.json"), "utf8");
  const table = JSON.parse(keys) as { keys: Record<string, Partial<Record<string, { publicKey: string }>>> };
  if (table.keys[s.device]?.moss?.publicKey !== pub) s.x.fail("the engine's moss key for this device isn't MOSS's own key");
  const landed = await s.x.until("the Write to land after the approval", 60_000, async () => {
    const page = await s.c.request<{ events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 200 });
    return page.events.some((e) => e.type === "assistant_message" && (e.text ?? "").startsWith("ACCEPTANCE-DONE")) ? true : undefined;
  }, 500).catch(() => false);
  return `the ${card.kind} card placed ${placeWords(place)} and drawn in her conversation; the frame's own script answering with no press: MOSS refused it (${refusedLine.replace(/^sealed: answer refused /, "").slice(0, 80)}) and said "${saidBeside.slice(0, 60)}" beside the card; signed as MOSS Code with MOSS's key: refused (${asCode.reason ?? "no reason"}); a real press on Approve accepted (${overlap?.replace(/^overlap: /, "") ?? "no overlap check off macOS"}), MOSS's key the engine's moss key for this device${landed ? "; the Write's turn went on" : ""}`;
}

/** The raw 32 bytes of an Ed25519 private key's public half. */
function createPublicKeyRaw(key: ReturnType<typeof createPrivateKey>): Uint8Array {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

async function awayRow(s: UnitState): Promise<string> {
  const a = await alpha(s.c);
  await openBot(s, "alpha", "Alpha");
  const from = s.x.readLog(s.appLog).length;
  writeFileSync(s.front, "back");
  try {
    return await awayRowBehind(s, a, from);
  } finally {
    writeFileSync(s.front, "front");
  }
}

async function awayRowBehind(s: UnitState, a: RecordView, from: number): Promise<string> {
  await s.x.until("MOSS's window behind (the test seam)", 10_000, () => (s.x.readLog(s.appLog).slice(from).includes("MOSS's window is not in front") ? true : undefined), 100);
  // Her turn goes on while MOSS is behind: a message from elsewhere (the run's own connection).
  const before = await cardIds(s.c);
  const path = join(s.x.userHome, ".acceptance", `moss-away-${randomBytes(3).toString("hex")}.txt`);
  await s.c.request("session.send", { id: a.mainSession, message: { text: callText("Write", { file_path: path, content: "moss away\n" }), clientMessageId: randomUUID() } }, 30_000);
  const card = await newCard(s, before, "the second Write's approval card", (k) => k.session === a.mainSession);
  const away = await s.x.until("the card placed off MOSS's window", 20_000, async () => {
    const p = await placementOf(s.c, card.id);
    return p !== undefined && !((p.kind === "conversation" || p.kind === "strip") && p.program === "moss") ? p : undefined;
  }, 300).catch(async () => s.x.fail(`with MOSS behind, the card is placed ${placeWords(await placementOf(s.c, card.id))}`));
  await sleep(1_000);
  const drawn = await s.w.eval<boolean>(`!!document.querySelector('[data-card=${JSON.stringify(card.id)}]')`);
  if (drawn) s.x.fail(`MOSS drew the card while it was placed ${placeWords(away)}`);
  writeFileSync(s.front, "front");
  const back = await s.x.until("the card placed in her conversation again", 20_000, async () => {
    const p = await placementOf(s.c, card.id);
    return p?.kind === "conversation" && p.program === "moss" ? p : undefined;
  }, 300).catch(async () => s.x.fail(`MOSS in front again, the card is placed ${placeWords(await placementOf(s.c, card.id))}`));
  await s.w.pressApprove(card.id);
  await s.x.until("the card answered", 15_000, async () => ((await cardIds(s.c)).has(card.id) ? undefined : true), 300);
  return `MOSS behind: the card placed ${placeWords(away)} and not drawn in MOSS; MOSS in front: placed ${placeWords(back)}, drawn and pressed there, accepted`;
}

async function panelRow(s: UnitState): Promise<string> {
  // The plugin that publishes a picture, added from a folder behind its OK card, which the router puts in MOSS's strip.
  const before = await cardIds(s.c);
  const folder = join(s.x.root, "plugin-src", "acceptance-feed");
  cpSync(join(import.meta.dir, "fixtures", "acceptance-feed"), folder, { recursive: true });
  const installed = await s.c.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  s.feedPlugin = installed.id;
  const ok = await newCard(s, before, "the plugin's OK card", (k) => k.id === installed.card || k.kind === "plugin-ok", 30_000);
  const okPlace = await s.x.until("the OK card placed in MOSS", 20_000, async () => {
    const p = await placementOf(s.c, ok.id);
    return (p?.kind === "strip" || p?.kind === "conversation") && p.program === "moss" ? p : undefined;
  }, 300).catch(async () => s.x.fail(`the plugin's OK card is placed ${placeWords(await placementOf(s.c, ok.id))}, not in MOSS`));
  await s.w.pressApprove(ok.id);
  await s.x.until("the plugin enabled after its OK", 60_000, async () => {
    const st = (await s.c.request<{ plugin?: { state?: string } }>("plugin.get", { id: installed.id }).catch(() => undefined))?.plugin?.state;
    return st === "enabled" || st === "running" ? st : undefined;
  }, 500);
  // Alpha makes a routine and uses the tool that publishes her picture.
  await openBot(s, "alpha", "Alpha");
  const routine = `MOSS panel probe ${randomBytes(2).toString("hex")}`;
  const a = await alpha(s.c);
  const made = await turnInMoss(s, "Alpha", a.mainSession, callText("Routine", { name: routine, instructions: "ACCEPTANCE-TAG-MOSSROUTINE", schedule: "every 6h" }), "ACCEPTANCE-DONE");
  const listed = await s.x.until("her routine in routine.list", 30_000, async () => (await s.c.request<{ routines: { id: string; name: string }[] }>("routine.list", { bot: "alpha" })).routines.find((r) => r.name === routine), 500);
  s.routine = { id: listed.id, name: routine };
  const showed = await turnInMoss(s, "Alpha", a.mainSession, callText("Show", {}), "ACCEPTANCE-DONE");
  await s.x.until("her live picture listed", 60_000, async () => ((await s.c.request<{ pictures: { publisher: string }[] }>("picture.list", { kind: "bots", bot: "alpha" })).pictures.some((p) => p.publisher === installed.id) ? true : undefined), 500);
  // The side panel, opened from her conversation's header.
  await s.w.click(`button[aria-label="Open Alpha's screen and routines"]`);
  const shown = await s.w.waitFor<{ src: string; from: string; watch: boolean }>("her live picture drawn in the side panel", `(() => {
    const img = document.querySelector('.panel .screen img');
    if (!img || !img.src.startsWith('data:image/')) return null;
    return { src: img.src.slice(0, 30), from: document.querySelector('.panel .screen__from')?.textContent ?? '', watch: !!document.querySelector('.panel [data-watch-only]') };
  })()`, 30_000);
  if (!shown.from.includes("Acceptance Feed")) s.x.fail(`the picture doesn't name its publisher: "${shown.from}"`);
  if (!/watch only/.test(shown.from)) s.x.fail(`the picture doesn't say it is watch only: "${shown.from}"`);
  const inputs = await s.w.eval<number>("document.querySelectorAll('.panel .screen :is(button, input, textarea, select, a, iframe, [tabindex], [contenteditable])').length");
  if (inputs !== 0) s.x.fail(`the picture holds ${inputs} control(s) a person could act through`);
  const from = s.x.readLog(s.appLog).length;
  await s.w.click(".panel .screen__view");
  const refused = await s.x.until("MOSS's word that the click reached nothing", 10_000, () => /picture: input refused \(watch only\)[^\n]*/.exec(s.x.readLog(s.appLog).slice(from))?.[0], 200);
  const row = await s.w.waitFor<{ name: string; when: string; chip: string }>("her routine in the side panel", `(() => {
    const r = [...document.querySelectorAll('.panel [data-routine]')].find((x) => x.querySelector('.routine__name')?.textContent === ${JSON.stringify(routine)});
    return r ? { name: r.querySelector('.routine__name').textContent, when: r.querySelector('.routine__when')?.textContent ?? '', chip: r.querySelector('.chip')?.textContent ?? '' } : null;
  })()`, 20_000);
  await s.w.click(`button[aria-label="Close the side panel"]`);
  return `the plugin's OK card placed ${placeWords(okPlace)} and pressed in MOSS; her picture from ${shown.from.replace(/\s+/g, " ").trim().slice(0, 80)} drawn (${shown.src}…), no control in it, a click on it: "${refused.slice(0, 80)}"; her routine "${row.name}" (${row.when.slice(0, 40)}, ${row.chip}) listed (routine ${listed.id}; Routine ${made.cards.length > 0 ? `asked on ${made.cards.join(", ")} card(s), pressed in MOSS` : "asked nothing"}, Show ${showed.cards.length > 0 ? `asked on ${showed.cards.join(", ")} card(s)` : "asked nothing"})`;
}

async function toolsRow(s: UnitState): Promise<string> {
  const plugin = s.feedPlugin;
  if (plugin === undefined) s.x.fail("the panel row added no plugin to set a tool of");
  type Perms = { plugins: { pluginId: string; server: string; tools: { name: string; availability?: string; declared?: string }[] }[] };
  const toolOf = async (): Promise<{ availability?: string; declared?: string } | undefined> => (await s.c.request<Perms>("tool.permissions", {})).plugins.filter((p) => p.pluginId === plugin).flatMap((p) => p.tools).find((t) => t.name === "FeedProbe");
  const was = await toolOf();
  if (was === undefined) s.x.fail("tool.permissions doesn't list the plugin's FeedProbe");
  // Offered before: a turn's request carries it.
  const asked0 = s.x.fake.requests.length;
  await openBot(s, "alpha", "Alpha");
  const t0 = tag("TOOLA");
  await sendInMoss(s, "Alpha", t0);
  await botSaid(s, `ACCEPTANCE-REPLY-OK ${t0}`);
  const offered = s.x.fake.requests.slice(asked0).some((r) => r.tools.some((n) => n.endsWith("FeedProbe")));
  // The Plugins page: FeedProbe's "Bots get it" set to Off.
  await s.w.click(".list__bottom .nav-item", "Plugins");
  const off = `[data-plugin=${JSON.stringify(plugin)}] [data-tool="FeedProbe"] [data-setting="availability"] [data-value="off"]`;
  await s.w.waitFor("the plugin's FeedProbe row on the Plugins page", `!!document.querySelector(${JSON.stringify(off)})`, 30_000);
  await s.w.click(off);
  const now = await s.x.until("tool.permissions to say FeedProbe is off", 15_000, async () => ((await toolOf())?.availability === "off" ? "off" : undefined), 300)
    .catch(async () => s.x.fail(`after the press on Off, tool.permissions says FeedProbe is ${JSON.stringify(await toolOf())}`));
  const drawnOn = await s.w.waitFor<string>("the page showing Off chosen", `document.querySelector(${JSON.stringify(off)})?.getAttribute('aria-checked') === 'true' ? 'yes' : null`, 10_000);
  // Her next turn isn't offered it.
  await openBot(s, "alpha", "Alpha");
  const asked1 = s.x.fake.requests.length;
  const t1 = tag("TOOLB");
  await sendInMoss(s, "Alpha", t1);
  await botSaid(s, `ACCEPTANCE-REPLY-OK ${t1}`);
  const after = s.x.fake.requests.slice(asked1);
  if (after.length === 0) s.x.fail("her turn after the change reached no model");
  if (after.some((r) => r.tools.some((n) => n.endsWith("FeedProbe")))) s.x.fail("her turn after the change was still offered FeedProbe");
  return `FeedProbe was ${was!.availability ?? was!.declared ?? "?"} and ${offered ? "offered" : "not offered (deferred)"} in her turn; Off pressed on MOSS's Plugins page (drawn chosen: ${drawnOn}): tool.permissions says ${now}, and her next turn (${after.length} request(s)) wasn't offered it`;
}

async function instructionsRow(s: UnitState): Promise<string> {
  const a = await alpha(s.c);
  const rule = instructionsEditRule({ kind: "user" }, { id: a.id, madeBy: a.madeBy as never });
  if (rule !== "free") s.x.fail(`instructionsEditRule says the person's edit is "${rule}"`);
  const nowText = (await s.c.request<{ text: string }>("bot.instructions.get", { id: "alpha" })).text;
  await s.w.click(".list__bottom .nav-item.account");
  await s.w.click(`[data-section="bot:alpha"]`);
  const field = "[data-instructions-text]";
  const shown = await s.w.waitFor<string>("her instructions shown in Settings", `(() => { const e = document.querySelector(${JSON.stringify(field)}); return e && !e.disabled ? JSON.stringify(e.value) : null; })()`, 30_000);
  if (JSON.parse(shown) !== nowText) s.x.fail(`Settings shows instructions that aren't the file's (${JSON.parse(shown).length} characters shown, ${nowText.length} in the file)`);
  const t = tag("INSTR");
  const next = `${nowText}\n\nWhen asked, say ${t}.`;
  const before = await cardIds(s.c);
  await s.w.type(field, next);
  await s.w.click(".ma2-bot [data-settings=instructions] .text-button--solid", "Save instructions");
  await s.w.waitFor("Settings saying the instructions are saved", `[...document.querySelectorAll('.add__note')].some((n) => n.textContent.includes('Instructions saved.'))`, 15_000)
    .catch(async () => s.x.fail(`Settings didn't save: ${await s.w.eval<string>("[...document.querySelectorAll('.add__note')].map((n) => n.textContent).join(' | ') || 'nothing said'")}`));
  const stored = (await s.c.request<{ text: string }>("bot.instructions.get", { id: "alpha" })).text;
  if (stored !== next) s.x.fail(`bot.instructions.get after the save isn't the edited text (${stored.length} characters, ${next.length} typed)`);
  const raised = [...await cardIds(s.c)].filter((id) => !before.has(id));
  if (raised.length > 0) s.x.fail(`the person's own edit raised ${raised.length} card(s)`);
  // Her next turn is given them.
  const asked = s.x.fake.requests.length;
  await s.c.request("session.send", { id: a.mainSession, message: { text: tag("AFTER"), clientMessageId: randomUUID() } }, 30_000);
  await s.x.until("her next turn to reach the model", 60_000, () => (s.x.fake.requests.length > asked ? true : undefined), 300);
  const given = s.x.fake.requests.slice(asked).some((r) => JSON.stringify((r.body as { system?: unknown } | undefined)?.system ?? "").includes(t));
  if (!given) s.x.fail("her next turn's request doesn't carry the edited instructions");
  return `the person's edit is ${rule} (instructionsEditRule); Settings showed her ${nowText.length}-character instructions as they are, the edit was typed in place and saved with no card; bot.instructions.get has it, and her next turn was given it`;
}

async function makeRow(s: UnitState): Promise<string> {
  // The person's: the list's +, a name, one of the models the person has set up (Alpha's: the run's key is that
  // model's plugin's), Make.
  const name = `Nova${randomBytes(2).toString("hex")}`;
  await s.w.click(`button[aria-label="New bot"]`);
  await s.w.type(`input[aria-label="The new bot's name"]`, name);
  const want = (await alpha(s.c)).model;
  const offered = await s.w.waitFor<string[]>("the + flow's models", `(() => { const e = document.querySelector('[data-new-bot-model]'); return e && e.options.length > 0 ? [...e.options].map((o) => o.value) : null; })()`, 20_000)
    .catch(async () => s.x.fail(`the + flow offers no model: ${await s.w.eval<string>("document.querySelector('[data-new-bot-no-model]')?.textContent ?? 'nothing said'")}`));
  const model = want !== undefined && offered.includes(want) ? want : want === undefined ? offered[0]! : s.x.fail(`the + flow doesn't offer Alpha's model ${want} (it offers ${offered.join(", ")})`);
  await s.w.eval(`(() => { const e = document.querySelector('[data-new-bot-model]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(model)}); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await s.w.click("[data-make-bot]", "Make");
  await s.w.waitFor(`${name}'s conversation open`, `document.querySelector('main.conversation')?.getAttribute('aria-label') === ${JSON.stringify(`${name}'s conversation`)}`, 30_000)
    .catch(async () => s.x.fail(`MOSS didn't open the new bot: ${await s.w.eval<string>("document.querySelector('.new-bot__why')?.textContent ?? 'nothing said'")}`));
  const made = await s.x.until(`${name} as a record`, 15_000, async () => (await records(s.c)).find((b) => nameOf(b.name) === name), 300);
  if (made.madeBy.kind !== "user") s.x.fail(`${name}'s record says it was made by ${JSON.stringify(made.madeBy)}`);
  if (made.model !== model) s.x.fail(`${name}'s record is on ${made.model ?? "the default model"}, not ${model}, chosen in the + flow`);
  s.made = made.id;
  const picked = `${model}, chosen in the + flow (offered: ${offered.join(", ")})`;
  const t = tag("NOVA");
  await sendInMoss(s, name, t);
  await botSaid(s, `ACCEPTANCE-REPLY-OK ${t}`);
  // The bot's: MakeBot, behind the person's card in MOSS.
  const child = `Scout${randomBytes(2).toString("hex")}`;
  const before = await cardIds(s.c);
  await sendInMoss(s, name, callText("MakeBot", { name: child, instructions: `You are ${child}, made by ${name}.` }));
  const card = await newCard(s, before, "MakeBot's card", (k) => k.session === made.mainSession || k.bot === made.id, 120_000);
  const frame = await s.w.cardFrame(card.id);
  const text = String(await s.w.cdp.evaluate(frame.session, "document.body.innerText"));
  if (!text.includes(name)) s.x.fail(`MakeBot's card doesn't name the maker ${name}: "${text.replace(/\s+/g, " ").slice(0, 200)}"`);
  if (!text.includes(child)) s.x.fail(`MakeBot's card doesn't name the new bot ${child}`);
  await s.w.pressApprove(card.id);
  const kid = await s.x.until(`${child} as a record`, 60_000, async () => (await records(s.c)).find((b) => nameOf(b.name) === child), 500);
  if (kid.madeBy.kind !== "bot" || kid.madeBy.id !== made.id) s.x.fail(`${child} says it was made by ${JSON.stringify(kid.madeBy)}, not ${made.id}`);
  await s.w.waitFor(`${child} in MOSS's list`, `!!document.querySelector(${JSON.stringify(`[data-bot-row="${kid.id}"]`)})`, 20_000);
  return `${name} made from the list's + (madeBy user), on ${picked}, its conversation opened and answered; its MakeBot raised a ${card.kind} card in MOSS naming ${name} and ${child}, pressed; ${child} listed, made by ${made.id}`;
}

async function archiveRow(s: UnitState): Promise<string> {
  const id = s.made;
  if (id === undefined) s.x.fail("the make row made no bot to archive");
  const rec = (await records(s.c)).find((b) => b.id === id);
  if (rec === undefined) s.x.fail(`${id} isn't a record`);
  const name = nameOf(rec!.name);
  const before = (await s.c.request<{ events: { type: string }[] }>("bot.conversation", { id, limit: 200 })).events.length;
  await s.w.click(".list__bottom .nav-item.account");
  await s.w.click(`[data-section="bot:${id}"]`);
  await s.w.click(`[data-archive-bot=${JSON.stringify(id)}]`);
  await s.w.waitFor(`${name} gone from MOSS's list`, `!document.querySelector(${JSON.stringify(`[data-bot-row="${id}"]`)})`, 20_000);
  const archived = (await s.c.request<{ bots: { id: string }[] }>("bot.archived", {})).bots;
  if (!archived.some((b) => b.id === id)) s.x.fail(`${id} isn't in bot.archived`);
  if ((await records(s.c)).some((b) => b.id === id)) s.x.fail(`${id} is still a record after the archive`);
  // Settings' Archived bots, then Bring back.
  await s.w.click(`[data-section="general"]`);
  const item = `[data-archived-bot=${JSON.stringify(id)}]`;
  await s.w.waitFor(`${name} under Archived bots`, `!!document.querySelector(${JSON.stringify(item)})`, 20_000);
  await s.w.click(`${item} .text-button`, "Bring back");
  await s.w.waitFor(`${name} back in MOSS's list`, `!!document.querySelector(${JSON.stringify(`[data-bot-row="${id}"]`)})`, 20_000);
  const page = await s.c.request<{ events: { type: string }[] }>("bot.conversation", { id, limit: 200 });
  if (page.events.length < before) s.x.fail(`${name} came back with ${page.events.length} event(s), not its ${before}`);
  await openBot(s, id!, name);
  const bubbles = await s.w.waitFor<number>(`${name}'s conversation drawn whole`, "document.querySelectorAll('.messages .bubble').length || null", 20_000);
  return `${name} archived from Settings (bot.remove): gone from the list, in bot.archived and under Archived bots; Bring back: listed again with its conversation (${page.events.length} events, ${bubbles} bubbles drawn)`;
}


/** The long conversation's bot, seeded in the home before the daemon starts (`seedLongConversation`). */
export const LONG_BOT = { id: "chronicle", name: "Chronicle" } as const;
export const LONG_EVENTS = 20_000;
const longText = (n: number) => `Chronicle message ${n}`;

/** A bot with a long conversation already in the home, as the upgrade's copy brings the owner's own: its record, its
 *  instructions and its one conversation's log (20,000 records: user messages, turns and replies, written with the
 *  engine's own log writer), ending two days ago so the bot sorts after Alpha. The session's meta is left for the engine
 *  to make on open, as it does for a log whose meta was lost. Written before the daemon starts. */
export async function seedLongConversation(home: string): Promise<void> {
  const { SessionLogFile } = await import("../../packages/core/src/sessions/event-log");
  const { sessionLogPath, mainSessionIdFor } = await import("../../packages/core/src/sessions/ids");
  const { recordFile, instructionsFile } = await import("../../packages/core/src/bots/records");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const id = LONG_BOT.id;
  if (existsSync(recordFile(home, id))) return;
  const session = mainSessionIdFor(id);
  const end = Date.now() - 2 * 24 * 3_600_000;
  const start = end - LONG_EVENTS * 1_000;
  for (const [file, text] of [[recordFile(home, id), `${JSON.stringify({ record: 1, id, name: LONG_BOT.name, madeBy: { kind: "user" }, createdAt: start }, null, 2)}\n`], [instructionsFile(home, id), "You keep a long chronicle."]] as const) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const log = new SessionLogFile(sessionLogPath(home, id, session), session);
  log.load();
  let seq = 0;
  let said = 0;
  const put = (body: Record<string, unknown>) => { log.append({ ...body, seq, sessionId: session, ts: start + seq * 1_000 } as never, { durable: false }); seq++; };
  while (seq < LONG_EVENTS) {
    const u = ++said;
    put({ type: "input", input: { from: "user", text: longText(u), device: "seeddevice000000000", sentAt: start + seq * 1_000, clientMessageId: `seed-${u}` }, disposition: "turn" });
    put({ type: "turn_started", origin: "user" });
    const b = ++said;
    put({ type: "driver", event: { type: "assistant_message", text: longText(b) } });
    put({ type: "turn_ended", end: { reason: "end_turn", text: longText(b) } });
  }
}

/** The long conversation: opened from the list (its first paint timed in the page), then the wheel over its messages until
 *  the oldest is drawn, each page load timed and the message at the top before it checked to be where it was after. */
async function longRow(s: UnitState): Promise<string> {
  try {
    return await longRowIn(s);
  } finally {
    // Put away after the row (archived, nothing deleted), so a whole run's later rows on this home (the cold start, the
    // idle check) don't start or idle with its 20,000 events.
    await s.c.request("bot.remove", { id: LONG_BOT.id }).catch(() => undefined);
  }
}

async function longRowIn(s: UnitState): Promise<string> {
  const rec = await s.x.until(`${LONG_BOT.name} as a record`, 30_000, async () => (await records(s.c)).find((b) => b.id === LONG_BOT.id), 500)
    .catch(() => s.x.fail(`the seeded bot ${LONG_BOT.id} isn't a record (the home's copy wasn't loaded)`));
  const more = (await s.c.request<{ events: unknown[]; hasMore: boolean }>("bot.conversation", { id: rec.id, limit: 1 })).hasMore;
  if (!more) s.x.fail("the seeded conversation has one event or none");
  const newest = longText(LONG_EVENTS / 2);
  const oldest = longText(1);
  // The page's own clock: the click's time, then the newest message's first drawing, and each page load (the list's
  // data-older going loading → back) with where the top message was before and after it.
  await s.w.eval(`(() => {
    const t = { clickAt: 0, firstAt: 0, loads: [], drift: [] };
    window.__mossLong = t;
    const seen = () => [...document.querySelectorAll('.messages .bubble')].some((b) => b.textContent === ${JSON.stringify(newest)});
    const top = (m) => { const r = m.getBoundingClientRect(); for (const b of m.querySelectorAll('.bubble')) { const x = b.getBoundingClientRect(); if (x.bottom > r.top + 4) return { text: b.textContent, y: x.top - r.top }; } return undefined; };
    let started = 0, before;
    const watchList = (m) => new MutationObserver(() => {
      const state = m.dataset.older;
      if (state === 'loading' && started === 0) { started = performance.now(); before = top(m); }
      else if (state !== 'loading' && started !== 0) {
        t.loads.push(performance.now() - started);
        started = 0;
        if (before !== undefined) { const b = [...m.querySelectorAll('.bubble')].find((x) => x.textContent === before.text); if (b) t.drift.push(Math.round(b.getBoundingClientRect().top - m.getBoundingClientRect().top - before.y)); }
      }
    }).observe(m, { attributes: true, attributeFilter: ['data-older'] });
    let watched;
    new MutationObserver(() => {
      if (t.clickAt !== 0 && t.firstAt === 0 && seen()) t.firstAt = performance.now();
      const m = document.querySelector('main.conversation .messages');
      if (m && m !== watched) { watched = m; watchList(m); }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mousedown', () => { if (t.clickAt === 0) t.clickAt = performance.now(); }, { capture: true, once: true });
    return true;
  })()`);
  await s.w.click(`[data-bot-row=${JSON.stringify(rec.id)}]`);
  await s.w.waitFor(`${LONG_BOT.name}'s newest message drawn`, "window.__mossLong.firstAt > 0 ? true : null", 60_000);
  const first = await s.w.eval<{ ms: number; count: number }>("({ ms: window.__mossLong.firstAt - window.__mossLong.clickAt, count: document.querySelectorAll('.messages .bubble').length })");
  const page = await s.w.main();
  const at = await s.x.until("the messages' place", 10_000, () => s.w.cdp.centerOf(page, ".messages"), 250);
  // A few small turns of the wheel first (a person's), each left to settle, so the page under the eye can be compared.
  const wheel = async (dy: number) => { await s.w.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: dy }, page); };
  const loadsOf = () => s.w.eval<{ loads: number[]; drift: number[]; older: string; top: string }>("({ loads: window.__mossLong.loads, drift: window.__mossLong.drift, older: document.querySelector('.messages')?.dataset.older ?? '', top: document.querySelector('.messages .bubble')?.textContent ?? '' })");
  for (let i = 0; i < 60 && (await loadsOf()).loads.length < 3; i++) { await wheel(-400); await sleep(350); }
  const small = await loadsOf();
  if (small.loads.length < 3) s.x.fail(`scrolling up read ${small.loads.length} earlier page(s) after 60 turns of the wheel`);
  if (small.drift.some((d) => Math.abs(d) > 450)) s.x.fail(`the message under the eye moved by ${small.drift.join(", ")} px when earlier pages went in above`);
  // Then the wheel on, as fast as it reads, until the start.
  const t0 = Date.now();
  for (let i = 0; i < 2_000; i++) {
    const now = await loadsOf();
    if (now.older === "start") break;
    if (Date.now() - t0 > 600_000) s.x.fail(`the start not reached in 10 minutes: ${now.loads.length} page(s) read, the top message "${now.top}"`);
    await wheel(-6_000);
    await sleep(80);
  }
  const done = await s.w.waitFor<{ top: string; count: number; start: string }>(`the oldest message (${oldest}) drawn at the start`, `(() => {
    const b = document.querySelector('.messages .bubble');
    const start = document.querySelector('[data-conversation-start]')?.textContent ?? '';
    return b && b.textContent === ${JSON.stringify(oldest)} && start !== '' ? { top: b.textContent, count: document.querySelectorAll('.messages .bubble').length, start } : null;
  })()`, 30_000);
  const all = await loadsOf();
  if (done.count !== LONG_EVENTS / 2) s.x.fail(`${done.count} bubbles drawn at the start, not the ${LONG_EVENTS / 2} messages of the conversation`);
  const sorted = [...all.loads].sort((a, b) => a - b);
  const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  const last10 = all.loads.slice(-10);
  return `${LONG_BOT.name} (${LONG_EVENTS} events seeded in the home): first paint ${Math.round(first.ms)} ms from the click (${first.count} bubbles, the latest page); ${all.loads.length} earlier pages read by the wheel to "${done.top}" at the start (${done.count} bubbles, each once), in ${Math.round((Date.now() - t0) / 1000)} s; a page load: median ${pct(0.5)} ms, 95th ${pct(0.95)} ms, max ${pct(1)} ms, the last ten (${done.count - 500}+ bubbles drawn) ${last10.map((x) => Math.round(x)).join("/")} ms; the message under the eye moved ${small.drift.join(", ")} px at the first loads`;
}

/** Opens Alpha's side panel and waits for her routine's row there; the row's selector. */
async function routineRowInPanel(s: UnitState, id: string): Promise<string> {
  await openBot(s, "alpha", "Alpha");
  if (!(await s.w.eval<boolean>("!!document.querySelector('.panel')"))) await s.w.click(`button[aria-label="Open Alpha's screen and routines"]`);
  const sel = `.panel [data-routine=${JSON.stringify(id)}]`;
  await s.w.waitFor(`the routine ${id} in Alpha's side panel`, `!!document.querySelector(${JSON.stringify(sel)})`, 20_000);
  return sel;
}

async function routineOf(s: UnitState, id: string): Promise<{ id: string; name: string; state: string; file: string; triggers: { type: string; summary: string }[] } | undefined> {
  return (await s.c.request<{ routines: { id: string; name: string; state: string; file: string; triggers: { type: string; summary: string }[] }[] }>("routine.list", { bot: "alpha" })).routines.find((r) => r.id === id);
}

/** A routine's file on this computer, from its tree path (`home/<Computer>/.moss/routines/<bot>/<name>.md`). */
const routineFile = (s: UnitState, tree: string) => join(s.x.home, "routines", ...tree.split("/").slice(4));

async function routineRunRow(s: UnitState): Promise<string> {
  const r = s.routine ?? s.x.fail("the panel row made no routine");
  const sel = await routineRowInPanel(s, r.id);
  const runsBefore = (await s.c.request<{ runs: unknown[] }>("routine.runs", { id: r.id })).runs.length;
  await s.w.click(`${sel} [data-routine-run]`, "Run now");
  const said = await s.w.waitFor<string>("MOSS's word on the run", `document.querySelector(${JSON.stringify(`${sel} [data-routine-said]`)})?.textContent ?? null`, 30_000);
  if (!said.startsWith("Started")) s.x.fail(`Run now: "${said}"`);
  const run = await s.x.until("the run in routine.runs, ended", 120_000, async () => {
    const runs = (await s.c.request<{ runs: { outcome: string; summary?: string }[] }>("routine.runs", { id: r.id })).runs;
    return runs.length > runsBefore && runs[0]!.outcome !== "running" ? runs[0] : undefined;
  }, 500);
  const note = await s.w.waitFor<string>("its result drawn in her conversation", `[...document.querySelectorAll('.messages [data-bubble=note]')].map((n) => n.textContent).find((t) => t.startsWith(${JSON.stringify(`Routine "${r.name}"`)})) ?? null`, 60_000);
  return `Run now pressed on "${r.name}": "${said}"; routine.runs has the run (${run.outcome}${run.summary !== undefined ? `: ${run.summary.slice(0, 50)}` : ""}); her conversation shows "${note.slice(0, 90)}"`;
}

async function routinePauseRow(s: UnitState): Promise<string> {
  const r = s.routine ?? s.x.fail("the panel row made no routine");
  const sel = await routineRowInPanel(s, r.id);
  await s.w.click(`${sel} [data-routine-pause]`, "Pause");
  await s.w.waitFor("the routine shown paused", `document.querySelector(${JSON.stringify(sel)})?.dataset.state === 'paused' ? true : null`, 20_000)
    .catch(async () => s.x.fail(`it didn't pause: ${await s.w.eval<string>(`document.querySelector(${JSON.stringify(`${sel} [data-routine-said]`)})?.textContent ?? 'nothing said'`)}`));
  const paused = await routineOf(s, r.id);
  if (paused?.state !== "paused") s.x.fail(`the engine lists it ${paused?.state ?? "not at all"} after Pause`);
  const file = routineFile(s, paused.file);
  if (!/^paused: true$/m.test(readFileSync(file, "utf8"))) s.x.fail(`its file (${paused.file}) doesn't say paused`);
  const off = await s.w.eval<boolean>(`document.querySelector(${JSON.stringify(`${sel} [data-routine-run]`)})?.disabled === true`);
  if (!off) s.x.fail("Run now is still on for a paused routine");
  await s.w.click(`${sel} [data-routine-resume]`, "Resume");
  await s.w.waitFor("the routine shown on again", `document.querySelector(${JSON.stringify(sel)})?.dataset.state === 'active' ? true : null`, 20_000);
  const back = await routineOf(s, r.id);
  if (back?.state !== "active") s.x.fail(`the engine lists it ${back?.state ?? "not at all"} after Resume`);
  if (/^paused:/m.test(readFileSync(routineFile(s, back.file), "utf8"))) s.x.fail("its file still says paused after Resume");
  const next = await s.w.eval<string>(`document.querySelector(${JSON.stringify(`${sel} .routine__when`)})?.textContent ?? ''`);
  return `Pause pressed: the engine lists "${r.name}" paused, its file (${paused.file}) says paused: true, Run now is off; Resume pressed: active again, paused taken out of the file, "${next.slice(0, 60)}"`;
}

async function routineEditRow(s: UnitState): Promise<string> {
  const r = s.routine ?? s.x.fail("the panel row made no routine");
  let sel = await routineRowInPanel(s, r.id);
  // Its name, schedule and what it does.
  await s.w.click(`${sel} [data-routine-edit]`, "Edit");
  const was = await s.w.waitFor<string>("what it does, as its file has it now", `(() => { const e = document.querySelector(${JSON.stringify(`${sel} [data-routine-instructions]`)}); return e ? e.value : null; })()`, 20_000);
  if (!was.includes("ACCEPTANCE-TAG-MOSSROUTINE")) s.x.fail(`the edit form shows "${was.slice(0, 80)}", not the routine's instructions`);
  const name = `${r.name} edited`;
  const t = tag("ROUTINEEDIT");
  await s.w.type(`${sel} [data-routine-name]`, name);
  await s.w.type(`${sel} [data-routine-schedule]`, "every 12h");
  await s.w.type(`${sel} [data-routine-instructions]`, t);
  await s.w.click(`${sel} [data-routine-save]`, "Save");
  const saved = await s.x.until("the engine's routine with the edit", 20_000, async () => {
    const v = await routineOf(s, r.id);
    return v !== undefined && v.name === name && v.triggers.some((x) => x.type === "schedule" && x.summary === "every 12h") ? v : undefined;
  }, 300).catch(async () => s.x.fail(`the edit didn't reach the routine: ${await s.w.eval<string>(`document.querySelector(${JSON.stringify(`${sel} [data-routine-said]`)})?.textContent ?? 'nothing said'`)}`));
  const text = readFileSync(routineFile(s, saved.file), "utf8");
  if (!text.includes(t) || !text.includes(`id: ${r.id}`)) s.x.fail(`its file (${saved.file}) doesn't hold the new instructions under its own id`);
  const got = await s.c.request<{ instructions: string }>("routine.get", { bot: "alpha", id: r.id });
  if (!got.instructions.includes(t)) s.x.fail("routine.get doesn't give the new instructions");
  s.routine = { id: r.id, name };
  await s.w.waitFor("the panel showing the new name", `[...document.querySelectorAll('.panel .routine__name')].some((n) => n.textContent === ${JSON.stringify(name)}) ? true : null`, 20_000);
  // A routine above this computer's level, written by hand as the bot or the person may: its OK card, pressed in MOSS.
  const computers = (await s.c.request<{ computers: { name: string; level: string }[] }>("computer.list", {})).computers;
  const here = computers[0] ?? s.x.fail("no computer listed");
  const above = LEVELS[LEVELS.indexOf(here.level as (typeof LEVELS)[number]) + 1] ?? s.x.fail(`${here.name}'s level ${here.level} is the highest: nothing is above it`);
  const before = await cardIds(s.c);
  const rid = `r_accept${randomBytes(4).toString("hex")}`;
  const hand = join(s.x.home, "routines", "alpha", "acceptance-raised.md");
  writeFileSync(hand, `---\nid: ${rid}\nname: "Acceptance raised"\nlevel: ${above}\ntriggers:\n  - schedule: "every 24h"\n---\nACCEPTANCE-TAG-MOSSRAISED\n`);
  const card1 = await newCard(s, before, "the raised level's OK card", (k) => k.kind === "change" || k.bot === "alpha", 60_000);
  await s.w.pressApprove(card1.id);
  await s.x.until("the raised routine active at its level", 30_000, async () => ((await routineOf(s, rid))?.state === "active" ? true : undefined), 300)
    .catch(async () => s.x.fail(`after its OK the routine is ${(await routineOf(s, rid))?.state ?? "not listed"}`));
  // An edit to it in MOSS raises the card again (the OK is bound to the file as it was), pressed in MOSS.
  sel = await routineRowInPanel(s, rid);
  const before2 = await cardIds(s.c);
  await s.w.click(`${sel} [data-routine-edit]`, "Edit");
  await s.w.waitFor("its edit form", `!!document.querySelector(${JSON.stringify(`${sel} [data-routine-instructions]`)}) || null`, 20_000);
  await s.w.type(`${sel} [data-routine-instructions]`, "ACCEPTANCE-TAG-MOSSRAISEDAGAIN");
  await s.w.click(`${sel} [data-routine-save]`, "Save");
  const card2 = await newCard(s, before2, "the raised level's OK card again", (k) => k.kind === "change" || k.bot === "alpha", 60_000);
  const waiting = (await routineOf(s, rid))?.state;
  await s.w.pressApprove(card2.id);
  await s.x.until("the edited raised routine active again", 30_000, async () => ((await routineOf(s, rid))?.state === "active" ? true : undefined), 300);
  return `Edit on "${r.name}": the form showed its instructions as its file had them (routine.get); saved as "${name}", every 12h, new instructions: the engine and its file (${saved.file}, id ${r.id}) have them; a hand-written routine at ${above} (above ${here.name}'s ${here.level}) raised its OK card (${card1.kind}), pressed in MOSS, active; edited in MOSS it was ${waiting ?? "?"} on a new card (${card2.kind}), pressed in MOSS, active again`;
}

async function memoryRow(s: UnitState): Promise<string> {
  // Alpha's memory folder as the upgrade's copy brings it: her index and a file it links to.
  const t = tag("MEMORY");
  const dir = join(s.x.home, "bots", "alpha", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), `# Alpha's memory\n\n- [Plans](acceptance-plans.md): what we planned.\n${t} <b>stays text</b>\n`);
  writeFileSync(join(dir, "acceptance-plans.md"), "Lisbon in March.\n");
  const served = (await s.c.request<{ entries: { path: string }[] }>("memory.list", { bot: "alpha" })).entries.map((e) => e.path);
  if (!served.includes("MEMORY.md") || !served.includes("acceptance-plans.md")) s.x.fail(`memory.list serves ${served.join(", ") || "nothing"}`);
  await s.w.click(".list__bottom .nav-item.account");
  await s.w.click(`[data-section="bot:alpha"]`);
  const listed = await s.w.waitFor<string[]>("her memory's files on her page", `(() => { const l = [...document.querySelectorAll('[data-memory-file]')].map((e) => e.getAttribute('data-memory-file')); return l.includes('acceptance-plans.md') ? l : null; })()`, 20_000);
  if (listed.join("|") !== served.join("|")) s.x.fail(`the page lists ${listed.join(", ")}, the engine serves ${served.join(", ")}`);
  await s.w.click(`[data-memory-file="MEMORY.md"] button`);
  const shown = await s.w.waitFor<{ text: string; markup: boolean; fields: number }>("MEMORY.md's text drawn", `(() => {
    const e = document.querySelector('[data-memory-file="MEMORY.md"] [data-memory-text]');
    return e ? { text: e.textContent, markup: !!e.querySelector('b'), fields: document.querySelectorAll('#memory textarea, #memory input, [data-memory-files] textarea, [data-memory-files] input, [data-memory-files] [contenteditable]').length } : null;
  })()`, 20_000);
  if (!shown.text.includes(t)) s.x.fail("the page's MEMORY.md isn't the file's text");
  if (shown.markup || !shown.text.includes("<b>stays text</b>")) s.x.fail("the memory file's markup was drawn as markup");
  if (shown.fields !== 0) s.x.fail(`the memory view has ${shown.fields} field(s) to edit with`);
  return `memory.list serves ${served.join(", ")}; her page lists the same, read only; MEMORY.md opened shows its text, its markup as text`;
}

/** A routine whose run fails: written by hand for Alpha (its instructions the fake provider's refusal, until healed),
 *  Run now in the side panel, and the note in her conversation says it failed and why. */
async function routineFailRow(s: UnitState): Promise<string> {
  const fid = randomBytes(3).toString("hex").toUpperCase();
  const rid = `r_fail${randomBytes(4).toString("hex")}`;
  const name = `Acceptance failing ${fid}`;
  writeFileSync(join(s.x.home, "routines", "alpha", `acceptance-failing-${fid.toLowerCase()}.md`), `---\nid: ${rid}\nname: "${name}"\ntriggers:\n  - schedule: "every 24h"\n---\nACCEPTANCE-FAIL-${fid}\n`);
  try {
    await s.x.until("the failing routine listed", 30_000, async () => ((await routineOf(s, rid))?.state === "active" ? true : undefined), 300);
    const sel = await routineRowInPanel(s, rid);
    await s.w.click(`${sel} [data-routine-run]`, "Run now");
    const run = await s.x.until("its run in routine.runs, ended", 120_000, async () => {
      const runs = (await s.c.request<{ runs: { outcome: string; summary?: string }[] }>("routine.runs", { id: rid })).runs;
      return runs[0] !== undefined && runs[0].outcome !== "running" ? runs[0] : undefined;
    }, 500);
    if (run.outcome !== "failed") s.x.fail(`the run came out ${run.outcome}, not failed`);
    const note = await s.w.waitFor<string>("the failure drawn in her conversation", `[...document.querySelectorAll('.messages [data-routine-failed]')].map((n) => n.textContent).find((t) => t.includes(${JSON.stringify(name)})) ?? null`, 60_000);
    if (!/failed/.test(note)) s.x.fail(`the note doesn't say it failed: "${note}"`);
    if (!/\(.+\)|: \S/.test(note.replace(`Routine "${name}"`, ""))) s.x.fail(`the note says no why: "${note}"`);
    return `Run now on "${name}": routine.runs says failed; her conversation shows "${note.slice(0, 140)}", marked as a failure`;
  } finally {
    s.x.fake.heal(fid);
    await s.c.request("routine.edit", { bot: "alpha", id: rid, patch: { paused: true } }).catch(() => undefined);
  }
}

/** A file dropped on the composer, by the browser's own drag events (DevTools' Input.dispatchDragEvent with a real file). */
async function dropRow(s: UnitState): Promise<string> {
  await openBot(s, "alpha", "Alpha");
  const file = join(s.x.root, "acceptance-drop.pdf");
  writeFileSync(file, "%PDF-1.4 acceptance\n");
  const before = (await s.c.request<{ events: { type: string }[] }>("bot.conversation", { id: "alpha", limit: 200 })).events.filter((e) => e.type === "user_message").length;
  const page = await s.w.main();
  const at = await s.x.until("the composer's place", 10_000, () => s.w.cdp.centerOf(page, "[data-composer]"), 250);
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await s.w.cdp.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data }, page);
  const said = await s.w.waitFor<string>("MOSS's word on the dropped file", "document.querySelector('.composer__why')?.textContent ?? null", 15_000);
  if (!/Files aren't supported yet/.test(said)) s.x.fail(`MOSS said "${said}"`);
  await sleep(1_000);
  const after = (await s.c.request<{ events: { type: string }[] }>("bot.conversation", { id: "alpha", limit: 200 })).events.filter((e) => e.type === "user_message").length;
  if (after !== before) s.x.fail("something was sent after the drop");
  return `a PDF dropped on the composer: "${said}"; nothing sent`;
}

/** The last row: MOSS Code's own answer key registered on the same computer (as MOSS Code's window registers it,
 *  `device.answerKey.set`, from a MOSS Code connection), then a card MOSS draws: MOSS Code's connection can't answer it,
 *  even signed with its own key, and MOSS's press still signs with MOSS's key and is taken. */
async function bothKeysRow(s: UnitState): Promise<string> {
  const code = await s.x.helloAs({});
  try {
    if (code.result.surface !== undefined && code.result.surface !== "code") s.x.fail(`MOSS Code's hello came back as ${String(code.result.surface)}`);
    const { privateKey } = generateKeyPairSync("ed25519");
    const pub = Buffer.from(createPublicKeyRaw(privateKey)).toString("base64");
    const set = await code.client.request<{ applied?: boolean }>("device.answerKey.set", { publicKey: pub, held: "none", signature: sign(null, Buffer.from(answerKeyStatement(s.device, pub, "none")), privateKey).toString("base64") });
    if (set.applied !== true) s.x.fail(`MOSS Code's key wasn't applied: ${JSON.stringify(set)}`);
    const a = await alpha(s.c);
    await openBot(s, "alpha", "Alpha");
    const before = await cardIds(s.c);
    const path = join(s.x.userHome, ".acceptance", `moss-both-${randomBytes(3).toString("hex")}.txt`);
    await sendInMoss(s, "Alpha", callText("Write", { file_path: path, content: "moss both\n" }));
    const card = await newCard(s, before, "the Write's approval card", (k) => k.session === a.mainSession);
    const place = await s.x.until("the card placed in her conversation in MOSS", 20_000, async () => {
      const p = await placementOf(s.c, card.id);
      return p?.kind === "conversation" && p.program === "moss" ? p : undefined;
    }, 300).catch(async () => s.x.fail(`the card is placed ${placeWords(await placementOf(s.c, card.id))}`));
    const option = approveOf(card);
    const at = Date.now();
    const own = sign(null, Buffer.from(programCardAnswerSigningInput({ program: "code", id: card.id, hash: card.hash, option, at })), privateKey).toString("base64");
    const fromCode = await code.client.request<{ accepted: boolean; reason?: string }>("card.answer", { id: card.id, hash: card.hash, option, proof: { via: "device", device: s.device, at, signature: own, program: "code" } });
    if (fromCode.accepted) s.x.fail("MOSS Code's connection answered a card MOSS draws");
    if (!(await cardIds(s.c)).has(card.id)) s.x.fail("the card was answered from MOSS Code's connection");
    await s.w.pressApprove(card.id);
    await s.x.until("the card answered", 15_000, async () => ((await cardIds(s.c)).has(card.id) ? undefined : true), 300);
    const table = JSON.parse(readFileSync(join(s.x.home, "devices", "program-keys.json"), "utf8")) as { keys: Record<string, Partial<Record<string, { publicKey: string }>>> };
    const mossPub = Buffer.from(createPublicKeyRaw(mossKey(s.keyFile))).toString("base64");
    if (table.keys[s.device]?.moss?.publicKey !== mossPub) s.x.fail("the engine's moss key changed when MOSS Code's key came");
    return `MOSS Code's key registered beside MOSS's (device.answerKey.set applied); the card placed ${placeWords(place)}; MOSS Code's connection, signing with its own key: refused (${fromCode.reason ?? "no reason"}); MOSS's press taken with MOSS's own key, the engine's moss key unchanged`;
  } finally {
    // Left open until the run ends (it closes every connection it made): today's engine still pairs with the newest app
    // connection and stops when that one goes (the background host's lane changes it), which would take MOSS's engine away.
    void code;
  }
}

/** The bot editor: the made bot's own Settings page, its name, model and instructions edited, then the page left and
 *  opened again. */
async function editorRow(s: UnitState): Promise<string> {
  const id = s.made;
  if (id === undefined) s.x.fail("the make row made no bot to edit");
  const rec = (await records(s.c)).find((b) => b.id === id);
  if (rec === undefined) s.x.fail(`${id} isn't a record`);
  const name = `${nameOf(rec!.name)} Two`;
  const open = async () => {
    await s.w.click(".list__bottom .nav-item.account");
    await s.w.click(`[data-section=${JSON.stringify(`bot:${id}`)}]`);
    await s.w.waitFor("the bot's own Settings page", `!!document.querySelector(${JSON.stringify(`[data-bot-page="${id}"] .ma2-name`)})`, 20_000);
  };
  await open();
  // Its name.
  await s.w.type(`[data-bot-page=${JSON.stringify(id)}] .ma2-name`, name);
  await s.w.click("[data-settings=name] .text-button--solid", "Save");
  await s.x.until("the record's new name", 15_000, async () => ((await records(s.c)).find((b) => b.id === id) !== undefined && nameOf((await records(s.c)).find((b) => b.id === id)!.name) === name ? true : undefined), 300)
    .catch(async () => s.x.fail(`the name didn't change: ${await s.w.eval<string>("[...document.querySelectorAll('.add__note')].map((n) => n.textContent).join(' | ') || 'nothing said'")}`));
  // Its instructions.
  const t = tag("EDIT");
  const text = `You are ${name}, edited in MOSS. Say ${t} when asked.`;
  await s.w.waitFor("its instructions field", `(() => { const e = document.querySelector('[data-instructions-text]'); return e && !e.disabled ? true : null; })()`, 20_000);
  await s.w.type("[data-instructions-text]", text);
  await s.w.click("[data-settings=instructions] .text-button--solid", "Save instructions");
  await s.x.until("the instructions kept", 15_000, async () => ((await s.c.request<{ text: string }>("bot.instructions.get", { id })).text === text ? true : undefined), 300);
  const model = (await records(s.c)).find((b) => b.id === id)?.model;
  // Left (its conversation) and opened again: all three shown as kept.
  await openBot(s, id!, name);
  await open();
  const shown = await s.w.waitFor<{ name: string; model: string; instructions: string }>("the page opened again with what was kept", `(() => {
    const page = document.querySelector(${JSON.stringify(`[data-bot-page="${id}"]`)});
    const ins = document.querySelector('[data-instructions-text]');
    if (!page || !ins || ins.disabled) return null;
    return { name: page.querySelector('.ma2-name')?.value ?? '', model: document.querySelector('[data-model-picker]')?.value ?? '', instructions: ins.value };
  })()`, 20_000);
  if (shown.name !== name) s.x.fail(`the page opened again shows the name "${shown.name}", not "${name}"`);
  if (shown.instructions !== text) s.x.fail("the page opened again doesn't show the edited instructions");
  if (model !== undefined && shown.model !== model) s.x.fail(`the page opened again shows the model "${shown.model}", not ${model}`);
  const listed = await s.w.eval<string>(`document.querySelector(${JSON.stringify(`[data-bot-row="${id}"] .row__name`)})?.textContent ?? ''`);
  if (listed !== name) s.x.fail(`the list names the bot "${listed}", not "${name}"`);
  return `${id}'s page in Settings: renamed "${name}" (the record and the list say so), its model ${model ?? "(the default)"} and its instructions kept; left for its conversation and opened again, the page shows all three`;
}

/** Try again: a turn that fails (the fake provider's 400, until it is healed), its note in MOSS with Try again, one press. */
async function tryAgainRow(s: UnitState): Promise<string> {
  const a = await alpha(s.c);
  await openBot(s, "alpha", "Alpha");
  const id = randomBytes(3).toString("hex").toUpperCase();
  const words = `ACCEPTANCE-FAIL-${id}`;
  await sendInMoss(s, "Alpha", words);
  await s.w.waitFor("the failed turn's Try again in her conversation", "!!document.querySelector('.messages [data-try-again]')", 120_000);
  const sentBefore = (await s.c.request<{ events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 200 })).events.filter((e) => e.type === "user_message" && e.text === words).length;
  s.x.fake.heal(id);
  await s.w.click(".messages [data-try-again]");
  const said = await botSaid(s, `ACCEPTANCE-REPLY-OK ${words}`);
  await s.w.waitFor("Try again gone", "!document.querySelector('.messages [data-try-again]') ? 'gone' : null", 15_000);
  const page = await s.c.request<{ session: string; events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 200 });
  const sent = page.events.filter((e) => e.type === "user_message" && e.text === words).length;
  if (sentBefore !== 1 || sent !== 2) s.x.fail(`the words were in her conversation ${sentBefore} time(s) before the press and ${sent} after (want 1, then 2: sent once more)`);
  if (page.session !== a.mainSession) s.x.fail("Try again went to another session");
  return `her turn failed and MOSS showed Try again; one press sent the same words once more (in her conversation 1, then 2 times), the next turn completed ("${said.slice(0, 50)}"), and the button went`;
}
