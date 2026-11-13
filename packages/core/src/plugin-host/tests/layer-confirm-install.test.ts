// What a component reaches through its layer's real entries (`plugin.layer.call` on its own connection, and the app's
// `plugin.layer.api`), over the real registry, a real plugin host's capability gate and the registry's own install door:
// `confirm` and `confirmCard` raise the app's own sealed card naming the plugin, as a host half's do, and the component
// gets only the answer (and the card's id); `plugins.install` (capability `plugins.install`, bundled-only in the
// catalog: "from the indexes and npm") installs from an index or npm through the user's door, landing found behind its OK
// card, which says which plugin asked. Refused: a folder or a wrapped item (the user's own to bring), a plugin without
// the capability, a host half's call (components only), a source that isn't one, a plugin that's off.
// Temp homes, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexFetch } from "../../registry/indexes/client";
import { tgz } from "../../registry/indexes/tests/tar-fixture";
import { validatePluginFolder } from "../../registry/validate";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { PLUGINS_METHODS, type Caller } from "@waifucave/clover-protocol";
import { measureBundledTree } from "../../bundled-plugins-dir";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { stageBundledPlugins, stagedBundledDir } from "../../registry/bundled-stage";
import { openPluginRegistry } from "../../registry/open";
import { pluginsInstallApi } from "../api/install";
import { startPluginHost } from "../daemon-host";
import { pluginRegistryMethods, type ComponentInstallDoor } from "../registry-methods";
import { pluginUi } from "../ui";

setDefaultTimeout(60_000);
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const ENGINES = { clover: `^${PLUGIN_API_VERSION}` };
const APP: Caller = { kind: "user", client: "app" };
const INDEX_URL = "https://plugins.example.test/index.json";

function plugin(folder: string, manifest: Record<string, unknown>): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, version: "1.0.0", engines: ENGINES, ...manifest }));
}

async function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-layer-")));
  temps.push(home);
  // Clover's own tree holds `plugins.install` (the catalog: bundled only); a third party doesn't and can't.
  const root = join(home, "resources", "plugins");
  plugin(join(root, "clover"), { id: "clover", name: "Clover", capabilities: ["plugins.install"] });
  const staged = stageBundledPlugins({ root, manifest: measureBundledTree(root), out: stagedBundledDir(home) });
  plugin(join(home, "plugins", "deck"), { id: "deck", name: "Deck" });
  // What a component asks to install: Tarot, listed in an index the user added (served by a fake fetch, as a download).
  plugin(join(home, "downloads", "tarot"), { id: "tarot", name: "Tarot" });
  const tarotManifest = JSON.stringify({ manifest: 1, version: "1.0.0", engines: ENGINES, id: "tarot", name: "Tarot" });
  const files = new Map<string, Uint8Array>([["https://plugins.example.test/tarot-1.0.0.tgz", tgz([{ path: "clover.json", data: tarotManifest }])]]);
  const hash = (await validatePluginFolder(join(home, "downloads", "tarot"))).treeHash!;
  files.set(INDEX_URL, new TextEncoder().encode(JSON.stringify({ index: 1, name: "Index", plugins: [{ id: "tarot", versions: [{ version: "1.0.0", hash, url: "https://plugins.example.test/tarot-1.0.0.tgz" }] }] })));
  const fetch: IndexFetch = async (url, max) => {
    const b = files.get(url);
    if (b === undefined) throw new Error("it answered 404");
    if (b.byteLength > max) throw new Error("too large");
    return b;
  };
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50, indexes: { cacheDir: join(home, "plugins-state", "index-cache"), fetch } });
  opened.indexes!.add(INDEX_URL);
  await opened.indexes!.refresh();
  let door: ComponentInstallDoor | undefined;
  const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests, fence: false, approvals: broker, handlers: [pluginsInstallApi(() => door)] });
  const methods = pluginRegistryMethods({ opened, host: ph.host, home, os: "macos", indexes: opened.indexes!, componentInstalls: (d) => { door = d; } });
  const ui = pluginUi({ registry: opened.registry, router: ph.gate, emit: () => {} });
  const answer = async (cardId: string, optionId: "approve" | "deny") => {
    const shown = broker.cards().find((c) => c.id === cardId)!;
    await broker.answer(cardId, { optionId, hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(cardId)!, input: "click", at: Date.now() } }, { role: "app" });
  };
  // The third party, OK'd.
  const { card } = await opened.registry.installed("deck", "app");
  await answer(card!, "approve");
  for (let i = 0; i < 250 && opened.registry.get("deck")?.state === "found"; i++) await Bun.sleep(20);
  // A component's own connection, and the app's entry for one of its components.
  const own = (pluginId: string, call: string, args: unknown[]) => ui.methods[PLUGINS_METHODS.pluginLayerCall.name]!({ call, args }, { caller: { kind: "plugin", pluginId } } as never) as Promise<{ result: unknown }>;
  const viaApp = (pluginId: string, call: string, args: unknown[]) => ui.methods[PLUGINS_METHODS.pluginLayerApi.name]!({ pluginId, call, args }, { caller: APP } as never) as Promise<{ result: unknown }>;
  const close = async () => { ui.close(); await ph.close(); opened.close(); };
  return { home, opened, broker, ph, methods, own, viaApp, answer, close };
}

const until = async <T,>(f: () => T | undefined, what: string): Promise<T> => {
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(20)) { const v = f(); if (v !== undefined) return v; }
  throw new Error(`never: ${what}`);
};
const error = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error & { code?: unknown });

