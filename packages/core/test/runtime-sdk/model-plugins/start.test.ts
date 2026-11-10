// A-M2: the daemon's one call (`startModelPlugins`) and where a bundled model plugin's keys come from there: today's
// provider keychain slots (`keychain-tokens.ts`). Fakes only: lane B's registry and host fakes, an in-memory daemon
// secret store, a recorded Codex fake. No network, no account, no real key, no real Keychain.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import type { ProviderEvent } from "@waifucave/clover-provider-runtime";
import { codexFake, openaiResponsesFake, type FakeServer } from "@waifucave/clover-provider-conformance/fakes";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import type { SecretStore } from "../../../src/auth/secret-store";
import { pluginFromFolder, removeTemps, tempDir } from "../../../src/bots/tests/fixtures";
import { FakeClock } from "../../../src/contracts/fakes/clock";
import { FakePluginHost } from "../../../src/contracts/fakes/plugin-host";
import { FakePluginRegistry, type FakePluginInput } from "../../../src/contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import type { HostModule } from "../../../src/contracts/sdk-types";
import { internalAdapterFor } from "../../../src/providers/internal-adapters";
import { BUNDLED_CHILDREN_DIR, CODE_PLUGINS, modelPluginId } from "../../../src/runtime-sdk/model-plugins/bundled";
import { activeCatalog, installedModelPlugins } from "../../../src/runtime-sdk/model-plugins/index";
import { bundledModelProviderOf, keychainModelPluginCredentials, modelPluginSlotFor } from "../../../src/runtime-sdk/model-plugins/keychain-tokens";
import { secretStoreCredentials } from "../../../src/runtime-sdk/model-plugins/plugin-api";
import { startModelPlugins, type StartedModelPlugins } from "../../../src/runtime-sdk/model-plugins/start";
import { serveApiHandlers } from "./api-handlers-host";

/** The daemon's store, in memory. */
class DaemonStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<boolean> {
    return this.values.delete(name);
  }
}

let bundled: FakePluginInput[];
beforeAll(async () => {
  bundled = (await pluginFromFolder(join(BUNDLED_CHILDREN_DIR, ".."), { bundled: true })).inputs;
});
let started: StartedModelPlugins | undefined;
afterEach(() => {
  started?.stop();
  started = undefined;
  removeTemps();
});

const registryOf = (extra: FakePluginInput[] = []) => new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [...bundled, ...extra] });

