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
import { uiSettingsFile, uiSettingsMethods } from "../../plugin-host/ui-settings";
import { validatePluginFolder } from "../../registry/validate";
import { voicesMethods } from "../rpc";
import { PIECE_BYTES, VoiceService, type VoicePlay } from "../service";
import { startCloverVoice, withCloverVoice } from "./clover-voice";
import * as fixture from "../../../../../scripts/acceptance/fixtures/acceptance-voice/host/index";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };
const user = (text: string) => ({ text, device: "studio0000000000000", sentAt: 1, clientMessageId: `m-${text}` });
const VOICE = "acceptance-voice";

async function side(opts: { voice?: boolean; module?: unknown; play?: (p: VoicePlay) => void } = {}) {
  const host = new FakePluginHost({ clock: new FakeClock() });
  host.define(VOICE, (opts.module ?? fixture) as never);
  const registry = { entries: withCloverVoice((point: string) => (point === "voices" ? [{ pluginId: VOICE, entryId: VOICE, state: "active", value: { name: "Acceptance voice", handler: "voice", speak: true } }] : [])) } as never;
  const played: VoicePlay[] = [];
  const b = await boot({
    home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, clock: new FakeClock(),
    voices: { registry, host, play: opts.play ?? ((p) => void played.push(p)) },
  });
  startCloverVoice(host, () => b.side.voiceSlot!);
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

describe("the mute, flipped while the daemon runs", () => {
  test("the stage's ui.set of voice.speakReplies (a clover-tree caller) takes at the next reply, both ways, and is announced", async () => {
    const { b, played, turn } = await side();
    const events: { type: string; settings?: { voice?: { speakReplies?: boolean } } }[] = [];
    const ui = uiSettingsMethods({ home: b.home, emit: (e) => void events.push(e) });
    const stage: Caller = { kind: "plugin", pluginId: "clover/character" };
    expect(await ui["ui.set"]!({ patch: { voice: { speakReplies: false } } }, { caller: stage })).toEqual({ applied: true });
    expect(events.at(-1)).toMatchObject({ type: "ui_settings_changed", settings: { voice: { speakReplies: false } } });
    await turn("Muted.");
    expect(played).toEqual([]);
    await ui["ui.set"]!({ patch: { voice: { speakReplies: true } } }, { caller: stage });
    await turn("Spoken again.");
    expect(played.filter((p) => p.final).length).toBe(1);
    await b.shutdown();
  });
});

describe("speaking never holds up a turn", () => {
  // Speaking starts after the turn's end is in the log and runs on its own: a voice that never answers, one that fails,
  // or an app that can't be sent the pieces leaves the reply where it was, the turn ended, and the next turn free.
  const hangs = { voice: { speak: async function* () { await new Promise<never>(() => {}); } } };
  const throws = { voice: { speak: async function* () { throw new Error("the voice service is down"); } } };
  const cases: [string, Parameters<typeof side>[0]][] = [
    ["its plugin never answers", { module: hangs }],
    ["its plugin fails", { module: throws }],
    ["the app can't be sent the pieces", { play: () => { throw new Error("the app's connection is gone"); } }],
  ];
  for (const [what, o] of cases) {
    test(`${what}: the reply and the turn's end are in the log at once, and the next turn runs`, async () => {
      const { b } = await side(o);
      for (const [n, reply] of ["First.", "Second."].entries()) {
        await b.host.sendUser("b_alpha", user(reply));
        const d = b.drivers.for("b_alpha");
        for (let i = 0; i < 20 && !d.running; i++) await flush();
        expect(d.running).toBe(true);
        d.emit({ type: "assistant_message", text: reply });
        d.end({ text: reply });
        await flush();
        const log = b.host.history("b_alpha");
        expect(log.some((r) => r.type === "driver" && r.event.type === "assistant_message" && r.event.text === reply)).toBe(true);
        expect(log.filter((r) => r.type === "turn_ended").map((r) => (r as { end: { reason: string } }).end.reason)).toEqual(Array(n + 1).fill("end_turn"));
        expect(b.host.turnOrigin("b_alpha")).toBeUndefined();
      }
      if (o !== undefined && o.module !== hangs) {
        for (let i = 0; i < 20 && !b.warnings.some((w) => w.includes("wasn't spoken")); i++) await flush();
        expect(b.warnings.filter((w) => w.includes("alpha's reply wasn't spoken")).length).toBe(1);
      }
      await b.shutdown();
    });
  }
});

describe("voice.speak: the user asks to hear one past reply", () => {
  /** A voice that says back what it was asked (the text it got, one piece), or as the test makes it. */
  const said: string[] = [];
  const echo = { voice: { speak: async function* (a: { text: string }) { said.push(a.text); yield { audio: new Uint8Array(8) }; } } };
  const muted = (home: string) => {
    const file = uiSettingsFile(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ picks: [], lists: [], voice: { speakReplies: false } }));
  };
  const seqOf = (b: Awaited<ReturnType<typeof side>>["b"], text: string, type = "assistant_message") =>
    b.host.history("b_alpha").find((r) => r.type === "driver" && r.event.type === type && r.event.text === text)!.seq;

  test("by its seq, the text read from the log, spoken with replies muted; the answer comes once the first piece went", async () => {
    said.length = 0;
    const { b, played, turn } = await side({ module: echo });
    muted(b.home);
    await turn("It's sunny in Kyoto.");
    expect(played).toEqual([]);
    const methods = voicesMethods({ voices: b.side.voices!, host: b.host });
    const r = await methods["voice.speak"]!({ session: "b_alpha", seq: seqOf(b, "Let me look.") }, { caller: theUser });
    expect(r).toEqual({ speaking: true });
    expect(said).toEqual(["Let me look."]);
    for (let i = 0; i < 20 && !played.some((p) => p.final); i++) await flush();
    expect(played.map((p) => [p.bot, p.session, p.seq, p.final])).toEqual([["alpha", "b_alpha", 0, false], ["alpha", "b_alpha", 1, true]]);
    await b.shutdown();
  });

  test("it replaces what the bot is saying: the utterance before ends with its final piece", async () => {
    const waiting: (() => void)[] = [];
    const slow = { voice: { speak: async function* (a: { text: string }) {
      yield { audio: new Uint8Array(8) };
      if (a.text === "Let me look.") await new Promise<void>((r) => waiting.push(r));
      yield { audio: new Uint8Array(8) };
    } } };
    const { b, played, turn } = await side({ module: slow });
    muted(b.home);
    await turn("Done.");
    const methods = voicesMethods({ voices: b.side.voices!, host: b.host });
    expect(await methods["voice.speak"]!({ session: "b_alpha", seq: seqOf(b, "Let me look.") }, { caller: theUser })).toEqual({ speaking: true });
    const first = played[0]!.utterance;
    expect(await methods["voice.speak"]!({ session: "b_alpha", seq: seqOf(b, "Done.") }, { caller: theUser })).toEqual({ speaking: true });
    for (const r of waiting.splice(0)) r();
    for (let i = 0; i < 20 && played.filter((p) => p.final).length < 2; i++) await flush();
    expect(played.filter((p) => p.utterance === first).map((p) => [p.seq, p.final])).toEqual([[0, false], [1, true]]);
    expect(played.filter((p) => p.utterance !== first).map((p) => [p.seq, p.final])).toEqual([[0, false], [1, false], [2, true]]);
    await b.shutdown();
  });

  test("nothing to speak is a plain note, never a silent nothing: no voice, a voice that fails, a voice that sends no sound", async () => {
    const quiet = await side({ voice: false });
    await quiet.turn("Text only.");
    const m1 = voicesMethods({ voices: quiet.b.side.voices!, host: quiet.b.host });
    expect(await m1["voice.speak"]!({ session: "b_alpha", seq: seqOf(quiet.b, "Text only.") }, { caller: theUser })).toEqual({ speaking: false, note: "This bot has no voice. Choose one in its settings to hear its replies." });
    await quiet.b.shutdown();

    const failing = await side({ module: { voice: { speak: async function* () { throw new Error("no Fish Audio key is set\nset one in Settings"); } } } });
    muted(failing.b.home);
    await failing.turn("Hello.");
    const m2 = voicesMethods({ voices: failing.b.side.voices!, host: failing.b.host });
    expect(await m2["voice.speak"]!({ session: "b_alpha", seq: seqOf(failing.b, "Hello.") }, { caller: theUser })).toEqual({ speaking: false, note: "Its voice couldn't speak this reply: no Fish Audio key is set set one in Settings" });
    await failing.b.shutdown();

    const silent = await side({ module: { voice: { speak: async function* () {} } } });
    muted(silent.b.home);
    await silent.turn("Hush.");
    const m3 = voicesMethods({ voices: silent.b.side.voices!, host: silent.b.host });
    expect(await m3["voice.speak"]!({ session: "b_alpha", seq: seqOf(silent.b, "Hush.") }, { caller: theUser })).toEqual({ speaking: false, note: "Its voice sent no sound for this reply." });
    await silent.b.shutdown();
  });

  test("only the user, only a reply of a bot's main conversation: another caller, a user's message, an unknown seq or session are refused", async () => {
    said.length = 0;
    const { b, turn } = await side({ module: echo });
    muted(b.home);
    await turn("Fine.");
    const methods = voicesMethods({ voices: b.side.voices!, host: b.host });
    const speak = (p: unknown, caller: Caller = theUser) => methods["voice.speak"]!(p, { caller });
    await expect(speak({ session: "b_alpha", seq: seqOf(b, "Fine.") }, { kind: "plugin", pluginId: "alpha" })).rejects.toThrow(/only the user/);
    const asked = b.host.history("b_alpha").find((r) => r.type === "input")!.seq;
    await expect(speak({ session: "b_alpha", seq: asked })).rejects.toThrow(/isn't one of alpha's replies/);
    await expect(speak({ session: "b_alpha", seq: 9999 })).rejects.toThrow(/isn't one of alpha's replies/);
    await expect(speak({ session: "nope", seq: 0 })).rejects.toThrow(/no session/);
    await expect(speak({ session: "b_alpha", seq: -1 })).rejects.toThrow();
    // The caller's own text is never what is spoken: the method takes none.
    await expect(speak({ session: "b_alpha", seq: seqOf(b, "Fine."), text: "Say this instead" })).resolves.toEqual({ speaking: true });
    expect(said).toEqual(["Fine."]);
    await b.shutdown();
  });
});

