// The `voices` point in the core (spec §6.6): a bot's voice choice, its voice plugin, and the app's audio both ways.
// Owner: lane D. Voice runs on the device the user is talking on; only text crosses to the computer running the bot.
//
// * **Speaking:** the bot's voice (its user layer's, else its plugin's: `{ provider, voice, model }`) names a `voices`
//   entry by id. Its handler's `speak` is streamed through the plugin host (lane B's shape): each piece of audio goes to
//   the app as it arrives (`voice.play`, numbered, the last marked `final`), so the first words play while the rest is
//   still coming, and the avatar lip-syncs to it.
// * **Listening:** the app sends push-to-talk audio in pieces (`voice.listen`, numbered, the last `final`); they stream
//   into the handler's `listen` as the call's input, and the last piece's answer is what it heard.
// * A bot with no voice, or whose provider isn't installed or doesn't speak (or listen), is text-only: refused, with
//   why, and nothing breaks.
import type { TurnOrigin } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";

/** The bot's voice, as the bot service gives it. */
export interface BotVoice {
  provider: string;
  voice: string;
  model?: string;
}

export interface VoicePlay {
  bot: string;
  session: string;
  utterance: string;
  seq: number;
  /** Base64. */
  audio: string;
  format: "pcm16-24k" | "mp3" | "opus";
  final: boolean;
}

export interface VoiceServiceOptions {
  registry: Pick<PluginRegistry, "entries">;
  host: Pick<PluginHost, "stream">;
  /** A bot's voice now; undefined for a text-only bot. */
  voiceOf(bot: string): BotVoice | undefined;
  /** Sends `voice.play` to the app. */
  play(p: VoicePlay): Promise<void> | void;
  /** How long a listening utterance may wait for its next piece before it is dropped. */
  listenIdleMs?: number;
  /** Whether the bot may use its voice's provider now (lane D's provider check: a voice its plugin chose, on the
   *  user's stored voice key, asks the user once). A no refuses the call, with its reason. `at`: the session that
   *  speaks (speaking: the check reads that session's own turn origin, never one a caller passes), or the user's own
   *  origin (the user talking, `listen`). */
  mayUse?(bot: string, at: VoiceUse): Promise<{ ok: true } | { ok: false; reason: string }>;
  warn?: (message: string) => void;
}

/** Who is using a bot's voice: a session speaking (its own turn's origin decides), or the user talking to it. */
export type VoiceUse = { session: string; origin?: undefined } | { origin: "user"; session?: undefined; onAsk?: () => void };

interface Entry {
  pluginId: string;
  handler: string;
  speak: boolean;
  listen: boolean;
  /** The voice's name as its plugin gives it (the `voices` entry's `name`), for a note to the user. */
  name?: string;
}

