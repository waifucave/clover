// Clover Voice's host half against a fake plugin API: a bot's main-conversation reply (the message.out observer, then the
// turn's end) streams its provider's audio to the player part; nothing for a side thread, a failed turn, a bot with no
// voice or "Speak replies" off; a voice mode the user chose is handed the reply instead; the speak button reads the reply
// from the log; push-to-talk holds the player.
import { describe, expect, test } from "bun:test";
import * as host from "../host/index";
import type { HookInput } from "@waifucave/clover-plugin-sdk";

function fake(o: { settings?: Record<string, unknown>; modes?: unknown[]; history?: Record<string, unknown>[] } = {}) {
  const settings = new Map<string, unknown>(Object.entries(o.settings ?? {}));
  const opened: { name: string; meta: Record<string, unknown>; bytes: number; closed: boolean }[] = [];
  const asked: { point: string; args: unknown }[] = [];
  const api = {
    plugin: { id: "clover/voice" },
    settings: {
      get: async (key: string, opts?: { bot?: string }) => settings.get(opts?.bot ? `${key}@${opts.bot}` : key),
      set: async (key: string, value: unknown, opts?: { bot?: string }) => void settings.set(opts?.bot ? `${key}@${opts.bot}` : key, value),
    },
    points: {
      entries: async (point: string) => (point === host.PROVIDERS ? [{ pluginId: "acceptance-voice", entryId: "acceptance-voice", value: { name: "Tone" } }] : (o.modes ?? [])),
      stream: async (point: string, _e: unknown, field: string, args: unknown) => {
        asked.push({ point: `${point}#${field}`, args });
        // Plain stand-ins for the Web streams (this suite's document stands in for the browser's globals).
        const queue = [new Uint8Array(4800), new Uint8Array(4800)];
        return { getReader: () => ({ read: async () => (queue.length > 0 ? { done: false, value: queue.shift()! } : { done: true, value: undefined }), cancel: async () => undefined }) };
      },
      call: async (point: string, _e: unknown, field: string, args: unknown) => { asked.push({ point: `${point}#${field}`, args }); return { ok: true }; },
    },
    streams: {
      open: async (name: string, opts: { meta: Record<string, unknown> }) => {
        const rec = { name, meta: opts.meta, bytes: 0, closed: false };
        opened.push(rec);
        return { close: async () => { rec.closed = true; }, getWriter: () => ({ write: async (c: Uint8Array) => { rec.bytes += c.length; }, close: async () => { rec.closed = true; }, abort: async () => undefined }) };
      },
    },
    conversation: {
      get: async (session: string) => ({ id: session, kind: session.startsWith("b_") ? "bot" : "side-thread", bot: "alpha" }),
      history: async () => ({ events: o.history ?? [], hasMore: false }),
    },
  };
  host.start(api as never);
  return { opened, asked, settings };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const at = (event: "message.out" | "turn.end", extra: Partial<HookInput> = {}, kind: "bot" | "side-thread" = "bot"): HookInput =>
  ({ event, session: { id: kind === "bot" ? "b_alpha" : "t_alpha", kind, caller: { kind: "user" } }, bot: "alpha", computer: "c", ...extra }) as HookInput;
const VOICED = { "provider@alpha": "acceptance-voice", "voice@alpha": "tone" };

describe("Clover Voice's host half", () => {
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

  test("a voice mode the user chose is handed the reply; Clover Voice's player gets nothing", async () => {
    const f = fake({ settings: { ...VOICED, active: "acme-voice" }, modes: [{ pluginId: "acme-voice", entryId: "acme", value: { name: "Acme" } }] });
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
    expect(await host.ui.voiceOf({ bot: "alpha" })).toEqual({ provider: "acceptance-voice", voice: "tone", model: "s2" });
    await host.ui.forget({ bot: "alpha" });
    expect(await host.ui.voiceOf({ bot: "alpha" })).toBeNull();
    await host.ui.stop({ bot: "alpha" });
    await settle();
    expect(f.opened.map((s) => [s.name, s.meta, s.closed])).toEqual([["control", { op: "stop", bot: "alpha" }, true]]);
  });
});
