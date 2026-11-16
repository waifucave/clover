// The Fish Audio plugin's host half (moss/fish-audio): Fish Audio's voices for MOSS Voice (spec §6.6). It starts only
// when first needed.
//
// * `speak` fills MOSS Voice's own providers point (`moss.voice.providers`, this plugin's moss.json): MOSS Voice
//   calls it through `points.stream` with the text and the bot's voice, and it answers with the audio as Fish sends it,
//   raw bytes in the format asked (pcm16-24k by default), so the first words play while the rest arrives.
// * `listen` is the same entry's, for push-to-talk: MOSS Voice calls it (`points.call`) with the whole recording
//   (`args.audio`, 16 kHz PCM, or Ogg Opus), and it answers with what Fish's `transcribe-1` heard.
//
// The plugin never holds the user's key. Every request goes through the core's keyed fetch with this plugin's `auth`
// entry, `fish-api-key`: the core adds the key, reaches only `api.fish.audio`, and fails at once when the user has no
// key, in which case the bot stays text-only (§6.6).
import type { HostPluginApi } from "@waifucave/moss-plugin-sdk";
import { ASR_MODELS, FishAudioClient, FishError, FREE_TTS_MODEL, TTS_MODELS, type AsrModel, type Latency, type TtsModel } from "../src/fish";

/** The `auth` entry whose key the core adds to this plugin's requests. */
export const FISH_SECRET = "fish-api-key";

/** What this handler uses of the plugin API (`HandlerContext` in the plugin SDK). */
export interface VoiceContext {
  readonly signal: AbortSignal;
  readonly api: Pick<HostPluginApi, "net">;
}

/** The formats MOSS Voice's player takes (`pcm16-24k`), and two more a caller may ask for. */
export type PlayFormat = "pcm16-24k" | "mp3" | "opus";

export interface SpeakArgs {
  text: string;
  /** The bot's voice: a voice in Fish's library. */
  voice: string;
  /** The bot's voice model; default the free one. */
  model?: string;
  format?: PlayFormat;
  latency?: Latency;
  speed?: number;
  language?: string;
}

/** One piece of speech, as `speak` yields it. */
export interface SpeakChunk {
  audio: Uint8Array;
}

/** What `speak` returns once the audio has all been yielded. */
export interface SpeakResult {
  model: TtsModel;
  format: PlayFormat;
  /** How many bytes of audio it yielded. */
  bytes: number;
  /** From the request to the first audio, and to the last. */
  firstAudioMs?: number;
  totalMs: number;
}

export interface ListenArgs {
  /** What MOSS Voice's talk button recorded while it was held: raw 16-bit PCM at 16 kHz, or an Ogg Opus stream. */
  audio?: Uint8Array;
  format: "pcm16-16k" | "opus";
  language?: string;
  model?: string;
}

export interface ListenResult {
  text: string;
  /** Seconds of audio, silence included. */
  duration: number;
  languageCode?: string;
}

const AS_FISH: Readonly<Record<PlayFormat, { format: "pcm" | "mp3" | "opus"; sampleRate: number }>> = {
  "pcm16-24k": { format: "pcm", sampleRate: 24_000 },
  mp3: { format: "mp3", sampleRate: 44_100 },
  opus: { format: "opus", sampleRate: 48_000 },
};

function clientFor(ctx: VoiceContext): FishAudioClient {
  return new FishAudioClient({ fetch: (url, init) => ctx.api.net.fetch(url, init, { auth: FISH_SECRET }) });
}

/** The most a recording may hold: ten minutes of 16 kHz PCM. */
export const LISTEN_MAX_BYTES = 10 * 60 * 16_000 * 2;

/** The audio for `args.text`, as Fish sends it, with what was spoken at the end. */
export async function* speakChunks(args: SpeakArgs, ctx: VoiceContext): AsyncGenerator<SpeakChunk, SpeakResult, undefined> {
    const model = (args.model ?? FREE_TTS_MODEL) as TtsModel;
    if (!(TTS_MODELS as readonly string[]).includes(model)) throw new Error(`"${String(args.model)}" isn't a Fish Audio voice model`);
    const format = args.format ?? "pcm16-24k";
    const out = AS_FISH[format];
    if (out === undefined) throw new Error(`"${String(format)}" isn't a format the app plays`);
    const speech = await clientFor(ctx).speak({
      text: args.text, voice: args.voice, model, format: out.format, sampleRate: out.sampleRate, latency: args.latency ?? "balanced",
      ...(args.speed === undefined ? {} : { speed: args.speed }),
      ...(args.language === undefined ? {} : { language: args.language }),
      signal: ctx.signal,
    });
    let firstAudioMs: number | undefined;
    let bytes = 0;
    for await (const chunk of speech.chunks) {
      if (firstAudioMs === undefined) firstAudioMs = performance.now() - speech.startedAt;
      bytes += chunk.length;
      yield { audio: chunk };
    }
    return { model, format, bytes, ...(firstAudioMs === undefined ? {} : { firstAudioMs }), totalMs: performance.now() - speech.startedAt };
}

/** The `moss.voice.providers` entry's `speak` (a `points.stream` handler): the audio, raw bytes as they come. */
export async function speak(args: SpeakArgs, ctx: VoiceContext): Promise<AsyncIterable<Uint8Array>> {
  const chunks = speakChunks(args, ctx);
  return (async function* () {
    for await (const c of chunks) yield c.audio;
  })();
}

/** The `moss.voice.providers` entry's `ready`: whether the user set Fish Audio up (their key in this plugin's settings).
 *  It asks Fish for one voice of its library with the key: no key saved is the only "not set up"; anything else (Fish
 *  down, a bad network) isn't the user's set-up, and speaking says what went wrong itself. */
export async function ready(_args: unknown, ctx: VoiceContext): Promise<{ ready: boolean; why?: string }> {
  try {
    await clientFor(ctx).voices({ pageSize: 1, signal: ctx.signal });
    return { ready: true };
  } catch (err) {
    if (err instanceof FishError && err.code === "no_key") return { ready: false, why: "add your Fish Audio API key in the Fish Audio plugin's settings" };
    return { ready: true };
  }
}

/** The `moss.voice.providers` entry's `listen` (a `points.call` handler): what the user said with push-to-talk,
 *  `{ audio, format }` (16 kHz PCM bytes, or Ogg Opus), written down. */
export async function listen(args: ListenArgs, ctx: VoiceContext): Promise<ListenResult> {
  const model = (args.model ?? "transcribe-1") as AsrModel;
  if (!(ASR_MODELS as readonly string[]).includes(model)) throw new Error(`"${String(args.model)}" isn't a Fish Audio listening model`);
  if (!(args.audio instanceof Uint8Array)) throw new Error("listen needs the recording, as its audio");
  if (args.audio.length > LISTEN_MAX_BYTES) throw new Error(`a recording holds at most ${LISTEN_MAX_BYTES} bytes`);
  const heard = await clientFor(ctx).transcribe({
    audio: args.audio, format: args.format === "opus" ? "ogg" : "pcm16-16k", model,
    ...(args.language === undefined ? {} : { language: args.language }),
    signal: ctx.signal,
  });
  return { text: heard.text, duration: heard.duration, ...(heard.languageCode === undefined ? {} : { languageCode: heard.languageCode }) };
}
