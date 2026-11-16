// MOSS Voice's host half (spec §6.6), built on general capabilities only:
// * It hears the bots' replies through its `message.out` hook, an observer (it changes nothing and the replies keep
//   streaming), and each turn's end through `turn.end`: when a bot's main conversation ends a turn with a reply, that
//   reply is spoken in the bot's voice, unless its "Speak replies" setting is off (as the core did before: at the turn's
//   end, the last reply).
// * A bot's voice is the user's choice, this plugin's own setting for that bot (`provider`, `voice`, `model`, bot
//   scope); else the default the plugin that brings the bot gives on this plugin's point `moss.voice.defaults` (only for its own
//   bot; the user's choice always wins). A default voice speaks only when its provider says it is set up (its
//   `ready`; a provider with none doesn't count), and the bot's Voice section says why not. The user may also say "no
//   voice" for one bot (its `silent` setting): nothing of it is spoken or heard. A provider is found by its plugin and
//   its entry id, so another plugin's entry of the same name never gets the text.
// * The provider is an entry of its own point, `moss.voice.providers` (Fish Audio fills it from its own folder): its
//   `speak` handler answers with the audio as it is made (`points.stream`), and this streams it to the plugin's
//   background part, the player (`streams.open("speech")`), which takes the device's speech turn, plays it and moves
//   the bot's mouth.
// * Which voice speaks and hears is the platform's pick on this plugin's own point `moss.voice.modes`, one at a time
//   (P4, titled "Voice"): the user's pick in Settings, else MOSS Voice, which fills it itself. When the active one is
//   another plugin's, it is handed the reply (`reply`) and speaks it its own way, and push-to-talk's recording (`hear`).
// * Its ui table: `speak` (the speak button under a reply, `conversation.message.action`), `stop` (the stage's chip),
//   `voiceOf`/`forget` (a bot's voice for its parts) and `ready` (the player, once it accepts speech).
// * The player's controls go as `ui.send` messages that carry the whole state (`holds`: the utterances push-to-talk
//   holds; `stops`: each bot's stop count), so the newest message of each is all a part needs.
// * Push-to-talk: this plugin's own talk button (`composer.action`) records and streams the audio here (`talk`); the
//   active voice writes it down (another plugin's `hear`, else the bot's provider's `listen`), the player held meanwhile,
//   and the button sends the words as the user's message. Its held key binding (`push-to-talk`, Ctrl+Shift+Space) holds
//   the button from the keyboard: its down and up are passed on to the button.
import type { HostPluginApi, HookInput, PointEntry } from "@waifucave/moss-plugin-sdk";

export const PROVIDERS = "moss.voice.providers";
export const MODES = "moss.voice.modes";
/** The default voice a plugin gives the bot it brings. */
export const DEFAULTS = "moss.voice.defaults";
/** The stream to the player. */
export const SPEECH = "speech";
/** How long a provider's `ready` answer is kept. */
export const READY_TTL_MS = 60_000;

/** A bot's voice: the user's choice (`user`), or the default from the plugin that brings it (`bot`). `plugin`: the
 *  provider entry's plugin, when it was named. */
export interface BotVoice { provider: string; plugin?: string; voice: string; model?: string; from: "user" | "bot" }

let api: HostPluginApi | undefined;
let count = 0;
/** Each session's last reply, as stored (the `message.out` observer), spoken at its turn's end. */
const lastReply = new Map<string, string>();
/** What stops each bot's provider stream now. */
const speaking = new Map<string, Set<AbortController>>();
/** The player's state: the utterances push-to-talk holds, and each bot's stop count (only goes up). */
const holds = new Set<string>();
const stops: Record<string, number> = {};
/** Each provider's last `ready` answer, by its plugin and entry id. */
const readiness = new Map<string, { at: number; ready: boolean; why?: string }>();
/** The player said it accepts speech. */
let playerReady: Promise<void> = Promise.resolve();
let readied: (() => void) | undefined;

const need = (): HostPluginApi => {
  if (api === undefined) throw new Error("MOSS Voice hasn't started");
  return api;
};
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const log = (line: string) => console.error(`voice: ${line}`);
const topOf = (id: string): string => id.split("/")[0]!;

