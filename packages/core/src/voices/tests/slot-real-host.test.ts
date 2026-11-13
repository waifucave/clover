// The voice slot (§6.6) in a real plugin host: Clover Voice (the bundled `clover/voice`, its real host module, staged
// as the bundled tree is) says a bot's reply through a provider's endpoint (the acceptance run's tone voice, a third
// party) and feeds the player; the queue rule holds on the player (two bots never sound at once; push-to-talk stops
// what sounds and is heard by the provider through the mode); `speech.*` is the active mode's alone; a third party's
// voice mode chosen by the user takes over, and when it stops voice falls back to Clover Voice and the user is told
// once; a plain plugin with `voices.use` gets the provider's audio back as its own and nothing sounds, and one without
// is refused. Temp home, the fake approval broker, an in-memory secret store; nothing plays a sound or opens a window.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { measureBundledTree } from "../../bundled-plugins-dir";
import type { BotSide } from "../../bots/wiring";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { stageBundledPlugins, stagedBundledDir } from "../../registry/bundled-stage";
import { openPluginRegistry } from "../../registry/open";
import { VoiceService, type VoicePlay } from "../service";
import { CLOVER_VOICE, VoiceSlot } from "../slot";

setDefaultTimeout(60_000);
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const ENGINES = { clover: `^${PLUGIN_API_VERSION}` };
const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const USER: Caller = { kind: "user", client: "app" };

/** A third party's voice mode: it says each reply at once through the provider the bot uses, and plays offered sound. */
const MODE_JS = `
let api;
export function start(a) { api = a; }
export const said = [];
export const voice = {
  async reply(args) {
    said.push(args.bot);
    const u = "vm_" + said.length;
    await new Promise((resolve) => {
      const off = api.voices.speak(args.voice.provider, { ticket: args.ticket }, (e) => {
        if (e.audio) void api.speech.piece({ bot: args.bot, session: args.session, utterance: u, data: e.audio, final: false });
        else { void api.speech.piece({ bot: args.bot, session: args.session, utterance: u, data: new Uint8Array(0), final: true }); resolve(); }
      });
    });
    return { queued: false };
  },
  async stop() {},
  async listenStart() {},
  async listenPiece() { return { text: "" }; },
  async listenEnd() {},
  async offer(args) { await api.speech.play({ ticket: args.ticket }); },
};
export const ui = {};
export const trySink = async () => { try { await api.speech.piece({ bot: "alpha", session: "b_alpha", utterance: "x", data: new Uint8Array(2), final: true }); return "sounded"; } catch (e) { return e.message; } };
`;

