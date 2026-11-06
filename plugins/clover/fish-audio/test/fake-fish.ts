// A recorded fake of Fish Audio's REST API, built from its public documentation (https://docs.fish.audio, read
// November 5, 2026) and the reconstructed responses in `cassettes/fish-api.json`. It answers a `fetch` in process: no
// socket, no network, no account. What it keeps from the documentation:
//
// * the routes `POST /v1/tts`, `POST /v1/asr`, `GET /model` and `GET /model/{id}`, with Bearer keys;
// * the `model` header, and the documented fallbacks: an unknown speech model is served and billed as `s2.1-pro`, an
//   unknown speech-to-text model as `transcribe-1` (`calls[].billedModel` shows which);
// * the body fields, their ranges and the audio formats and sample rates;
// * the prices: `s2.1-pro-free` at $0, `s2.1-pro`, `s2-pro` and `s1` at $15 per million bytes of text, `drama-3` at $50,
//   speech-to-text at $0.36 per hour; 402 when the balance can't pay;
// * 429 at the account's concurrency limit (5 on the starter tier), with no `Retry-After`;
// * speech-to-text's refusal of raw, headerless PCM (`invalid_audio`), and its error bodies with `code`.
//
// What it has to guess, which live gate 5 checks (see `s4.ts`): whether the free model needs a balance at all
// (`freeModelNeedsCredit`), the status of a validation error (422 here), what an unknown `reference_id` returns (404
// here), the error messages' texts, the response's content type, and how fast and how chunked real audio comes.
import { createHash } from "node:crypto";
import { readWav, sniffAudio } from "../src/audio";
import { TTS_MODELS, type FetchLike, type Timer } from "../src/fish";
import { cassette } from "./cassette";

export interface FakeFishOptions {
  /** The one key it accepts. The fake never puts it in a response or in `calls`. */
  key: string;
  balanceUsd?: number;
  /** Whether `s2.1-pro-free` still needs a positive balance (unknown until live gate 5). */
  freeModelNeedsCredit?: boolean;
  /** Concurrent requests per account: 5 on the starter tier. */
  concurrency?: number;
  timer?: Timer;
  /** From the request to the first audio. */
  ttfaMs?: number;
  /** Between audio chunks. */
  chunkMs?: number;
  chunkBytes?: number;
  /** How fast its voice speaks, for how much audio a text makes. */
  charsPerSecond?: number;
  /** How long speech-to-text takes. */
  asrMs?: number;
}

export interface FakeCall {
  method: string;
  path: string;
  status: number;
  authorized: boolean;
  /** The `model` header as sent. */
  model?: string;
  /** What Fish would bill it as. */
  billedModel?: string;
  costUsd?: number;
}

const TTS_PRICE_PER_BYTE: Readonly<Record<string, number>> = {
  "s2.1-pro-free": 0, "s2.1-pro": 15 / 1e6, "s2-pro": 15 / 1e6, s1: 15 / 1e6, "drama-3": 50 / 1e6,
};
const ASR_PRICE_PER_SECOND = 0.36 / 3600;
const RATES: Readonly<Record<string, readonly number[]>> = {
  pcm: [8000, 16000, 24000, 32000, 44100], wav: [8000, 16000, 24000, 32000, 44100], mp3: [32000, 44100], opus: [48000],
};

/** Time that moves only when something waits on it: each sleep adds its length. */
export class VirtualTimer implements Timer {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    this.t += Math.max(0, ms);
    await Promise.resolve();
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Deterministic speech-like PCM: a 220 Hz tone, 16-bit mono. */
function tone(seconds: number, sampleRate: number): Uint8Array {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)), true);
  return out;
}

function wavOf(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); put(8, "WAVE"); put(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); put(36, "data");
  v.setUint32(40, pcm.length, true); out.set(pcm, 44);
  return out;
}

/** MPEG-1 Layer III frames of silence: frame syncs a player recognises, 1152 samples each. */
function mp3Of(seconds: number, sampleRate: number): Uint8Array {
  const frames = Math.max(1, Math.ceil((seconds * sampleRate) / 1152));
  const size = sampleRate === 44100 ? 417 : 576;
  const out = new Uint8Array(frames * size);
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, sampleRate === 44100 ? 0x90 : 0x98, 0xc4], f * size);
  return out;
}

