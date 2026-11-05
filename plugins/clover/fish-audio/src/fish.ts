// A client for Fish Audio's REST API (https://docs.fish.audio, read November 5, 2026): text-to-speech, speech-to-text
// and the voice library. Spec §6.6: Alpha ships with a Fish Audio voice, `s2.1-pro-free` by default with `s2.1-pro`
// one switch away; without a key, Alpha is text-only. Spike S4 measures the free model (`s4.ts`).
//
// The client never holds a key. Every request goes through the `fetch` it is given: in the plugin host that is the
// core's keyed fetch (`net.fetch(url, init, { auth: "fish-api-key" })`, spec §5.4), which adds the user's key, reaches
// only `api.fish.audio` (the manifest's `network:` host) and refuses a request that sets `Authorization` itself. Its
// refusals come back at once, never retried: with no key saved (`no_credential`) the client says `no_key`, and the bot
// stays text-only.
//
// What the documentation says, and what the client does about it:
// * `POST /v1/tts`, JSON body, model in a `model` header. An unknown model is not refused: Fish serves and bills it as
//   `s2.1-pro`. So the client sends only the models it knows, and refuses any other before a request goes out.
// * `s2.1-pro-free` costs nothing, under fair-use limits Fish doesn't state, with "No TTFA or DPA guarantees".
// * The audio streams back (`Transfer-Encoding: chunked`) in the format asked for: raw 16-bit mono `pcm` at 8, 16, 24,
//   32 or 44.1 kHz (24 kHz is `voice.play`'s `pcm16-24k`), `wav`, `mp3` at 32 or 44.1 kHz, or `opus` at 48 kHz.
// * `POST /v1/asr`, multipart, model in a `model` header (`transcribe-1`, or `transcribe-1-pro` for recordings); a
//   missing or unknown model runs and bills as `transcribe-1`. Raw headerless PCM is refused, so PCM goes as WAV.
// * Errors are JSON `{ status, message }` (speech-to-text's newer errors add `code` and `request_id`); some from the
//   network edge have no body. 429 means the account's concurrent requests are all in use (5 on the starter tier) and
//   comes with no `Retry-After`; it and 5xx are retried with backoff. 401, 402 and 4xx are not.
import { pcm16ToWav, sniffAudio } from "./audio";

export const FISH_ORIGIN = "https://api.fish.audio";
export const FISH_HOST = "api.fish.audio";

export const TTS_MODELS = ["s2.1-pro-free", "s2.1-pro", "s2-pro", "drama-3", "s1"] as const;
export type TtsModel = (typeof TTS_MODELS)[number];
/** Spec §6.6: Alpha's default. */
export const FREE_TTS_MODEL: TtsModel = "s2.1-pro-free";

export const ASR_MODELS = ["transcribe-1", "transcribe-1-pro"] as const;
export type AsrModel = (typeof ASR_MODELS)[number];
/** Push-to-talk is short speech, which `transcribe-1` is documented for. */
export const DEFAULT_ASR_MODEL: AsrModel = "transcribe-1";

export const TTS_FORMATS = ["pcm", "wav", "mp3", "opus"] as const;
export type TtsFormat = (typeof TTS_FORMATS)[number];
export const SAMPLE_RATES: Readonly<Record<TtsFormat, readonly number[]>> = {
  pcm: [8000, 16000, 24000, 32000, 44100],
  wav: [8000, 16000, 24000, 32000, 44100],
  mp3: [32000, 44100],
  opus: [48000],
};
const DEFAULT_SAMPLE_RATE: Readonly<Record<TtsFormat, number>> = { pcm: 24000, wav: 24000, mp3: 44100, opus: 48000 };
export const LATENCIES = ["low", "normal", "balanced"] as const;
export type Latency = (typeof LATENCIES)[number];

/** The longest text one request speaks; a bot's reply is split into sentences before it is spoken. */
export const TEXT_MAX_CHARS = 20_000;
/** `transcribe-1` takes up to 50 MiB, and asks for compressed audio under 25 MiB. */
export const ASR_MAX_BYTES = 50 * 1024 * 1024;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Time for measuring and for waiting between retries; tests pass a virtual one. */
export interface Timer {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realTimer: Timer = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortedError());
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(abortedError());
      }, { once: true });
    }),
};

