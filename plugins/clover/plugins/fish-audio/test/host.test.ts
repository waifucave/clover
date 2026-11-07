// The plugin's host half (../host/index.ts): its `voices` handler speaks in the formats the app plays and listens to
// push-to-talk audio, with every request going through the keyed fetch it is handed, which adds the key.
import { describe, expect, test } from "bun:test";
import { FISH_SECRET, voice, type VoiceContext } from "../host/index";
import { FakeFish } from "./fake-fish";

const KEY = "test-key-not-a-secret";

function context(fish: FakeFish, seen: { auth?: string | false }[] = []): VoiceContext {
  return {
    signal: new AbortController().signal,
    api: {
      net: {
        fetch: (url, init = {}, opts = {}) => {
          seen.push(opts);
          const headers = new Headers(init.headers);
          if (opts.auth === FISH_SECRET) headers.set("authorization", `Bearer ${KEY}`);
          return fish.fetch(url, { ...init, headers });
        },
      },
    },
  };
}

/** Runs a streamed handler as the plugin host does: its values in order, then its return value. */
async function drain<T, R>(gen: AsyncGenerator<T, R, undefined>): Promise<{ values: T[]; result: R }> {
  const values: T[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { values, result: next.value };
    values.push(next.value);
  }
}

const joined = (chunks: { audio: Uint8Array }[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.audio.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c.audio, at);
    at += c.audio.length;
  }
  return out;
};

describe("the voices handler (lane B's streaming shape)", () => {
  test("speaks with the free model as PCM at 24 kHz by default, asking the core for its key by name", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0 });
    const seen: { auth?: string | false }[] = [];
    const out = await drain(voice.speak({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f" }, context(fish, seen)));
    expect(out.result).toMatchObject({ model: "s2.1-pro-free", format: "pcm16-24k" });
    expect(out.values.length).toBeGreaterThan(0);
    const audio = joined(out.values);
    expect(audio.length % 2).toBe(0);
    expect(out.result.bytes).toBe(audio.length);
    expect(seen).toEqual([{ auth: "fish-api-key" }]);
    const mp3 = await drain(voice.speak({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", format: "mp3" }, context(fish)));
    expect(joined(mp3.values)[0]).toBe(0xff);
    await expect(drain(voice.speak({ text: "x", voice: "v", model: "s9" }, context(fish)))).rejects.toThrow("isn't a Fish Audio voice model");
  });

  test("listens to push-to-talk PCM, whole or as the call's input", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0, balanceUsd: 1 });
    const said = "What's on my calendar?";
    const spoken = joined((await drain(voice.speak({ text: said, voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", format: "pcm16-24k" }, context(fish)))).values);
    // The fake hears back the PCM it spoke; the handler wraps PCM in WAV, since Fish refuses raw PCM.
    const heard = await drain(voice.listen({ audio: spoken, format: "pcm16-16k", language: "en" }, context(fish)));
    expect(heard.values).toEqual([]);
    expect(heard.result).toMatchObject({ text: said, languageCode: "en" });
    expect(fish.calls.at(-1)).toMatchObject({ path: "/v1/asr", billedModel: "transcribe-1", status: 200 });
    // The recording as it was made, in chunks.
    async function* mic() {
      yield spoken.subarray(0, 1000);
      yield spoken.subarray(1000);
    }
    const streamed = await drain(voice.listen({ format: "pcm16-16k", language: "en" }, { ...context(fish), input: mic() }));
    expect(streamed.result.text).toBe(said);
    // Anything else it doesn't know is the cassette's transcript.
    const other = await drain(voice.listen({ audio: new Uint8Array(32_000), format: "pcm16-16k" }, context(fish)));
    expect(other.result.text).toBe("Hello from the other side.");
    expect(other.result.duration).toBe(1);
    await expect(drain(voice.listen({ format: "pcm16-16k" }, context(fish)))).rejects.toThrow("needs the recording");
  });
});