export function start(given: HostPluginApi): void {
  api = given;
  talks.clear();
  // The talk button's recordings (its own part's streams).
  try {
    void Promise.resolve(given.streams.accept("talk", (stream, meta) => acceptTalk(stream, meta))).catch(() => undefined);
  } catch {
    /* no streams here (a test's fake) */
  }
  lastReply.clear();
  speaking.clear();
  holds.clear();
  for (const k of Object.keys(stops)) delete stops[k];
  readiness.clear();
  playerReady = new Promise<void>((r) => { readied = r; });
}

const named = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** A bot's voice as chosen, whether or not the user turned the bot's voice off: the user's choice, else the default
 *  from the plugin that brings it. */
export async function voiceChoice(bot: string): Promise<BotVoice | undefined> {
  const a = need();
  const [provider, plugin, voice, model] = await Promise.all([
    a.settings.get<string>("provider", { bot }), a.settings.get<string>("providerPlugin", { bot }), a.settings.get<string>("voice", { bot }), a.settings.get<string>("model", { bot }),
  ]);
  if (named(provider) !== undefined && named(voice) !== undefined) {
    // A pick is tied to the plugin whose entry it named, recorded the first time it is read (a settings watch doesn't
    // say which bot changed): later, another plugin's entry of the same id never takes it over.
    let tied = named(plugin);
    if (tied === undefined) {
      const offering = (await a.points.entries(PROVIDERS).catch(() => [])).filter((e) => e.entryId === provider);
      if (offering.length === 1) {
        tied = offering[0]!.pluginId;
        await a.settings.set("providerPlugin", tied, { bot }).catch(() => undefined);
      }
    }
    return { provider: provider!, ...(tied !== undefined ? { plugin: tied } : {}), voice: voice!, ...(named(model) ? { model: model! } : {}), from: "user" };
  }
  // Only the bot's own plugin (its tree) speaks for its default.
  const own = (await a.points.entries<{ provider?: unknown; plugin?: unknown; voice?: unknown; model?: unknown }>(DEFAULTS).catch(() => [])).find((e) => topOf(e.pluginId) === topOf(bot));
  const v = own?.value;
  if (v === undefined || named(v.provider) === undefined || named(v.voice) === undefined) return undefined;
  return { provider: v.provider as string, ...(named(v.plugin) ? { plugin: v.plugin as string } : {}), voice: v.voice as string, ...(named(v.model) ? { model: v.model as string } : {}), from: "bot" };
}

/** Whether the user said "no voice" for this bot. */
export async function silent(bot: string): Promise<boolean> {
  return (await need().settings.get<boolean>("silent", { bot }).catch(() => false)) === true;
}

/** A bot's voice now, or undefined (text-only: none chosen, or the user turned it off for this bot). */
export async function voiceOf(bot: string): Promise<BotVoice | undefined> {
  return (await silent(bot)) ? undefined : voiceChoice(bot);
}

/** The provider entry a voice names: by its plugin when named, else the one entry with that id (two plugins' entries of
 *  the same id and no plugin named: none, so the text never goes to the wrong one). */
export async function providerOf(v: BotVoice): Promise<{ entry?: PointEntry<{ name?: string; ready?: unknown }>; note?: string }> {
  const all = (await need().points.entries<{ name?: string; ready?: unknown }>(PROVIDERS).catch(() => [])).filter((e) => e.entryId === v.provider && (v.plugin === undefined || e.pluginId === v.plugin));
  if (all.length === 1) return { entry: all[0]! };
  if (all.length === 0) return { note: "Its voice plugin isn't installed or is turned off." };
  return { note: `More than one plugin offers a voice provider "${v.provider}"; choose which in the bot's voice.` };
}

const readyKey = (e: PointEntry): string => `${e.pluginId}\u0000${e.entryId}`;

/** Whether a provider is set up (its key or sign-in in its own settings), by its optional `ready` handler; one without
 *  it says nothing, and is taken as set up. */
