// Spike S4 (spec §14.1 item 4): the quality and the limits of Fish Audio's free voice, `s2.1-pro-free` (§6.6). Fish
// lists it at $0 under unstated fair-use limits, "with no TTFA or DPA guarantees", so whether Alpha can speak with it
// by default is a measurement. `runS4` makes it, through any `fetch`: in the tests against the recorded fake
// (test/fake-fish.ts), and at live gate 5 against Fish itself with the owner's key (scripts/s4-live.ts).
//
// It measures, for a short, a medium and a long text:
// 1. time to first audio (TTFA) and the real-time factor, over several runs each, on the free model (and, when asked,
//    on `s2.1-pro`, which costs a few cents);
// 2. what happens with more requests at once than the account's concurrency (5 on the starter tier);
// 3. a burst of requests one after another, for fair-use limits that show up as 429, 402 or 503;
// 4. a round trip: speak a sentence, transcribe the audio (`transcribe-1`), and compare the words.
// What it can't measure is how the voice sounds; the owner listens at the gate (the report says so).
import { pcm16Seconds, pcm16ToWav } from "./audio";
import { collectSpeech, FishAudioClient, FishError, FREE_TTS_MODEL, type FetchLike, type Timer, type TtsModel } from "./fish";

export const S4_TEXTS = {
  short: "Good morning! Want me to read you today's plan?",
  medium: "The build passed on the second try. One test was flaky, so I re-ran it and opened an issue with the logs. Your train leaves at 6:40, and it might rain on the way home.",
  long: "Here's where we are. The landlord replied about Friday: the plumber can come between nine and eleven, and he needs someone home to let him in. I moved your dentist appointment to Tuesday at 3:30, since Friday morning is now taken. The quarterly report is drafted; the numbers in section two still use last month's export, so I flagged them in yellow rather than guess. Two things need you: whether the team offsite should be in March or April, and whether I should accept the conference invitation before the early-bird price ends on the twelfth. Everything else is on track, and I'll keep an eye on the deploy tonight.",
} as const;
export type S4TextKind = keyof typeof S4_TEXTS;

export interface S4Options {
  fetch: FetchLike;
  timer: Timer;
  /** A voice from Fish's library; without one, the first of `voices()` is used. */
  voice?: string;
  /** Runs per text and model. Default 5. */
  runs?: number;
  /** Also measure `s2.1-pro` (paid: about a cent per run of the long text). */
  comparePaid?: boolean;
  /** Requests fired at once. Default 8, above the starter tier's 5. */
  concurrency?: number;
  /** Requests one after another. Default 30. */
  burst?: number;
  roundTrip?: boolean;
  onProgress?: (line: string) => void;
  /** The first audio each model speaks for each text, for the owner to listen to: the live script saves it as WAV. */
  onAudio?: (sample: { model: TtsModel; kind: S4TextKind; pcm: Uint8Array; sampleRate: number }) => void;
}

export interface LatencyStats {
  runs: number;
  ok: number;
  /** Time to first audio, in ms. */
  p50?: number;
  p95?: number;
  max?: number;
  /** Generation time over audio length: under 1 is faster than real time. */
  meanRtf?: number;
}

export interface S4Report {
  model: TtsModel;
  voice?: string;
  format: "pcm";
  sampleRate: number;
  ttfa: Record<S4TextKind, LatencyStats>;
  paid?: Record<S4TextKind, LatencyStats>;
  concurrency: { fired: number; ok: number; rateLimited: number; other: number };
  burst: { requests: number; ok: number; rateLimited: number; paymentRequired: number; unavailable: number; other: number; p50?: number; p95?: number };
  roundTrip?: { said: string; heard: string; similarity: number };
  failures: { phase: string; code: string; status?: number; message: string }[];
  /** What a measurement can't settle; the owner decides these at the gate. */
  forTheOwner: string[];
}

const SAMPLE_RATE = 24_000;

