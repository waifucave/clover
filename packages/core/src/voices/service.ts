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
   *  speaks and what started its turn (speaking), or the user's own origin (the user talking, `listen`). */
  mayUse?(bot: string, at: { session?: string; origin?: TurnOrigin }): Promise<{ ok: true } | { ok: false; reason: string }>;
  warn?: (message: string) => void;
}

interface Entry {
  pluginId: string;
  handler: string;
  speak: boolean;
  listen: boolean;
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

/** How long an utterance waits for its next piece by default before it is dropped. */
export const LISTEN_IDLE_MS = 30_000;

let utteranceCount = 0;

export class VoiceService {
  readonly #o: VoiceServiceOptions;
  readonly #listening = new Map<string, Listening>();

  constructor(opts: VoiceServiceOptions) {
    this.#o = opts;
  }

  #entry(provider: string): Entry {
    for (const c of this.#o.registry.entries("voices")) {
      if (c.state !== "active" || c.entryId !== provider) continue;
      const v = c.value as { handler?: unknown; speak?: unknown; listen?: unknown };
      if (typeof v.handler !== "string") continue;
      return { pluginId: c.pluginId, handler: v.handler, speak: v.speak === true, listen: v.listen === true };
    }
    throw new ContractError("not_installed", `no voice plugin "${provider}" is installed; the bot is text-only`);
  }

  #voice(bot: string): BotVoice {
    const v = this.#o.voiceOf(bot);
    if (!v) throw new ContractError("refused", `${bot} has no voice; it is text-only`);
    return v;
  }

  async #mayUse(bot: string, at: { session?: string; origin?: TurnOrigin }): Promise<void> {
    const verdict = await this.#o.mayUse?.(bot, at);
    if (verdict !== undefined && !verdict.ok) throw new ContractError("refused", verdict.reason);
  }

  /** Speaks a bot's text on the app here, piece by piece. Resolves once the last piece was sent. */
  async speak(o: { bot: string; session: string; text: string; format?: VoicePlay["format"]; signal?: AbortSignal; origin?: TurnOrigin }): Promise<{ utterance: string; bytes: number }> {
    const voice = this.#voice(o.bot);
    // The speaking session's own turn decides (its origin, unless the caller says): a routine's speech never counts as
    // the user talking.
    await this.#mayUse(o.bot, { session: o.session, ...(o.origin === undefined ? {} : { origin: o.origin }) });
    const entry = this.#entry(voice.provider);
    if (!entry.speak) throw new ContractError("refused", `the voice plugin "${voice.provider}" doesn't speak`);
    const format = o.format ?? "pcm16-24k";
    const utterance = `u_${Date.now().toString(36)}_${(++utteranceCount).toString(36)}`;
    const gen = this.#o.host.stream<{ audio: Uint8Array }, unknown>({
      pluginId: entry.pluginId, handler: entry.handler, method: "speak", caller: { kind: "core" },
      args: { text: o.text, voice: voice.voice, ...(voice.model === undefined ? {} : { model: voice.model }), format },
    });
    let seq = 0;
    let bytes = 0;
    for (;;) {
      if (o.signal?.aborted) {
        await gen.return(undefined);
        break;
      }
      const next = await gen.next();
      if (next.done) break;
      const audio = next.value?.audio;
      if (!(audio instanceof Uint8Array)) continue;
      bytes += audio.length;
      await this.#o.play({ bot: o.bot, session: o.session, utterance, seq: seq++, audio: Buffer.from(audio).toString("base64"), format, final: false });
    }
    await this.#o.play({ bot: o.bot, session: o.session, utterance, seq: seq++, audio: "", format, final: true });
    return { utterance, bytes };
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