export class FakeFish {
  readonly calls: FakeCall[] = [];
  balanceUsd: number;
  freeModelNeedsCredit: boolean;
  concurrency: number;
  /** The next this many requests get 503 ("high load"). */
  overloadNext = 0;
  inFlight = 0;
  peakInFlight = 0;
  readonly #o: Required<Omit<FakeFishOptions, "balanceUsd" | "freeModelNeedsCredit" | "concurrency">>;
  /** What each piece of audio it spoke says, so its speech-to-text hears it back. */
  readonly #spoken = new Map<string, string>();

  constructor(opts: FakeFishOptions) {
    this.balanceUsd = opts.balanceUsd ?? 0;
    this.freeModelNeedsCredit = opts.freeModelNeedsCredit ?? false;
    this.concurrency = opts.concurrency ?? 5;
    this.#o = {
      key: opts.key, timer: opts.timer ?? new VirtualTimer(), ttfaMs: opts.ttfaMs ?? 400, chunkMs: opts.chunkMs ?? 20,
      chunkBytes: opts.chunkBytes ?? 8192, charsPerSecond: opts.charsPerSecond ?? 15, asrMs: opts.asrMs ?? 300,
    };
  }

  readonly fetch: FetchLike = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin !== "https://api.fish.audio") throw new TypeError(`the fake serves only api.fish.audio, not ${u.host}`);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const authorized = headers.get("authorization") === `Bearer ${this.#o.key}`;
    const call: FakeCall = { method, path: u.pathname, status: 0, authorized, ...(headers.get("model") === null ? {} : { model: headers.get("model")! }) };
    this.calls.push(call);
    const answer = (res: Response) => {
      call.status = res.status;
      return res;
    };
    if (!authorized) return answer(json(401, cassette.errors["401"]));
    if (this.overloadNext > 0) {
      this.overloadNext--;
      return answer(json(503, cassette.errors["503"]));
    }
    if (method === "POST" && u.pathname === "/v1/tts") return answer(await this.#tts(headers, init, call));
    if (method === "POST" && u.pathname === "/v1/asr") return answer(await this.#asr(headers, init, call));
    if (method === "GET" && u.pathname === "/model") return answer(this.#models(u));
    if (method === "GET" && u.pathname.startsWith("/model/")) {
      const item = cassette.models.items.find((m) => m._id === decodeURIComponent(u.pathname.slice("/model/".length)));
      return answer(item ? json(200, item) : json(404, cassette.errors["404"]));
    }
    return answer(json(404, { status: 404, message: "Not Found" }));
  };

  #busy(): boolean {
    return this.inFlight >= this.concurrency;
  }

  #enter(): void {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
  }

  async #tts(headers: Headers, init: RequestInit, call: FakeCall): Promise<Response> {
    if (!(headers.get("content-type") ?? "").startsWith("application/json")) return json(415, cassette.errors["415"]);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
    } catch {
      return json(422, cassette.errors["422"]);
    }
    const modelHeader = headers.get("model");
    const billed = modelHeader !== null && (TTS_MODELS as readonly string[]).includes(modelHeader) ? modelHeader : "s2.1-pro";
    call.billedModel = billed;
    const format = (body.format ?? "mp3") as string;
    const rate = (body.sample_rate ?? (format === "opus" ? 48000 : 44100)) as number;
    const within = (v: unknown, lo: number, hi: number) => v === undefined || (typeof v === "number" && v >= lo && v <= hi);
    const speed = (body.prosody as { speed?: unknown } | undefined)?.speed;
    const valid = typeof body.text === "string" && body.text !== ""
      && (RATES[format] ?? []).includes(rate)
      && (body.mp3_bitrate === undefined || [64, 128, 192].includes(body.mp3_bitrate as number))
      && (body.latency === undefined || ["low", "normal", "balanced"].includes(body.latency as string))
      && within(body.temperature, 0, 1) && within(body.top_p, 0, 1) && within(speed, 0.5, 2);
    if (!valid) return json(422, cassette.errors["422"]);
    if (body.reference_id !== undefined && !cassette.models.items.some((m) => m._id === body.reference_id)) return json(404, cassette.errors["404"]);
    const text = body.text as string;
    const cost = new TextEncoder().encode(text).length * (TTS_PRICE_PER_BYTE[billed] ?? 0);
    if ((cost > 0 && this.balanceUsd < cost) || (cost === 0 && this.freeModelNeedsCredit && this.balanceUsd <= 0)) return json(402, cassette.errors["402"]);
    if (this.#busy()) return json(429, cassette.errors["429"]);
    this.balanceUsd -= cost;
    call.costUsd = cost;

    const seconds = Math.min(600, Math.max(0.4, text.length / this.#o.charsPerSecond));
    const pcmRate = format === "mp3" || format === "opus" ? 16000 : rate;
    const pcm = tone(seconds, pcmRate);
    this.#spoken.set(sha(pcm), text);
    const audio = format === "pcm" ? pcm : format === "wav" ? wavOf(pcm, rate) : format === "mp3" ? mp3Of(seconds, rate) : new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Uint8Array(Math.round(seconds * 4000))]);
    const { timer, ttfaMs, chunkMs, chunkBytes } = this.#o;
    this.#enter();
    let at = 0;
    let open = true;
    const close = () => {
      if (open) {
        open = false;
        this.inFlight--;
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        await timer.sleep(at === 0 ? ttfaMs : chunkMs);
        if (!open) return;
        controller.enqueue(audio.slice(at, at + chunkBytes));
        at += chunkBytes;
        if (at >= audio.length) {
          close();
          controller.close();
        }
      },
      cancel: () => close(),
    }, { highWaterMark: 0 });
    const contentType = { pcm: "audio/pcm", wav: "audio/wav", mp3: "audio/mpeg", opus: "audio/ogg" }[format] ?? "application/octet-stream";
    return new Response(stream, { status: 200, headers: { "content-type": contentType } });
  }

  async #asr(headers: Headers, init: RequestInit, call: FakeCall): Promise<Response> {
    if (!(init.body instanceof FormData)) return json(415, cassette.errors["415"]);
    const modelHeader = headers.get("model");
    const billed = modelHeader === "transcribe-1-pro" || modelHeader === "transcribe-1" ? modelHeader : "transcribe-1";
    call.billedModel = billed;
    const audios = init.body.getAll("audio");
    const file = audios[0];
    if (audios.length !== 1 || !(file instanceof Blob)) return json(400, cassette.errors.asr_invalid_request);
    const language = init.body.get("language");
    if (language !== null && !/^[a-z]{2}$/.test(String(language))) return json(400, cassette.errors.asr_invalid_parameter);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffAudio(bytes) === "unknown") return json(400, cassette.errors.asr_invalid_audio);
    const wav = readWav(bytes);
    const duration = wav ? wav.pcm.length / (2 * wav.sampleRate * wav.channels) : bytes.length / 16_000;
    const cost = Math.ceil(duration) * ASR_PRICE_PER_SECOND;
    if (this.balanceUsd < cost) return json(402, cassette.errors["402"]);
    if (this.#busy()) return json(429, cassette.errors["429"]);
    this.balanceUsd -= cost;
    call.costUsd = cost;
    this.#enter();
    try {
      await this.#o.timer.sleep(this.#o.asrMs);
    } finally {
      this.inFlight--;
    }
    const heard = (wav && this.#spoken.get(sha(wav.pcm))) ?? cassette.transcript.text;
    const timestamps = String(init.body.get("ignore_timestamps") ?? "true").toLowerCase() === "false";
    const words = heard.split(/\s+/).filter(Boolean);
    return json(200, {
      text: heard,
      duration: Math.round(duration * 1000) / 1000,
      segments: timestamps ? words.map((w, i) => ({ text: w, start: (i * duration) / words.length, end: ((i + 1) * duration) / words.length })) : [],
      language: cassette.transcript.language,
      language_code: cassette.transcript.language_code,
      ...(billed === "transcribe-1-pro" ? { request_id: "req_fake" } : {}),
    });
  }

  #models(u: URL): Response {
    const size = Number(u.searchParams.get("page_size") ?? "10");
    const page = Number(u.searchParams.get("page_number") ?? "1");
    if (!(size >= 1 && size <= 100 && page >= 1)) return json(422, cassette.errors["422"]);
    const title = u.searchParams.get("title");
    const all = cassette.models.items.filter((m) => title === null || m.title.toLowerCase().includes(title.toLowerCase()));
    const items = all.slice((page - 1) * size, page * size);
    return json(200, { total: all.length, items, has_more: page * size < all.length });
  }
}
