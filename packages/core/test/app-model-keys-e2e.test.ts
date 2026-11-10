// The app's model keys, end to end (K's macOS audit, #328): the user signs a bundled model plugin in with an API key
// (`plugin.auth.signIn`), the model picker then lists that provider's models as signed in (`models.list`), the bots'
// key check (`hasKeyFor`, lane D's `botKeyPresence`) sees the key without a restart, and a bot turn on the real
// embedded runtime reaches the provider (a loopback fake) with that key, brokered by the daemon. The key appears
// nowhere in the runtime's store. Signing out takes it away again.
//
// ISOLATION: a temp home, a `FileSecretStore` under it, a loopback fake, a dummy key. No Keychain, no network.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiChatFake, startFake, type FakeServer } from "@waifucave/clover-provider-conformance/fakes";
import { query as sdkQuery } from "@waifucave/clover-agent-sdk";
import { FileSecretStore } from "../src/auth/secret-store";
import { botKeyPresence } from "../src/bots/key-presence";
import { botPaths } from "../src/bots/paths";
import type { BotSessionContext, EffectiveBot } from "../src/bots/service";
import { MemorySecretStore } from "../src/contracts/fakes/secret-store";
import type { PluginRecord } from "../src/contracts/plugin-registry";
import type { TurnControl, TurnInput } from "../src/contracts/session-host";
import { keychainService } from "../src/profile";
import { createHostCredentialBroker } from "../src/runtime-sdk/host-credentials";
import { credentialPresenceFrom } from "../src/runtime-sdk/keychain";
import { modelsMethods } from "../src/runtime-sdk/models-list";
import { createPluginAuth, pluginAuthMethods } from "../src/runtime-sdk/plugin-auth";
import { BotSessionDriver } from "../src/runtime-sdk/turn-loop/driver";
import { botProviderFill } from "../src/runtime-sdk/turn-loop/provider-fill";
import type { Settings } from "../src/settings";
import { describeWithEmbeddedRuntime } from "./helpers/embedded-runtime";

const SENTINEL = "A3-SENTINEL-app-model-keys-5e0d71c2";
const MODEL = "deepseek/deepseek-v4-pro";
const DEEPSEEK = { id: "clover/model-deepseek", source: "bundled", manifest: { contributes: { models: [{ provider: "deepseek", auth: [{ method: "api-key", secret: "api-key" }] }] } } } as unknown as PluginRecord;
const USER = { caller: { kind: "user", client: "app" } } as never;

const temps: string[] = [];
let fake: FakeServer | undefined;
afterAll(async () => {
  await fake?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const control = (): TurnControl => ({ origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} });
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

function context(home: string): BotSessionContext {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: MODEL, modelFrom: "plugin", userLayer: [] };
  return {
    botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot,
    memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true,
    whenMayAct: async () => {},
    cacheCold: () => false,
  } as unknown as BotSessionContext;
}

/** Every file under `dir`, read as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const f of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(f));
    try { if (statSync(p).isFile()) out.push({ path: p, text: readFileSync(p, "utf8") }); } catch { /* gone */ }
  }
  return out;
}

describeWithEmbeddedRuntime("the app's model keys", (spawn) => {
  test("plugin.auth.signIn, then models.list signed in, hasKeyFor yes without a restart, and a bot turn reaching the provider with the key", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a3-keys-")));
    temps.push(home);
    const auth: string[] = [];
    fake = await startFake({
      routes: [{
        path: "*",
        handler: (req, recorded) => {
          auth.push(req.headers.get("authorization") ?? "");
          if (!recorded.path.endsWith("/chat/completions")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          return openaiChatFake.chatStream({ text: ["hello from the loopback provider"], finishReason: "stop" });
        },
      }],
    });
    const secrets = new FileSecretStore(join(home, "secrets"));
    let clock = 1_000_000;
    const hasKeyFor = await botKeyPresence(secrets, home, { now: () => clock, pluginServes: () => false });
    const pluginAuth = createPluginAuth({ registry: { get: (id) => (id === DEEPSEEK.id ? DEEPSEEK : undefined) }, secrets, pluginSecrets: new MemorySecretStore(), modelProviders: () => [] });
    const authMethods = pluginAuthMethods(pluginAuth);
    // As the daemon mounts it: the providers' slots, and third parties' own keys.
    const picker = modelsMethods({
      signedIn: async () => new Set([...Object.keys((await credentialPresenceFrom(secrets)).byProvider), ...await pluginAuth.signedInProviders()]),
    })["models.list"]!;
    const listed = async () => ((await picker({}, USER)) as { models: { id: string; provider: string; signedIn: boolean }[] }).models.filter((m) => m.provider === "deepseek");
    /** hasKeyFor after its next read (it reads again at most every few seconds). */
    const keyed = async () => { clock += 10_000; hasKeyFor(MODEL); await Bun.sleep(50); return hasKeyFor(MODEL); };

    // Before: no key anywhere.
    expect((await listed()).some((m) => m.id === MODEL)).toBe(true);
    expect((await listed()).every((m) => !m.signedIn)).toBe(true);
    expect(hasKeyFor(MODEL)).toBe(false);

    // The user signs the bundled DeepSeek plugin in.
    expect(await authMethods["plugin.auth.signIn"]!({ id: DEEPSEEK.id, index: 0, key: `  ${SENTINEL}  ` }, USER)).toEqual({ state: "signed-in" });
    expect(await authMethods["plugin.auth.list"]!({ id: DEEPSEEK.id }, USER)).toEqual({ auth: [{ index: 0, method: "api-key", secret: "api-key", state: "signed-in" }] });
    expect((await listed()).every((m) => m.signedIn)).toBe(true);
    expect(await keyed()).toBe(true);

    // A bot on that model: its turn reaches the provider with the key, which the daemon's broker hands the runtime.
    const settings = { providers: { deepseek: { baseUrl: `${fake.url}/v1` } } } as unknown as Settings;
    const broker = createHostCredentialBroker({ secrets, keychainService: keychainService(undefined, home) });
    const deps = {
      home, spawn, query: sdkQuery,
      canUseTool: () => async (_n: string, input: unknown) => ({ behavior: "allow" as const, updatedInput: input as Record<string, unknown> }),
      sandbox: () => ({ enabled: false }), stopGraceMs: 5_000, log: () => {},
      provider: botProviderFill({ home, broker, secrets, settings: () => settings, modelPlugins: () => undefined }),
    };
    const driver = new BotSessionDriver(context(home), deps as never);
    try {
      expect((await driver.turn(user("hello"), control())).reason).toBe("end_turn");
    } finally {
      await driver.stop();
    }
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.every((h) => h === `Bearer ${SENTINEL}`)).toBe(true);
    // The key is in the secret store alone: never in the runtime's store (transcripts, state).
    for (const f of filesUnder(join(home, "sdk"))) expect(f.text.includes(SENTINEL)).toBe(false);

    // Signing out takes it away: the picker and the bots' check both say so.
    await authMethods["plugin.auth.signOut"]!({ id: DEEPSEEK.id, index: 0 }, USER);
    expect((await listed()).every((m) => !m.signedIn)).toBe(true);
    expect(await keyed()).toBe(false);
  }, 120_000);
});
