// `audio.onRecording` in a real plugin host (a worker of the shared process and a process of the plugin's own) over
// lane D's push-to-talk path (`VoiceService`'s copy of each piece): with `audio`, a plugin hears each piece of the
// user's push-to-talk as it comes; without `audio`, it can't. A plugin's own sound is a background part of its own
// (`app.background`, taking `device/speech`); `audio.play` went with the core's player. Temp home, the fake approval
// broker, an in-memory secret store; nothing opens a window or plays a sound.
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
import { VoiceService } from "../../voices/service";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const play = async (args, ctx) => tried(async () => ctx.api.audio.play({ format: "pcm16-24k", data: new Uint8Array(2) }));
let heard = [];
let off;
export const listen = async (args, ctx) => tried(async () => { heard = []; off = ctx.api.audio.onRecording((p) => heard.push({ utterance: p.utterance, format: p.format, bytes: Array.from(p.data), final: p.final })); return true; });
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
  test("with audio, a plugin hears push-to-talk as it comes; without it, it can't; audio.play is no more", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-audio-")));
    temps.push(home);
    plugin(home, "luna", { capabilities: ["audio"] });
    plugin(home, "sol", { process: "own", capabilities: ["audio"] });
    plugin(home, "quiet", { capabilities: [] });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    let voices: VoiceService | undefined;
    const ph = await startPluginHost({
      home, computer: "Studio", registry: opened.registry, secrets, fence: false,
      areas: {
        bots: () => ({ bots: { has: (id: string) => id === "luna" || id === "sol" || id === "quiet" }, voices }) as unknown as BotSide,
        node: () => undefined, links: () => undefined,
      },
    });
    voices = new VoiceService({ registry: opened.registry, host: ph.host });
    try {
      for (const id of ["luna", "sol", "quiet"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER, timeoutMs: 20_000 });
      for (const id of ["luna", "sol"]) {
        await call(id, "listen");
        await Bun.sleep(300);
        voices.hearRecording({ bot: "luna", utterance: "u1", format: "pcm16-16k", data: new Uint8Array([1, 2]), final: false });
        voices.hearRecording({ bot: "luna", utterance: "u1", format: "pcm16-16k", data: new Uint8Array([3]), final: true });
        let heard: unknown[] = [];
        for (let i = 0; i < 100 && heard.length < 2; i++) { await Bun.sleep(20); heard = await call<unknown[]>(id, "heardSoFar"); }
        expect(heard).toEqual([{ utterance: "u1", format: "pcm16-16k", bytes: [1, 2], final: false }, { utterance: "u1", format: "pcm16-16k", bytes: [3], final: true }]);
        await call(id, "unlisten");
        // The core's player path is gone: a plugin plays its own sound in a part of its own.
        expect(await call(id, "play")).toEqual({ error: expect.stringMatching(/audio\.play/) });
      }
      // Without `audio`, push-to-talk isn't the plugin's to hear.
      await call("quiet", "listen");
      await Bun.sleep(300);
      voices.hearRecording({ bot: "luna", utterance: "u2", format: "pcm16-16k", data: new Uint8Array([4]), final: true });
      await Bun.sleep(300);
      expect(await call<unknown[]>("quiet", "heardSoFar")).toEqual([]);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 120_000);
});
