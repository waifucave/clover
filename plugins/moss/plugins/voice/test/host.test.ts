// MOSS Voice's host half against a fake plugin API: a bot's main-conversation reply (the message.out observer, then the
// turn's end) streams its provider's audio to the player part; nothing for a side thread, a failed turn, a bot with no
// voice or "Speak replies" off; the voice the user picked (the active filler of its own `moss.voice.modes`) is handed the reply
// instead; the default voice a plugin gives the bot it brings (the user's choice wins; it speaks only with a provider set up);
// the speak button reads the reply from the log; the player's stops and holds go as whole-state `ui.send` messages.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as host from "../host/index";
import type { HookInput } from "@waifucave/moss-plugin-sdk";

type Fake = {
  settings?: Record<string, unknown>; modes?: unknown[]; defaults?: unknown[]; history?: Record<string, unknown>[];
  active?: { pluginId: string; entryId: string }; ready?: { ready: boolean; why?: string }; refuseFirstOpen?: boolean;
  /** Extra provider entries, besides the run's tone voice. */
  providers?: { pluginId: string; entryId: string; value: Record<string, unknown> }[];
  /** The run's tone voice offers `listen`. */
  providerListens?: boolean;
};
function fake(o: Fake = {}) {
  const settings = new Map<string, unknown>(Object.entries(o.settings ?? {}));
  const opened: { name: string; meta: Record<string, unknown>; bytes: number; closed: boolean }[] = [];
  const asked: { point: string; args: unknown; plugin?: string }[] = [];
  const sent: [string, unknown][] = [];
  const accepted = new Map<string, (stream: unknown, meta: Record<string, unknown>) => void>();
  let refuse = o.refuseFirstOpen === true;
  const provider = { pluginId: "acceptance-voice", entryId: "acceptance-voice", value: { name: "Tone", ...(o.ready ? { ready: "ready" } : {}), ...(o.providerListens ? { listen: "listen" } : {}) } };
  const api = {
    plugin: { id: "moss/voice" },
    settings: {
      get: async (key: string, opts?: { bot?: string }) => settings.get(opts?.bot ? `${key}@${opts.bot}` : key),
      set: async (key: string, value: unknown, opts?: { bot?: string }) => void settings.set(opts?.bot ? `${key}@${opts.bot}` : key, value),
    },
    points: {
      entries: async (point: string) => (point === host.PROVIDERS ? [provider, ...(o.providers ?? [])] : point === host.DEFAULTS ? (o.defaults ?? []) : (o.modes ?? [])),
      active: async (point: string) => (point === host.MODES ? (o.active ?? { pluginId: "moss/voice", entryId: "moss-voice" }) : undefined),
      stream: async (point: string, e: { pluginId: string }, field: string, args: unknown) => {
        asked.push({ point: `${point}#${field}`, args, ...(e.pluginId !== "acceptance-voice" ? { plugin: e.pluginId } : {}) });
        // Plain stand-ins for the Web streams (this suite's document stands in for the browser's globals).
        const queue = [new Uint8Array(4800), new Uint8Array(4800)];
        return { getReader: () => ({ read: async () => (queue.length > 0 ? { done: false, value: queue.shift()! } : { done: true, value: undefined }), cancel: async () => undefined }) };
      },
      call: async (point: string, _e: unknown, field: string, args: unknown) => {
        asked.push({ point: `${point}#${field}`, args });
        if (field === "listen" || field === "hear") return { text: `heard ${(args as { audio: Uint8Array }).audio.length} bytes by ${field}` };
        return field === "ready" ? o.ready : { ok: true };
      },
    },
    streams: {
      accept: (name: string, listener: (stream: unknown, meta: Record<string, unknown>) => void) => { accepted.set(name, listener); return () => undefined; },
      open: async (name: string, opts: { meta: Record<string, unknown> }) => {
        if (refuse) {
          refuse = false;
          throw new Error(`moss/voice has no component accepting a stream named "${name}"`);
        }
        const rec = { name, meta: opts.meta, bytes: 0, closed: false };
        opened.push(rec);
        return { close: async () => { rec.closed = true; }, getWriter: () => ({ write: async (c: Uint8Array) => { rec.bytes += c.length; }, close: async () => { rec.closed = true; }, abort: async () => undefined }) };
      },
    },
    ui: { send: (event: string, data: unknown) => void sent.push([event, data]) },
    conversation: {
      get: async (session: string) => ({ id: session, kind: session.startsWith("b_") ? "bot" : "side-thread", bot: "alpha" }),
      history: async () => ({ events: o.history ?? [], hasMore: false }),
    },
  };
  host.start(api as never);
  return { opened, asked, settings, sent, accepted };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const at = (event: "message.out" | "turn.end", extra: Partial<HookInput> = {}, kind: "bot" | "side-thread" = "bot"): HookInput =>
  ({ event, session: { id: kind === "bot" ? "b_alpha" : "t_alpha", kind, caller: { kind: "user" } }, bot: "alpha", computer: "c", ...extra }) as HookInput;
const VOICED = { "provider@alpha": "acceptance-voice", "voice@alpha": "tone" };

describe("MOSS Voice's host half", () => {
  test("a reply stored then its turn completed: the provider's audio streams to the player part", async () => {
    const f = fake({ settings: VOICED });
    await host.replies(at("message.out", { text: "Hello there." }));
    await host.replies(at("turn.end", { outcome: "completed", text: "Hello there." }));
    await settle();
    expect(f.asked).toEqual([{ point: `${host.PROVIDERS}#speak`, args: { text: "Hello there.", voice: "tone", format: "pcm16-24k" } }]);
    expect(f.opened.map((s) => [s.name, s.meta.bot, s.meta.asked, s.bytes, s.closed])).toEqual([["speech", "alpha", false, 9600, true]]);
  });

  test("nothing for a side thread, a failed turn, a bot with no voice, or Speak replies off", async () => {
    let f = fake({ settings: VOICED });
    await host.replies(at("message.out", { text: "x" }, "side-thread"));
    await host.replies(at("turn.end", { outcome: "completed", text: "x" }, "side-thread"));
    await host.replies(at("message.out", { text: "y" }));
    await host.replies(at("turn.end", { outcome: "failed", text: "boom" }));
    await settle();
    expect(f.opened).toEqual([]);
    f = fake();
    await host.replies(at("message.out", { text: "z" }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened).toEqual([]);
    f = fake({ settings: { ...VOICED, speakReplies: false } });
    await host.replies(at("message.out", { text: "z" }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened).toEqual([]);
  });

  test("the voice the user picked (another plugin's active moss.voice.modes entry) is handed the reply; MOSS Voice's player gets nothing", async () => {
    const f = fake({ settings: VOICED, active: { pluginId: "acme-voice", entryId: "acme" }, modes: [{ pluginId: "acme-voice", entryId: "acme", value: { name: "Acme", reply: "reply" } }] });
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.asked).toEqual([{ point: `${host.MODES}#reply`, args: { bot: "alpha", session: "b_alpha", text: "Hi.", asked: false } }]);
    expect(f.opened).toEqual([]);
  });

  test("the speak button reads the reply from the log and speaks it, asked; a note when it can't", async () => {
    const f = fake({ settings: VOICED, history: [{ seq: 7, type: "assistant_message", text: "Again, please." }] });
    expect(await host.ui.speak({ session: "b_alpha", seq: 7 })).toEqual({ ok: true });
    await settle();
    expect(f.opened.map((s) => [s.meta.asked, s.bytes])).toEqual([[true, 9600]]);
    expect(await host.ui.speak({ session: "b_alpha", seq: 3 })).toEqual({ note: "That isn't one of the bot's replies." });
    fake({ history: [{ seq: 7, type: "assistant_message", text: "x" }] });
    expect(await host.ui.speak({ session: "b_alpha", seq: 7 })).toEqual({ note: "This bot has no voice. Choose one in its settings to hear its replies." });
  });

  test("a bot's voice for its parts, its reset, and the chip's stop", async () => {
    const f = fake({ settings: { ...VOICED, "model@alpha": "s2" } });
    expect(await host.ui.voiceOf({ bot: "alpha" })).toEqual({ provider: "acceptance-voice", plugin: "acceptance-voice", voice: "tone", model: "s2", from: "user" });
    await host.ui.forget({ bot: "alpha" });
    expect(await host.ui.voiceOf({ bot: "alpha" })).toBeNull();
    await host.ui.stop({ bot: "alpha" });
    await settle();
    await host.ui.stop({ bot: "alpha" });
    await host.ui.stop({ bot: "beta" });
    // Each message carries the whole state: the newest is all the player needs.
    expect(f.sent).toEqual([["stops", { alpha: 1 }], ["stops", { alpha: 2 }], ["stops", { alpha: 2, beta: 1 }]]);
    expect(await host.ui.ready()).toEqual({ holds: [], stops: { alpha: 2, beta: 1 } });
  });

  test("the default voice a plugin gives the bot it brings: used until the user chooses one; another plugin's default for it is ignored", async () => {
    const defaults = [
      { pluginId: "beta", entryId: "0", value: { provider: "acceptance-voice", voice: "not-hers" } },
      { pluginId: "alpha/extras", entryId: "0", value: { provider: "acceptance-voice", voice: "hers", model: "m1" } },
    ];
    let f = fake({ defaults, ready: { ready: true } });
    expect(await host.voiceOf("alpha")).toEqual({ provider: "acceptance-voice", voice: "hers", model: "m1", from: "bot" });
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened.map((s) => [s.name, s.meta.bot])).toEqual([["speech", "alpha"]]);
    f = fake({ defaults, settings: VOICED });
    expect(await host.voiceOf("alpha")).toEqual({ provider: "acceptance-voice", plugin: "acceptance-voice", voice: "tone", from: "user" });
    f = fake({ defaults: [defaults[0]] });
    expect(await host.voiceOf("alpha")).toBeUndefined();
  });

  test("a provider that doesn't say whether it is set up doesn't count for a default; the user's own pick may use it", async () => {
    const defaults = [{ pluginId: "alpha", entryId: "0", value: { provider: "acceptance-voice", voice: "hers" } }];
    const f = fake({ defaults });
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened).toEqual([]);
    expect((await host.ui.voiceOf({ bot: "alpha" }))?.why).toContain("doesn't say whether you set it up");
    const g = fake({ settings: VOICED });
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(g.opened.map((s) => s.name)).toEqual(["speech"]);
  });

  test("a pick is tied to the plugin whose entry it named, the first time it is read; a twin installed later doesn't take it", async () => {
    const f = fake({ settings: VOICED });
    expect(await host.voiceOf("alpha")).toEqual({ provider: "acceptance-voice", plugin: "acceptance-voice", voice: "tone", from: "user" });
    expect(f.settings.get("providerPlugin@alpha")).toBe("acceptance-voice");
  });

  test("a provider is found by its plugin and its entry: another plugin's entry of the same id never gets the text", async () => {
    const twin = { pluginId: "mimic", entryId: "acceptance-voice", value: { name: "Mimic", ready: "ready" } };
    let f = fake({ settings: VOICED, providers: [twin] });
    expect(await host.say({ bot: "alpha", session: "b_alpha", text: "Hi.", asked: true })).toEqual({ speaking: false, note: 'More than one plugin offers a voice provider "acceptance-voice"; choose which in the bot\'s voice. This reply can\'t be spoken.' });
    expect(f.asked).toEqual([]);
    f = fake({ settings: { ...VOICED, "providerPlugin@alpha": "acceptance-voice" }, providers: [twin] });
    await host.say({ bot: "alpha", session: "b_alpha", text: "Hi.", asked: true });
    await settle();
    expect(f.asked.map((a) => [a.point, a.plugin])).toEqual([[`${host.PROVIDERS}#speak`, undefined]]);
    // The readiness of one isn't the other's: a default naming the twin's plugin asks the twin.
    f = fake({ defaults: [{ pluginId: "alpha", entryId: "0", value: { provider: "acceptance-voice", plugin: "mimic", voice: "hers" } }], providers: [twin], ready: { ready: false, why: "no key" } });
    expect((await host.ui.voiceOf({ bot: "alpha" }))?.why).toBe("Mimic isn't set up: no key");
  });

  test("no voice for one bot: none of its replies are spoken or heard, kept as the user's own bot setting", async () => {
    const f = fake({ settings: { ...VOICED, "providerPlugin@alpha": "acceptance-voice" }, providerListens: true });
    expect(await host.ui.listens({ bot: "alpha" })).toBe(true);
    expect(await host.ui.setOff({ bot: "alpha", off: true })).toEqual({ ok: true });
    expect(f.settings.get("silent@alpha")).toBe(true);
    expect(await host.ui.voiceOf({ bot: "alpha" })).toEqual({ provider: "acceptance-voice", plugin: "acceptance-voice", voice: "tone", from: "user", off: true });
    expect(await host.ui.listens({ bot: "alpha" })).toBe(false);
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened).toEqual([]);
    await host.ui.setOff({ bot: "alpha", off: false });
    expect(f.settings.get("silent@alpha")).toBeNull();
    expect((await host.ui.voiceOf({ bot: "alpha" }))?.off).toBeUndefined();
  });

  test("a default voice from a provider the user hasn't set up doesn't speak, and its Voice section says why", async () => {
    const defaults = [{ pluginId: "alpha", entryId: "0", value: { provider: "acceptance-voice", voice: "hers" } }];
    const f = fake({ defaults, ready: { ready: false, why: "add your Tone key in its settings" } });
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened).toEqual([]);
    expect(f.asked.map((a) => a.point)).toEqual([`${host.PROVIDERS}#ready`]);
    expect(await host.ui.voiceOf({ bot: "alpha" })).toEqual({ provider: "acceptance-voice", voice: "hers", from: "bot", why: "Tone isn't set up: add your Tone key in its settings" });
    // Set up: it speaks.
    const g = fake({ defaults, ready: { ready: true } });
    expect(await host.ui.voiceOf({ bot: "alpha" })).toEqual({ provider: "acceptance-voice", voice: "hers", from: "bot" });
    await host.replies(at("message.out", { text: "Hi." }));
    await host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(g.opened.map((s) => s.name)).toEqual(["speech"]);
  });

  test("push-to-talk from its own talk button: the recording streamed in is written down by the bot's provider; the player holds meanwhile", async () => {
    const f = fake({ settings: VOICED, providers: [] });
    // The run's tone voice listens once its entry offers `listen`.
    expect(await host.ui.listens({ bot: "alpha" })).toBe(false);
    const g = fake({ settings: { ...VOICED, "providerPlugin@alpha": "acceptance-voice" }, providerListens: true });
    expect(await host.ui.listens({ bot: "alpha" })).toBe(true);
    const chunks = [new Uint8Array(3200), new Uint8Array(3200)];
    const stream = { getReader: () => ({ read: async () => (chunks.length > 0 ? { done: false, value: chunks.shift()! } : { done: true, value: undefined }), cancel: async () => undefined }), cancel: async () => undefined };
    g.accepted.get("talk")!(stream, { bot: "alpha", utterance: "u1" });
    expect(await host.ui.heard({ utterance: "u1" })).toEqual({ text: "heard 6400 bytes by listen" });
    expect(g.sent).toEqual([["holds", { utterances: ["u1"] }], ["holds", { utterances: [] }]]);
    expect(g.asked.map((a) => a.point)).toEqual([`${host.PROVIDERS}#listen`]);
    expect(await host.ui.heard({ utterance: "u1" })).toEqual({ note: "That recording isn't here." });
    void f;
  });

  test("another plugin's voice, picked in Settings, hears too (its hear); one with no hear doesn't listen", async () => {
    const f = fake({ active: { pluginId: "acme-voice", entryId: "acme" }, modes: [{ pluginId: "acme-voice", entryId: "acme", value: { name: "Acme", hear: "hear" } }] });
    expect(await host.ui.listens({ bot: "alpha" })).toBe(true);
    expect(await host.transcribe({ bot: "alpha", audio: new Uint8Array(10) })).toEqual({ ok: true, text: "heard 10 bytes by hear" });
    expect(f.asked.map((a) => [a.point, (a.args as { bot?: string }).bot])).toEqual([[`${host.MODES}#hear`, "alpha"]]);
    fake({ active: { pluginId: "acme-voice", entryId: "acme" }, modes: [{ pluginId: "acme-voice", entryId: "acme", value: { name: "Acme" } }] });
    expect(await host.ui.listens({ bot: "alpha" })).toBe(false);
  });

  test("its held key binding (push-to-talk, Ctrl+Shift+Space): the key's down and up go on to its talk buttons; run with no key it does nothing", async () => {
    const f = fake();
    expect(host.pushToTalk({ key: "down" })).toEqual({ ok: true });
    expect(host.pushToTalk({ key: "up" })).toEqual({ ok: true });
    expect(host.pushToTalk({ key: "cancel" })).toEqual({ ok: true });
    expect(host.pushToTalk({})).toEqual({ ok: false });
    expect(host.pushToTalk({ key: "sideways" })).toEqual({ ok: false });
    expect(host.pushToTalk(null)).toEqual({ ok: false });
    expect(f.sent).toEqual([["talk-down", {}], ["talk-up", {}], ["talk-cancel", {}]]);
  });

  test("each of its points' fills lines warns: a filler is sent what the user says, and what it writes down goes as the user's message unseen", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "moss.json"), "utf8")) as { host: { declares: Record<string, { fills?: { ok: string; warns?: boolean } }> } };
    for (const point of [host.PROVIDERS, host.MODES, host.DEFAULTS]) expect([point, manifest.host.declares[point]?.fills?.warns]).toEqual([point, true]);
  });

  test("its manifest binds Ctrl+Shift+Space as a held key to that handler", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "moss.json"), "utf8")) as { contributes: { commands?: Record<string, unknown>[] } };
    expect(manifest.contributes.commands).toEqual([expect.objectContaining({ name: "push-to-talk", handler: "pushToTalk", key: "ctrl+shift+space", hold: true })]);
  });

  test("push-to-talk's holds go to the player as the whole set; the player's ready answers the state so far", async () => {
    const f = fake({ settings: { ...VOICED, "providerPlugin@alpha": "acceptance-voice" }, providerListens: true });
    /** A recording that lasts until `end`. */
    const held = () => {
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      const stream = { getReader: () => ({ read: async () => { await ended; return { done: true, value: undefined }; }, cancel: async () => undefined }), cancel: async () => undefined };
      return { end, stream };
    };
    const one = held();
    const two = held();
    f.accepted.get("talk")!(one.stream, { bot: "alpha", utterance: "u1" });
    f.accepted.get("talk")!(two.stream, { bot: "alpha", utterance: "u2" });
    expect(await host.ui.ready()).toEqual({ holds: ["u1", "u2"], stops: {} });
    one.end();
    await host.ui.heard({ utterance: "u1" });
    expect(f.sent).toEqual([["holds", { utterances: ["u1"] }], ["holds", { utterances: ["u1", "u2"] }], ["holds", { utterances: ["u2"] }]]);
    two.end();
    await host.ui.heard({ utterance: "u2" });
  });

  test("a reply before the player's frame accepts speech waits for its ready, then goes to it", async () => {
    const f = fake({ settings: VOICED, refuseFirstOpen: true });
    await host.replies(at("message.out", { text: "Early." }));
    const ended = host.replies(at("turn.end", { outcome: "completed" }));
    await settle();
    expect(f.opened).toEqual([]);
    await host.ui.ready();
    await ended;
    await settle();
    expect(f.opened.map((s) => [s.name, s.bytes, s.closed])).toEqual([["speech", 9600, true]]);
  });
});