export type FishErrorCode =
  | "unauthorized" | "payment_required" | "rate_limited" | "unavailable" | "invalid_request" | "not_found" | "too_large"
  | "unsupported_media" | "network" | "aborted" | "bad_response"
  /** The core's keyed fetch has no key for this plugin: the user hasn't added one, so the bot stays text-only. */
  | "no_key"
  /** The core's keyed fetch refused the request for another reason (a host not declared, a header the plugin set). */
  | "refused";

/** A failure the voice path can branch on. Its message is Fish's (cut short) or the client's own, never a key. */
export class FishError extends Error {
  constructor(
    readonly code: FishErrorCode,
    message: string,
    readonly status?: number,
    /** Speech-to-text's own error code (`invalid_audio`, `audio_too_long` …). */
    readonly fishCode?: string,
  ) {
    super(message);
    this.name = "FishError";
  }

  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable" || this.code === "network";
  }
}

function abortedError(): FishError {
  return new FishError("aborted", "the request was cancelled");
}

/** The keyed fetch's failure codes (the plugin API's `KEYED_FETCH_ERROR_CODES`) that are the core saying no rather than
 *  the network failing: trying again can't help. `network` and `idle_timeout` are retried as network failures. */
const CORE_REFUSALS: ReadonlySet<string> = new Set([
  "host_not_declared", "insecure_url", "redirect_refused", "unknown_auth", "ambiguous_auth", "no_credential", "no_account",
  "credential_header", "refused",
]);

function failureCode(err: unknown): string | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** A refusal by the core's keyed fetch as the client's own error, or undefined for anything else. Only the code is
 *  kept: the fetch's message is the core's, and the client adds no more to it. */
function coreRefusal(err: unknown): FishError | undefined {
  const code = failureCode(err);
  if (code === "no_credential") return new FishError("no_key", "there is no Fish Audio key on this computer; add yours to the Fish Audio plugin to give bots a voice");
  if (code !== undefined && CORE_REFUSALS.has(code)) return new FishError("refused", `Clover refused the request to Fish Audio (${code})`);
  return undefined;
}

const ERROR_FOR_STATUS: Readonly<Record<number, FishErrorCode>> = {
  400: "invalid_request", 401: "unauthorized", 402: "payment_required", 404: "not_found", 413: "too_large",
  415: "unsupported_media", 422: "invalid_request", 429: "rate_limited", 500: "unavailable", 502: "unavailable",
  503: "unavailable", 504: "unavailable",
};

async function errorFromResponse(res: Response): Promise<FishError> {
  let message = `Fish Audio answered ${res.status}`;
  let fishCode: string | undefined;
  try {
    const body = (await res.json()) as { message?: unknown; code?: unknown };
    if (typeof body.message === "string" && body.message !== "") message = `Fish Audio: ${body.message.slice(0, 300)}`;
    if (typeof body.code === "string") fishCode = body.code.slice(0, 64);
  } catch {
    // An error from the network edge may have no JSON body.
  }
  const code = ERROR_FOR_STATUS[res.status] ?? (res.status >= 500 ? "unavailable" : res.status >= 400 ? "invalid_request" : "bad_response");
  return new FishError(code, message, res.status, fishCode);
}

export interface RetryPolicy {
  /** Retries after the first try. */
  attempts: number;
  baseMs: number;
  maxMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseMs: 500, maxMs: 4_000 };

export interface SpeakRequest {
  text: string;
  /** A voice from Fish's library (its model id, `reference_id`); without one Fish picks a voice. */
  voice?: string;
  model?: TtsModel;
  format?: TtsFormat;
  sampleRate?: number;
  mp3Bitrate?: 64 | 128 | 192;
  /** `normal` favours quality; `balanced` and `low` answer sooner. Default `balanced`, for conversation. */
  latency?: Latency;
  /** 0.5–2.0 */
  speed?: number;
  /** Decibels. */
  volume?: number;
  /** 0–1 */
  temperature?: number;
  /** 0–1 */
  topP?: number;
  /** A BCP-47 tag, for reading numbers and dates aloud. */
  language?: string;
  signal?: AbortSignal;
}

export interface Speech {
  model: TtsModel;
  format: TtsFormat;
  sampleRate: number;
  /** When the request went out, on the client's timer. */
  startedAt: number;
  /** From the request to the response's headers. */
  headersMs: number;
  /** The audio as it arrives. Reading it to the end, or stopping early, ends the request. */
  chunks: AsyncIterable<Uint8Array>;
}

