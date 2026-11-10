// `plugin.auth.*` (runtime-sdk/plugin-auth.ts): a plugin's sign-ins, where each key lands, the OAuth and device flows
// in the background, signing out, and the user-only gate. Every store here is in memory; no flow touches the network.
import { describe, expect, test } from "bun:test";
import type { PluginAuthView } from "@waifucave/clover-protocol";
import type { SecretStore } from "../../src/auth/secret-store";
import { readCredentialMaterial } from "../../src/auth/credential-material";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import type { PluginRecord } from "../../src/contracts/plugin-registry";
import { authEntriesOf, createPluginAuth, pluginAuthMethods, type OAuthRun } from "../../src/runtime-sdk/plugin-auth";
import { modelPluginSlotFor } from "../../src/runtime-sdk/model-plugins/keychain-tokens";

class DaemonStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
}

const rec = (id: string, source: string, manifest: unknown): PluginRecord => ({ id, source, manifest } as unknown as PluginRecord);
const GROQ = rec("clover/model-groq", "bundled", { contributes: { models: [{ provider: "groq", auth: [{ method: "api-key", secret: "api-key" }] }] } });
const CODEX = rec("clover/model-codex-oauth", "bundled", { contributes: { models: [{ provider: "codex-oauth", auth: [{ method: "oauth-pkce", authorizeUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "c", scopes: ["a", "b"], secret: "chatgpt" }] }] } });
const XAI = rec("clover/model-xai-oauth", "bundled", { contributes: { models: [{ provider: "xai-oauth", auth: [{ method: "custom", handler: "signIn" }] }] } });
const THIRD = rec("acme/models", "folder", { contributes: { models: [{ provider: "acme", auth: [{ method: "api-key", secret: "key" }] }] }, auth: [{ method: "api-key", secret: "extra" }] });

const LOCAL = rec("acme/local", "folder", { contributes: { models: [{ provider: "acme-local" }] } });

