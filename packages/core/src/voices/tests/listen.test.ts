// The listening half of voice (push-to-talk), which stays in the core until it is re-founded: in a real plugin host, the
// voice slot hands the user's pieces to Clover Voice's real host module (its `voiceModes` handler), which reads the bot's
// voice from its own bot setting, holds its player and feeds the provider's listening (`voices.listen`); `voice.status`
// asks it whether the bot listens; `audio.onRecording` gets a copy; `voices.*` is a voice mode's or a `voices.use`
// plugin's; an utterance whose last piece never comes is dropped.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { measureBundledTree } from "../../bundled-plugins-dir";
import type { BotSide } from "../../bots/wiring";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { filePluginSettings } from "../../plugin-host/api/settings";
import { stageBundledPlugins, stagedBundledDir } from "../../registry/bundled-stage";
import { openPluginRegistry } from "../../registry/open";
import { VoiceService, type RecordingPiece } from "../service";
import { VoiceSlot } from "../slot";

/** Clover Voice, the bundled filler of `voiceModes` (the default active one). */
const CLOVER_VOICE = "clover/voice";

setDefaultTimeout(60_000);
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const ENGINES = { clover: `^${PLUGIN_API_VERSION}` };
const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");

/** A plain plugin that transcribes through a provider, as its own data. */
const SCRIBE_JS = `
let api;
export function start(a) { api = a; }
export const scribe = async () => {
  try {
    return await new Promise((resolve) => {
      const off = api.voices.listen("acceptance-voice", { id: "s1", format: "pcm16-16k" }, (e) => resolve(e.text !== undefined ? { text: e.text } : { error: e.error }));
      void api.voices.feed("s1", new Uint8Array(320), true).catch((e) => resolve({ error: e.message }));
    });
  } catch (e) { return { error: e.message }; }
};
`;

function plugin(folder: string, manifest: Record<string, unknown>, js?: string): void {
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, version: "1.0.0", engines: ENGINES, ...(js === undefined ? {} : { host: { entry: "host/index.js" } }), ...manifest }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  if (js !== undefined) writeFileSync(join(folder, "host", "index.js"), js);
}

async function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-listen-")));
  temps.push(home);
  const root = join(home, "resources", "plugins");
  plugin(join(root, "clover"), { id: "clover", name: "Clover" });
  for (const part of ["clover.json", "host", "src", "client", "assets"]) cpSync(join(REPO, "plugins", "clover", "plugins", "voice", part), join(root, "clover", "plugins", "voice", part), { recursive: true });
  const staged = stageBundledPlugins({ root, manifest: measureBundledTree(root), out: stagedBundledDir(home) });
  cpSync(join(REPO, "scripts", "acceptance", "fixtures", "acceptance-voice"), join(home, "plugins", "acceptance-voice"), { recursive: true });
  cpSync(join(REPO, "scripts", "acceptance", "fixtures", "acceptance-voice-mode"), join(home, "plugins", "acceptance-voice-mode"), { recursive: true });
  plugin(join(home, "plugins", "scribe"), { id: "scribe", name: "Scribe", capabilities: ["voices.use"] }, SCRIBE_JS);
  plugin(join(home, "plugins", "nosy"), { id: "nosy", name: "Nosy" }, SCRIBE_JS);
  // Alpha's voice: Clover Voice's own setting for her (bot scope); Beta has none.
  filePluginSettings(home).write(CLOVER_VOICE, { account: {}, device: {}, bot: { alpha: { provider: "acceptance-voice", voice: "tone" } } });
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
  let slot: VoiceSlot | undefined;
  const service = new VoiceService({ registry: opened.registry, host: undefined as never });
  const ph = await startPluginHost({
    home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests, fence: false,
    areas: {
      bots: () => ({ bots: { has: (id: string) => id === "alpha" || id === "beta" }, voiceSlot: slot, voices: service }) as unknown as BotSide,
      node: () => undefined, links: () => undefined,
    },
  });
  (service as unknown as { constructor: unknown });
  const live = new VoiceService({ registry: opened.registry, host: ph.host });
  slot = new VoiceSlot({ registry: opened.registry, host: ph.host, service: live, listenIdleMs: 300 });
  for (const id of ["acceptance-voice", "scribe", "nosy", "acceptance-voice-mode"]) {
    const { card } = await opened.registry.installed(id, "app");
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
  }
  for (let i = 0; i < 500 && ["acceptance-voice", "scribe", "nosy", "acceptance-voice-mode", CLOVER_VOICE].some((id) => !["running", "waiting"].includes(opened.registry.get(id)?.state ?? "")); i++) await Bun.sleep(20);
  const run = <T,>(id: string, handler: string) => ph.host.invoke<T>({ pluginId: id, handler, args: {}, caller: { kind: "user", client: "app" } });
  return { slot, service: live, ph, run, registry: opened.registry, close: async () => { await ph.close(); opened.close(); } };
}