describe("a bundled model plugin's keys come from its provider's keychain slot", () => {
  test("the slot is the provider's inventory slot, else <provider>:default", () => {
    expect(modelPluginSlotFor("openai").account).toBe("openai:default");
    expect(modelPluginSlotFor("codex-oauth").account).toBe("codex-oauth:default");
    expect(modelPluginSlotFor("anthropic").account).toBe("anthropic:default");
    expect(modelPluginSlotFor("console").account).toBe("anthropic:console");
    expect(modelPluginSlotFor("groq").account).toBe("groq:default");
    expect(modelPluginSlotFor("bedrock").account).toBe("bedrock:default");
  });

  test("an api-key record gives its key; a new value is a new generation; nothing stored is null", async () => {
    const registry = registryOf();
    expect(bundledModelProviderOf(registry.get(modelPluginId("groq")))).toBe("groq");
    const store = new DaemonStore();
    const creds = keychainModelPluginCredentials({ registry, secrets: store });
    const source = creds.tokens(modelPluginId("groq"), "api-key");
    expect(await source.current()).toBeNull();
    store.values.set("groq:default", JSON.stringify({ kind: "api-key", key: "k-one" }));
    expect(await source.current()).toEqual({ value: "k-one", generation: 1 });
    expect(await source.current()).toEqual({ value: "k-one", generation: 1 });
    expect(await source.newer(1)).toBeNull();
    store.values.set("groq:default", JSON.stringify({ kind: "api-key", key: "k-two" }));
    expect(await source.newer(1)).toEqual({ value: "k-two", generation: 2 });
  });

  test("Codex: the access token, a 401 runs the slot's refresher, and the account id fills the connection", async () => {
    const registry = registryOf();
    const store = new DaemonStore();
    store.values.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "a-one", refreshToken: "r", accountId: "acct-1" }));
    const refreshed: string[] = [];
    const creds = keychainModelPluginCredentials({
      registry,
      secrets: store,
      refreshers: {
        "codex-oauth:default": async (account) => {
          refreshed.push(account);
          store.values.set(account, JSON.stringify({ kind: "oauth", accessToken: "a-two", refreshToken: "r", accountId: "acct-1" }));
        },
      },
    });
    await creds.prime();
    expect(creds.connectionFor(modelPluginId("codex-oauth"), { providerId: "codex-oauth" } as { account?: string })).toEqual({ providerId: "codex-oauth", account: "acct-1" } as never);
    expect(creds.connectionFor(modelPluginId("codex-oauth"), { account: "stated" })).toEqual({ account: "stated" });
    const source = creds.tokens(modelPluginId("codex-oauth"), "chatgpt");
    expect(await source.current()).toEqual({ value: "a-one", generation: 1 });
    expect(await source.newer(1)).toEqual({ value: "a-two", generation: 2 });
    expect(refreshed).toEqual(["codex-oauth:default"]);
  });

  test("every auth name a bundled plugin declares reads its provider's slot: xAI's custom signIn, Codex's chatgpt", async () => {
    const store = new DaemonStore();
    store.values.set("xai-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "xai-token", refreshToken: "r" }));
    store.values.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: "codex-token" }));
    const creds = keychainModelPluginCredentials({ registry: registryOf(), secrets: store });
    expect(modelPluginSlotFor("xai-oauth").account).toBe("xai-oauth:default");
    expect((await creds.tokens(modelPluginId("xai-oauth"), "signIn").current())?.value).toBe("xai-token");
    expect((await creds.tokens(modelPluginId("codex-oauth"), "chatgpt").current())?.value).toBe("codex-token");
  });

  test("a signing plugin's own secret is its provider's record, as stored", async () => {
    const store = new DaemonStore();
    const aws = JSON.stringify({ kind: "aws", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-secret" });
    store.values.set("bedrock:default", aws);
    const creds = keychainModelPluginCredentials({ registry: registryOf(), secrets: store });
    expect(await creds.secret(modelPluginId("bedrock"), "aws")).toBe(aws);
    expect(await creds.secret(modelPluginId("vertex"), "gcp-service-account")).toBeUndefined();
  });

  test("a plugin that isn't bundled never reads a provider slot: its own items serve it", async () => {
    const extra: FakePluginInput[] = [
      {
        id: "third-groq",
        manifest: { manifest: 1, id: "third-groq", name: "Third", contributes: { models: [{ provider: "groq-third", name: "Groq", catalog: [], auth: [{ method: "api-key", secret: "api-key" }], endpoint: { protocol: "openai-chat", baseUrl: "https://api.groq.com/openai/v1" } }] } } as never,
        source: "local",
      },
    ];
    const registry = registryOf(extra);
    expect(bundledModelProviderOf(registry.get("third-groq"))).toBeUndefined();
    const store = new DaemonStore();
    store.values.set("groq:default", JSON.stringify({ kind: "api-key", key: "the-users-groq-key" }));
    const own = new MemorySecretStore();
    await own.set({ owner: { kind: "plugin", pluginId: "third-groq" }, name: "api-key" }, "third-party-key");
    const creds = keychainModelPluginCredentials({ registry, secrets: store, fallback: secretStoreCredentials(own) });
    expect((await creds.tokens("third-groq", "api-key").current())?.value).toBe("third-party-key");
    expect(await keychainModelPluginCredentials({ registry, secrets: store }).tokens("third-groq", "api-key").current()).toBeNull();
  });
});

async function text(events: AsyncIterable<ProviderEvent>): Promise<string> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") throw new Error(`${e.error.code}: ${e.error.message}`);
    if (e.type === "text_delta") out += e.text;
  }
  return out;
}

