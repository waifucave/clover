// `hasKeyFor` as the daemon builds it (key-presence.ts, #313's review): read before the bots start, read again when a
// bot asks after a few seconds, and a model plugin's own provider asked of the model plugins.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FileSecretStore } from "../../auth/secret-store";
import { flush } from "../../contracts/fakes/clock";
import { CLOVER_CREDENTIAL_INVENTORY } from "../../runtime-sdk/keychain";
import { BOT_KEY_PRESENCE_MS, botKeyPresence } from "../key-presence";
import { boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "./fixtures";

afterEach(() => removeTemps());

const slotOf = (provider: string) => CLOVER_CREDENTIAL_INVENTORY.find((s) => s.provider === provider)!.secretName;

describe("the daemon's hasKeyFor", () => {
  test("a bot whose plugin's model has a stored key gets that model from its very first look after a boot", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    await store.set(slotOf("anthropic"), JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    const hasKeyFor = await botKeyPresence(store, home);
    const root = tempDir();
    const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna", { model: { default: "anthropic/claude-sonnet-5-5" } }), "bot/instructions.md": "You are Luna." });
    const b = await boot({ home, plugins: (await pluginFromFolder(luna)).inputs, hasKeyFor });
    expect(b.bots.effective("luna")).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });
    expect(b.drivers.made[0]!.ctx.current().model).toBe("anthropic/claude-sonnet-5-5");
    await b.shutdown();
  });

  test("no key: the bot falls back to the user's default; a key stored later is seen once the view is a few seconds old", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    let now = 1_000;
    const hasKeyFor = await botKeyPresence(store, home, { now: () => now });
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false);
    expect(hasKeyFor("winter-test/calls")).toBe(true);
    await store.set(slotOf("anthropic"), JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false);
    now += BOT_KEY_PRESENCE_MS + 1;
    hasKeyFor("anthropic/claude-sonnet-5-5");
    for (let i = 0; i < 20 && !hasKeyFor("anthropic/claude-sonnet-5-5"); i++) await flush();
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(true);
  });

  test("a model plugin's own provider counts when a model plugin serves it; a built-in slot never asks the plugins", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    const served = new Set(["acme-llm"]);
    const hasKeyFor = await botKeyPresence(store, home, { pluginServes: (p) => served.has(p) });
    expect(hasKeyFor("acme-llm/acme-1")).toBe(true);
    expect(hasKeyFor("other-llm/x")).toBe(false);
    // A built-in provider with no stored key stays keyless, whatever a plugin says.
    served.add("anthropic");
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false);
  });

  test("a store that fails at boot reads as no key, so the bots still start, and the next read heals it", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    await store.set(slotOf("anthropic"), JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    let failing = true;
    const flaky = { get: (name: string) => (failing ? Promise.reject(new Error("the store is locked")) : store.get(name)), set: store.set.bind(store), delete: store.delete.bind(store) } as unknown as FileSecretStore;
    let now = 1_000;
    const hasKeyFor = await botKeyPresence(flaky, home, { now: () => now });
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false);
    failing = false;
    now += BOT_KEY_PRESENCE_MS + 1;
    hasKeyFor("anthropic/claude-sonnet-5-5");
    for (let i = 0; i < 20 && !hasKeyFor("anthropic/claude-sonnet-5-5"); i++) await flush();
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(true);
  });

  test("#328's check: a third party's provider counts only while signed in through its plugin (or taking no sign-in)", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    const served = new Set(["acme-llm", "acme-local"]);
    // acme-local takes no sign-in; acme-llm needs its key.
    const signedIn = new Set(["acme-local"]);
    let reads = 0;
    const hasKeyFor = await botKeyPresence(store, home, { pluginServes: (p) => served.has(p), pluginSignedIn: async () => (reads++, new Set(signedIn)) });
    expect(hasKeyFor("acme-llm/acme-1")).toBe(false);
    expect(hasKeyFor("acme-local/tiny")).toBe(true);
    // Signed in: keyed once the view is read again (the daemon refreshes at the sign-in's event).
    signedIn.add("acme-llm");
    expect(hasKeyFor("acme-llm/acme-1")).toBe(false);
    await hasKeyFor.refresh();
    expect(hasKeyFor("acme-llm/acme-1")).toBe(true);
    // Signed out: not keyed again.
    signedIn.delete("acme-llm");
    await hasKeyFor.refresh();
    expect(hasKeyFor("acme-llm/acme-1")).toBe(false);
    expect(reads).toBe(3);
    // A failed read keeps the last view.
    const failing = await botKeyPresence(store, home, { pluginServes: (p) => served.has(p), pluginSignedIn: () => Promise.reject(new Error("no")) });
    expect(failing("acme-llm/acme-1")).toBe(false);
  });

  test("#328's check: a bot whose plugin model is a third party's provider with no key falls back to the default model, and takes it once signed in", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    const signedIn = new Set<string>();
    const hasKeyFor = await botKeyPresence(store, home, { pluginServes: (p) => p === "acme-llm", pluginSignedIn: async () => new Set(signedIn) });
    const root = tempDir();
    const luna = writePlugin(root, "luna", { "clover.json": botManifest("luna", "Luna", { model: { default: "acme-llm/acme-1" } }), "bot/instructions.md": "You are Luna." });
    const b = await boot({ home, plugins: (await pluginFromFolder(luna)).inputs, hasKeyFor });
    expect(b.bots.effective("luna")).toMatchObject({ model: "fireworks/kimi-k3", modelFrom: "default" });
    signedIn.add("acme-llm");
    await hasKeyFor.refresh();
    expect(b.bots.effective("luna")).toMatchObject({ model: "acme-llm/acme-1", modelFrom: "plugin" });
    signedIn.delete("acme-llm");
    await hasKeyFor.refresh();
    expect(b.bots.effective("luna")).toMatchObject({ model: "fireworks/kimi-k3", modelFrom: "default" });
    await b.shutdown();
  });

  test("a sign-in or sign-out refreshes the view at once: the very next look sees it, with no wait for the view to age", async () => {
    const home = tempDir();
    const store = new FileSecretStore(join(home, "secrets.json"));
    const now = 1_000; // frozen: the periodic read never fires
    const hasKeyFor = await botKeyPresence(store, home, { now: () => now, pluginServes: () => false });
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false);
    await store.set(slotOf("anthropic"), JSON.stringify({ kind: "api-key", key: "sk-ant-test" }));
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false); // the stale view, until a refresh
    await hasKeyFor.refresh();
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(true);
    await store.delete(slotOf("anthropic"));
    await hasKeyFor.refresh();
    expect(hasKeyFor("anthropic/claude-sonnet-5-5")).toBe(false);
    // A store that fails on the refresh keeps the last view.
    const failing = await botKeyPresence({ get: () => Promise.reject(new Error("locked")) } as unknown as FileSecretStore, home, { now: () => now });
    await failing.refresh();
    expect(failing("anthropic/claude-sonnet-5-5")).toBe(false);
  });
});