export interface TranscribeRequest {
  audio: Uint8Array;
  /** `pcm16-16k` is the app's push-to-talk recording, wrapped in WAV before it goes. */
  format: "pcm16-16k" | "wav" | "mp3" | "ogg" | "flac";
  model?: AsrModel;
  /** A lowercase ISO 639-1 code (`en`); Fish detects the language either way. */
  language?: string;
  /** Word timings in `segments`; off by default, as Fish's is. */
  timestamps?: boolean;
  signal?: AbortSignal;
}

export interface Transcript {
  text: string;
  /** Seconds, silence included. */
  duration: number;
  segments: { text: string; start: number; end: number }[];
  language?: string;
  languageCode?: string;
  requestId?: string;
}

export interface FishVoice {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
  state: string;
  visibility: string;
  author: { id: string; nickname: string };
  taskCount: number;
  likeCount: number;
}

export interface VoicesQuery {
  pageSize?: number;
  pageNumber?: number;
  title?: string;
  /** The account's own voices. */
  self?: boolean;
  language?: string;
  sortBy?: "score" | "task_count" | "created_at";
  signal?: AbortSignal;
}

const LANGUAGE_TAG_RE = /^[A-Za-z0-9_-]{1,35}$/;
const ISO_639_1_RE = /^[a-z]{2}$/;

function invalid(message: string): FishError {
  return new FishError("invalid_request", message);
}

function inRange(name: string, value: number | undefined, lo: number, hi: number): void {
  if (value !== undefined && !(Number.isFinite(value) && value >= lo && value <= hi)) throw invalid(`${name} is between ${lo} and ${hi}`);
}

function voiceOf(raw: unknown): FishVoice {
  const v = (raw ?? {}) as Record<string, unknown>;
  if (typeof v._id !== "string" || typeof v.title !== "string") throw new FishError("bad_response", "Fish Audio sent a voice with no id or title");
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const author = (v.author ?? {}) as Record<string, unknown>;
  return {
    id: v._id,
    title: v.title,
    description: typeof v.description === "string" ? v.description : "",
    languages: strings(v.languages),
    tags: strings(v.tags),
    state: typeof v.state === "string" ? v.state : "unknown",
    visibility: typeof v.visibility === "string" ? v.visibility : "unknown",
    author: { id: typeof author._id === "string" ? author._id : "", nickname: typeof author.nickname === "string" ? author.nickname : "" },
    taskCount: typeof v.task_count === "number" ? v.task_count : 0,
    likeCount: typeof v.like_count === "number" ? v.like_count : 0,
  };
}

export class FishAudioClient {
  readonly #fetch: FetchLike;
  readonly #origin: string;
  readonly #timer: Timer;
  readonly #retry: RetryPolicy;
  readonly #random: () => number;

  constructor(opts: { fetch: FetchLike; origin?: string; timer?: Timer; retry?: Partial<RetryPolicy>; random?: () => number }) {
    this.#fetch = opts.fetch;
    this.#origin = opts.origin ?? FISH_ORIGIN;
    this.#timer = opts.timer ?? realTimer;
    this.#retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.#random = opts.random ?? Math.random;
  }