export async function providerReady(entry: PointEntry<{ ready?: unknown }>): Promise<{ ready: boolean; why?: string }> {
  // A provider that doesn't say: not set up, for a default (a bot's plugin may not spend the user's account on a guess).
  if (typeof entry.value.ready !== "string") return { ready: false, why: "it doesn't say whether you set it up, so a bot's default voice doesn't use it; choose the voice yourself to use it" };
  const kept = readiness.get(readyKey(entry));
  if (kept !== undefined && Date.now() - kept.at < READY_TTL_MS) return kept;
  let got: { ready: boolean; why?: string };
  try {
    const r = (await need().points.call(PROVIDERS, entry, "ready", {})) as { ready?: unknown; why?: unknown } | undefined;
    got = r?.ready === false ? { ready: false, why: typeof r.why === "string" ? r.why.slice(0, 300) : "its provider isn't set up" } : { ready: true };
  } catch (err) {
    got = { ready: false, why: reason(err) };
  }
  readiness.set(readyKey(entry), { at: Date.now(), ...got });
  return got;
}

/** The voice the user picked: the active entry of this plugin's modes point (one at a time, Settings' picker; MOSS
 *  Voice's own entry by default). Another plugin's: its entry (`reply` and `hear` are its own to offer). */
async function activeMode(): Promise<{ other: false } | { other: true; mode: PointEntry<{ reply?: unknown; hear?: unknown }> | undefined }> {
  const a = need();
  const active = await a.points.active(MODES).catch(() => undefined);
  if (active === undefined || active.pluginId === a.plugin.id) return { other: false };
  return { other: true, mode: (await a.points.entries<{ reply?: unknown; hear?: unknown }>(MODES).catch(() => [])).find((e) => e.pluginId === active.pluginId && e.entryId === active.entryId) };
}

/** The most a push-to-talk recording may hold: 60 s of 16 kHz 16-bit mono. */
export const TALK_MAX_BYTES = 60 * 16_000 * 2;
type Hearing = { ok: true; text: string } | { ok: false; note: string };

/** Whether push-to-talk for `bot` would be heard now: the voice picked hears (another plugin's mode offers `hear`), or
 *  MOSS Voice's own: the bot has a voice (not turned off) whose provider listens, and a default's provider is set up. */
export async function listensFor(bot: string): Promise<boolean> {
  const picked = await activeMode();
  if (picked.other) return typeof picked.mode?.value.hear === "string";
  const v = await voiceOf(bot);
  if (v === undefined) return false;
  const found = await providerOf(v);
  if (found.entry === undefined || typeof (found.entry.value as { listen?: unknown }).listen !== "string") return false;
  return v.from === "user" || (await providerReady(found.entry)).ready;
}

/** What the user said with push-to-talk, as words: the voice picked writes it down (another plugin's `hear`, or the bot's
 *  provider's `listen` for MOSS Voice's own). */
export async function transcribe(o: { bot: string; audio: Uint8Array }): Promise<Hearing> {
  const a = need();
  if (o.audio.length === 0) return { ok: false, note: "Nothing was heard." };
  const picked = await activeMode();
  if (picked.other) {
    if (typeof picked.mode?.value.hear !== "string") return { ok: false, note: "The voice picked in Settings doesn't listen." };
    const r = (await a.points.call(MODES, picked.mode, "hear", { bot: o.bot, audio: o.audio, format: "pcm16-16k" })) as { text?: unknown } | undefined;
    return typeof r?.text === "string" ? { ok: true, text: r.text } : { ok: false, note: "The voice heard nothing." };
  }
  if (!(await listensFor(o.bot))) return { ok: false, note: "This bot's voice doesn't listen." };
  const v = (await voiceOf(o.bot))!;
  const entry = (await providerOf(v)).entry!;
  const r = (await a.points.call(PROVIDERS, entry, "listen", { audio: o.audio, format: "pcm16-16k" })) as { text?: unknown } | undefined;
  return typeof r?.text === "string" ? { ok: true, text: r.text } : { ok: false, note: "The voice heard nothing." };
}

/** Push-to-talk's recordings from this plugin's own talk button, by utterance: what each was heard as, once its stream
 *  ended (the button asks `heard` for it). */
const talks = new Map<string, Promise<Hearing>>();

/** A recording from the talk button (`streams.accept("talk")`, meta `{ bot, utterance }`): the player holds while it
 *  lasts; its bytes, at most TALK_MAX_BYTES, are written down when it ends. */