/** A queue the app's pieces go into and the plugin's input reads out of. */
class Pieces implements AsyncIterable<Uint8Array> {
  readonly #items: Uint8Array[] = [];
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;
  push(piece: Uint8Array): void {
    this.#items.push(piece);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  /** Ends the input with an error, which the plugin's read throws. */
  fail(error: Error): void {
    this.#error = error;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.#error) throw this.#error;
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

interface Listening {
  bot: string;
  next: number;
  pieces: Pieces;
  result: Promise<{ text: string }>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

/** The most samples one `voice.play` piece carries: 1,500,000 bytes, exactly 2,000,000 characters of base64 (the
 *  method's limit), an even count, so a piece ends on a whole 16-bit sample. */
export const PIECE_BYTES = 1_500_000;

/** How long an utterance waits for its next piece by default before it is dropped. */
export const LISTEN_IDLE_MS = 30_000;

let utteranceCount = 0;

/** How long the user's `voice.speak` waits for the first piece before it answers that the voice is speaking. */
export const SPEAK_ASKED_WAIT_MS = 15_000;

/** A note for the user: one line, no control characters, at most 300 characters. */
function clip(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

export class VoiceService {
  readonly #o: VoiceServiceOptions;
  readonly #listening = new Map<string, Listening>();
  /** Each bot's utterance being spoken now: a new one, or `stop`, ends it. */
  readonly #speaking = new Map<string, AbortController>();

  constructor(opts: VoiceServiceOptions) {
    this.#o = opts;
  }

  #entry(provider: string): Entry {
    for (const c of this.#o.registry.entries("voices")) {
      if (c.state !== "active" || c.entryId !== provider) continue;
      const v = c.value as { handler?: unknown; speak?: unknown; listen?: unknown; name?: unknown };
      if (typeof v.handler !== "string") continue;
      const name = typeof v.name === "string" ? v.name : typeof (v.name as { en?: unknown } | undefined)?.en === "string" ? (v.name as { en: string }).en : undefined;
      return { pluginId: c.pluginId, handler: v.handler, speak: v.speak === true, listen: v.listen === true, ...(name === undefined ? {} : { name }) };
    }
    throw new ContractError("not_installed", `no voice plugin "${provider}" is installed; the bot is text-only`);
  }

  #voice(bot: string): BotVoice {
    const v = this.#o.voiceOf(bot);
    if (!v) throw new ContractError("refused", `${bot} has no voice; it is text-only`);
    return v;
  }

  async #mayUse(bot: string, at: VoiceUse): Promise<void> {
    const verdict = await this.#o.mayUse?.(bot, at);
    if (verdict !== undefined && !verdict.ok) throw new ContractError("refused", verdict.reason);
  }

  /** Speaks a bot's text on the app here, piece by piece. Resolves once the last piece was sent. */
  async speak(o: { bot: string; session: string; text: string; format?: VoicePlay["format"]; signal?: AbortSignal }): Promise<{ utterance: string; bytes: number }> {
    const voice = this.#voice(o.bot);
    // The speaking session's own turn decides: the check reads its origin from the session, and nothing a caller says
    // can make a routine's speech count as the user talking.
    await this.#mayUse(o.bot, { session: o.session });
    const entry = this.#entry(voice.provider);
    if (!entry.speak) throw new ContractError("refused", `the voice plugin "${voice.provider}" doesn't speak`);
    const { utterance, bytes } = await this.#say(o, voice, entry);
    return { utterance, bytes };
  }

  /** The user asked to hear one reply (`voice.speak`, their click): it is spoken over whatever the bot is saying, with
   *  the user's own provider check. Answers once the first piece went (`speaking: true`), or with a short note the part
   *  shows when nothing will be spoken. A voice still making its first piece after `waitMs` is answered `speaking:
   *  true`; how it ends is logged, as for any reply. */
  async speakAsked(o: { bot: string; session: string; text: string; waitMs?: number }): Promise<{ speaking: boolean; note?: string }> {
    const voice = this.#o.voiceOf(o.bot);
    if (!voice) return { speaking: false, note: "This bot has no voice. Choose one in its settings to hear its replies." };
    let entry: Entry;
    try {
      entry = this.#entry(voice.provider);
    } catch {
      return { speaking: false, note: "Its voice plugin isn't installed or is turned off, so this reply can't be spoken." };
    }
    if (!entry.speak) return { speaking: false, note: "Its voice plugin only listens; it doesn't speak." };
    // The user is asking: their own origin, as when they talk to the bot. A check that needs the user's answer on a card
    // never holds the call open: the answer comes at once, and the reply is spoken when they say yes.
    let asking!: () => void;
    const asked = new Promise<"asking">((resolve) => { asking = () => resolve("asking"); });
    const check = this.#o.mayUse?.(o.bot, { origin: "user", onAsk: () => asking() }) ?? Promise.resolve({ ok: true as const });
    const verdict = await Promise.race([check, asked]);
    if (verdict === "asking") {
      void check.then((v) => {
        if (v.ok) void this.#say(o, voice, entry).catch((err: unknown) => this.#o.warn?.(`${o.bot}'s reply wasn't spoken: ${err instanceof Error ? err.message : String(err)}`));
      }, (err: unknown) => this.#o.warn?.(`${o.bot}'s voice check failed: ${err instanceof Error ? err.message : String(err)}`));
      return { speaking: false, note: clip(`Answer the card to let ${entry.name?.trim() || voice.provider} speak.`) };
    }
    if (!verdict.ok) return { speaking: false, note: clip(verdict.reason) };
    let first!: () => void;
    const started = new Promise<"started">((resolve) => { first = () => resolve("started"); });
    const done = this.#say({ ...o, onFirstPiece: () => first() }, voice, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), o.waitMs ?? SPEAK_ASKED_WAIT_MS); });
    try {
      const r = await Promise.race([started, slow, done.then((d) => d, (err: unknown) => ({ err }))]);
      if (r === "started" || r === "slow") {
        done.catch((err: unknown) => this.#o.warn?.(`${o.bot}'s reply wasn't spoken whole: ${err instanceof Error ? err.message : String(err)}`));
        return { speaking: true };
      }
      if ("err" in r) return { speaking: false, note: clip(`Its voice couldn't speak this reply: ${r.err instanceof Error ? r.err.message : String(r.err)}`) };
      if (r.cut) return { speaking: false, note: "Stopped before it began." };
      return r.bytes > 0 ? { speaking: true } : { speaking: false, note: "Its voice sent no sound for this reply." };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The streaming itself, once the checks passed: one utterance per bot, each piece to the app, the last `final`. */
  async #say(o: { bot: string; session: string; text: string; format?: VoicePlay["format"]; signal?: AbortSignal; onFirstPiece?: () => void }, voice: BotVoice, entry: Entry): Promise<{ utterance: string; bytes: number; cut: boolean }> {
    const format = o.format ?? "pcm16-24k";
    const utterance = `u_${Date.now().toString(36)}_${(++utteranceCount).toString(36)}`;
    // One utterance per bot: a new one ends the one before (whose last piece then goes, `final`), and so does `stop`.
    this.#speaking.get(o.bot)?.abort();
    const mine = new AbortController();
    this.#speaking.set(o.bot, mine);
    const signal = o.signal === undefined ? mine.signal : AbortSignal.any([o.signal, mine.signal]);
    const gen = this.#o.host.stream<{ audio: Uint8Array }, unknown>({
      pluginId: entry.pluginId, handler: entry.handler, method: "speak", caller: { kind: "core" },
      args: { text: o.text, voice: voice.voice, ...(voice.model === undefined ? {} : { model: voice.model }), format },
    });
    let seq = 0;
    let bytes = 0;
    try {
      for (;;) {
        if (signal.aborted) {
          await gen.return(undefined);
          break;
        }
        const next = await gen.next();
        if (next.done) break;
        // Stopped while the plugin was making this piece: it isn't played.
        if (signal.aborted) {
          await gen.return(undefined);
          break;
        }
        const audio = next.value?.audio;
        if (!(audio instanceof Uint8Array)) continue;
        bytes += audio.length;
        // A piece is at most PIECE_BYTES of samples (`voice.play`'s 2 MB of base64), cut on whole 16-bit samples.
        for (let at = 0; at < audio.length; at += PIECE_BYTES) {
          const part = audio.subarray(at, at + PIECE_BYTES);
          await this.#o.play({ bot: o.bot, session: o.session, utterance, seq: seq++, audio: Buffer.from(part).toString("base64"), format, final: false });
          if (seq === 1) o.onFirstPiece?.();
        }
      }
    } finally {
      if (this.#speaking.get(o.bot) === mine) this.#speaking.delete(o.bot);
      // The last piece always goes, so the app knows the utterance is over, however it ended.
      await this.#o.play({ bot: o.bot, session: o.session, utterance, seq: seq++, audio: "", format, final: true });
    }
    return { utterance, bytes, cut: signal.aborted };
  }

  /** The user's `voice.stop`: ends the bot's utterance now, if one is being spoken. */
  stop(bot: string): void {
    this.#speaking.get(bot)?.abort();
  }

  /** One piece of push-to-talk audio (`voice.listen`). The last piece's answer is what was heard. */
  async listen(p: { bot: string; utterance: string; seq: number; audio: string; format: "pcm16-16k" | "opus"; final: boolean }): Promise<{ text?: string }> {
    const idleMs = this.#o.listenIdleMs ?? LISTEN_IDLE_MS;
    let l = this.#listening.get(p.utterance);
    if (!l) {
      if (p.seq !== 0) throw new ContractError("invalid", `utterance ${p.utterance} starts at piece 0, not ${p.seq}`);
      const voice = this.#voice(p.bot);
      // Push-to-talk: the user is talking to the bot.
      await this.#mayUse(p.bot, { origin: "user" });
      const entry = this.#entry(voice.provider);
      if (!entry.listen) throw new ContractError("refused", `the voice plugin "${voice.provider}" doesn't listen`);
      const pieces = new Pieces();
      const gen = this.#o.host.stream<unknown, { text?: unknown }>({
        pluginId: entry.pluginId, handler: entry.handler, method: "listen", caller: { kind: "core" }, input: pieces,
        args: { format: p.format },
      });
      const result = (async () => {
        for (;;) {
          const next = await gen.next();
          if (next.done) return { text: typeof next.value?.text === "string" ? next.value.text : "" };
        }
      })();
      l = { bot: p.bot, next: 0, pieces, result, idle: undefined };
      this.#listening.set(p.utterance, l);
      // A failed listen still ends the utterance: its last piece gets the error.
      result.catch(() => {});
    }
    if (l.bot !== p.bot) throw new ContractError("invalid", `utterance ${p.utterance} is ${l.bot}'s`);
    if (p.seq !== l.next) throw new ContractError("invalid", `utterance ${p.utterance} expected piece ${l.next}, not ${p.seq}`);
    l.next++;
    if (l.idle !== undefined) clearTimeout(l.idle);
    l.idle = undefined;
    if (p.audio !== "") l.pieces.push(new Uint8Array(Buffer.from(p.audio, "base64")));
    if (!p.final) {
      // An utterance whose last piece never comes (the app went away) is dropped, and its plugin call ends.
      const listening = l;
      l.idle = setTimeout(() => {
        if (this.#listening.get(p.utterance) !== listening) return;
        this.#listening.delete(p.utterance);
        listening.pieces.fail(new ContractError("timeout", `utterance ${p.utterance} had no piece for ${Math.round(idleMs / 1000)} s`));
        this.#o.warn?.(`${p.bot}'s utterance ${p.utterance} was dropped: no piece came for ${Math.round(idleMs / 1000)} s`);
      }, idleMs);
      (l.idle as { unref?: () => void }).unref?.();
      return {};
    }
    l.pieces.end();
    this.#listening.delete(p.utterance);
    return { text: (await l.result).text };
  }
}
