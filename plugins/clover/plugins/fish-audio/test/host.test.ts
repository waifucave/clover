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

describe("the voices handler", () => {
  test("speaks with the free model as PCM at 24 kHz by default, asking the core for its key by name", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0 });
    const seen: { auth?: string | false }[] = [];
    const out = await voice.speak({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f" }, context(fish, seen));
    expect(out).toMatchObject({ model: "s2.1-pro-free", format: "pcm16-24k" });
    expect(out.audio.length % 2).toBe(0);
    expect(seen).toEqual([{ auth: "fish-api-key" }]);
    const mp3 = await voice.speak({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", format: "mp3" }, context(fish));
    expect(mp3.audio[0]).toBe(0xff);
    await expect(voice.speak({ text: "x", voice: "v", model: "s9" }, context(fish))).rejects.toThrow("isn't a Fish Audio voice model");
  });

  test("listens to push-to-talk PCM", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0, balanceUsd: 1 });
    const said = "What's on my calendar?";
    const spoken = await voice.speak({ text: said, voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", format: "pcm16-24k" }, context(fish));
    // The fake hears back the PCM it spoke; the handler wraps PCM in WAV, since Fish refuses raw PCM.
    const heard = await voice.listen({ audio: spoken.audio, format: "pcm16-16k", language: "en" }, context(fish));
    expect(heard).toMatchObject({ text: said, languageCode: "en" });
    expect(fish.calls.at(-1)).toMatchObject({ path: "/v1/asr", billedModel: "transcribe-1", status: 200 });
    // Anything else it doesn't know is the cassette's transcript.
    const other = await voice.listen({ audio: new Uint8Array(32_000), format: "pcm16-16k" }, context(fish));
    expect(other.text).toBe("Hello from the other side.");
    expect(other.duration).toBe(1);
  });
});