  /** Text-to-speech, streamed. Retries only before the audio starts. */
  async speak(req: SpeakRequest): Promise<Speech> {
    const model = req.model ?? FREE_TTS_MODEL;
    if (!(TTS_MODELS as readonly string[]).includes(model)) throw invalid(`"${String(model)}" isn't a Fish Audio speech model; Fish would bill it as s2.1-pro`);
    if (typeof req.text !== "string" || req.text.trim() === "") throw invalid("there is no text to speak");
    if (req.text.length > TEXT_MAX_CHARS) throw invalid(`one request speaks at most ${TEXT_MAX_CHARS} characters`);
    const format = req.format ?? "pcm";
    if (!(TTS_FORMATS as readonly string[]).includes(format)) throw invalid(`"${format}" isn't a format Fish Audio speaks`);
    const sampleRate = req.sampleRate ?? DEFAULT_SAMPLE_RATE[format];
    if (!SAMPLE_RATES[format].includes(sampleRate)) throw invalid(`${format} comes at ${SAMPLE_RATES[format].join(", ")} Hz`);
    if (req.mp3Bitrate !== undefined && (format !== "mp3" || ![64, 128, 192].includes(req.mp3Bitrate))) throw invalid("an MP3 bitrate is 64, 128 or 192 kbps, for mp3 only");
    const latency = req.latency ?? "balanced";
    if (!(LATENCIES as readonly string[]).includes(latency)) throw invalid(`latency is ${LATENCIES.join(", ")}`);
    inRange("speed", req.speed, 0.5, 2);
    inRange("volume", req.volume, -20, 20);
    inRange("temperature", req.temperature, 0, 1);
    inRange("top_p", req.topP, 0, 1);
    if (req.language !== undefined && !LANGUAGE_TAG_RE.test(req.language)) throw invalid("a language is a BCP-47 tag");
    if (req.voice !== undefined && (req.voice === "" || req.voice.length > 256)) throw invalid("a voice is a Fish Audio model id");
    const body = {
      text: req.text,
      ...(req.voice === undefined ? {} : { reference_id: req.voice }),
      format,
      sample_rate: sampleRate,
      ...(req.mp3Bitrate === undefined ? {} : { mp3_bitrate: req.mp3Bitrate }),
      latency,
      ...(req.speed === undefined && req.volume === undefined ? {} : { prosody: { ...(req.speed === undefined ? {} : { speed: req.speed }), ...(req.volume === undefined ? {} : { volume: req.volume }) } }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.topP === undefined ? {} : { top_p: req.topP }),
      ...(req.language === undefined ? {} : { language: req.language }),
    };
    const startedAt = this.#timer.now();
    const res = await this.#send("/v1/tts", { method: "POST", headers: { "content-type": "application/json", model }, body: JSON.stringify(body) }, req.signal);
    const headersMs = this.#timer.now() - startedAt;
    if (res.body === null) throw new FishError("bad_response", "Fish Audio sent no audio");
    return { model, format, sampleRate, startedAt, headersMs, chunks: readChunks(res.body, req.signal) };
  }

