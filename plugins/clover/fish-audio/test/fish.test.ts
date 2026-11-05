// The Fish Audio client (../src/fish.ts) against the recorded fake (./fake-fish.ts): speech streamed in the format the
// app plays, the free model by default, the documented failures mapped and retried as they should be, listening with
// PCM wrapped as WAV, and the voice library. No network: the fake answers in process.
import { describe, expect, test } from "bun:test";
import { pcm16Seconds, pcm16ToWav, readWav } from "../src/audio";
import { collectSpeech, FishAudioClient, FishError, type FetchLike } from "../src/fish";
import { cassette } from "./cassette";
import { FakeFish, VirtualTimer } from "./fake-fish";

const KEY = "test-key-not-a-secret";
const VOICE = cassette.models.items[1]!._id;

/** Stands in for the core's keyed fetch: it adds the key, as `net.fetch` with the plugin's `auth` entry will. */
function keyed(fish: FakeFish, key = KEY): FetchLike {
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (headers.has("authorization")) throw new Error("the plugin set its own Authorization header");
    headers.set("authorization", `Bearer ${key}`);
    return fish.fetch(url, { ...init, headers });
  };
}

function setup(opts: Partial<ConstructorParameters<typeof FakeFish>[0]> = {}) {
  const timer = new VirtualTimer();
  const fish = new FakeFish({ key: KEY, timer, ...opts });
  const client = new FishAudioClient({ fetch: keyed(fish), timer, random: () => 0.5 });
  return { timer, fish, client };
}

async function failure(p: Promise<unknown>): Promise<FishError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(FishError);
  return err as FishError;
}

