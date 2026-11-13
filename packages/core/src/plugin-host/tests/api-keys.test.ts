// `keys.*` in a real plugin host: a bundled plugin of the `clover` tree, in the `clover` process, makes its own X25519
// pair, hands out the public half, opens an HPKE message sealed to it (RFC 9180 base mode, the forwarder's suite) and
// drops it; the private half never reaches the host (a device item in the secret store, under a name no plugin's
// `secrets.get` reads); another name's message doesn't open; a third-party plugin, in a process of its own or a worker,
// has no keys at all. Temp home, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYS_PER_PLUGIN_MAX, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { measureBundledTree } from "../../bundled-plugins-dir";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { fromBase64Url } from "../../identity/bytes";
import { sealToBoxKey } from "../../identity/box-key";
import { stageBundledPlugins, stagedBundledDir } from "../../registry/bundled-stage";
import { openPluginRegistry } from "../../registry/open";
import { pluginKeyRef } from "../api/keys";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const pub = async (args, ctx) => tried(() => ctx.api.keys.publicKey(args.name));
export const open = async (args, ctx) => tried(async () => new TextDecoder().decode(await ctx.api.keys.open(args.name, args.sealed)));
export const drop = async (args, ctx) => tried(() => ctx.api.keys.delete(args.name));
export const many = async (args, ctx) => { const out = []; for (let i = 0; i < args.n; i++) out.push(await tried(async () => (await ctx.api.keys.publicKey("k" + i)).length)); return out; };
export const secret = async (args, ctx) => tried(() => ctx.api.secrets.get(args.name));
export const has = async (args, ctx) => ({ keys: "keys" in ctx.api });
`;

function write(folder: string, id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", ...extra } }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
}

function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => { if (registry.get(id)?.state !== "found") { off(); resolve(); } });
    if (registry.get(id)?.state !== "found") { off(); resolve(); }
  });
}

/** A message sealed to `publicKey` as the forwarder seals one: its parts. */
function seal(publicKey: Uint8Array, text: string, aad: string, info: string) {
  const box = fromBase64Url(sealToBoxKey(publicKey, new TextEncoder().encode(aad), new TextEncoder().encode(text), info))!;
  return { enc: box.subarray(0, 32), ciphertext: box.subarray(32), aad: new TextEncoder().encode(aad), info: new TextEncoder().encode(info) };
}

describe("keys.* in a real plugin host", () => {
  test("the clover process's plugin makes, uses and drops its own keys; nothing of them reaches the host; no other plugin has keys", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-keys-")));
    temps.push(home);
    const root = join(home, "resources", "plugins");
    write(join(root, "clover"), "clover");
    const staged = stageBundledPlugins({ root, manifest: measureBundledTree(root), out: stagedBundledDir(home) });
    write(join(home, "plugins", "thirdparty"), "thirdparty", { process: "own" });
    write(join(home, "plugins", "worker"), "worker");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests, fence: false });
    try {
      for (const id of ["thirdparty", "worker"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER });
      expect(await call("clover", "has")).toEqual({ keys: true });
      // Made on first use, the same on the next.
      const pub = await call<Uint8Array>("clover", "pub", { name: "fwd" });
      expect(pub).toBeInstanceOf(Uint8Array);
      expect(pub.length).toBe(32);
      expect(await call<Uint8Array>("clover", "pub", { name: "fwd" })).toEqual(pub);
      // A webhook sealed to it opens; one sealed to another key, or tampered with, doesn't.
      const msg = seal(pub, "a webhook body", "route-1", "clover forwarder v1");
      expect(await call("clover", "open", { name: "fwd", sealed: msg })).toBe("a webhook body");
      const other = await call<Uint8Array>("clover", "pub", { name: "other" });
      expect(await call("clover", "open", { name: "fwd", sealed: seal(other, "x", "a", "i") })).toEqual({ error: "invalid: the message doesn't open with that key" });
      expect(await call("clover", "open", { name: "fwd", sealed: { ...msg, aad: new TextEncoder().encode("route-2") } })).toEqual({ error: "invalid: the message doesn't open with that key" });
      expect(await call("clover", "open", { name: "never", sealed: msg })).toEqual({ error: expect.stringMatching(/^not_found: clover has no key never/) });
      expect(await call("clover", "pub", { name: "Bad Name" })).toEqual({ error: expect.stringMatching(/^invalid: a key's name/) });
      // The private half is a device item the core holds, never synced, under a name the plugin's own secrets don't reach.
      const item = await secrets.get(pluginKeyRef("clover", "fwd"));
      expect(item).not.toBeNull();
      expect((await secrets.list({ kind: "device" })).find((m) => m.ref.name === pluginKeyRef("clover", "fwd").name)?.synced).toBe(false);
      expect(await secrets.list({ kind: "plugin", pluginId: "clover" })).toEqual([]);
      // At most KEYS_PER_PLUGIN_MAX a plugin.
      const made = await call<unknown[]>("clover", "many", { n: KEYS_PER_PLUGIN_MAX });
      expect(made.filter((x) => x === 32).length).toBe(KEYS_PER_PLUGIN_MAX - 2);
      expect(made.at(-1)).toEqual({ error: expect.stringMatching(/^refused: clover holds 16 keys/) });
      // Dropped: what was sealed to it no longer opens, and a new one is a new pair.
      await call("clover", "drop", { name: "fwd" });
      expect(await call("clover", "open", { name: "fwd", sealed: msg })).toEqual({ error: expect.stringMatching(/^not_found/) });
      expect(await call<Uint8Array>("clover", "pub", { name: "fwd" })).not.toEqual(pub);
      // A third-party plugin has no keys, in a process of its own or a worker.
      for (const id of ["thirdparty", "worker"]) {
        expect(await call(id, "pub", { name: "fwd" })).toEqual({ error: expect.stringMatching(/keys\.publicKey .*clover/) });
        expect(await call(id, "open", { name: "fwd", sealed: msg })).toEqual({ error: expect.stringMatching(/keys\.open .*clover/) });
      }
    } finally {
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
