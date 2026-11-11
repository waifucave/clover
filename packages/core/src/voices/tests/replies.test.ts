// A bot's replies spoken (../replies.ts) with the acceptance run's fixture voice (a generated tone, no key, no network),
// on the bot side as the daemon wires it: each reply of a main conversation goes to the app as `voice.play` pieces in
// order, the last `final`; the user's `voice.speakReplies: false` mutes it; `voice.stop` ends an utterance; a bot with no
// voice stays text-only. Temp homes, fake drivers.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { uiSettingsFile } from "../../plugin-host/ui-settings";
import { validatePluginFolder } from "../../registry/validate";
import { voicesMethods } from "../rpc";
import { PIECE_BYTES, VoiceService, type VoicePlay } from "../service";
import * as fixture from "../../../../../scripts/acceptance/fixtures/acceptance-voice/host/index";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };
const user = (text: string) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: `m-${text}` });
const VOICE = "acceptance-voice";

async function side(opts: { voice?: boolean } = {}) {
  const host = new FakePluginHost({ clock: new FakeClock() });
  host.define(VOICE, fixture as never);
  const registry = { entries: (point: string) => (point === "voices" ? [{ pluginId: VOICE, entryId: VOICE, state: "active", value: { name: "Acceptance voice", handler: "voice", speak: true } }] : []) } as never;
  const played: VoicePlay[] = [];
  const b = await boot({
    home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, clock: new FakeClock(),
    voices: { registry, host, play: (p) => void played.push(p) },
  });
  if (opts.voice !== false) await b.bots.setUserLayer("alpha", { voice: { provider: VOICE, voice: "tone" } }, theUser);
  else await b.bots.setUserLayer("alpha", { voice: null } as never, theUser).catch(() => undefined);
  /** One turn of Alpha's main conversation that ends with `reply`. */
  const turn = async (reply: string, end: Record<string, unknown> = {}) => {
    await b.host.sendUser("b_alpha", user(`ask ${Math.random()}`));
    const d = b.drivers.for("b_alpha");
    for (let i = 0; i < 20 && !d.running; i++) await flush();
    d.emit({ type: "assistant_message", text: "Let me look." });
    d.emit({ type: "assistant_message", text: reply });
    d.end({ text: reply, ...end });
    await flush();
    for (let i = 0; i < 20 && !played.some((p) => p.final && p.seq > 0); i++) await flush();
  };
  return { b, played, turn };
}

describe("a bot's replies, spoken", () => {
  test("a reply of the main conversation: its last message is spoken, the tone's pieces in order, then one final, all pcm16-24k", async () => {
    const { b, played, turn } = await side();
    await turn("It's sunny.");
    expect(played.map((p) => [p.bot, p.session, p.seq, p.final, p.format])).toEqual([
      ["alpha", "b_alpha", 0, false, "pcm16-24k"], ["alpha", "b_alpha", 1, false, "pcm16-24k"], ["alpha", "b_alpha", 2, false, "pcm16-24k"], ["alpha", "b_alpha", 3, true, "pcm16-24k"],
    ]);
    expect(new Set(played.map((p) => p.utterance)).size).toBe(1);
    // Each piece is the fixture's 0.2 s of 16-bit samples at 24 kHz; the last carries none.
    expect(played.map((p) => Buffer.from(p.audio, "base64").length)).toEqual([9600, 9600, 9600, 0]);
    await b.shutdown();
  });

  test("muted (`voice.speakReplies: false`), a cut-off turn, or a bot with no voice: nothing is spoken; unmuted, the next reply is", async () => {
    const { b, played, turn } = await side();
    const file = uiSettingsFile(b.home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ picks: [], lists: [], voice: { speakReplies: false } }));
    await turn("Muted.");
    expect(played).toEqual([]);
    writeFileSync(file, JSON.stringify({ picks: [], lists: [], voice: {} }));
    await turn("Cut off.", { reason: "max_tokens" });
    expect(played).toEqual([]);
    await turn("Spoken.");
    expect(played.filter((p) => p.final).length).toBe(1);
    await b.shutdown();

    const quiet = await side({ voice: false });
    await quiet.turn("Text only.");
    expect(quiet.played).toEqual([]);
    expect(quiet.b.warnings.filter((w) => w.includes("wasn't spoken")).length).toBeLessThanOrEqual(1);
    await quiet.b.shutdown();
  });
});

