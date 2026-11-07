// The Fish Audio plugin's host half (clover/fish-audio): the handler of its `voices` entry (clover.json), which the core
// calls on the computer the user is talking on (spec §5.2, §6.6). It starts only when first needed.
//
// The handler is an object of handlers, `speak` and `listen`, in lane B's streaming shape (the plugin host's `stream`):
// * `speak` yields the audio as Fish sends it (`{ audio }` chunks), so the app plays the first words while the rest
//   arrives, and returns what was spoken (the model, the format, the times);
// * `listen` takes the recording as it is made (`ctx.input`, chunks of audio) or whole (`args.audio`), and returns
//   what it heard. Fish's `transcribe-1` takes a whole recording, so it yields nothing on the way.
//
// The plugin never holds the user's key. Every request goes through the core's keyed fetch with this plugin's `auth`
// entry, `fish-api-key`: the core adds the key, reaches only `api.fish.audio`, and fails at once when the user has no
// key, in which case the bot stays text-only (§6.6).
import { ASR_MODELS, FishAudioClient, FREE_TTS_MODEL, TTS_MODELS, type AsrModel, type Latency, type TtsModel } from "../src/fish";

/** The `auth` entry whose key the core adds to this plugin's requests. */
export const FISH_SECRET = "fish-api-key";

/** What this handler uses of the plugin API (`HandlerContext` in the plugin SDK). */
export interface VoiceContext {
  readonly signal: AbortSignal;
  /** A streamed call's input: the recording's chunks, for `listen`. */
  readonly input?: AsyncIterable<unknown>;
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
  /** What the app recorded while push-to-talk was held: raw 16-bit PCM at 16 kHz, or an Ogg Opus stream. Left out,
   *  the recording comes as the call's input. */
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

async function recording(args: ListenArgs, ctx: VoiceContext): Promise<Uint8Array> {
  if (args.audio !== undefined) return args.audio;
  if (ctx.input === undefined) throw new Error("listen needs the recording, as its audio or as the call's input");
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of ctx.input) {
    if (!(chunk instanceof Uint8Array)) throw new Error("listen's input is audio: chunks of bytes");
    size += chunk.length;
    if (size > LISTEN_MAX_BYTES) throw new Error(`a recording holds at most ${LISTEN_MAX_BYTES} bytes`);
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const voice = {
  async *speak(args: SpeakArgs, ctx: VoiceContext): AsyncGenerator<SpeakChunk, SpeakResult, undefined> {
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
  },

  // eslint-disable-next-line require-yield
  async *listen(args: ListenArgs, ctx: VoiceContext): AsyncGenerator<never, ListenResult, undefined> {
    const model = (args.model ?? "transcribe-1") as AsrModel;
    if (!(ASR_MODELS as readonly string[]).includes(model)) throw new Error(`"${String(args.model)}" isn't a Fish Audio listening model`);
    const audio = await recording(args, ctx);
    const heard = await clientFor(ctx).transcribe({
      audio, format: args.format === "opus" ? "ogg" : "pcm16-16k", model,
      ...(args.language === undefined ? {} : { language: args.language }),
      signal: ctx.signal,
    });
    return { text: heard.text, duration: heard.duration, ...(heard.languageCode === undefined ? {} : { languageCode: heard.languageCode }) };
  },
};