/** A plain plugin: its own narration through a provider, as data. */
const NARRATOR_JS = `
let api;
export function start(a) { api = a; }
export const narrate = async () => {
  try {
    const providers = await api.voices.providers();
    return await new Promise((resolve) => {
      let bytes = 0;
      api.voices.speak("acceptance-voice", { text: "a narration", voice: "tone" }, (e) => {
        if (e.audio) bytes += e.audio.length;
        else if (e.done) resolve({ providers: providers.map((p) => p.id), bytes, done: e.done.bytes });
        else resolve({ error: e.error });
      });
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

/** `reportMs`: the fake player says an utterance ended this long after its last piece (none: it never says). */
async function world(o: { reportMs?: number; graceMs?: number } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-voice-")));
  temps.push(home);
  // The bundled tree: Clover's root and Clover Voice, its real files, staged as a release stages them.
  const root = join(home, "resources", "plugins");
  plugin(join(root, "clover"), { id: "clover", name: "Clover" });
  for (const part of ["clover.json", "host", "src", "client"]) cpSync(join(REPO, "plugins", "clover", "plugins", "voice", part), join(root, "clover", "plugins", "voice", part), { recursive: true });
  const staged = stageBundledPlugins({ root, manifest: measureBundledTree(root), out: stagedBundledDir(home) });
  // The run's tone provider (a third party), a third party's voice mode, a narrator with `voices.use`, one without.
  cpSync(join(REPO, "scripts", "acceptance", "fixtures", "acceptance-voice"), join(home, "plugins", "acceptance-voice"), { recursive: true });
  plugin(join(home, "plugins", "vmode"), { id: "vmode", name: "Other voice", contributes: { voiceModes: [{ id: "other-voice", name: "Other voice", handler: "voice" }] } }, MODE_JS);
  plugin(join(home, "plugins", "narrator"), { id: "narrator", name: "Narrator", capabilities: ["voices.use"] }, NARRATOR_JS);
  plugin(join(home, "plugins", "nosy"), { id: "nosy", name: "Nosy" }, NARRATOR_JS);
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
  const played: (VoicePlay & { at: number })[] = [];
  const reports: { utterance: string; at: number }[] = [];
  let slot: VoiceSlot | undefined;
  let service: VoiceService | undefined;
  const ph = await startPluginHost({
    home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests, fence: false,
    areas: {
      bots: () => ({ bots: { has: (id: string) => id === "alpha" || id === "beta" }, voiceSlot: slot, voices: service }) as unknown as BotSide,
      node: () => undefined, links: () => undefined,
    },
  });
  const told: string[] = [];
  let chosen: string | undefined;
  service = new VoiceService({
    registry: opened.registry, host: ph.host,
    voiceOf: (bot) => (bot === "alpha" || bot === "beta" ? { provider: "acceptance-voice", voice: "tone" } : undefined),
    play: (p) => {
      played.push({ ...p, at: Date.now() });
      if (p.final && o.reportMs !== undefined) setTimeout(() => { reports.push({ utterance: p.utterance, at: Date.now() }); slot?.played(p.bot, p.utterance); }, o.reportMs);
    },
  });
  slot = new VoiceSlot({ registry: opened.registry, host: ph.host, service, chosen: () => chosen, tell: (t) => void told.push(t), ...(o.graceMs === undefined ? {} : { playedGraceMs: o.graceMs }) });
  for (const id of ["acceptance-voice", "vmode", "narrator", "nosy"]) {
    const { card } = await opened.registry.installed(id, "app");
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
  }
  for (let i = 0; i < 500 && ["acceptance-voice", "vmode", "narrator", "nosy", CLOVER_VOICE].some((id) => !["running", "waiting"].includes(opened.registry.get(id)?.state ?? "")); i++) await Bun.sleep(20);
  const until = async (what: string, f: () => boolean, ms = 10_000) => {
    for (let t = 0; t < ms / 20 && !f(); t++) await Bun.sleep(20);
    if (!f()) throw new Error(`not in time: ${what}`);
  };
  const close = async () => { await ph.close(); opened.close(); };
  return { home, opened, ph, played, reports, slot: slot!, service: service!, told, choose: (id: string | undefined) => { chosen = id; }, until, close };
}

describe("the voice slot in a real plugin host", () => {
  test("Clover Voice says a reply through the provider's endpoint and feeds the player; two bots never sound at once; push-to-talk stops what sounds and the provider hears it through the mode", async () => {
    // The player says each utterance ended 1.5 s after its last piece: later than Clover Voice's own clock would guess
    // (0.6 s and its latency), as a player whose audio starts late does.
    const w = await world({ reportMs: 1_500 });
    try {
      expect((await w.slot.active())?.pluginId).toBe(CLOVER_VOICE);
      await w.slot.reply({ bot: "alpha", session: "b_alpha", text: "first" });
      await w.slot.reply({ bot: "beta", session: "b_beta", text: "second" });
      await w.until("both replies to sound out", () => w.played.filter((p) => p.final).length >= 2, 15_000);
      const alpha = w.played.filter((p) => p.bot === "alpha");
      const beta = w.played.filter((p) => p.bot === "beta");
      // Alpha's tone: three pieces of 0.2 s (pcm16-24k), then its last; every piece through Clover Voice's own utterance.
      expect(alpha.filter((p) => !p.final).map((p) => p.audio.length)).toEqual([12_800, 12_800, 12_800]); // 9,600 bytes each, as base64
      expect(alpha.every((p) => p.utterance.startsWith(`${CLOVER_VOICE}:`) && p.format === "pcm16-24k")).toBe(true);
      // Beta waited until the player said Alpha's utterance ended, not merely her 0.6 s by the clock.
      const alphaEnded = w.reports.find((r) => r.utterance === alpha[0]!.utterance)!;
      expect(beta[0]!.at).toBeGreaterThanOrEqual(alphaEnded.at);
      // Push-to-talk while Alpha speaks: what sounds stops at once, and what the user said reaches the provider.
      w.played.length = 0;
      await w.slot.reply({ bot: "alpha", session: "b_alpha", text: "again" });
      await w.until("Alpha speaking again", () => w.played.some((p) => !p.final));
      const pcm = Buffer.from(new Uint8Array(3200)).toString("base64");
      expect(await w.slot.listen({ bot: "alpha", utterance: "ptt1", seq: 0, audio: pcm, format: "pcm16-16k", final: false })).toEqual({});
      await w.until("Alpha's speech stopped by the hold", () => w.played.some((p) => p.final));
      expect(await w.slot.listen({ bot: "alpha", utterance: "ptt1", seq: 1, audio: pcm, format: "pcm16-16k", final: true })).toEqual({ text: "heard 2 pieces, 6400 bytes of pcm16-16k" });
    } finally {
      await w.close();
    }
  });

  test("with no word from the player its end is its length and the grace; a report of an utterance the core isn't waiting on, or for another bot, changes nothing", async () => {
    const w = await world({ graceMs: 1_200 });
    try {
      await w.slot.reply({ bot: "alpha", session: "b_alpha", text: "first" });
      await w.slot.reply({ bot: "beta", session: "b_beta", text: "second" });
      await w.until("Alpha's last piece", () => w.played.some((p) => p.final && p.bot === "alpha"));
      const alphaLast = w.played.find((p) => p.final && p.bot === "alpha")!;
      const alphaFirst = w.played.find((p) => p.bot === "alpha")!;
      // Reports that end nothing: an unknown utterance, and Alpha's under another bot's name.
      w.slot.played("alpha", "clover/voice:nothing");
      w.slot.played("beta", alphaLast.utterance);
      await w.until("both replies to sound out", () => w.played.filter((p) => p.final).length >= 2, 15_000);
      const beta = w.played.find((p) => p.bot === "beta")!;
      // 0.6 s of tone and 1.2 s of grace from Alpha's first piece.
      expect(beta.at - alphaFirst.at).toBeGreaterThanOrEqual(1_700);
    } finally {
      await w.close();
    }
  });

  test("speech.* is the active voice's alone; the user's choice takes over, and when it stops voice falls back to Clover Voice and the user is told once", async () => {
    const w = await world();
    try {
      const invoke = (pluginId: string, handler: string) => w.ph.host.invoke<unknown>({ pluginId, handler, args: {}, caller: USER });
      expect(await invoke("vmode", "trySink")).toContain("vmode isn't the active voice; choose it in Settings › Voice");
      w.choose("vmode");
      expect((await w.slot.active())?.pluginId).toBe("vmode");
      await w.slot.reply({ bot: "alpha", session: "b_alpha", text: "from the other voice" });
      await w.until("the other voice's reply", () => w.played.some((p) => p.final && p.utterance.startsWith("vmode:")));
      expect(w.played.every((p) => p.utterance.startsWith("vmode:"))).toBe(true);
      // Its stop: voice goes back to Clover Voice, said once in words.
      await w.opened.registry.setEnabled("vmode", false);
      for (let i = 0; i < 200 && w.opened.registry.get("vmode")?.state !== "off"; i++) await Bun.sleep(20);
      expect((await w.slot.active())?.pluginId).toBe(CLOVER_VOICE);
      await w.slot.active();
      expect(w.told).toEqual(["Other voice isn't running, so Clover Voice speaks for your bots for now."]);
    } finally {
      await w.close();
    }
  });

  test("a plain plugin with voices.use gets the provider's audio back as its own and nothing sounds; one without is refused", async () => {
    const w = await world();
    try {
      const narrate = (pluginId: string) => w.ph.host.invoke<{ providers?: string[]; bytes?: number; done?: number; error?: string }>({ pluginId, handler: "narrate", args: {}, caller: USER });
      expect(await narrate("narrator")).toEqual({ providers: ["acceptance-voice"], bytes: 28_800, done: 28_800 });
      expect(w.played).toEqual([]);
      expect((await narrate("nosy")).error).toContain("needs the capability voices.use");
    } finally {
      await w.close();
    }
  });
});