function world(o: { oauth?: () => OAuthRun; xaiDevice?: Parameters<typeof createPluginAuth>[0]["xaiDevice"]; invoke?: (req: { handler: string }) => unknown } = {}) {
  const records = new Map([GROQ, CODEX, XAI, THIRD, LOCAL].map((r) => [r.id, r]));
  const secrets = new DaemonStore();
  const pluginSecrets = new MemorySecretStore();
  const events: { id: string; auth: PluginAuthView }[] = [];
  const refreshed: string[] = [];
  const auth = createPluginAuth({
    registry: { get: (id) => records.get(id) },
    host: { invoke: async (req) => o.invoke?.(req) as never },
    secrets, pluginSecrets,
    changed: (id, view) => events.push({ id, auth: view }),
    credentialChanged: (p) => { refreshed.push(p); },
    ...(o.oauth ? { oauth: o.oauth } : {}),
    ...(o.xaiDevice ? { xaiDevice: o.xaiDevice } : {}),
    modelProviders: () => [{ provider: "groq", pluginId: GROQ.id }, { provider: "acme", pluginId: THIRD.id }, { provider: "acme-local", pluginId: LOCAL.id }, { provider: "gone", pluginId: "acme/gone" }],
  });
  return { auth, secrets, pluginSecrets, events, refreshed };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("plugin.auth", () => {
  test("the sign-ins are numbered: the models entries' first, then the manifest's own", () => {
    expect(authEntriesOf(THIRD).map((e) => [e.index, e.provider ?? null, (e.entry as { secret: string }).secret])).toEqual([[0, "acme", "key"], [1, null, "extra"]]);
  });

  test("a bundled plugin's key lands in its provider's slot (where the model plugin reads it), and shows signed in", async () => {
    const w = world();
    expect(await w.auth.list(GROQ.id)).toEqual([{ index: 0, method: "api-key", secret: "api-key", state: "signed-out" }]);
    expect(await w.auth.signIn(GROQ.id, 0, "  gsk-the-key  ")).toEqual({ state: "signed-in" });
    expect(await readCredentialMaterial(w.secrets, modelPluginSlotFor("groq").account)).toEqual({ kind: "api-key", key: "gsk-the-key" });
    expect((await w.auth.list(GROQ.id))[0]!.state).toBe("signed-in");
    expect(w.refreshed).toEqual(["groq"]);
    expect(w.events.at(-1)).toEqual({ id: GROQ.id, auth: { index: 0, method: "api-key", secret: "api-key", state: "signed-in" } });
    await w.auth.signOut(GROQ.id, 0);
    expect((await w.auth.list(GROQ.id))[0]!.state).toBe("signed-out");
    expect(w.refreshed).toEqual(["groq", "groq"]);
  });

  test("a key stored before the plugins existed (the provider's slot) shows as signed in", async () => {
    const w = world();
    w.secrets.values.set(modelPluginSlotFor("groq").account, JSON.stringify({ kind: "api-key", key: "older" }));
    expect((await w.auth.list(GROQ.id))[0]!.state).toBe("signed-in");
  });

  test("another plugin's key is its own secret, never a provider slot", async () => {
    const w = world();
    await w.auth.signIn(THIRD.id, 1, "k2");
    expect((await w.pluginSecrets.get({ owner: { kind: "plugin", pluginId: THIRD.id }, name: "extra" }))?.value.reveal()).toBe("k2");
    expect(w.secrets.values.size).toBe(0);
    expect(w.refreshed).toEqual([]);
    expect((await w.auth.list(THIRD.id)).map((a) => a.state)).toEqual(["signed-out", "signed-in"]);
  });

  test("signedInProviders: a third party's provider once its own key is in, one taking no sign-in always; never a bundled one (its slot says) or a plugin gone", async () => {
    const w = world();
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
    await w.auth.signIn(GROQ.id, 0, "gsk");
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
    // The manifest's own sign-in isn't the provider's.
    await w.auth.signIn(THIRD.id, 1, "extra");
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
    await w.auth.signIn(THIRD.id, 0, "k1");
    expect([...await w.auth.signedInProviders()].sort()).toEqual(["acme", "acme-local"]);
    await w.auth.signOut(THIRD.id, 0);
    expect([...await w.auth.signedInProviders()]).toEqual(["acme-local"]);
  });

  test("a bad key is refused without echoing it; a key for a flow that takes none is refused", async () => {
    const w = world();
    const err = await w.auth.signIn(GROQ.id, 0, "bad​key").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("bad");
    await expect(w.auth.signIn(CODEX.id, 0, "x")).rejects.toThrow(/takes no key/);
    await expect(w.auth.signIn("nope/x", 0, "x")).rejects.toThrow(/no plugin/);
    await expect(w.auth.signIn(GROQ.id, 3, "x")).rejects.toThrow(/no sign-in 3/);
  });

  test("oauth-pkce: the URL comes back at once, the tokens land in the slot on the redirect, and the event says so", async () => {
    let finish!: () => void;
    const w = world({
      oauth: () => ({
        authorizeUrl: Promise.resolve("https://auth.example/authorize?x=1"),
        tokens: new Promise((res) => { finish = () => res({ accessToken: "at", refreshToken: "rt", idToken: null, accountId: "acct", expiresAt: 9e12 }); }),
      }),
    });
    expect(await w.auth.signIn(CODEX.id, 0)).toEqual({ state: "refreshing", authorizeUrl: "https://auth.example/authorize?x=1" });
    expect((await w.auth.list(CODEX.id))[0]!.state).toBe("refreshing");
    await expect(w.auth.signIn(CODEX.id, 0)).rejects.toThrow(/already running/);
    finish();
    await settle(); await settle(); await settle();
    expect(await readCredentialMaterial(w.secrets, modelPluginSlotFor("codex-oauth").account)).toMatchObject({ kind: "oauth", accessToken: "at", refreshToken: "rt", accountId: "acct" });
    expect(w.events.at(-1)?.auth.state).toBe("signed-in");
    expect(w.refreshed).toEqual(["codex-oauth"]);
  });

  test("an OAuth sign-in that fails shows failed with a reason, and the event says so", async () => {
    const w = world({ oauth: () => ({ authorizeUrl: Promise.resolve("https://auth.example/a"), tokens: Promise.reject(new Error("login timed out")) }) });
    await w.auth.signIn(CODEX.id, 0);
    await settle(); await settle();
    const v = (await w.auth.list(CODEX.id))[0]!;
    expect(v.state).toBe("failed");
    expect(v.reason).toContain("login timed out");
    expect(w.events.at(-1)?.auth.state).toBe("failed");
  });

  test("custom: the plugin's handler names the core's xAI device flow, whose URL comes back and whose token lands in the slot", async () => {
    const w = world({
      invoke: (req) => (req.handler === "signIn" ? { flow: "core", id: "xai-device" } : undefined),
      xaiDevice: async (store, onUrl) => {
        onUrl("https://accounts.x.ai/device?user_code=ABCD");
        await store.set({ kind: "keychain", account: "xai-oauth:someone" }, { kind: "oauth", accessToken: "xat", refreshToken: "xrt", expiresAt: 9e12 });
      },
    });
    expect(await w.auth.signIn(XAI.id, 0)).toEqual({ state: "refreshing", authorizeUrl: "https://accounts.x.ai/device?user_code=ABCD" });
    await settle(); await settle();
    expect(await readCredentialMaterial(w.secrets, modelPluginSlotFor("xai-oauth").account)).toMatchObject({ kind: "oauth", accessToken: "xat" });
    expect((await w.auth.list(XAI.id))[0]!.state).toBe("signed-in");
  });

  test("a custom handler that names no core flow is refused", async () => {
    const w = world({ invoke: () => ({ something: "else" }) });
    await expect(w.auth.signIn(XAI.id, 0)).rejects.toThrow(/names no sign-in flow/);
  });

  test("signing in and out is the user's alone; anyone may list", async () => {
    const w = world();
    const m = pluginAuthMethods(w.auth);
    const asSession = { caller: { kind: "session", sessionId: "s1", sessionKind: "bot" } as never };
    const asUser = { caller: { kind: "user", client: "app" } as never };
    await expect(m["plugin.auth.signIn"]!({ id: GROQ.id, index: 0, key: "k" }, asSession)).rejects.toThrow(/only the user/);
    await expect(m["plugin.auth.signOut"]!({ id: GROQ.id, index: 0 }, asSession)).rejects.toThrow(/only the user/);
    expect(await m["plugin.auth.signIn"]!({ id: GROQ.id, index: 0, key: "k" }, asUser)).toEqual({ state: "signed-in" });
    expect(await m["plugin.auth.list"]!({ id: GROQ.id }, asSession)).toEqual({ auth: [{ index: 0, method: "api-key", secret: "api-key", state: "signed-in" }] });
    expect(await m["plugin.auth.signOut"]!({ id: GROQ.id, index: 0 }, asUser)).toEqual({ ok: true });
  });
});
