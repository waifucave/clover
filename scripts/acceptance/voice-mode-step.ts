// The voice slot (spec §6.6, lane A's voice plugin): a clause of the push-to-talk row, run while the run's tone voice
// (`acceptance-voice`) is Alpha's voice. Clover Voice (the bundled `clover/voice`) is the active voice mode; a third
// party's (`acceptance-voice-mode`) is installed the user's way and its OK card says it can replace Clover's voice. Not
// chosen, the core refuses it the player. Its `chime` (a plugin's sound as Alpha's voice, the `audio` capability) goes
// to Clover Voice's one queue while Alpha's reply sounds, and waits its turn: it never cuts her reply (the player's
// `data-voice-cut` stays) and no two bots ever sound at once (`data-voice-overlap` at most 1). Chosen in Settings › Voice
// (the section's select, the user's way), the third party's mode says Alpha's next reply through her provider; choosing
// Clover Voice again takes it back. A plain plugin with `voices.use` (`acceptance-narrator`) gets the provider's audio
// back as its own data with nothing played; its child, with no `voices.use`, is refused.
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { VOICE_MODE_OK_LINE } from "../../packages/plugin-sdk/src/manifest/validate";
import { clickTree, fail, leave, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

export const VOICE_MODE_CLAUSE = "a third party's voice mode: its OK says it can replace Clover's voice; not chosen it is refused the player; a plugin's sound waits behind Alpha's reply in Clover Voice's one queue, never cutting it, and no two bots sound at once; chosen in Settings › Voice it says Alpha's reply through her provider, and Clover Voice takes back over when chosen again; a plugin with voices.use gets a provider's audio as its own data, one without is refused";

const MODE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-voice-mode");
const MODE_ID = "acceptance-voice-mode";
const NARRATOR_DIR = resolve(import.meta.dir, "fixtures", "acceptance-narrator");
const NARRATOR_ID = "acceptance-narrator";
/** What the run's tone voice yields for any text: 3 pieces of 0.2 s of pcm16-24k. */
const TONE_BYTES = 28_800;

type Counters = { pieces: number; speaking: string[]; overlap: number; cut: number };
type CardView = { id: string; kind: string; pluginId?: string };

export async function voiceModeClause(ctx: ExampleCtx): Promise<string[]> {
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  let chosen = false;
  let long = false;
  const counters = async (): Promise<Counters | undefined> => {
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "(() => { const d = document.documentElement.dataset; return d.voicePieces === undefined ? null : JSON.stringify({ pieces: +d.voicePieces, speaking: (d.voiceSpeaking || '').split(',').filter(Boolean), overlap: +(d.voiceOverlap || 0), cut: +(d.voiceCut || 0) }); })()").catch(() => null);
      if (typeof v === "string") return JSON.parse(v) as Counters;
    }
    return undefined;
  };
  const run = async <T>(name: string): Promise<T> => (await rpc.request<{ result: T }>("command.run", { name, args: {} }, 30_000)).result;
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
  /** Settings › Voice, the user's way: the gear, the Voice section, its select set to `name`'s option; then closed. */
  const choose = async (name: string) => {
    await clickTree(cdp, "the Settings button", "button[aria-label=Settings]");
    await clickTree(cdp, "the Settings window's Voice section", "button.cl-settings__section", "Voice");
    const picked = await until(`the Active voice select offering ${name}`, 20_000, async () => {
      for (const d of await treeDocs(cdp)) {
        const r = await cdp.evaluate(d.session, `(() => {
          const s = document.querySelector('select[aria-label="Active voice"]');
          if (!s) return null;
          const o = [...s.options].find((x) => x.textContent === ${JSON.stringify(name)});
          if (!o) return null;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return o.value;
        })()`).catch(() => null);
        if (typeof r === "string") return r;
      }
      return undefined;
    });
    for (const d of await treeDocs(cdp)) for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined);
    await sleep(300);
    return picked;
  };
  /** A record of the player's counters as they change (the tree document's root), for a failure's dump. */
  const record = async () => {
    for (const d of await treeDocs(cdp)) {
      await cdp.evaluate(d.session, "(() => { const e = document.documentElement; if (e.dataset.voicePieces === undefined || window.__vq) return false; const t0 = Date.now(); window.__vq = []; const note = () => { const d = e.dataset; window.__vq.push([Date.now() - t0, +d.voicePieces, d.voiceSpeaking || '-', +(d.voiceCut || 0)].join(' ')); if (window.__vq.length > 200) window.__vq.shift(); }; note(); new MutationObserver(note).observe(e, { attributes: true }); return true; })()").catch(() => undefined);
    }
  };
  const dump = async () => {
    let seen = "";
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "window.__vq ? window.__vq.join(' | ') : null").catch(() => null);
      if (typeof v === "string") seen = v;
    }
    const logs = (await rpc.request<{ lines: string[] }>("plugin.logs", { id: "clover/voice", lines: 20 }).catch(() => ({ lines: [] as string[] }))).lines.join(" | ");
    return `${JSON.stringify(await counters())}; player (ms pieces speaking cut): ${seen.slice(-1200)}; Clover Voice's log: ${logs.slice(-1200)}; app: ${ctx.appLog().split("\n").filter((l) => /voice/i.test(l)).slice(-8).join(" | ").slice(-1500)}`;
  };
  const active = async () => (await rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: "clover/voice" })).settings.find((s) => s.key === "active")?.value;
  try {
    // The third party's voice mode, its OK card saying what it can do.
    const ok = await install(MODE_DIR, MODE_ID);
    if (!ok.includes(VOICE_MODE_OK_LINE)) fail(`${MODE_ID}'s OK card lacks "${VOICE_MODE_OK_LINE}": ${ok.slice(0, 400)}`);
    done.push(`${MODE_ID}'s OK card says "${VOICE_MODE_OK_LINE}"`);
    const sink = await run<{ refused?: string; sounded?: boolean }>(`${MODE_ID}.sink`);
    if (sink.refused === undefined || !sink.refused.includes("isn't the active voice")) fail(`not chosen, ${MODE_ID} reached the player itself: ${JSON.stringify(sink)}`);
    done.push(`not chosen, it was refused the player ("${sink.refused}")`);

    // A plugin's sound offered while Alpha's reply sounds: Clover Voice plays it after, and her reply is never cut. Her
    // voice is the tone's long one for this (2.5 s), so the sound is offered well inside her reply.
    await rpc.request("bot.setUserLayer", { id: "alpha", patch: { voice: { provider: "acceptance-voice", voice: "long" } } });
    long = true;
    await record();
    const before = await until("the shell's voice counters", 20_000, counters);
    const replied = say("Say something for the queue.");
    let offered: Counters | undefined;
    for (let i = 0; i < 3 && offered === undefined; i++) {
      const start = (await counters())!;
      const deadline = Date.now() + 120_000;
      let sounding = false;
      while (Date.now() < deadline) {
        const c = await counters();
        if (c !== undefined && c.speaking.includes("alpha") && c.pieces > start.pieces) {
          sounding = true;
          break;
        }
        await sleep(25);
      }
      if (!sounding) fail(`Alpha's reply never sounded: ${await dump()}`);
      await run(`${MODE_ID}.chime`);
      const now = (await counters())!;
      // The sound must have been offered while she still spoke, or the order proves nothing: again, with a new reply.
      if (now.speaking.includes("alpha")) offered = now;
      else if (i < 2) await say("Say something again.");
    }
    const offeredAt = offered ?? fail("Alpha's reply ended each time before the sound was offered: the queue went unproven");
    await replied;
    const after = await until("the sound played after her reply", 30_000, async () => {
      const c = await counters();
      return c !== undefined && c.pieces > offeredAt.pieces && c.speaking.length === 0 ? c : undefined;
    }, dump);
    await rpc.request("bot.setUserLayer", { id: "alpha", patch: { voice: { provider: "acceptance-voice", voice: "tone" } } });
    long = false;
    if (after.cut !== before.cut) fail(`the sound cut Alpha's reply off (data-voice-cut ${before.cut} → ${after.cut}): it didn't wait its turn; ${await dump()}`);
    if (after.overlap > 1) fail(`two bots sounded at once (data-voice-overlap ${after.overlap})`);
    done.push(`a chime offered while Alpha's reply sounded played after it (${after.pieces - offeredAt.pieces} more piece(s)), her reply never cut (data-voice-cut ${after.cut}), and no two bots sounded at once (data-voice-overlap ${after.overlap})`);

    // Chosen in Settings › Voice: the third party's mode says Alpha's next reply.
    const value = await choose("Acceptance voice mode");
    chosen = true;
    await until(`clover/voice's active setting = ${MODE_ID}`, 10_000, async () => ((await active()) === MODE_ID ? true : undefined), async () => `it reads ${JSON.stringify(await active())} (the select chose ${value})`);
    const heard = (await run<{ replies: string[]; bytes: number }>(`${MODE_ID}.report`)).replies.length;
    const p0 = (await counters())!;
    await say("Say it in the other voice.");
    const r = await until(`${MODE_ID} saying Alpha's reply`, 30_000, async () => {
      const x = await run<{ replies: string[]; bytes: number }>(`${MODE_ID}.report`);
      return x.replies.length > heard ? x : undefined;
    });
    const p1 = await until("its pieces at the player", 20_000, async () => {
      const c = await counters();
      return c !== undefined && c.pieces > p0.pieces && c.speaking.length === 0 ? c : undefined;
    });
    if (r.bytes < TONE_BYTES) fail(`${MODE_ID} got ${r.bytes} bytes from Alpha's provider, fewer than the tone's ${TONE_BYTES}`);
    done.push(`chosen in Settings › Voice, ${MODE_ID} said Alpha's reply through her provider (${r.bytes} bytes, ${p1.pieces - p0.pieces} piece(s) at the player)`);

    // Clover Voice again: the third party's mode is refused the player once more.
    await choose("Clover Voice");
    await until("clover/voice's active setting back to empty", 10_000, async () => ((await active()) === "" ? true : undefined));
    chosen = false;
    const again = await run<{ refused?: string }>(`${MODE_ID}.sink`);
    if (again.refused === undefined) fail(`with Clover Voice chosen again, ${MODE_ID} still reached the player`);
    done.push("Clover Voice chosen again, the third party's mode was refused the player again");

    // A plain plugin with voices.use, and its child without.
    const nok = await install(NARRATOR_DIR, NARRATOR_ID);
    if (!nok.includes("can ask your voice providers to speak or transcribe")) fail(`${NARRATOR_ID}'s OK card doesn't say it may use the voice providers: ${nok.slice(0, 400)}`);
    const p2 = (await counters())!;
    const n = await run<{ providers?: string[]; bytes?: number; error?: string }>(`${NARRATOR_ID}.narrate`);
    if (n.bytes !== TONE_BYTES || !(n.providers ?? []).includes("acceptance-voice")) fail(`the narrator's ask came back ${JSON.stringify(n)}; wanted ${TONE_BYTES} bytes from acceptance-voice`);
    await sleep(1_000);
    if ((await counters())!.pieces !== p2.pieces) fail("the narrator's audio reached the player: it is the plugin's data, never played");
    const nosy = await run<{ error?: string }>(`${NARRATOR_ID}.nosy`);
    if (nosy.error === undefined || !nosy.error.includes("voices.use")) fail(`the child with no voices.use got ${JSON.stringify(nosy)}`);
    done.push(`a plugin with voices.use (its OK says so) got the tone back as its own data (${n.bytes} bytes, nothing played); its child without was refused ("${nosy.error}")`);
    return done;
  } finally {
    if (chosen) await rpc.request("plugin.settings.set", { id: "clover/voice", key: "active", value: null }).catch(() => undefined);
    if (long) await rpc.request("bot.setUserLayer", { id: "alpha", patch: { voice: { provider: "acceptance-voice", voice: "tone" } } }).catch(() => undefined);
    await leave(ctx, NARRATOR_ID);
    await leave(ctx, MODE_ID);
  }
}
