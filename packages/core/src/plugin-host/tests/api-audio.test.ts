// `audio.*` in a real plugin host (a worker of the shared process and a process of the plugin's own) over lane D's real
// voices (`VoiceService`, its push-to-talk path into a real listening voice plugin in the same host): with `audio`, a bot
// plugin's audio reaches the app as its bot's speech (`voice.play` pieces, the last final), whole or streamed piece by
// piece, and it hears each piece of the user's push-to-talk as it comes; without `audio`, neither. Temp home, the fake
// approval broker, an in-memory secret store, a stand-in for the bot side's bot list and the app's connection (the
// pieces it is sent); nothing opens a window or plays a sound.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import type { BotSide } from "../../bots/wiring";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { VoiceService, type VoicePlay } from "../../voices/service";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const clip = async (args, ctx) => tried(async () => { const h = await ctx.api.audio.play({ format: "pcm16-24k", data: new Uint8Array(args.n) }, args.opts); await h.done; return "played"; });
export const stream = async (args, ctx) => tried(async () => {
  async function* pieces() { for (let i = 0; i < args.pieces; i++) { await new Promise((r) => setTimeout(r, 20)); yield new Uint8Array(4).fill(i + 1); } }
  const h = await ctx.api.audio.play({ format: "pcm16-24k", data: pieces() });
  await h.done;
  return "streamed";
});
export const stopped = async (args, ctx) => tried(async () => {
  async function* forever() { for (let i = 0; ; i++) { await new Promise((r) => setTimeout(r, 30)); yield new Uint8Array(2).fill(9); } }
  const h = await ctx.api.audio.play({ format: "pcm16-24k", data: forever() });
  await new Promise((r) => setTimeout(r, 100));
  h.stop();
  await h.done;
  return "stopped";
});
let heard = [];
let off;
export const listen = async (args, ctx) => { heard = []; off = ctx.api.audio.onRecording((p) => heard.push({ utterance: p.utterance, format: p.format, bytes: Array.from(p.data), final: p.final })); return true; };
export const heardSoFar = async () => heard;
export const unlisten = async () => { off?.(); return true; };
export const voice = { async *listen(_args, ctx) { let n = 0; for await (const p of ctx.input) n += p.length; return { text: "heard " + n + " bytes" }; } };
`;

function plugin(home: string, id: string, o: { process?: "own"; capabilities: string[]; voices?: unknown[] }): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", ...(o.process === undefined ? {} : { process: o.process }) }, capabilities: o.capabilities,
    ...(o.voices === undefined ? {} : { contributes: { voices: o.voices } }),
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
}

function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => { if (registry.get(id)?.state !== "found") { off(); resolve(); } });
    if (registry.get(id)?.state !== "found") { off(); resolve(); }
  });
}

describe("audio.* in a real plugin host", () => {
  test("a bot plugin's audio plays as its bot's speech, whole or streamed, and stops; it hears push-to-talk; nothing without audio", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-audio-")));
    temps.push(home);
    plugin(home, "luna", { capabilities: ["audio"] });
    plugin(home, "sol", { process: "own", capabilities: ["audio"] });
    plugin(home, "quiet", { capabilities: [] });
    plugin(home, "ear", { capabilities: [], voices: [{ id: "ear", name: "Ear", listen: true, handler: "voice" }] });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const sent: VoicePlay[] = [];
    let voices: VoiceService | undefined;
    const ph = await startPluginHost({
      home, computer: "Studio", registry: opened.registry, secrets, fence: false,
      areas: {
        bots: () => ({ bots: { has: (id: string) => id === "luna" || id === "sol" || id === "quiet" }, voices }) as unknown as BotSide,
        node: () => undefined, links: () => undefined, voicePlay: (p) => void sent.push(p),
      },
    });
    voices = new VoiceService({ registry: opened.registry, host: ph.host, voiceOf: () => ({ provider: "ear", voice: "default" }), play: () => {} });
    try {
      for (const id of ["luna", "sol", "quiet", "ear"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      expect(opened.folders.okText("luna", "macos").lines).toContain("It hears what you say to your bots with push-to-talk, and can play sound, including as your bots' voices.");
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER, timeoutMs: 20_000 });
      const of = (utterance: string) => sent.filter((p) => p.utterance === utterance);
      for (const id of ["luna", "sol"]) {
        // A whole clip, cut in app-sized pieces, then the final empty one; as its own bot's speech in its main session.
        sent.length = 0;
        expect(await call(id, "clip", { n: 1_600_000 })).toBe("played");
        const u = sent[0]!.utterance;
        expect(of(u).map((p) => [p.bot, p.seq, p.final, Buffer.from(p.audio, "base64").length])).toEqual([[id, 0, false, 1_500_000], [id, 1, false, 100_000], [id, 2, true, 0]]);
        expect(sent[0]!.session.length).toBeGreaterThan(0);
        // Another bot's figure, named.
        sent.length = 0;
        expect(await call(id, "clip", { n: 10, opts: { bot: "quiet" } })).toBe("played");
        expect(sent[0]!.bot).toBe("quiet");
        expect(await call(id, "clip", { n: 10, opts: { bot: "nobody" } })).toEqual({ error: expect.stringMatching(/^not_found: no bot nobody/) });
        // Streamed: each piece as it comes, under one utterance, the last final.
        sent.length = 0;
        expect(await call(id, "stream", { pieces: 3 })).toBe("streamed");
        const s = sent[0]!.utterance;
        expect(of(s).map((p) => [p.seq, p.final, [...Buffer.from(p.audio, "base64")][0] ?? null])).toEqual([[0, false, 1], [1, false, 2], [2, false, 3], [3, true, null]]);
        // Stopped: no more pieces, and the utterance ends.
        sent.length = 0;
        expect(await call(id, "stopped")).toBe("stopped");
        const t = of(sent[0]!.utterance);
        expect(t.at(-1)!.final).toBe(true);
        const count = sent.length;
        await Bun.sleep(150);
        expect(sent.length).toBe(count);
      }
      // Push-to-talk: the app's pieces for a bot reach the plugin as they come.
      await call("luna", "listen");
      await Bun.sleep(300);
      await voices.listen({ bot: "luna", utterance: "u1", seq: 0, audio: Buffer.from([1, 2]).toString("base64"), format: "pcm16-16k", final: false });
      expect(await voices.listen({ bot: "luna", utterance: "u1", seq: 1, audio: Buffer.from([3]).toString("base64"), format: "pcm16-16k", final: true })).toEqual({ text: "heard 3 bytes" });
      let heard: unknown[] = [];
      for (let i = 0; i < 100 && heard.length < 2; i++) { await Bun.sleep(20); heard = await call<unknown[]>("luna", "heardSoFar"); }
      expect(heard).toEqual([{ utterance: "u1", format: "pcm16-16k", bytes: [1, 2], final: false }, { utterance: "u1", format: "pcm16-16k", bytes: [3], final: true }]);
      await call("luna", "unlisten");
      // Without `audio`, neither call exists for the plugin.
      expect(await call("quiet", "clip", { n: 10 })).toEqual({ error: expect.stringMatching(/needs the capability audio/) });
    } finally {
      await ph.close();
      opened.close();
    }
  }, 120_000);
});