describe("the acceptance voice fixture", () => {
  test("validates as a plugin with one speaking voice, no network and no capability", async () => {
    const v = await validatePluginFolder(join(import.meta.dir, "..", "..", "..", "..", "..", "scripts", "acceptance", "fixtures", "acceptance-voice"));
    expect({ ok: v.ok, errors: v.issues.filter((i) => i.severity === "error") }).toEqual({ ok: true, errors: [] });
  });
});

describe("voice.stop and the pieces' size", () => {
  const service = (speak: (a: { text: string }) => AsyncGenerator<{ audio: Uint8Array }, unknown, undefined>) => {
    const host = new FakePluginHost({ clock: new FakeClock() });
    host.define(VOICE, { voice: { speak } } as never);
    const played: VoicePlay[] = [];
    const voices = new VoiceService({
      registry: { entries: () => [{ pluginId: VOICE, entryId: VOICE, state: "active", value: { handler: "voice", speak: true } }] } as never,
      host, voiceOf: () => ({ provider: VOICE, voice: "tone" }), play: (p) => void played.push(p),
    });
    return { voices, played };
  };

  test("the user's voice.stop ends the bot's utterance at once, with its final piece; a new utterance of the bot ends the one before", async () => {
    const waiting: (() => void)[] = [];
    const release = () => { for (const r of waiting.splice(0)) r(); };
    const { voices, played } = service(async function* () {
      yield { audio: new Uint8Array(4) };
      await new Promise<void>((r) => waiting.push(r));
      yield { audio: new Uint8Array(4) };
    });
    const methods = voicesMethods({ voices });
    const speaking = voices.speak({ bot: "alpha", session: "b_alpha", text: "a long reply" });
    for (let i = 0; i < 5 && played.length === 0; i++) await flush();
    expect(await methods["voice.stop"]!({ bot: "alpha" }, { caller: theUser })).toEqual({ ok: true });
    release();
    await speaking;
    expect(played.map((p) => [p.utterance === played[0]!.utterance, p.seq, p.final])).toEqual([[true, 0, false], [true, 1, true]]);
    // Only the user stops a bot's speech.
    await expect(methods["voice.stop"]!({ bot: "alpha" }, { caller: { kind: "plugin", pluginId: "x" } })).rejects.toThrow();

    played.length = 0;
    const first = voices.speak({ bot: "alpha", session: "b_alpha", text: "one" });
    for (let i = 0; i < 5 && played.length === 0; i++) await flush();
    const second = voices.speak({ bot: "alpha", session: "b_alpha", text: "two" });
    for (let i = 0; i < 10 && waiting.length < 2; i++) await flush();
    release();
    await first;
    // The first utterance ended (its final piece) without its second piece: the second replaced it.
    const firstId = played[0]!.utterance;
    expect(played.filter((p) => p.utterance === firstId).map((p) => [p.seq, p.final])).toEqual([[0, false], [1, true]]);
    for (let i = 0; i < 10 && waiting.length === 0; i++) await flush();
    release();
    await second;
    expect(played.filter((p) => p.utterance !== firstId).map((p) => [p.seq, p.final])).toEqual([[0, false], [1, false], [2, true]]);
  });

  test("a chunk larger than a piece goes in pieces of at most 2 MB of base64, each a whole number of samples", async () => {
    const { voices, played } = service(async function* () {
      yield { audio: new Uint8Array(PIECE_BYTES * 2 + 10) };
    });
    await voices.speak({ bot: "alpha", session: "b_alpha", text: "big" });
    const sizes = played.filter((p) => !p.final).map((p) => Buffer.from(p.audio, "base64").length);
    expect(sizes).toEqual([PIECE_BYTES, PIECE_BYTES, 10]);
    expect(played.every((p) => p.audio.length <= 2_000_000)).toBe(true);
    expect(PIECE_BYTES % 2).toBe(0);
  });
});
