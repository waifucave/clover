// Clover Voice's host half (spec §6.6), built on general capabilities only:
// * It hears the bots' replies through its `message.out` hook, an observer (it changes nothing and the replies keep
//   streaming), and each turn's end through `turn.end`: when a bot's main conversation ends a turn with a reply, that
//   reply is spoken in the bot's voice, unless its "Speak replies" setting is off.
// * A bot's voice is this plugin's own setting for that bot (`provider`, `voice`, `model`, bot scope). The provider is
//   an entry of its own point, `clover.voice.providers` (Fish Audio fills it from its own folder): its `speak` handler
//   answers with the audio as it is made (`points.stream`), and this streams it to the plugin's background part, the
//   player (`streams.open("speech")`), which takes the device's speech turn, plays it and moves the bot's mouth.
// * A voice mode another plugin offers (its entry on `clover.voice.modes`), when the user chose it in Settings › Voice
//   (the `active` setting), says the replies instead: its `reply` handler is handed the reply and speaks it its own way.
// * Its ui table: `speak` (the speak button under a reply, `conversation.message.action`) and `stop` (the stage's chip).
// * Push-to-talk (the listening half, until it is re-founded too): the core's voice slot hands the user's audio to this
//   plugin's `voiceModes` handler, which feeds the bot's provider (`voices.listen`) and holds the player meanwhile.
import type { HostPluginApi, HookInput, PointEntry } from "@waifucave/clover-plugin-sdk";

export const PROVIDERS = "clover.voice.providers";
export const MODES = "clover.voice.modes";
/** The stream to the player. */
export const SPEECH = "speech";

/** A bot's voice, from this plugin's settings. */
export interface BotVoice { provider: string; voice: string; model?: string }

let api: HostPluginApi | undefined;
let count = 0;
/** Each session's last reply, as stored (the `message.out` observer), spoken at its turn's end. */
const lastReply = new Map<string, string>();
/** What stops each bot's provider stream now. */
const speaking = new Map<string, Set<AbortController>>();
/** The push-to-talk utterances being heard: the provider's listening, its id, and what it heard. */
const hearing = new Map<string, { id: string; close: () => void; heard: Promise<string> }>();

const need = (): HostPluginApi => {
  if (api === undefined) throw new Error("Clover Voice hasn't started");
  return api;
};
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const log = (line: string) => console.error(`voice: ${line}`);

export function start(given: HostPluginApi): void {
  api = given;
  lastReply.clear();
  speaking.clear();
  hearing.clear();
}

/** A bot's voice now, or undefined (text-only). */
export async function voiceOf(bot: string): Promise<BotVoice | undefined> {
  const a = need();
  const [provider, voice, model] = await Promise.all([
    a.settings.get<string>("provider", { bot }), a.settings.get<string>("voice", { bot }), a.settings.get<string>("model", { bot }),
  ]);
  if (typeof provider !== "string" || provider === "" || typeof voice !== "string" || voice === "") return undefined;
  return { provider, voice, ...(typeof model === "string" && model !== "" ? { model } : {}) };
}

/** The voice mode the user chose, when it is another plugin's and it is on. */
async function chosenMode(): Promise<PointEntry | undefined> {
  const a = need();
  const active = await a.settings.get<string>("active").catch(() => undefined);
  if (typeof active !== "string" || active === "" || active === a.plugin.id) return undefined;
  return (await a.points.entries(MODES).catch(() => [])).find((e) => e.pluginId === active);
}

type Said = { speaking: true } | { speaking: false; note: string };

/** Says `text` in `bot`'s voice: through the user's chosen voice mode, or the provider's audio to the player. */
export async function say(o: { bot: string; session: string; text: string; asked: boolean }): Promise<Said> {
  const a = need();
  const voice = await voiceOf(o.bot);
  if (voice === undefined) return { speaking: false, note: "This bot has no voice. Choose one in its settings to hear its replies." };
  const mode = await chosenMode();
  if (mode !== undefined) {
    await a.points.call(MODES, mode, "reply", { bot: o.bot, session: o.session, text: o.text, asked: o.asked });
    return { speaking: true };
  }
  const provider = (await a.points.entries<{ name?: string }>(PROVIDERS)).find((e) => e.entryId === voice.provider);
  if (provider === undefined) return { speaking: false, note: "Its voice plugin isn't installed or is turned off, so this reply can't be spoken." };
  const abort = new AbortController();
  const mine = speaking.get(o.bot) ?? new Set<AbortController>();
  speaking.set(o.bot, mine);
  mine.add(abort);
  const utterance = `cv_${Date.now().toString(36)}_${(++count).toString(36)}`;
  try {
    const audio = await a.points.stream(PROVIDERS, provider, "speak", { text: o.text, voice: voice.voice, ...(voice.model === undefined ? {} : { model: voice.model }), format: "pcm16-24k" }, { signal: abort.signal });
    const out = await a.streams.open(SPEECH, { meta: { bot: o.bot, session: o.session, utterance, asked: o.asked }, signal: abort.signal });
    let bytes = 0;
    void audio.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (c, ctl) => { bytes += c.length; ctl.enqueue(c); } }))
      .pipeTo(out, { signal: abort.signal })
      .then(() => log(`${o.bot}'s ${o.asked ? "asked " : ""}reply spoken by ${voice.provider} (${bytes} bytes)`), (err: unknown) => {
        if (!abort.signal.aborted) log(`${o.bot}'s reply wasn't spoken whole: ${reason(err)}`);
      })
      .finally(() => mine.delete(abort));
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