describe("speaking", () => {
  test("the free model by default, raw 16-bit PCM at 24 kHz, streamed in chunks", async () => {
    const { timer, fish, client } = setup({ ttfaMs: 450, chunkMs: 20, chunkBytes: 4096 });
    const speech = await client.speak({ text: "Hi, I'm Alpha.", voice: VOICE });
    expect(speech).toMatchObject({ model: "s2.1-pro-free", format: "pcm", sampleRate: 24_000 });
    const got = await collectSpeech(speech, timer);
    expect(got.firstAudioMs).toBe(450);
    expect(got.chunks).toBeGreaterThan(1);
    expect(pcm16Seconds(got.audio.length, 24_000)).toBeCloseTo(Math.max(0.4, "Hi, I'm Alpha.".length / 15), 2);
    expect(fish.calls).toEqual([{ method: "POST", path: "/v1/tts", status: 200, authorized: true, model: "s2.1-pro-free", billedModel: "s2.1-pro-free", costUsd: 0 }]);
    expect(fish.inFlight).toBe(0);
  });

  test("other formats come at their documented rates; anything else is refused before a request goes out", async () => {
    const { timer, fish, client } = setup();
    const mp3 = await collectSpeech(await client.speak({ text: "mp3 please", format: "mp3" }), timer);
    expect([mp3.audio[0], mp3.audio[1]]).toEqual([0xff, 0xfb]);
    const wav = await collectSpeech(await client.speak({ text: "wav please", format: "wav", sampleRate: 16_000 }), timer);
    expect(readWav(wav.audio)).toMatchObject({ sampleRate: 16_000, channels: 1 });
    const before = fish.calls.length;
    for (const bad of [
      { text: "x", format: "mp3" as const, sampleRate: 24_000 },
      { text: "x", format: "opus" as const, sampleRate: 44_100 },
      { text: "x", speed: 3 },
      { text: "x", temperature: 1.5 },
      { text: "   " },
      { text: "x".repeat(20_001) },
      { text: "x", latency: "instant" as never },
    ]) expect((await failure(client.speak(bad))).code).toBe("invalid_request");
    expect(fish.calls.length).toBe(before);
  });

  test("a model Fish doesn't know is refused here, since Fish would bill it as s2.1-pro", async () => {
    const { fish, client } = setup({ balanceUsd: 10 });
    const err = await failure(client.speak({ text: "hello", model: "s2.1-pro-freee" as never }));
    expect(err.message).toContain("bill it as s2.1-pro");
    expect(fish.calls).toEqual([]);
    // The trap itself, as the fake keeps it: an unknown model header is billed at s2.1-pro's price.
    const res = await keyed(fish)("https://api.fish.audio/v1/tts", { method: "POST", headers: { "content-type": "application/json", model: "s2.1-pro-freee" }, body: JSON.stringify({ text: "hello", format: "pcm", sample_rate: 24_000 }) });
    await res.body?.cancel();
    expect(fish.calls.at(-1)).toMatchObject({ status: 200, billedModel: "s2.1-pro" });
    expect(fish.calls.at(-1)!.costUsd).toBeCloseTo((5 * 15) / 1e6, 12);
  });

  test("a wrong key is unauthorized, at once and without the key in the message", async () => {
    const timer = new VirtualTimer();
    const fish = new FakeFish({ key: KEY, timer });
    const client = new FishAudioClient({ fetch: keyed(fish, "the-wrong-key"), timer });
    const err = await failure(client.speak({ text: "hello" }));
    expect(err).toMatchObject({ code: "unauthorized", status: 401 });
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("the-wrong-key");
    expect(fish.calls).toHaveLength(1);
  });

  test("a refused key's error is a fixed text, even when Fish's body echoes the key", async () => {
    const timer = new VirtualTimer();
    for (const status of [401, 403]) {
      const echoing: FetchLike = async () => new Response(JSON.stringify({ status, message: `bad key the-real-key-123` }), { status, headers: { "content-type": "application/json" } });
      const err = await failure(new FishAudioClient({ fetch: echoing, timer }).voices());
      expect(err).toMatchObject({ code: status === 401 ? "unauthorized" : "forbidden", status });
      expect(err.message).not.toContain("the-real-key-123");
      expect(err.retryable).toBe(false);
    }
  });

  test("a paid model needs credit; the free one doesn't, unless Fish says otherwise at the live gate", async () => {
    const { client, fish } = setup({ balanceUsd: 0 });
    expect(await failure(client.speak({ text: "hello", model: "s2.1-pro" }))).toMatchObject({ code: "payment_required", status: 402 });
    await (await client.speak({ text: "hello" })).chunks[Symbol.asyncIterator]().return?.();
    fish.freeModelNeedsCredit = true;
    expect((await failure(client.speak({ text: "hello" }))).code).toBe("payment_required");
  });

  test("at the account's concurrency limit Fish answers 429 with no Retry-After; the client backs off and tries again", async () => {
    const { timer, fish, client } = setup({ concurrency: 5 });
    const open = await Promise.all(Array.from({ length: 5 }, () => client.speak({ text: "hold the line" })));
    const t0 = timer.now();
    const err = await failure(client.speak({ text: "one more" }));
    expect(err).toMatchObject({ code: "rate_limited", status: 429 });
    expect(err.retryable).toBe(true);
    expect(fish.calls.filter((c) => c.status === 429)).toHaveLength(4); // the try and 3 retries
    expect(timer.now() - t0).toBe(Math.round(500 * 0.75) + Math.round(1000 * 0.75) + Math.round(2000 * 0.75));
    await collectSpeech(open[0]!, timer);
    expect(fish.inFlight).toBe(4);
    await collectSpeech(await client.speak({ text: "now there's room" }), timer);
    for (const s of open.slice(1)) await collectSpeech(s, timer);
    expect(fish.peakInFlight).toBe(5);
  });

  test("high load (503) is retried; stopping the audio early frees the slot", async () => {
    const { timer, fish, client } = setup();
    fish.overloadNext = 2;
    const speech = await client.speak({ text: "after the storm" });
    expect(fish.calls.map((c) => c.status)).toEqual([503, 503, 200]);
    const abort = new AbortController();
    const long = await client.speak({ text: "a long story ".repeat(40), signal: abort.signal });
    const it = long.chunks[Symbol.asyncIterator]();
    await it.next();
    await it.return?.();
    expect(fish.inFlight).toBe(1);
    await collectSpeech(speech, timer);
    expect(fish.inFlight).toBe(0);
    abort.abort();
    expect((await failure(client.speak({ text: "x", signal: abort.signal }))).code).toBe("aborted");
  });

  test("the core's refusals come back at once; only the network failing is tried again", async () => {
    const timer = new VirtualTimer();
    let tries = 0;
    const failing = (code: string): FetchLike => async () => {
      tries++;
      throw Object.assign(new Error(`the keyed fetch failed: ${code}`), { code });
    };
    const noKey = await failure(new FishAudioClient({ fetch: failing("no_credential"), timer }).speak({ text: "hello" }));
    expect(noKey).toMatchObject({ code: "no_key" });
    expect(noKey.retryable).toBe(false);
    expect(noKey.message).toContain("no Fish Audio key");
    for (const code of ["host_not_declared", "credential_header", "unknown_auth", "redirect_refused"]) {
      expect((await failure(new FishAudioClient({ fetch: failing(code), timer }).voices())).code).toBe("refused");
    }
    expect((await failure(new FishAudioClient({ fetch: failing("aborted"), timer }).voices())).code).toBe("aborted");
    expect(tries).toBe(6);
    expect(timer.now()).toBe(0);
    tries = 0;
    const lost = await failure(new FishAudioClient({ fetch: failing("network"), timer, random: () => 0.5 }).voices());
    expect(lost.code).toBe("network");
    expect(tries).toBe(4);
    expect(timer.now()).toBe(Math.round(500 * 0.75) + Math.round(1000 * 0.75) + Math.round(2000 * 0.75));
  });

  test("an unknown voice is not found", async () => {
    const { client } = setup();
    expect(await failure(client.speak({ text: "hello", voice: "ffffffffffffffffffffffffffffffff" }))).toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("listening", () => {
  test("push-to-talk PCM goes as WAV; Fish hears back what it said", async () => {
    const { timer, fish, client } = setup({ balanceUsd: 1 });
    const said = "Remind me to call the plumber.";
    const pcm = (await collectSpeech(await client.speak({ text: said, format: "pcm", sampleRate: 16_000 }), timer)).audio;
    const heard = await client.transcribe({ audio: pcm, format: "pcm16-16k", language: "en" });
    expect(heard).toMatchObject({ text: said, segments: [], languageCode: "en" });
    expect(heard.duration).toBeCloseTo(pcm16Seconds(pcm.length, 16_000), 2);
    expect(fish.calls.at(-1)).toMatchObject({ path: "/v1/asr", model: "transcribe-1", billedModel: "transcribe-1", status: 200 });
    const timed = await client.transcribe({ audio: pcm16ToWav(pcm, 16_000), format: "wav", timestamps: true, model: "transcribe-1-pro" });
    expect(timed.segments.map((s) => s.text)).toEqual(said.split(" "));
    expect(timed.requestId).toBe("req_fake");
  });

  test("audio Fish can't read is refused before it goes; bad parameters and no credit are Fish's refusals", async () => {
    const { fish, client } = setup({ balanceUsd: 0 });
    const pcm = new Uint8Array(3200);
    expect((await failure(client.transcribe({ audio: pcm, format: "wav" }))).code).toBe("invalid_request");
    expect((await failure(client.transcribe({ audio: pcm, format: "pcm16-16k", language: "en-US" }))).code).toBe("invalid_request");
    expect(fish.calls).toEqual([]);
    expect(await failure(client.transcribe({ audio: pcm, format: "pcm16-16k" }))).toMatchObject({ code: "payment_required", status: 402 });
    // Raw PCM sent past the client is Fish's `invalid_audio`.
    fish.balanceUsd = 1;
    const form = new FormData();
    form.append("audio", new Blob([pcm]), "a.raw");
    const res = await keyed(fish)("https://api.fish.audio/v1/asr", { method: "POST", headers: { model: "transcribe-1" }, body: form });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_audio" });
  });
});

describe("the voice library", () => {
  test("voices and a voice, with Fish's fields mapped", async () => {
    const { client } = setup();
    const page = await client.voices({ pageSize: 2, sortBy: "task_count" });
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.voices.map((v) => v.title)).toEqual(["Calm narrator", "Bright companion"]);
    expect(await client.voice(VOICE)).toMatchObject({ id: VOICE, title: "Bright companion", languages: ["en", "ja"], author: { nickname: "kumo" }, taskCount: 45102 });
    expect((await failure(client.voice("nope"))).code).toBe("not_found");
    expect((await failure(client.voices({ pageSize: 0 }))).code).toBe("invalid_request");
  });
});