function acceptTalk(stream: ReadableStream<Uint8Array>, meta: Record<string, unknown>): void {
  const bot = typeof meta.bot === "string" ? meta.bot : undefined;
  const utterance = typeof meta.utterance === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(meta.utterance) ? meta.utterance : undefined;
  if (bot === undefined || utterance === undefined) {
    void stream.cancel("a recording names its bot and its utterance").catch(() => undefined);
    return;
  }
  hold(utterance, true);
  const done = (async (): Promise<Hearing> => {
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        size += value.length;
        if (size > TALK_MAX_BYTES) {
          void reader.cancel("too long").catch(() => undefined);
          return { ok: false, note: "That was longer than a minute; hold to talk for less." };
        }
        parts.push(value);
      }
    } catch (err) {
      return { ok: false, note: `The recording stopped: ${reason(err)}` };
    } finally {
      hold(utterance, false);
    }
    const audio = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      audio.set(p, at);
      at += p.length;
    }
    try {
      return await transcribe({ bot, audio });
    } catch (err) {
      return { ok: false, note: `The voice couldn't write it down: ${reason(err)}` };
    }
  })();
  talks.set(utterance, done);
  // Forgotten a while after it is answered, or if nobody asks.
  void done.then(() => setTimeout(() => { if (talks.get(utterance) === done) talks.delete(utterance); }, 60_000));
}

type Said = { speaking: true } | { speaking: false; note: string };

/** Opens the stream to the player; once more after it says it accepts speech, when its frame was still loading. */
async function openSpeech(meta: Record<string, unknown>, signal: AbortSignal): Promise<WritableStream<Uint8Array>> {
  const a = need();
  try {
    return await a.streams.open(SPEECH, { meta, signal });
  } catch {
    await Promise.race([playerReady, new Promise((r) => setTimeout(r, 10_000))]);
    return await a.streams.open(SPEECH, { meta, signal });
  }
}

/** Says `text` in `bot`'s voice: through the voice mode the user picked, or the provider's audio to the player. */
export async function say(o: { bot: string; session: string; text: string; asked: boolean }): Promise<Said> {
  const a = need();
  const picked = await activeMode();
  if (picked.other) {
    if (typeof picked.mode?.value.reply !== "string") return { speaking: false, note: "The voice picked in Settings doesn't speak replies through MOSS Voice." };
    await a.points.call(MODES, picked.mode, "reply", { bot: o.bot, session: o.session, text: o.text, asked: o.asked });
    return { speaking: true };
  }
  const voice = await voiceOf(o.bot);
  if (voice === undefined) return { speaking: false, note: "This bot has no voice. Choose one in its settings to hear its replies." };
  const found = await providerOf(voice);
  const provider = found.entry;
  if (provider === undefined) return { speaking: false, note: `${found.note ?? "Its voice plugin isn't installed or is turned off."} This reply can't be spoken.` };
  // A default voice speaks only with a provider the user set up.
  if (voice.from === "bot") {
    const r = await providerReady(provider);
    if (!r.ready) return { speaking: false, note: `${provider.value.name ?? voice.provider} isn't set up: ${r.why ?? ""}` };
  }
  const abort = new AbortController();
  const mine = speaking.get(o.bot) ?? new Set<AbortController>();
  speaking.set(o.bot, mine);
  mine.add(abort);
  const utterance = `cv_${Date.now().toString(36)}_${(++count).toString(36)}`;
  try {
    const audio = await a.points.stream(PROVIDERS, provider, "speak", { text: o.text, voice: voice.voice, ...(voice.model === undefined ? {} : { model: voice.model }), format: "pcm16-24k" }, { signal: abort.signal });
    const out = await openSpeech({ bot: o.bot, session: o.session, utterance, asked: o.asked }, abort.signal);
    // The provider's bytes to the player as they come; the player's own pace holds the provider back (back-pressure).
    const reader = audio.getReader();
    const writer = out.getWriter();
    abort.signal.addEventListener("abort", () => {
      void reader.cancel("stopped").catch(() => undefined);
      void writer.abort("stopped").catch(() => undefined);
    }, { once: true });
    void (async () => {
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || abort.signal.aborted) break;
          bytes += value.length;
          await writer.write(value);
        }
        if (!abort.signal.aborted) await writer.close();
        log(`${o.bot}'s ${o.asked ? "asked " : ""}reply spoken by ${voice.provider} (${bytes} bytes)`);
      } catch (err) {
        if (!abort.signal.aborted) log(`${o.bot}'s reply wasn't spoken whole: ${reason(err)}`);
        void writer.abort(reason(err)).catch(() => undefined);
        void reader.cancel(reason(err)).catch(() => undefined);
      } finally {
        mine.delete(abort);
      }
    })();
    return { speaking: true };
  } catch (err) {
    mine.delete(abort);
    abort.abort();
    return { speaking: false, note: `Its voice couldn't speak this reply: ${reason(err)}` };
  }
}

