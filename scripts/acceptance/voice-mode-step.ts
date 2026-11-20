// Voice on general capabilities (spec §6.6, F1's speaking half): a clause of the push-to-talk row, run while the run's tone
// voice (`acceptance-voice`, an entry on MOSS Voice's providers point) is Alpha's voice. A second speaking plugin
// (`acceptance-voice-mode`) is installed from its folder the user's way: it speaks through a background part of its own
// (its OK card says it keeps one running), which takes the device's speech turn (`device/speech`) like MOSS Voice's
// player. Its `chime`, asked for while Alpha's reply sounds, waits for that turn: its span begins only once MOSS Voice's
// ended (the two plugins' turn spans never overlap). It fills MOSS Voice's own modes point (`moss.voice.modes`, one
// at a time, P4, titled "Voice"): picked in Settings › Plugins' "Voice" picker it says Alpha's next reply its own way and
// MOSS Voice's player says nothing, and MOSS Voice's talk button, held, hands it the recording (its `hear`), whose
// words are sent as the user's message; MOSS Voice picked again takes it back. Assertions are on the turn spans, the
// players' counters and the conversation, never on sound (the test build is muted).
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { BACKGROUND_OK_LINE, fillsLine } from "../../packages/plugin-sdk/src/manifest/validate";
import { clickTree, fail, leave, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

export const VOICE_MODE_CLAUSE = "a second speaking plugin from a folder speaks through its own background part in the device's speech turn: its OK says it keeps a part running in the background and, in MOSS Voice's words, what it is given as a voice; a bot that brings a default voice says MOSS Voice's caution for it on its OK card; its chime, asked for while MOSS's reply sounds, begins only after MOSS Voice's turn ended (the spans never overlap); picked in Settings' Voice picker (MOSS Voice's own point, one at a time) it says MOSS's reply its own way while MOSS Voice's player stays quiet, and hears the talk button's recording, whose words are sent as the user's message; MOSS Voice takes back over when chosen again";

/** Holds MOSS Voice's talk button through a clip and waits for the user's message carrying `words`; answers the button's document (listen-step.ts). */
export type Talk = (words: string) => Promise<string>;

const MODE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-voice-mode");
const MODE_ID = "acceptance-voice-mode";
const VOICE_BOT_DIR = resolve(import.meta.dir, "fixtures", "acceptance-voice-bot");
const VOICE_BOT_ID = "acceptance-voice-bot";
/** MOSS Voice's own one-at-a-time point of voices. */
const MODES = "moss.voice.modes";

/** The line MOSS Voice's point puts on its fillers' OK cards (its declaration's `fills`), as the card says it. */
function voiceFills(point: string): string {
  const voice = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins", "voice", "moss.json"), "utf8")) as { name: string; host: { declares: Record<string, { title: string; fills: { ok: string; warns?: boolean } }> } };
  const d = voice.host.declares[point]!;
  return fillsLine({ by: voice.name, id: "moss/voice", title: d.title, ok: d.fills.ok, ...(d.fills.warns === true ? { warns: true } : {}) });
}
/** Whether a card's text (its JSON) shows `line`. */
const shows = (cardJson: string, line: string): boolean => cardJson.includes(JSON.stringify(line).slice(1, -1));
/** What the second voice's `hear` answers for the talk button's 1.2 s clip. */
const MODE_HEARD = "heard by the voice mode: 38400 bytes of pcm16-16k";

type Span = { bot: string; id: string; from: number; to: number; cut: boolean };
type Counters = { pieces: number; speaking: string[]; overlap: number; cut: number; spans: Span[] };
type CardView = { id: string; kind: string; pluginId?: string };
type Report = { replies: string[]; heard: number[]; spans: { what: string; from: number; to: number }[] };

export async function voiceModeClause(ctx: ExampleCtx, talk: Talk): Promise<string[]> {
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  let chosen = false;
  let long = false;
  /** MOSS Voice's player's counters (its background part's document root, a test build's). */
  const counters = async (): Promise<Counters | undefined> => {
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "(() => { const d = document.documentElement.dataset; return d.voicePieces === undefined ? null : JSON.stringify({ pieces: +d.voicePieces, speaking: (d.voiceSpeaking || '').split(',').filter(Boolean), overlap: +(d.voiceOverlap || 0), cut: +(d.voiceCut || 0), spans: JSON.parse(d.voiceSpans || '[]') }); })()").catch(() => null);
      if (typeof v === "string") return JSON.parse(v) as Counters;
    }
    return undefined;
  };
  const run = async <T>(name: string): Promise<T> => (await rpc.request<{ result: T }>("command.run", { name, args: {} }, 30_000)).result;
  const setVoice = async (voice: string) => {
    await rpc.request("plugin.settings.set", { id: "moss/voice", key: "provider", value: "acceptance-voice", bot: "alpha" });
    await rpc.request("plugin.settings.set", { id: "moss/voice", key: "voice", value: voice, bot: "alpha" });
  };
  const alphaSession = (await rpc.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.mainSession ?? fail("no Alpha in bot.list");
  /** Sends Alpha a message; resolves when her reply is in the log. */
  const say = async (words: string) => {
    const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
    await rpc.request("session.send", { id: alphaSession, message: { text: `${words} ${tag}`, clientMessageId: `vmode-${tag}` } }, 30_000);
    await until("Alpha's reply", 120_000, async () => {
      const events = (await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: alphaSession, limit: 200 })).events;
      return events.some((e) => e.type === "assistant_message" && typeof e.text === "string" && e.text.includes(tag)) ? true : undefined;
    });
  };
  /** Installs a fixture from its folder the user's way: its OK card read, then pressed in the window. */
  const install = async (dir: string, id: string): Promise<string> => {
    const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: dir } }, 60_000);
    if (r.id !== id) fail(`${id} installed as ${r.id}`);
    const card = await until(`${id}'s OK card`, 60_000, async () => (await rpc.request<{ cards: CardView[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === id));
    const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
    await ctx.pressCard(`${id}'s OK card`, (c) => c.id === card.id);
    await until(`${id} running`, 60_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state === "running" ? true : undefined));
    return text;
  };
  /** Settings › Plugins, the user's way: the gear, the Plugins section, `name` in the "Voice" picker (MOSS Voice's
   *  `moss.voice.modes` point, one at a time); then closed. A layer installed a moment ago may load the window's document
   *  again, closing a dialog opened before it: opened again until the picker shows. */
  const PICKER = '.cl-settings__one [role=radiogroup][aria-label="Voice"]';
  const choose = async (name: string) => {
    let shown = false;
    for (let attempt = 0; attempt < 3 && !shown; attempt++) {
      for (const d of await treeDocs(cdp)) for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined);
      await clickTree(cdp, "the Settings button", "button[aria-label=Settings]").catch(() => undefined);
      await clickTree(cdp, "the Settings window's Plugins section", "button.cl-settings__section", "Plugins").catch(() => undefined);
      shown = await until("Settings' Voice picker", 8_000, async () => {
        for (const d of await treeDocs(cdp)) if ((await cdp.evaluate(d.session, `!!document.querySelector(${JSON.stringify(PICKER)})`).catch(() => false)) === true) return true;
        return undefined;
      }).catch(() => false);
    }
    if (!shown) fail(`Settings › Plugins drew no "Voice" picker (point.active.list: ${JSON.stringify(await rpc.request("point.active.list", {}).catch((e: unknown) => String(e))).slice(0, 600)})`);
    await clickTree(cdp, `${name} in the Voice picker`, `${PICKER} [role=radio]`, name);
    const picked = await until(`${name} checked in the Voice picker`, 10_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const r = await cdp.evaluate(d.session, `(() => { const c = document.querySelector(${JSON.stringify(`${PICKER} [role=radio][aria-checked=true]`)}); return c ? c.textContent : null; })()`).catch(() => null);
        if (r === name) return r;
      }
      return undefined;
    });
    for (const d of await treeDocs(cdp)) for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined);
    await sleep(300);
    return picked;
  };
  const dump = async () => {
    const logs = (await rpc.request<{ lines: string[] }>("plugin.logs", { id: "moss/voice", lines: 20 }).catch(() => ({ lines: [] as string[] }))).lines.join(" | ");
    const mode = await run<Report>(`${MODE_ID}.report`).catch(() => undefined);
    return `MOSS Voice's player: ${JSON.stringify(await counters())}; ${MODE_ID}: ${JSON.stringify(mode)}; MOSS Voice's log: ${logs.slice(-1200)}; app: ${ctx.appLog().split("\n").filter((l) => /voice|turns:/i.test(l)).slice(-8).join(" | ").slice(-1500)}`;
  };
  /** The active filler of MOSS Voice's modes point (P4), by its plugin. */
  const active = async () => (await rpc.request<{ points: { point: string; active?: { pluginId: string } }[] }>("point.active.list", {})).points.find((p) => p.point === MODES)?.active?.pluginId;
  try {
    // The second speaking plugin, its OK card saying it keeps a part running in the background.
    const ok = await install(MODE_DIR, MODE_ID);
    if (!ok.includes(BACKGROUND_OK_LINE)) fail(`${MODE_ID}'s OK card lacks "${BACKGROUND_OK_LINE}": ${ok.slice(0, 400)}`);
    // What it is given as a voice mode: MOSS Voice's words for its modes point, by MOSS Voice's name.
    const modesLine = voiceFills("moss.voice.modes");
    if (!shows(ok, modesLine)) fail(`${MODE_ID}'s OK card lacks MOSS Voice's line "${modesLine}": ${ok.slice(0, 600)}`);
    done.push(`${MODE_ID}, from its folder, says on its OK card "${BACKGROUND_OK_LINE}" and "${modesLine}"`);

    // A bot that brings a default voice: its OK card carries MOSS Voice's caution for that point. Read, then removed.
    {
      const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: VOICE_BOT_DIR } }, 60_000);
      if (r.id !== VOICE_BOT_ID) fail(`${VOICE_BOT_ID} installed as ${r.id}`);
      const card = await until(`${VOICE_BOT_ID}'s OK card`, 60_000, async () => (await rpc.request<{ cards: CardView[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === VOICE_BOT_ID));
      const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
      const defaultsLine = voiceFills("moss.voice.defaults");
      if (!shows(text, defaultsLine)) fail(`${VOICE_BOT_ID}'s OK card lacks MOSS Voice's line "${defaultsLine}": ${text.slice(0, 600)}`);
      await leave(ctx, VOICE_BOT_ID);
      done.push(`a bot that brings a default voice says on its OK card "${defaultsLine}"`);
    }

    // Its chime asked for while Alpha's reply sounds (her `long` voice: 2.5 s): it waits for the device's speech turn.
    await setVoice("long");
    long = true;
    const before = await until("MOSS Voice's player's counters", 30_000, counters, dump);
    const replied = say("Say something for the turn.");
    const deadline = Date.now() + 120_000;
    while (!(await counters())!.speaking.includes("alpha")) {
      if (Date.now() > deadline) fail(`Alpha's reply never sounded on MOSS Voice's player: ${await dump()}`);
      await sleep(25);
    }
    const asked = await run<{ offered: boolean; at: number }>(`${MODE_ID}.chime`);
    await replied;
    const chime = await until("the chime's span", 30_000, async () => (await run<Report>(`${MODE_ID}.report`)).spans.find((s) => s.what === "chime"), dump);
    const after = await until("MOSS Voice's player quiet again", 30_000, async () => {
      const c = await counters();
      return c !== undefined && c.speaking.length === 0 ? c : undefined;
    }, dump);
    const hers = after.spans.filter((s) => s.bot === "alpha" && !before.spans.some((b) => b.id === s.id));
    const reply = hers.find((s) => s.from <= asked.at && asked.at < s.to) ?? fail(`the chime wasn't asked for while Alpha's reply held the turn (asked at ${asked.at}): ${JSON.stringify(hers)}; ${await dump()}`);
    if (chime.from < reply.to) fail(`the chime began ${reply.to - chime.from} ms before Alpha's reply let the device's speech turn go: they overlapped; ${await dump()}`);
    for (const s of hers) if (chime.from < s.to && s.from < chime.to) fail(`the chime's span overlapped a span of MOSS Voice's: ${JSON.stringify({ chime, s })}`);
    if (reply.cut) fail(`Alpha's reply was cut: ${JSON.stringify(reply)}`);
    if (after.overlap > 1) fail(`two bots sounded at once on MOSS Voice's player (data-voice-overlap ${after.overlap})`);
    await setVoice("tone");
    long = false;
    done.push(`the chime, asked for ${asked.at - reply.from} ms into Alpha's ${reply.to - reply.from} ms reply, began ${chime.from - reply.to} ms after MOSS Voice let the device's speech turn go (spans ${reply.from}–${reply.to} and ${chime.from}–${chime.to}, never overlapping); her reply wasn't cut`);

    // Picked in Settings' Voice picker: the second plugin says Alpha's next reply its own way; MOSS Voice says nothing.
    const value = await choose("Acceptance voice mode");
    chosen = true;
    await until(`the active ${MODES} filler = ${MODE_ID}`, 10_000, async () => ((await active()) === MODE_ID ? true : undefined), async () => `it reads ${JSON.stringify(await active())} (the list chose ${value})`);
    const heard = (await run<Report>(`${MODE_ID}.report`)).replies.length;
    const p0 = (await counters())!;
    await say("Say it in the other voice.");
    const r = await until(`${MODE_ID} saying Alpha's reply in its own turn`, 30_000, async () => {
      const x = await run<Report>(`${MODE_ID}.report`);
      return x.replies.length > heard && x.spans.some((s) => s.what === "reply:alpha") ? x : undefined;
    }, dump);
    await sleep(1_000);
    const p1 = (await counters())!;
    if (p1.pieces !== p0.pieces) fail(`with ${MODE_ID} chosen, MOSS Voice's player still got ${p1.pieces - p0.pieces} piece(s) of Alpha's reply`);
    done.push(`picked in Settings' Voice picker (MOSS Voice's own point, one at a time), ${MODE_ID} said Alpha's reply in its own part (${r.spans.filter((s) => s.what === "reply:alpha").length} span(s) in the device's speech turn) and MOSS Voice's player got nothing`);

    // Still picked: MOSS Voice's talk button hands it the recording (its `hear`), and its words go as the user's message.
    const heardBefore = (await run<Report>(`${MODE_ID}.report`)).heard.length;
    await talk(MODE_HEARD);
    const hr = await run<Report>(`${MODE_ID}.report`);
    if (hr.heard.length !== heardBefore + 1 || hr.heard.at(-1) !== 38_400) fail(`${MODE_ID}'s hear got ${JSON.stringify(hr.heard)}; wanted one more recording of 38400 bytes`);
    done.push(`held, the talk button's recording went to ${MODE_ID}'s hear (38,400 bytes), and its words "${MODE_HEARD}" were sent as the user's message`);

    // MOSS Voice again.
    await choose("MOSS Voice");
    await until(`MOSS Voice the active ${MODES} filler again`, 10_000, async () => ((await active()) === "moss/voice" ? true : undefined));
    chosen = false;
    done.push("MOSS Voice picked again in Settings' Voice picker");

    return done;
  } finally {
    if (chosen) await rpc.request("point.active.set", { point: MODES, entry: { pluginId: "moss/voice", entryId: "moss-voice" } }).catch(() => undefined);
    if (long) await setVoice("tone").catch(() => undefined);
    await leave(ctx, VOICE_BOT_ID);
    await leave(ctx, MODE_ID);
  }
}