/** Nearest-rank percentile of ascending values. */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Word overlap between two texts, 0–1 (case and punctuation ignored). */
export function wordSimilarity(a: string, b: string): number {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  const x = words(a);
  const y = words(b);
  if (x.length + y.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const w of x) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      common++;
      counts.set(w, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

export async function runS4(opts: S4Options): Promise<S4Report> {
  const runs = opts.runs ?? 5;
  const log = opts.onProgress ?? (() => {});
  const failures: S4Report["failures"] = [];
  const fail = (phase: string, err: unknown) => {
    const e = err instanceof FishError ? err : new FishError("bad_response", err instanceof Error ? err.message : String(err));
    failures.push({ phase, code: e.code, ...(e.status === undefined ? {} : { status: e.status }), message: e.message });
    return e;
  };
  // Measurements retry as the voice path does; the limit probes don't, so a 429 shows.
  const client = new FishAudioClient({ fetch: opts.fetch, timer: opts.timer });
  const probe = new FishAudioClient({ fetch: opts.fetch, timer: opts.timer, retry: { attempts: 0 } });

  let voice = opts.voice;
  if (voice === undefined) {
    try {
      voice = (await client.voices({ pageSize: 1, sortBy: "task_count" })).voices[0]?.id;
    } catch (err) {
      fail("voices", err);
    }
  }
  log(`S4: voice ${voice ?? "(Fish's default)"}, ${runs} runs per text`);

  const measure = async (model: TtsModel, kind: S4TextKind): Promise<LatencyStats> => {
    const ttfas: number[] = [];
    const rtfs: number[] = [];
    let kept = false;
    for (let i = 0; i < runs; i++) {
      try {
        const speech = await client.speak({ text: S4_TEXTS[kind], model, format: "pcm", sampleRate: SAMPLE_RATE, latency: "balanced", ...(voice === undefined ? {} : { voice }) });
        const got = await collectSpeech(speech, opts.timer);
        if (got.firstAudioMs !== undefined) ttfas.push(got.firstAudioMs);
        const audioMs = pcm16Seconds(got.audio.length, SAMPLE_RATE) * 1000;
        if (audioMs > 0) rtfs.push(got.totalMs / audioMs);
        if (!kept && got.audio.length > 0) {
          kept = true;
          opts.onAudio?.({ model, kind, pcm: got.audio, sampleRate: SAMPLE_RATE });
        }
      } catch (err) {
        fail(`${model} ${kind}`, err);
      }
    }
    const sorted = [...ttfas].sort((a, b) => a - b);
    const stats: LatencyStats = {
      runs, ok: ttfas.length,
      ...(sorted.length === 0 ? {} : { p50: percentile(sorted, 50)!, p95: percentile(sorted, 95)!, max: sorted.at(-1)! }),
      ...(rtfs.length === 0 ? {} : { meanRtf: rtfs.reduce((a, b) => a + b, 0) / rtfs.length }),
    };
    log(`S4: ${model} ${kind}: TTFA p50 ${stats.p50 ?? "-"} ms, p95 ${stats.p95 ?? "-"} ms, ${stats.ok}/${runs} ok`);
    return stats;
  };

  const ttfa = { short: await measure(FREE_TTS_MODEL, "short"), medium: await measure(FREE_TTS_MODEL, "medium"), long: await measure(FREE_TTS_MODEL, "long") };
  const paid = opts.comparePaid ? { short: await measure("s2.1-pro", "short"), medium: await measure("s2.1-pro", "medium"), long: await measure("s2.1-pro", "long") } : undefined;

  // Concurrency: fire at once, then read every stream that opened, so its slot frees.
  const fired = opts.concurrency ?? 8;
  const at = await Promise.allSettled(Array.from({ length: fired }, () => probe.speak({ text: S4_TEXTS.short, format: "pcm", sampleRate: SAMPLE_RATE, latency: "balanced", ...(voice === undefined ? {} : { voice }) })));
  const concurrency = { fired, ok: 0, rateLimited: 0, other: 0 };
  await Promise.all(at.map(async (r) => {
    if (r.status === "fulfilled") {
      concurrency.ok++;
      await collectSpeech(r.value, opts.timer).catch((err: unknown) => fail("concurrency read", err));
    } else if (r.reason instanceof FishError && r.reason.code === "rate_limited") concurrency.rateLimited++;
    else {
      concurrency.other++;
      fail("concurrency", r.reason);
    }
  }));
  log(`S4: ${fired} at once: ${concurrency.ok} ok, ${concurrency.rateLimited} rate-limited`);

  const requests = opts.burst ?? 30;
  const burst: S4Report["burst"] = { requests, ok: 0, rateLimited: 0, paymentRequired: 0, unavailable: 0, other: 0 };
  const burstTtfa: number[] = [];
  for (let i = 0; i < requests; i++) {
    try {
      const got = await collectSpeech(await probe.speak({ text: S4_TEXTS.short, format: "pcm", sampleRate: SAMPLE_RATE, latency: "balanced", ...(voice === undefined ? {} : { voice }) }), opts.timer);
      burst.ok++;
      if (got.firstAudioMs !== undefined) burstTtfa.push(got.firstAudioMs);
    } catch (err) {
      const e = fail("burst", err);
      if (e.code === "rate_limited") burst.rateLimited++;
      else if (e.code === "payment_required") burst.paymentRequired++;
      else if (e.code === "unavailable") burst.unavailable++;
      else burst.other++;
    }
  }
  burstTtfa.sort((a, b) => a - b);
  if (burstTtfa.length > 0) {
    burst.p50 = percentile(burstTtfa, 50)!;
    burst.p95 = percentile(burstTtfa, 95)!;
  }
  log(`S4: burst of ${requests}: ${burst.ok} ok, ${burst.rateLimited} rate-limited, ${burst.paymentRequired} payment required`);

  let roundTrip: S4Report["roundTrip"];
  if (opts.roundTrip ?? true) {
    try {
      const said = S4_TEXTS.medium;
      const spoken = await collectSpeech(await client.speak({ text: said, format: "pcm", sampleRate: SAMPLE_RATE, latency: "normal", ...(voice === undefined ? {} : { voice }) }), opts.timer);
      const heard = await client.transcribe({ audio: pcm16ToWav(spoken.audio, SAMPLE_RATE), format: "wav", language: "en" });
      roundTrip = { said, heard: heard.text, similarity: wordSimilarity(said, heard.text) };
      log(`S4: round trip: ${Math.round(roundTrip.similarity * 100)}% of the words came back`);
    } catch (err) {
      fail("round trip", err);
    }
  }

  return {
    model: FREE_TTS_MODEL,
    ...(voice === undefined ? {} : { voice }),
    format: "pcm",
    sampleRate: SAMPLE_RATE,
    ttfa,
    ...(paid === undefined ? {} : { paid }),
    concurrency,
    burst,
    ...(roundTrip === undefined ? {} : { roundTrip }),
    failures,
    forTheOwner: [
      "Listen to the free model's audio for each text (the live script saves it as WAV): is it good enough to be Alpha's default voice (§6.6)?",
      "Is the free model's TTFA close enough to s2.1-pro's for conversation, or should Alpha default to s2.1-pro?",
      "Pick Alpha's voice: one the project holds the rights to (spec §14.2 item 26); its id goes in Alpha's manifest.",
    ],
  };
}
