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
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { instructionsEditRule, programCardAnswerSigningInput } from "../../packages/protocol/src/index";
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
export const MOSS_MAKE_STEP = "MOSS: a bot made from the list's + (the person's bot.create) opens on its own conversation and answers; that bot's MakeBot raises the person's OK card in MOSS naming the maker, and once pressed the new bot is listed, made by it";
export const MOSS_ARCHIVE_STEP = "MOSS's Settings: a bot archived leaves the list and is listed under Archived bots; brought back, it is in the list again with its conversation whole";
export const MOSS_BOTH_KEYS_STEP = "MOSS beside MOSS Code on one computer: with MOSS Code's own answer key registered too, MOSS still answers its card with its own key (program moss), and MOSS Code's connection can't answer a card MOSS draws, even signed with MOSS Code's own key";

/** The unit's rows, in the order it runs them. */
export const MOSS_STEPS: readonly string[] = [MOSS_LIST_STEP, MOSS_MESSAGE_STEP, MOSS_CARD_STEP, MOSS_AWAY_STEP, MOSS_PANEL_STEP, MOSS_TOOLS_STEP, MOSS_INSTRUCTIONS_STEP, MOSS_MAKE_STEP, MOSS_ARCHIVE_STEP, MOSS_BOTH_KEYS_STEP];

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
    await row(MOSS_ARCHIVE_STEP, () => archiveRow(s));
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
    const from = this.x.readLog(this.log).length;
    const doc = await this.cardFrame(cardId);
    const sel = ".seal-button[data-kind=approve]:not([data-remember])";
    const inFrame = await this.x.until("the card's Approve button", 15_000, () => this.cdp.centerOf(doc.session, sel), 250);
    // The card's frame may sit in a list that scrolls (the strip holds at most 45% of the window): the person scrolls
    // until the button shows, and so does the run (its scrolling list, never the frame's own page).
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
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y, button: "none", buttons: 0 }, doc.session).catch(() => undefined);
    await this.x.until("the sealed page's ready-to-answer mark", 15_000, async () => ((await this.cdp.evaluate(doc.session, "document.body.dataset.ready ?? 'none'").catch(() => "gone")) === "yes" ? true : undefined), 100);
    await sleep(200);
    await this.cdp.click(doc.session, btn.x, btn.y);
    const said = await this.x.until(`MOSS's answer for the card ${cardId}`, 15_000, () => {
      const text = this.x.readLog(this.log).slice(from);
      if (text.includes(`sealed: answer accepted for ${cardId}`)) return "accepted";
      return /sealed: answer refused \([^\n]*/.exec(text)?.[0];
    }, 200);
    if (said !== "accepted") this.x.fail(`the press on the card's Approve in MOSS: ${said}`);
    return "accepted";
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

const tag = (what: string) => `ACCEPTANCE-TAG-MOSS${what.toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;

// ── the rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function listRow(s: UnitState): Promise<string> {
  const a = await s.x.until("Alpha as a record (bot.records)", 60_000, async () => (await records(s.c).catch(() => [])).find((b) => b.id === "alpha"), 500);
  if (a.madeBy.kind !== "move") s.x.fail(`Alpha's record says it was made by ${JSON.stringify(a.madeBy)}, not the move (offered by default)`);
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
  // MOSS's key is the one the engine holds for the `moss` program on this device.
  const pub = Buffer.from(createPublicKeyRaw(key)).toString("base64");
  const keys = readFileSync(join(s.x.home, "devices", "program-keys.json"), "utf8");
  const table = JSON.parse(keys) as { keys: Record<string, Partial<Record<string, { publicKey: string }>>> };
  if (table.keys[s.device]?.moss?.publicKey !== pub) s.x.fail("the engine's moss key for this device isn't MOSS's own key");
  const landed = await s.x.until("the Write to land after the approval", 60_000, async () => {
    const page = await s.c.request<{ events: { type: string; text?: string }[] }>("bot.conversation", { id: "alpha", limit: 200 });
    return page.events.some((e) => e.type === "assistant_message" && (e.text ?? "").startsWith("ACCEPTANCE-DONE")) ? true : undefined;
  }, 500).catch(() => false);
  return `the ${card.kind} card placed ${placeWords(place)} and drawn in her conversation; the frame's own script answering with no press: MOSS refused it (${refusedLine.replace(/^sealed: answer refused /, "").slice(0, 80)}); signed as MOSS Code with MOSS's key: refused (${asCode.reason ?? "no reason"}); a real press on Approve accepted, MOSS's key the engine's moss key for this device${landed ? "; the Write's turn went on" : ""}`;
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
  await sendInMoss(s, "Alpha", callText("Routine", { name: routine, instructions: "ACCEPTANCE-TAG-MOSSROUTINE", schedule: "every 6h" }));
  await botSaid(s, "ACCEPTANCE-DONE");
  const listed = await s.x.until("her routine in routine.list", 30_000, async () => (await s.c.request<{ routines: { id: string; name: string }[] }>("routine.list", { bot: "alpha" })).routines.find((r) => r.name === routine), 500);
  await sendInMoss(s, "Alpha", callText("Show", {}));
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
  return `the plugin's OK card placed ${placeWords(okPlace)} and pressed in MOSS; her picture from ${shown.from.replace(/\s+/g, " ").trim().slice(0, 80)} drawn (${shown.src}…), no control in it, a click on it: "${refused.slice(0, 80)}"; her routine "${row.name}" (${row.when.slice(0, 40)}, ${row.chip}) listed (routine ${listed.id})`;
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
  // The person's: the list's +, a name, Make.
  const name = `Nova${randomBytes(2).toString("hex")}`;
  await s.w.click(`button[aria-label="New bot"]`);
  await s.w.type(`input[aria-label="The new bot's name"]`, name);
  await s.w.click(".new-bot .text-button", "Make");
  await s.w.waitFor(`${name}'s conversation open`, `document.querySelector('main.conversation')?.getAttribute('aria-label') === ${JSON.stringify(`${name}'s conversation`)}`, 30_000)
    .catch(async () => s.x.fail(`MOSS didn't open the new bot: ${await s.w.eval<string>("document.querySelector('.new-bot__why')?.textContent ?? 'nothing said'")}`));
  const made = await s.x.until(`${name} as a record`, 15_000, async () => (await records(s.c)).find((b) => nameOf(b.name) === name), 300);
  if (made.madeBy.kind !== "user") s.x.fail(`${name}'s record says it was made by ${JSON.stringify(made.madeBy)}`);
  s.made = made.id;
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
  return `${name} made from the list's + (madeBy user), its conversation opened and answered; its MakeBot raised a ${card.kind} card in MOSS naming ${name} and ${child}, pressed; ${child} listed, made by ${made.id}`;
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
