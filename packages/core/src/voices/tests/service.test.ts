// The `voices` point in the core (../service.ts): speech streamed to the app piece by piece, push-to-talk audio
// streamed into the plugin, and a text-only bot refused with why. The plugin runs on the contracts' fake host.
import { afterEach, describe, expect, test } from "bun:test";
import { CLOVER_ERR, type Caller } from "@waifucave/clover-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { MethodError } from "../../bots/rpc";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { voicesMethods } from "../rpc";
import { VoiceService, type VoicePlay } from "../service";

const VOICE_PLUGIN = "clover/fish-audio";

afterEach(() => removeTemps());

function setup(opts: { speak?: boolean; listen?: boolean; voice?: boolean; listenIdleMs?: number } = {}) {
  const host = new FakePluginHost({ clock: new FakeClock() });
  const heard: Uint8Array[] = [];
  const spoke: unknown[] = [];
  host.define(VOICE_PLUGIN, {
    voice: {
      speak: async function* (a: { text: string }) {
        spoke.push(a);
        for (const word of a.text.split(" ")) yield { audio: new TextEncoder().encode(word) };
        return { bytes: a.text.length };
      },
      listen: async function* (_a: unknown, ctx: { input?: AsyncIterable<unknown> }) {
        for await (const piece of ctx.input!) heard.push(piece as Uint8Array);
        return { text: heard.map((p) => new TextDecoder().decode(p)).join(" ") };
      },
    },
  } as never);
  const registry = {
    entries: () => [{ pluginId: VOICE_PLUGIN, entryId: "fish-audio", state: "active", value: { name: "Fish Audio", handler: "voice", speak: opts.speak ?? true, listen: opts.listen ?? true } }],
  } as never;
  const played: VoicePlay[] = [];
  const warned: string[] = [];
  const voices = new VoiceService({
    registry, host, warn: (m) => warned.push(m),
    ...(opts.listenIdleMs === undefined ? {} : { listenIdleMs: opts.listenIdleMs }),
    voiceOf: (bot) => (opts.voice === false || bot !== "alpha" ? undefined : { provider: "fish-audio", voice: "v1", model: "s2.1-pro-free" }),
    play: (p) => {
      played.push(p);
    },
  });
  return { voices, played, spoke, heard, host, registry, warned };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("the voices point", () => {
  test("a bot's text is spoken piece by piece to the app, the last marked final", async () => {
    const { voices, played, spoke } = setup();
    const r = await voices.speak({ bot: "alpha", session: "b_alpha", text: "good morning everyone" });
    expect(spoke).toEqual([{ text: "good morning everyone", voice: "v1", model: "s2.1-pro-free", format: "pcm16-24k" }]);
    expect(played.map((p) => [p.seq, Buffer.from(p.audio, "base64").toString(), p.final])).toEqual([[0, "good", false], [1, "morning", false], [2, "everyone", false], [3, "", true]]);
    expect(new Set(played.map((p) => p.utterance))).toEqual(new Set([r.utterance]));
    expect(r.bytes).toBe("goodmorningeveryone".length);
  });

  test("push-to-talk pieces stream into the plugin; the last piece's answer is what it heard", async () => {
    const { voices } = setup();
    expect(await voices.listen({ bot: "alpha", utterance: "u1", seq: 0, audio: b64("what's"), format: "pcm16-16k", final: false })).toEqual({});
    await expect(voices.listen({ bot: "alpha", utterance: "u1", seq: 5, audio: b64("x"), format: "pcm16-16k", final: false })).rejects.toThrow("expected piece 1");
    expect(await voices.listen({ bot: "alpha", utterance: "u1", seq: 1, audio: b64("up"), format: "pcm16-16k", final: true })).toEqual({ text: "what's up" });
  });

  test("a text-only bot, or a plugin that can't, is refused with why", async () => {
    await expect(setup({ voice: false }).voices.speak({ bot: "alpha", session: "b_alpha", text: "hi" })).rejects.toThrow("text-only");
    await expect(setup({ speak: false }).voices.speak({ bot: "alpha", session: "b_alpha", text: "hi" })).rejects.toThrow("doesn't speak");
    await expect(setup({ listen: false }).voices.listen({ bot: "alpha", utterance: "u", seq: 0, audio: "", format: "opus", final: true })).rejects.toThrow("doesn't listen");
  });

  test("voice.listen is the user's", async () => {
    const { voices } = setup();
    const m = voicesMethods({ voices })["voice.listen"]!;
    const plugin: Caller = { kind: "plugin", pluginId: "clover/pill" };
    const err = await m({ bot: "alpha", utterance: "u2", seq: 0, audio: b64("hi"), format: "pcm16-16k", final: true }, { caller: plugin }).catch((e: unknown) => e);
    expect(err instanceof MethodError && err.code).toBe(CLOVER_ERR.NOT_THE_USER);
    expect(await m({ bot: "alpha", utterance: "u3", seq: 0, audio: b64("hi"), format: "pcm16-16k", final: true }, { caller: { kind: "user", client: "app" } })).toEqual({ text: "hi" });
  });

  test("an utterance whose last piece never comes is dropped, and its plugin call ends", async () => {
    const { voices, warned } = setup({ listenIdleMs: 20 });
    expect(await voices.listen({ bot: "alpha", utterance: "u4", seq: 0, audio: b64("hel"), format: "pcm16-16k", final: false })).toEqual({});
    await new Promise((r) => setTimeout(r, 60));
    expect(warned).toEqual(["alpha's utterance u4 was dropped: no piece came for 0 s"]);
    await expect(voices.listen({ bot: "alpha", utterance: "u4", seq: 1, audio: b64("lo"), format: "pcm16-16k", final: true })).rejects.toThrow("starts at piece 0");
  });

  test("on the bot side, a bot speaks with its effective voice: text-only until its user layer gives it one", async () => {
    const { host, registry } = setup();
    const played: VoicePlay[] = [];
    const b = await boot({
      home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs,
      voices: { registry, host, play: (p) => void played.push(p) },
    });
    const listen = b.side.methods({ localDevice: "studio" })["voice.listen"]!;
    const theUser: Caller = { kind: "user", client: "app" };
    const piece = { bot: "alpha", utterance: "u5", seq: 0, audio: b64("hi"), format: "pcm16-16k", final: true };
    const refused = await listen(piece, { caller: theUser }).catch((e: unknown) => e);
    expect(String((refused as Error).message)).toContain("text-only");
    await b.bots.setUserLayer("alpha", { voice: { provider: "fish-audio", voice: "v2" } }, theUser);
    expect(await listen({ ...piece, utterance: "u6" }, { caller: theUser })).toEqual({ text: "hi" });
    await b.side.voices!.speak({ bot: "alpha", session: "b_alpha", text: "hello there" });
    expect(played.at(-1)).toMatchObject({ bot: "alpha", final: true });
    await b.shutdown();
  });
});
