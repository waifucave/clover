// The Fish Audio plugin's host half (clover/fish-audio): the handler of its `voices` entry (clover.json), which the core
// calls on the computer the user is talking on (spec §5.2, §6.6). It starts only when first needed.
//
// The handler is an object of handlers, `speak` and `listen`. Their arguments and results are this plugin's proposal
// for the `voices` point, which lane D wires into the core in M3: until then the shape is provisional.
//
// The plugin never holds the user's key. Every request goes through the core's keyed fetch with this plugin's `auth`
// entry, `fish-api-key`: the core adds the key, reaches only `api.fish.audio`, and fails at once when the user has no
// key, in which case the bot stays text-only (§6.6).
import { ASR_MODELS, collectSpeech, FishAudioClient, FREE_TTS_MODEL, TTS_MODELS, type AsrModel, type Latency, type TtsModel } from "../src/fish";

/** The `auth` entry whose key the core adds to this plugin's requests. */
export const FISH_SECRET = "fish-api-key";

/** What this handler uses of the plugin API (`HandlerContext` in the plugin SDK). */
export interface VoiceContext {
  readonly signal: AbortSignal;
  readonly api: {
    readonly net: { fetch(url: string, init?: RequestInit, opts?: { auth?: string | false }): Promise<Response> };
  };
}

/** The formats `voice.play` takes (protocol, app area). */
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

export interface SpeakResult {
  model: TtsModel;
  format: PlayFormat;
  audio: Uint8Array;
  /** From the request to the first audio, and to the last. */
  firstAudioMs?: number;
  totalMs: number;
}

export interface ListenArgs {
  /** What the app recorded while push-to-talk was held: raw 16-bit PCM at 16 kHz, or an Ogg Opus stream. */
  audio: Uint8Array;
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

export const voice = {
  async speak(args: SpeakArgs, ctx: VoiceContext): Promise<SpeakResult> {
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
    const got = await collectSpeech(speech);
    return { model, format, audio: got.audio, ...(got.firstAudioMs === undefined ? {} : { firstAudioMs: got.firstAudioMs }), totalMs: got.totalMs };
  },

  async listen(args: ListenArgs, ctx: VoiceContext): Promise<ListenResult> {
    const model = (args.model ?? "transcribe-1") as AsrModel;
    if (!(ASR_MODELS as readonly string[]).includes(model)) throw new Error(`"${String(args.model)}" isn't a Fish Audio listening model`);
    const heard = await clientFor(ctx).transcribe({
      audio: args.audio, format: args.format === "opus" ? "ogg" : "pcm16-16k", model,
      ...(args.language === undefined ? {} : { language: args.language }),
      signal: ctx.signal,
    });
    return { text: heard.text, duration: heard.duration, ...(heard.languageCode === undefined ? {} : { languageCode: heard.languageCode }) };
  },
};
