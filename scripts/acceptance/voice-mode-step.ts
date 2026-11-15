// Voice on general capabilities (spec §6.6, F1's speaking half): a clause of the push-to-talk row, run while the run's tone
// voice (`acceptance-voice`, an entry on Clover Voice's providers point) is Alpha's voice. A second speaking plugin
// (`acceptance-voice-mode`) is installed from its folder the user's way: it speaks through a background part of its own
// (its OK card says it keeps one running), which takes the device's speech turn (`device/speech`) like Clover Voice's
// player. Its `chime`, asked for while Alpha's reply sounds, waits for that turn: its span begins only once Clover Voice's
// ended (the two plugins' turn spans never overlap). It fills the platform's `voiceModes` (one at a time, P4) and offers
// its reply on Clover Voice's own modes point: picked in Settings › Plugins' "Voice" picker it says Alpha's next reply
// its own way and Clover Voice's player says nothing; Clover Voice picked again takes it back. A plain plugin with `voices.use` (`acceptance-narrator`) gets a provider's transcription as its
// own data; its child, with no `voices.use`, is refused. Assertions are on the turn spans and the players' counters,
// never on sound (the test build is muted).
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKGROUND_OK_LINE } from "../../packages/plugin-sdk/src/manifest/validate";
import { clickTree, fail, leave, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

export const VOICE_MODE_CLAUSE = "a second speaking plugin from a folder speaks through its own background part in the device's speech turn: its OK says it keeps a part running in the background; its chime, asked for while Alpha's reply sounds, begins only after Clover Voice's turn ended (the spans never overlap); picked in Settings' Voice picker (the platform's one at a time) it says Alpha's reply its own way while Clover Voice's player stays quiet, and Clover Voice takes back over when chosen again; a plugin with voices.use gets a provider's transcription as its own data, one without is refused";

const MODE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-voice-mode");
const MODE_ID = "acceptance-voice-mode";
const NARRATOR_DIR = resolve(import.meta.dir, "fixtures", "acceptance-narrator");
const NARRATOR_ID = "acceptance-narrator";
/** What the run's tone voice hears of the narrator's 3,200 bytes. */
const NARRATED = "heard 1 pieces, 3200 bytes of pcm16-16k";

type Span = { bot: string; id: string; from: number; to: number; cut: boolean };
type Counters = { pieces: number; speaking: string[]; overlap: number; cut: number; spans: Span[] };
type CardView = { id: string; kind: string; pluginId?: string };
type Report = { replies: string[]; spans: { what: string; from: number; to: number }[] };

export async function voiceModeClause(ctx: ExampleCtx): Promise<string[]> {
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  let chosen = false;
  let long = false;
  /** Clover Voice's player's counters (its background part's document root, a test build's). */
  const counters = async (): Promise<Counters | undefined> => {
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "(() => { const d = document.documentElement.dataset; return d.voicePieces === undefined ? null : JSON.stringify({ pieces: +d.voicePieces, speaking: (d.voiceSpeaking || '').split(',').filter(Boolean), overlap: +(d.voiceOverlap || 0), cut: +(d.voiceCut || 0), spans: JSON.parse(d.voiceSpans || '[]') }); })()").catch(() => null);
      if (typeof v === "string") return JSON.parse(v) as Counters;
    }
    return undefined;
  };
  const run = async <T>(name: string): Promise<T> => (await rpc.request<{ result: T }>("command.run", { name, args: {} }, 30_000)).result;
  const setVoice = async (voice: string) => {
    await rpc.request("plugin.settings.set", { id: "clover/voice", key: "provider", value: "acceptance-voice", bot: "alpha" });
    await rpc.request("plugin.settings.set", { id: "clover/voice", key: "voice", value: voice, bot: "alpha" });
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
  /** Settings › Plugins, the user's way: the gear, the Plugins section, `name` in the platform's "Voice" picker (the
   *  `voiceModes` point, one at a time); then closed. A layer installed a moment ago may load the window's document
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
    const logs = (await rpc.request<{ lines: string[] }>("plugin.logs", { id: "clover/voice", lines: 20 }).catch(() => ({ lines: [] as string[] }))).lines.join(" | ");
    const mode = await run<Report>(`${MODE_ID}.report`).catch(() => undefined);
    return `Clover Voice's player: ${JSON.stringify(await counters())}; ${MODE_ID}: ${JSON.stringify(mode)}; Clover Voice's log: ${logs.slice(-1200)}; app: ${ctx.appLog().split("\n").filter((l) => /voice|turns:/i.test(l)).slice(-8).join(" | ").slice(-1500)}`;
  };
  /** The platform's active `voiceModes` filler (P4), by its plugin. */
  const active = async () => (await rpc.request<{ points: { point: string; active?: { pluginId: string } }[] }>("point.active.list", {})).points.find((p) => p.point === "voiceModes")?.active?.pluginId;
  try {
    // The second speaking plugin, its OK card saying it keeps a part running in the background.
    const ok = await install(MODE_DIR, MODE_ID);
    if (!ok.includes(BACKGROUND_OK_LINE)) fail(`${MODE_ID}'s OK card lacks "${BACKGROUND_OK_LINE}": ${ok.slice(0, 400)}`);
    done.push(`${MODE_ID}, from its folder, says on its OK card "${BACKGROUND_OK_LINE}"`);

    // Its chime asked for while Alpha's reply sounds (her `long` voice: 2.5 s): it waits for the device's speech turn.
    await setVoice("long");
    long = true;
    const before = await until("Clover Voice's player's counters", 30_000, counters, dump);
    const replied = say("Say something for the turn.");
    const deadline = Date.now() + 120_000;
    while (!(await counters())!.speaking.includes("alpha")) {
      if (Date.now() > deadline) fail(`Alpha's reply never sounded on Clover Voice's player: ${await dump()}`);
      await sleep(25);
    }
    const asked = await run<{ offered: boolean; at: number }>(`${MODE_ID}.chime`);
    await replied;
    const chime = await until("the chime's span", 30_000, async () => (await run<Report>(`${MODE_ID}.report`)).spans.find((s) => s.what === "chime"), dump);
    const after = await until("Clover Voice's player quiet again", 30_000, async () => {
      const c = await counters();
      return c !== undefined && c.speaking.length === 0 ? c : undefined;
    }, dump);
    const hers = after.spans.filter((s) => s.bot === "alpha" && !before.spans.some((b) => b.id === s.id));
    const reply = hers.find((s) => s.from <= asked.at && asked.at < s.to) ?? fail(`the chime wasn't asked for while Alpha's reply held the turn (asked at ${asked.at}): ${JSON.stringify(hers)}; ${await dump()}`);
    if (chime.from < reply.to) fail(`the chime began ${reply.to - chime.from} ms before Alpha's reply let the device's speech turn go: they overlapped; ${await dump()}`);
    for (const s of hers) if (chime.from < s.to && s.from < chime.to) fail(`the chime's span overlapped a span of Clover Voice's: ${JSON.stringify({ chime, s })}`);
    if (reply.cut) fail(`Alpha's reply was cut: ${JSON.stringify(reply)}`);
    if (after.overlap > 1) fail(`two bots sounded at once on Clover Voice's player (data-voice-overlap ${after.overlap})`);
    await setVoice("tone");
    long = false;
    done.push(`the chime, asked for ${asked.at - reply.from} ms into Alpha's ${reply.to - reply.from} ms reply, began ${chime.from - reply.to} ms after Clover Voice let the device's speech turn go (spans ${reply.from}–${reply.to} and ${chime.from}–${chime.to}, never overlapping); her reply wasn't cut`);

    // Picked in Settings' Voice picker: the second plugin says Alpha's next reply its own way; Clover Voice says nothing.
    const value = await choose("Acceptance voice mode");
    chosen = true;
    await until(`the active voiceModes filler = ${MODE_ID}`, 10_000, async () => ((await active()) === MODE_ID ? true : undefined), async () => `it reads ${JSON.stringify(await active())} (the list chose ${value})`);
    const heard = (await run<Report>(`${MODE_ID}.report`)).replies.length;
    const p0 = (await counters())!;
    await say("Say it in the other voice.");
    const r = await until(`${MODE_ID} saying Alpha's reply in its own turn`, 30_000, async () => {
      const x = await run<Report>(`${MODE_ID}.report`);
      return x.replies.length > heard && x.spans.some((s) => s.what === "reply:alpha") ? x : undefined;
    }, dump);
    await sleep(1_000);
    const p1 = (await counters())!;
    if (p1.pieces !== p0.pieces) fail(`with ${MODE_ID} chosen, Clover Voice's player still got ${p1.pieces - p0.pieces} piece(s) of Alpha's reply`);
    done.push(`picked in Settings' Voice picker (the platform's voiceModes, one at a time), ${MODE_ID} said Alpha's reply in its own part (${r.spans.filter((s) => s.what === "reply:alpha").length} span(s) in the device's speech turn) and Clover Voice's player got nothing`);

    // Clover Voice again.
    await choose("Clover Voice");
    await until("Clover Voice the active voiceModes filler again", 10_000, async () => ((await active()) === "clover/voice" ? true : undefined));
    chosen = false;
    done.push("Clover Voice picked again in Settings' Voice picker");

    // A plain plugin with voices.use, and its child without.
    const nok = await install(NARRATOR_DIR, NARRATOR_ID);
    if (!nok.includes("can ask your voice providers to transcribe")) fail(`${NARRATOR_ID}'s OK card doesn't say it may use the voice providers: ${nok.slice(0, 400)}`);
    const n = await run<{ providers?: string[]; text?: string; error?: string }>(`${NARRATOR_ID}.narrate`);
    if (n.text !== NARRATED || !(n.providers ?? []).includes("acceptance-voice")) fail(`the narrator's ask came back ${JSON.stringify(n)}; wanted "${NARRATED}" from acceptance-voice`);
    const nosy = await run<{ error?: string }>(`${NARRATOR_ID}.nosy`);
    if (nosy.error === undefined || !nosy.error.includes("voices.use")) fail(`the child with no voices.use got ${JSON.stringify(nosy)}`);
    done.push(`a plugin with voices.use (its OK says so) got a transcription back as its own data ("${n.text}"); its child without was refused ("${nosy.error}")`);
    return done;
  } finally {
    if (chosen) await rpc.request("point.active.set", { point: "voiceModes", entry: { pluginId: "clover/voice", entryId: "clover-voice" } }).catch(() => undefined);
    if (long) await setVoice("tone").catch(() => undefined);
    await leave(ctx, NARRATOR_ID);
    await leave(ctx, MODE_ID);
  }
}