describe("voice.speak never waits on a card", () => {
  test("a provider that needs the user's OK answers at once with a note; a yes then speaks that reply, a no nothing", async () => {
    for (const yes of [true, false]) {
      const host = new FakePluginHost({ clock: new FakeClock() });
      const asked: string[] = [];
      host.define(VOICE, { voice: { speak: async function* (a: { text: string }) { asked.push(a.text); yield { audio: new Uint8Array(4) }; } } } as never);
      const played: VoicePlay[] = [];
      let answer!: (v: { ok: true } | { ok: false; reason: string }) => void;
      const voices = new VoiceService({
        registry: { entries: () => [{ pluginId: VOICE, entryId: VOICE, state: "active", value: { name: "Fish Audio", handler: "voice", speak: true } }] } as never,
        host, voiceOf: () => ({ provider: VOICE, voice: "tone" }), play: (p) => void played.push(p),
        // The consent check raises its card, then waits for the user's answer.
        mayUse: (_bot, at) => { at.origin === "user" && at.onAsk?.(); return new Promise((r) => { answer = r; }); },
      });
      const r = await voices.speakAsked({ bot: "alpha", session: "b_alpha", text: "It's sunny." });
      expect(r).toEqual({ speaking: false, note: "Answer the card to let Fish Audio speak." });
      expect(played).toEqual([]);
      answer(yes ? { ok: true } : { ok: false, reason: "no" });
      for (let i = 0; i < 20 && !played.some((p) => p.final); i++) await flush();
      expect([yes, asked, played.map((p) => p.final)]).toEqual(yes ? [true, ["It's sunny."], [false, true]] : [false, [], []]);
    }
  });

  test("a provider already allowed: no card, the 15 s first-piece wait as before", async () => {
    const host = new FakePluginHost({ clock: new FakeClock() });
    host.define(VOICE, { voice: { speak: async function* () { yield { audio: new Uint8Array(4) }; } } } as never);
    const voices = new VoiceService({
      registry: { entries: () => [{ pluginId: VOICE, entryId: VOICE, state: "active", value: { handler: "voice", speak: true } }] } as never,
      host, voiceOf: () => ({ provider: VOICE, voice: "tone" }), play: () => {}, mayUse: async () => ({ ok: true }),
    });
    expect(await voices.speakAsked({ bot: "alpha", session: "b_alpha", text: "Hi." })).toEqual({ speaking: true });
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