/** Stops what `bot` says now: its provider streams, and the player (the stage's chip). */
function stopBot(bot: string): void {
  for (const c of speaking.get(bot) ?? []) c.abort();
  speaking.delete(bot);
  api?.ui.send("stop", { bot });
}

/** The plugin's ui table (`host.call`): the speak button's `speak`, the chip's `stop`. */
export const ui = {
  /** One past reply, the user's press (`conversation.message.action`: `{ session, seq }`). */
  async speak(args: unknown): Promise<{ ok: true } | { note: string }> {
    const a = need();
    const p = args as { session?: unknown; seq?: unknown } | null;
    const session = p?.session, seq = p?.seq;
    if (typeof session !== "string" || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return { note: "Nothing to speak." };
    const conv = a.conversation;
    if (conv?.get === undefined || conv.history === undefined) return { note: "Clover Voice can't read the conversation here." };
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

/** A watch's unsubscribe: the function itself in a plugin host, or a promise of it where a call answers late. */
const unsubscriber = (r: unknown): (() => void) => {
  if (typeof r === "function") return r as () => void;
  let stopped = false;
  let off: (() => void) | undefined;
  void Promise.resolve(r).then((f) => {
    if (typeof f !== "function") return;
    off = f as () => void;
    if (stopped) off();
  }, () => undefined);
  return () => {
    stopped = true;
    off?.();
  };
};

/** The listening half (`voiceModes`' `handler: "voice"`), as the core's voice slot calls it on push-to-talk. */
export const voice = {
  /** Whether a push-to-talk for `bot` would be heard: it has a voice whose provider listens. */
  async listens(args: { bot: string }): Promise<boolean> {
    const v = await voiceOf(args.bot);
    if (v === undefined) return false;
    const providers = await need().voices?.providers().catch(() => []);
    return (providers ?? []).some((p) => p.id === v.provider && p.listen);
  },
  async listenStart(args: { bot: string; utterance: string; format: "pcm16-16k" | "opus" }): Promise<void> {
    const a = need();
    const v = await voiceOf(args.bot);
    if (v === undefined) throw new Error(`${args.bot} has no voice; it is text-only`);
    // The user talks: whatever sounds stops, and nothing starts until they let go.
    a.ui.send("hold", { utterance: args.utterance, on: true });
    const id = `cl_${(++count).toString(36)}`;
    let close = () => {};
    const heard = new Promise<string>((resolve, reject) => {
      close = unsubscriber(a.voices!.listen(v.provider, { id, format: args.format }, (e) => {
        if (e.text !== undefined) resolve(e.text);
        else reject(new Error(e.error ?? "the voice heard nothing"));
      }));
    });
    heard.catch(() => undefined);
    hearing.set(args.utterance, { id, close, heard });
  },
  async listenPiece(args: { bot: string; utterance: string; data: Uint8Array; final: boolean }): Promise<{ text?: string }> {
    const h = hearing.get(args.utterance);
    if (h === undefined) throw new Error(`no push-to-talk ${args.utterance} is being heard`);
    await need().voices!.feed(h.id, args.data, args.final);
    if (!args.final) return {};
    try {
      return { text: await h.heard };
    } finally {
      hearing.delete(args.utterance);
      h.close();
      api?.ui.send("hold", { utterance: args.utterance, on: false });
    }
  },
  async listenEnd(args: { bot: string; utterance: string }): Promise<void> {
    const h = hearing.get(args.utterance);
    hearing.delete(args.utterance);
    h?.close();
    api?.ui.send("hold", { utterance: args.utterance, on: false });
  },
};