describe("push-to-talk in a real plugin host", () => {
  test("the voice that hears it is the platform's one at a time: Clover Voice by default; the user's pick moves it, and an inactive mode hears nothing", async () => {
    const w = await world();
    try {
      expect((await w.slot.active())?.pluginId).toBe(CLOVER_VOICE);
      w.registry.choose("voiceModes", { pluginId: "acceptance-voice-mode", entryId: "acceptance-voice-mode" });
      expect((await w.slot.active())?.pluginId).toBe("acceptance-voice-mode");
      expect(w.slot.inactiveMode(CLOVER_VOICE)).toBe(true);
      // That mode doesn't listen: no button for Alpha.
      expect(await w.slot.listens("alpha")).toBe(false);
      w.registry.choose("voiceModes", undefined);
      expect((await w.slot.active())?.pluginId).toBe(CLOVER_VOICE);
    } finally {
      await w.close();
    }
  });

  test("the slot hands the pieces to Clover Voice, which reads the bot's voice from its own setting; the provider hears them; audio.onRecording gets a copy", async () => {
    const w = await world();
    try {
      expect((await w.slot.active())?.pluginId).toBe(CLOVER_VOICE);
      expect(await w.slot.listens("alpha")).toBe(true);
      expect(await w.slot.listens("beta")).toBe(false);
      const copies: RecordingPiece[] = [];
      const off = w.service.onRecording((p) => copies.push(p));
      const pcm = Buffer.from(new Uint8Array(3200)).toString("base64");
      expect(await w.slot.listen({ bot: "alpha", utterance: "ptt1", seq: 0, audio: pcm, format: "pcm16-16k", final: false })).toEqual({});
      expect(await w.slot.listen({ bot: "alpha", utterance: "ptt1", seq: 1, audio: pcm, format: "pcm16-16k", final: true })).toEqual({ text: "heard 2 pieces, 6400 bytes of pcm16-16k" });
      off();
      expect(copies.map((c) => [c.utterance, c.data.length, c.final])).toEqual([["ptt1", 3200, false], ["ptt1", 3200, true]]);
      // A bot with no voice: the mode refuses, so the call does.
      await expect(w.slot.listen({ bot: "beta", utterance: "ptt2", seq: 0, audio: pcm, format: "pcm16-16k", final: false })).rejects.toThrow(/no voice/);
      // Out of order is refused.
      await expect(w.slot.listen({ bot: "alpha", utterance: "ptt3", seq: 1, audio: pcm, format: "pcm16-16k", final: false })).rejects.toThrow(/starts at piece 0/);
    } finally {
      await w.close();
    }
  });

  test("a plain plugin with voices.use gets a transcription as its own data; one without is refused", async () => {
    const w = await world();
    try {
      expect(await w.run<{ text?: string }>("scribe", "scribe")).toEqual({ text: "heard 1 pieces, 320 bytes of pcm16-16k" });
      expect((await w.run<{ error?: string }>("nosy", "scribe")).error).toContain("voices.use");
    } finally {
      await w.close();
    }
  });
});