describe("confirm and confirmCard from a component", () => {
  test("the app's own sealed card, naming the plugin; the component gets only the answer, on both entries", async () => {
    const w = await world();
    try {
      // On its own connection: the card is a `confirm` card from the plugin, its words only in `what`.
      const asked = w.own("deck", "confirm", ["Shuffle the whole deck?"]);
      const card = await until(() => w.broker.cards().find((c) => c.kind === "confirm" && c.pluginId === "deck"), "the confirm card");
      expect(card.fields["title"]).toEqual({ type: "text", text: "A plugin asks" });
      expect(card.fields["what"]).toEqual({ type: "text", text: "Shuffle the whole deck?" });
      expect(card.fields["source"]).toMatchObject({ type: "rows", rows: expect.arrayContaining([{ label: "Plugin", value: "Deck" }, { label: "Id", value: "deck" }]) });
      await w.answer(card.id, "approve");
      expect(await asked).toEqual({ result: true });
      // `confirmCard`: the answer and the card's id; a no is a no.
      const withCard = w.own("deck", "confirmCard", ["Keep the reversed cards?"]);
      const second = await until(() => w.broker.cards().find((c) => c.kind === "confirm" && c.id !== card.id && c.pluginId === "deck"), "the second card");
      await w.answer(second.id, "deny");
      expect(await withCard).toEqual({ result: { allowed: false, card: second.id } });
      // The app's entry for the plugin's component (`plugin.layer.api`) asks the same way.
      const viaApp = w.viaApp("deck", "confirm", ["From the app's side?"]);
      const third = await until(() => w.broker.cards().find((c) => c.kind === "confirm" && ![card.id, second.id].includes(c.id)), "the third card");
      expect(third.pluginId).toBe("deck");
      await w.answer(third.id, "approve");
      expect(await viaApp).toEqual({ result: true });
    } finally {
      await w.close();
    }
  });

  test("refused: no text, or a plugin that is off", async () => {
    const w = await world();
    try {
      expect((await error(w.own("deck", "confirm", [""])))?.message).toContain("confirm takes the question as text");
      await w.opened.registry.setEnabled("deck", false);
      expect((await error(w.own("deck", "confirm", ["Still there?"])))?.message).toMatch(/deck is off/);
      expect(w.broker.cards().filter((c) => c.kind === "confirm")).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe("plugins.install from a component", () => {
  test("installs through the user's door: the plugin lands found, nothing runs, and its OK card says which plugin asked", async () => {
    const w = await world();
    try {
      const r = await w.own("clover", "plugins.install", [{ from: "index", id: "tarot" }]);
      const got = r.result as { id: string; state: string; card?: string };
      expect([got.id, got.state, typeof got.card]).toEqual(["tarot", "found", "string"]);
      const card = w.broker.cards().find((c) => c.id === got.card)!;
      expect(JSON.stringify(card.fields)).toContain("Clover wants to add Tarot.");
      expect(w.opened.registry.get("tarot")).toMatchObject({ state: "found", provenance: { by: "plugin", plugin: "clover" } });
      // Its OK applies it, as any install's.
      await w.answer(card.id, "approve");
      await until(() => (w.opened.registry.get("tarot")?.state !== "found" ? true : undefined), "tarot OK'd");
      expect(w.opened.registry.get("tarot")!.okHash).toBe(w.opened.registry.get("tarot")!.treeHash);
    } finally {
      await w.close();
    }
  });

  test("refused: without the capability, from the app's entry for a plugin without it, a source that isn't one", async () => {
    const w = await world();
    try {
      const fromIndex = { from: "index", id: "tarot" };
      for (const got of [await error(w.own("deck", "plugins.install", [fromIndex])), await error(w.viaApp("deck", "plugins.install", [fromIndex]))]) {
        expect(got?.message).toBe("plugins.install needs the capability plugins.install, which this plugin's OK doesn't list");
      }
      expect((await error(w.own("clover", "plugins.install", [{ from: "nowhere" }])))?.message).toContain("plugins.install takes a source");
      expect(w.opened.registry.get("tarot")).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  test("only from an index or npm: a folder or a wrapped item from a component is refused, plainly; the user's own install keeps them", async () => {
    const w = await world();
    try {
      const folder = { from: "folder", path: join(w.home, "downloads", "tarot") };
      const wrap = { from: "wrap", kind: "mcp-config", value: JSON.stringify({ mcpServers: { x: { command: "/bin/echo" } } }) };
      for (const source of [folder, wrap]) {
        expect((await error(w.own("clover", "plugins.install", [source])))?.message).toBe("a plugin can add plugins only from an index or npm");
      }
      expect(w.opened.registry.get("tarot")).toBeUndefined();
      expect(w.opened.registry.list().filter((r) => r.provenance.by === "plugin")).toEqual([]);
      // The user's own install from the same folder still goes (its card says the user added it).
      const mine = (await w.methods["plugin.install"]!({ source: folder }, { caller: APP } as never)) as { id: string; state: string };
      expect([mine.id, mine.state]).toEqual(["tarot", "found"]);
      expect(w.opened.registry.get("tarot")!.provenance.by).toBe("user-app");
    } finally {
      await w.close();
    }
  });

  test("a host half can't install: plugins.install is a component's call only", async () => {
    const w = await world();
    try {
      const got = await error(w.ph.gate({ pluginId: "clover", process: "clover", path: "plugins.install", args: [{ from: "index", id: "tarot" }], caller: { kind: "plugin", pluginId: "clover" } }));
      expect(got?.message).toBe("plugins.install exists only in components");
    } finally {
      await w.close();
    }
  });
});