  /** Speech-to-text for one recording. */
  async transcribe(req: TranscribeRequest): Promise<Transcript> {
    const model = req.model ?? DEFAULT_ASR_MODEL;
    if (!(ASR_MODELS as readonly string[]).includes(model)) throw invalid(`"${String(model)}" isn't a Fish Audio speech-to-text model; Fish would bill it as transcribe-1`);
    if (!(req.audio instanceof Uint8Array) || req.audio.length === 0) throw invalid("there is no audio to transcribe");
    if (req.language !== undefined && !ISO_639_1_RE.test(req.language)) throw invalid("a language is a lowercase ISO 639-1 code, such as en");
    const audio = req.format === "pcm16-16k" ? pcm16ToWav(req.audio, 16_000) : req.audio;
    if (audio.length > ASR_MAX_BYTES) throw new FishError("too_large", `one recording is at most ${ASR_MAX_BYTES} bytes`);
    const kind = sniffAudio(audio);
    if (kind === "unknown") throw invalid("the audio isn't WAV, MP3, Ogg or FLAC");
    const form = new FormData();
    form.append("audio", new Blob([audio as Uint8Array<ArrayBuffer>], { type: `audio/${kind === "mp3" ? "mpeg" : kind}` }), `audio.${kind}`);
    if (req.language !== undefined) form.append("language", req.language);
    form.append("ignore_timestamps", req.timestamps ? "false" : "true");
    const res = await this.#send("/v1/asr", { method: "POST", headers: { model }, body: form }, req.signal);
    let raw: Record<string, unknown>;
    try {
      raw = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new FishError("bad_response", "Fish Audio's transcript isn't JSON");
    }
    if (typeof raw.text !== "string" || typeof raw.duration !== "number") throw new FishError("bad_response", "Fish Audio's transcript has no text or duration");
    const segments = Array.isArray(raw.segments)
      ? raw.segments.filter((s): s is { text: string; start: number; end: number } => typeof s === "object" && s !== null && typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number")
      : [];
    return {
      text: raw.text,
      duration: raw.duration,
      segments: segments.map((s) => ({ text: s.text, start: s.start, end: s.end })),
      ...(typeof raw.language === "string" ? { language: raw.language } : {}),
      ...(typeof raw.language_code === "string" ? { languageCode: raw.language_code } : {}),
      ...(typeof raw.request_id === "string" ? { requestId: raw.request_id } : {}),
    };
  }

  /** A page of Fish's voice library. */
  async voices(q: VoicesQuery = {}): Promise<{ total: number; voices: FishVoice[]; hasMore?: boolean }> {
    const params = new URLSearchParams();
    if (q.pageSize !== undefined) {
      if (!(Number.isInteger(q.pageSize) && q.pageSize >= 1 && q.pageSize <= 100)) throw invalid("a page holds 1 to 100 voices");
      params.set("page_size", String(q.pageSize));
    }
    if (q.pageNumber !== undefined) {
      if (!(Number.isInteger(q.pageNumber) && q.pageNumber >= 1)) throw invalid("pages start at 1");
      params.set("page_number", String(q.pageNumber));
    }
    if (q.title !== undefined) params.set("title", q.title);
    if (q.self !== undefined) params.set("self", String(q.self));
    if (q.language !== undefined) params.set("language", q.language);
    if (q.sortBy !== undefined) params.set("sort_by", q.sortBy);
    const query = params.toString();
    const res = await this.#send(`/model${query === "" ? "" : `?${query}`}`, { method: "GET" }, q.signal);
    const raw = (await res.json().catch(() => undefined)) as { total?: unknown; items?: unknown; has_more?: unknown } | undefined;
    if (raw === undefined || typeof raw.total !== "number" || !Array.isArray(raw.items)) throw new FishError("bad_response", "Fish Audio's voice list has no total or items");
    return { total: raw.total, voices: raw.items.map(voiceOf), ...(typeof raw.has_more === "boolean" ? { hasMore: raw.has_more } : {}) };
  }

  /** One voice from the library. */
  async voice(id: string, signal?: AbortSignal): Promise<FishVoice> {
    if (id === "" || id.length > 256) throw invalid("a voice is a Fish Audio model id");
    const res = await this.#send(`/model/${encodeURIComponent(id)}`, { method: "GET" }, signal);
    return voiceOf(await res.json().catch(() => undefined));
  }

  /** One request, retried with backoff after 429, 5xx and network failures. */
  async #send(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortedError();
      let res: Response;
      try {
        res = await this.#fetch(`${this.#origin}${path}`, { ...init, ...(signal === undefined ? {} : { signal }) });
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError") || failureCode(err) === "aborted") throw abortedError();
        if (err instanceof FishError) throw err;
        const refused = coreRefusal(err);
        if (refused) throw refused;
        if (attempt >= this.#retry.attempts) throw new FishError("network", `Fish Audio couldn't be reached: ${err instanceof Error ? err.message.slice(0, 200) : "network error"}`);
        await this.#backoff(attempt, signal);
        continue;
      }
      if (res.ok) return res;
      const err = await errorFromResponse(res);
      if (!err.retryable || attempt >= this.#retry.attempts) throw err;
      await this.#backoff(attempt, signal);
    }
  }

  async #backoff(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    const ceiling = Math.min(this.#retry.maxMs, this.#retry.baseMs * 2 ** attempt);
    await this.#timer.sleep(Math.round(ceiling * (0.5 + this.#random() / 2)), signal);
  }
}

async function* readChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (err) {
        if (signal?.aborted) throw abortedError();
        throw new FishError("network", `the audio stopped: ${err instanceof Error ? err.message.slice(0, 200) : "network error"}`);
      }
      if (next.done) {
        done = true;
        return;
      }
      if (next.value.length > 0) yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reads a speech to its end: the audio, how long the first audio took from the request, and the whole. */
export async function collectSpeech(speech: Speech, timer: Timer = realTimer): Promise<{ audio: Uint8Array; chunks: number; firstAudioMs?: number; totalMs: number }> {
  const parts: Uint8Array[] = [];
  let firstAudioMs: number | undefined;
  for await (const chunk of speech.chunks) {
    if (firstAudioMs === undefined) firstAudioMs = timer.now() - speech.startedAt;
    parts.push(chunk);
  }
  const audio = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    audio.set(p, at);
    at += p.length;
  }
  return { audio, chunks: parts.length, ...(firstAudioMs === undefined ? {} : { firstAudioMs }), totalMs: timer.now() - speech.startedAt };
}
