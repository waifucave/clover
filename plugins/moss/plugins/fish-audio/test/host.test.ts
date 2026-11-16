// The plugin's host half (../host/index.ts): its `moss.voice.providers` entry speaks in the formats the app plays and
// writes down push-to-talk audio, with every request going through the keyed fetch it is handed, which adds the key.
import { describe, expect, test } from "bun:test";
import { FISH_SECRET, listen, ready, speak, speakChunks, type VoiceContext } from "../host/index";
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

describe("MOSS Voice's provider entry (speak) and the core's voices entry (listen)", () => {
  test("ready: set up with a key saved; not, with none (the keyed fetch's no_credential), and it says where to add it", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0 });
    expect(await ready({}, context(fish))).toEqual({ ready: true });
    const noKey: VoiceContext = {
      signal: new AbortController().signal,
      api: { net: { fetch: async () => { throw Object.assign(new Error("no key"), { code: "no_credential" }); } } },
    };
    expect(await ready({}, noKey)).toEqual({ ready: false, why: "add your Fish Audio API key in the Fish Audio plugin's settings" });
  });

  test("speaks with the free model as PCM at 24 kHz by default, asking the core for its key by name", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0 });
    const seen: { auth?: string | false }[] = [];
    const out = await drain(speakChunks({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f" }, context(fish, seen)));
    expect(out.result).toMatchObject({ model: "s2.1-pro-free", format: "pcm16-24k" });
    expect(out.values.length).toBeGreaterThan(0);
    const audio = joined(out.values);
    expect(audio.length % 2).toBe(0);
    expect(out.result.bytes).toBe(audio.length);
    expect(seen).toEqual([{ auth: "fish-api-key" }]);
    const mp3 = await drain(speakChunks({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", format: "mp3" }, context(fish)));
    expect(joined(mp3.values)[0]).toBe(0xff);
    await expect(drain(speakChunks({ text: "x", voice: "v", model: "s9" }, context(fish)))).rejects.toThrow("isn't a Fish Audio voice model");
    // The point's handler: raw bytes as they come, the same audio.
    const bytes: Uint8Array[] = [];
    for await (const b of await speak({ text: "Hello there.", voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f" }, context(fish))) bytes.push(b);
    expect(bytes.every((b) => b instanceof Uint8Array)).toBe(true);
    expect(bytes.reduce((n, b) => n + b.length, 0)).toBe(audio.length);
  });

  test("MOSS Voice's listen: the push-to-talk recording whole, written down", async () => {
    const fish = new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0, balanceUsd: 1 });
    const said = "What's on my calendar?";
    const spoken = joined((await drain(speakChunks({ text: said, voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", format: "pcm16-24k" }, context(fish)))).values);
    expect(await listen({ audio: spoken, format: "pcm16-16k", language: "en" }, context(fish))).toMatchObject({ text: said, languageCode: "en" });
    expect(fish.calls.at(-1)).toMatchObject({ path: "/v1/asr", billedModel: "transcribe-1", status: 200 });
    // Anything else it doesn't know is the cassette's transcript.
    const other = await listen({ audio: new Uint8Array(32_000), format: "pcm16-16k" }, context(fish));
    expect(other.text).toBe("Hello from the other side.");
    expect(other.duration).toBe(1);
    await expect(listen({ format: "pcm16-16k" }, context(fish))).rejects.toThrow("needs the recording");
  });
});