/** The bots' replies (`hooks` entry `replies`, observe only): the stored reply, then the turn's end. */
export async function replies(input: HookInput): Promise<void> {
  const bot = input.bot;
  if (input.session.kind !== "bot" || bot === undefined) return;
  if (input.event === "message.out") {
    if (typeof input.text === "string" && input.text.trim() !== "") lastReply.set(input.session.id, input.text);
    return;
  }
  if (input.event !== "turn.end") return;
  // The stored reply's observer is never awaited: it may still be on its way.
  let text = lastReply.get(input.session.id);
  if (text === undefined && input.outcome === "completed") {
    await new Promise((r) => setTimeout(r, 100));
    text = lastReply.get(input.session.id) ?? input.text;
  }
  lastReply.delete(input.session.id);
  if (input.outcome !== "completed" || text === undefined || text.trim() === "") return;
  const a = need();
  if ((await a.settings.get<boolean>("speakReplies").catch(() => true)) === false) return;
  const said = await say({ bot, session: input.session.id, text, asked: false }).catch((err: unknown) => ({ speaking: false as const, note: reason(err) }));
  if (!said.speaking) log(`${bot}'s reply wasn't spoken: ${said.note}`);
}

/** Tells the player the utterances push-to-talk holds now (the whole state, `ui.send`). */
function sendHolds(): void {
  try {
    api?.ui.send("holds", { utterances: [...holds] });
  } catch {
    /* no part to tell */
  }
}

function hold(utterance: string, on: boolean): void {
  if (on) holds.add(utterance);
  else if (!holds.delete(utterance)) return;
  sendHolds();
}

/** Stops what `bot` says now: its provider streams, and the player (the stage's chip). */
function stopBot(bot: string): void {
  for (const c of speaking.get(bot) ?? []) c.abort();
  speaking.delete(bot);
  stops[bot] = (stops[bot] ?? 0) + 1;
  try {
    api?.ui.send("stops", { ...stops });
  } catch {
    /* no part to tell */
  }
}

/** Its command `push-to-talk`, Ctrl+Shift+Space held anywhere in the window (a held key binding, run only from its key:
 *  `{ key: "down" }` on the press, `{ key: "up" }` on the user's release, `{ key: "cancel" }` for a hold that ended with
 *  none): passed on to its talk buttons (`talk-down`, `talk-up`, `talk-cancel`), which hold to talk exactly as when the
 *  button is held, and drop the recording on a cancel as on a lost pointer. */
export function pushToTalk(args: unknown): { ok: boolean } {
  const key = (args as { key?: unknown } | null)?.key;
  if (key !== "down" && key !== "up" && key !== "cancel") return { ok: false };
  try {
    api?.ui.send(`talk-${key}`, {});
  } catch {
    /* no part to tell */
  }
  return { ok: true };
}

/** The plugin's ui table (`host.call`): the speak button's `speak`, the chip's `stop`, and a bot's voice for its
 *  parts (`voiceOf`, `forget`): a page reads and changes only its plugin's plain settings, a bot's value is the host
 *  half's. */