describe("startModelPlugins", () => {
  test("a first load that fails rolls back (no handlers, nothing installed); a clean stop leaves the router as it was", async () => {
    const registry = registryOf();
    const host = new FakePluginHost({ clock: new FakeClock() });
    const api = serveApiHandlers(host, registry);
    let serveApiCalls = 0;
    const serveApi = host.serveApi.bind(host);
    host.serveApi = (r) => { serveApiCalls += 1; serveApi(r); };
    // A home whose catalog folder can't be made: the first load fails.
    const blocker = join(tempDir("clover-a2-start-bad-"), "a-file");
    writeFileSync(blocker, "x");
    await expect(startModelPlugins({ registry, host, home: blocker, secrets: new DaemonStore(), addApiHandlers: (h) => api.addApiHandlers(h) })).rejects.toThrow();
    expect(api.served()).toBe(0);
    expect(installedModelPlugins()).toBeUndefined();
    // A clean start and stop: the handlers come and go; the host's router is never replaced.
    const ok = await startModelPlugins({ registry, host, home: tempDir("clover-a2-start-ok-"), secrets: new DaemonStore(), addApiHandlers: (h) => api.addApiHandlers(h) });
    expect(api.served()).toBe(1);
    ok.stop();
    ok.stop();
    expect(api.served()).toBe(0);
    expect(installedModelPlugins()).toBeUndefined();
    expect(serveApiCalls).toBe(0);
  });

  test("installs the plugins: the catalog readers read theirs, the internal jobs run Codex on its plugin with the keychain's sign-in; stop puts the compiled catalog back", async () => {
    const fake: FakeServer & { bearers: string[]; requests: Array<{ path: string; headers: Record<string, string> }> } = (await codexFake.startCodexFake({
      scenarios: { "gpt-5.6-luna": [openaiResponsesFake.responsesStream({ text: ["hello from ", "codex"] })] },
    })) as never;
    try {
      const registry = registryOf();
      const host = new FakePluginHost({ clock: new FakeClock() });
      for (const id of Object.keys(CODE_PLUGINS)) {
        const record = registry.get(modelPluginId(id))!;
        host.define(record.id, (await import(join(record.folder, record.manifest!.host!.entry))) as HostModule, { source: "bundled", runtime: record.manifest!.host!.runtime ?? "bun" });
      }
      const store = new DaemonStore();
      store.values.set("codex-oauth:default", JSON.stringify({ kind: "oauth", accessToken: codexFake.FAKE_ACCESS_TOKEN, accountId: codexFake.FAKE_ACCOUNT_ID }));
      const fetch = async (url: string, init: RequestInit): Promise<Response> => {
        const u = new URL(url);
        if (u.host !== "chatgpt.com") throw new Error(`no fake for ${u.host}`);
        return globalThis.fetch(`${fake.url}${u.pathname}${u.search}`, init);
      };
      const api = serveApiHandlers(host, registry);
      started = await startModelPlugins({ registry, host, home: tempDir("clover-a2-start-home-"), secrets: store, fetch, addApiHandlers: (h) => api.addApiHandlers(h) });
      expect(installedModelPlugins()).toBe(started.plugins);
      expect(activeCatalog()).not.toBe(loadCatalog());
      expect(activeCatalog().providers.length).toBe(loadCatalog().providers.length);

      const adapter = internalAdapterFor("codex-oauth")!;
      const ctx = { connection: { providerId: "codex-oauth" } as never, credentials: { get: async () => null, set: async () => {}, delete: async () => {} }, authRef: { kind: "none" as const }, stallTimeoutMs: 5000, log: () => {} };
      expect(await text(adapter.streamTurn({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }, ctx as never))).toBe("hello from codex");
      expect(fake.bearers).toEqual([codexFake.FAKE_ACCESS_TOKEN]);
      const turn = fake.requests.find((r) => r.path.endsWith("/responses"))!;
      expect(turn.headers["chatgpt-account-id"]).toBe(codexFake.FAKE_ACCOUNT_ID);
      expect(turn.headers["originator"]).toBe("clover");

      started.stop();
      started = undefined;
      expect(installedModelPlugins()).toBeUndefined();
      expect(activeCatalog()).toBe(loadCatalog());
    } finally {
      await fake.close();
    }
  }, 30_000);
});