export const ui = {
  /** Whether push-to-talk for this bot would be heard now (the talk button shows only then), in its own conversation
   *  (`session`, when given, a bot's main conversation; not a side thread or an agent's tab). */
  async listens(args: unknown): Promise<boolean> {
    const p = args as { bot?: unknown; session?: unknown } | null;
    if (typeof p?.bot !== "string") return false;
    if (typeof p.session === "string") {
      const view = await need().conversation?.get?.(p.session).catch(() => undefined);
      if (view === undefined || view.kind !== "bot") return false;
    }
    return listensFor(p.bot).catch(() => false);
  },
  /** What a recording the talk button sent was heard as (it asks once its stream ended): `{ text }` or `{ note }`. */
  async heard(args: unknown): Promise<{ text: string } | { note: string }> {
    const utterance = (args as { utterance?: unknown } | null)?.utterance;
    const r = typeof utterance === "string" ? talks.get(utterance) : undefined;
    if (r === undefined) return { note: "That recording isn't here." };
    const h = await r;
    talks.delete(utterance as string);
    return h.ok ? { text: h.text } : { note: h.note };
  },
  /** A bot's voice, where it comes from, whether the user turned it off for this bot, and why a default can't speak
   *  when its provider isn't set up (or the provider can't be told apart). */
  async voiceOf(args: unknown): Promise<(Partial<BotVoice> & { why?: string; off?: true }) | null> {
    const bot = (args as { bot?: unknown } | null)?.bot;
    if (typeof bot !== "string") return null;
    const off = await silent(bot);
    const v = await voiceChoice(bot);
    if (v === undefined) return off ? { off: true } : null;
    const found = await providerOf(v);
    const why = found.entry === undefined ? found.note
      : v.from === "bot" ? await providerReady(found.entry).then((r) => (r.ready ? undefined : `${found.entry!.value.name ?? v.provider} isn't set up: ${r.why ?? ""}`))
        : undefined;
    return { ...v, ...(why === undefined ? {} : { why }), ...(off ? { off: true as const } : {}) };
  },
  /** The user's "no voice" for one bot (its Voice section's switch), kept as the user's own bot setting. */
  async setOff(args: unknown): Promise<{ ok: true }> {
    const p = args as { bot?: unknown; off?: unknown } | null;
    if (typeof p?.bot === "string" && typeof p.off === "boolean") await need().settings.set("silent", p.off ? true : null, { bot: p.bot });
    return { ok: true };
  },
  /** The player, mounted: it accepts speech now; what it should hold and each bot's stop count so far. */
  async ready(): Promise<{ holds: string[]; stops: Record<string, number> }> {
    readied?.();
    return { holds: [...holds], stops: { ...stops } };
  },
  /** The user's reset in a bot's editor: the bot goes text-only. */
  async forget(args: unknown): Promise<{ ok: true }> {
    const bot = (args as { bot?: unknown } | null)?.bot;
    if (typeof bot === "string") for (const key of ["provider", "providerPlugin", "voice", "model"]) await need().settings.set(key, null, { bot });
    return { ok: true };
  },
  /** One past reply, the user's press (`conversation.message.action`: `{ session, seq }`). */
  async speak(args: unknown): Promise<{ ok: true } | { note: string }> {
    const a = need();
    const p = args as { session?: unknown; seq?: unknown } | null;
    const session = p?.session, seq = p?.seq;
    if (typeof session !== "string" || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return { note: "Nothing to speak." };
    const conv = a.conversation;
    if (conv?.get === undefined || conv.history === undefined) return { note: "MOSS Voice can't read the conversation here." };
    const view = await conv.get(session).catch(() => undefined);
    if (view === undefined || view.kind !== "bot" || view.bot === undefined) return { note: "Only a bot's replies in its conversation are spoken." };
    const page = await conv.history(session, { before: seq + 1, limit: 1 }).catch(() => undefined);
    const record = (page as { events?: Record<string, unknown>[] } | undefined)?.events?.find((e) => e.seq === seq);
    const text = record?.type === "assistant_message" && typeof record.text === "string" ? record.text : undefined;
    if (text === undefined || text.trim() === "") return { note: "That isn't one of the bot's replies." };
    const said = await say({ bot: view.bot, session, text, asked: true });
    return said.speaking ? { ok: true } : { note: said.note };
  },
  /** The user's stop on a bot (the stage's chip while it speaks). */
  async stop(args: unknown): Promise<{ ok: true }> {
    const bot = (args as { bot?: unknown } | null)?.bot;
    if (typeof bot === "string") stopBot(bot);
    return { ok: true };
  },
};

