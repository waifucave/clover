// Pins the PluginRegistry contract through FakePluginRegistry: states, children, waiting points and spots, unique
// entry ids and namespaces, private points, the catalog's declarations, the OK bound to a tree hash, and the order
// changes arrive in.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { CORE_POINTS } from "../../../../plugin-sdk/src/catalogs/points";
import { FakePluginRegistry, type FakePluginInput, type FakePluginRegistryOptions } from "../fakes/plugin-registry";
import { UNIQUE_ENTRY_FIELD, type RegistryChange } from "../plugin-registry";
import type { Manifest } from "../sdk-types";

const m = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over });
const make = (opts: Omit<FakePluginRegistryOptions, "catalog"> = {}) => new FakePluginRegistry({ catalog: catalogPointDecl, ...opts });
const hashOf = (reg: FakePluginRegistry, id: string) => reg.get(id)!.treeHash!;

const island: FakePluginInput = {
  id: "island",
  manifest: m({
    name: "Island",
    client: { entry: "client/index.tsx" },
    contributes: {
      ui: [{ spot: "app.surface", id: "island", component: "Island", declares: { "island.tab": { shape: "list", props: {}, doc: "A tab in the island" } } }],
    },
  }),
};
const usageTab: FakePluginInput = {
  id: "usage-tab",
  manifest: m({ name: "Usage tab", client: { entry: "client/index.tsx" }, contributes: { ui: [{ spot: "island.tab", id: "usage", component: "UsageTab" }] } }),
};
const forwarder: FakePluginInput = {
  id: "forwarder",
  manifest: m({ name: "Forwarder", host: { entry: "host/index.ts" }, contributes: { "webhook.ingress": [{ id: "waifucave", handler: "ingress" }] } }),
};
const webhook: FakePluginInput = {
  id: "webhook",
  manifest: m({
    name: "Webhook trigger",
    host: { entry: "host/index.ts", declares: { "webhook.ingress": { shape: "list", fields: { type: "object" }, doc: "Ways in for webhooks" } } },
    contributes: { triggers: [{ type: "webhook", title: "Webhook", handler: "arm" }] },
  }),
};

describe("FakePluginRegistry: states", () => {
  test("a found plugin waits for its OK; approving runs it; refusing keeps it off until its folder changes", async () => {
    const reg = make({ plugins: [{ ...webhook, approved: false }] });
    expect(reg.get("webhook")).toMatchObject({ state: "found", reason: "waiting for your OK" });
    expect(reg.entries("triggers")).toEqual([]);
    await reg.refuse("webhook");
    expect(reg.get("webhook")?.state).toBe("refused");
    reg.put(webhook);
    expect(reg.get("webhook")?.state).toBe("refused");
    reg.put({ ...webhook, manifest: { ...webhook.manifest, version: "1.0.1" } });
    expect(reg.get("webhook")?.state).toBe("found");
    expect(await reg.approve("webhook", hashOf(reg, "webhook"))).toBe("approved");
    expect(reg.get("webhook")?.state).toBe("running");
    expect(reg.entries("triggers").map((c) => [c.entryId, c.state])).toEqual([["webhook", "active"]]);
  });

  test("invalid, blocked and stopped plugins say why, and contribute nothing", () => {
    const reg = make({
      plugins: [{ ...webhook, invalid: "needs a newer Clover (plugin API ^2.0.0)" }, { ...forwarder, blocked: "revoked by the official index: malware" }],
    });
    expect(reg.get("webhook")).toMatchObject({ state: "invalid", reason: "needs a newer Clover (plugin API ^2.0.0)", manifest: undefined });
    expect(reg.get("forwarder")).toMatchObject({ state: "blocked", reason: "revoked by the official index: malware" });
    expect(reg.entries("triggers")).toEqual([]);
    const ok = make({ plugins: [webhook] });
    ok.setStopped("webhook", "crashed 3 times in 10 minutes");
    expect(ok.get("webhook")).toMatchObject({ state: "stopped", reason: "plugin stopped: crashed 3 times in 10 minutes" });
    ok.setStopped("webhook", null);
    expect(ok.get("webhook")?.state).toBe("running");
  });

  test("a child switches by itself, and its parent's switch turns it off", async () => {
    const parent: FakePluginInput = { id: "luna", manifest: m({ id: "luna", name: "Luna", version: "1.2.0", contributes: { bot: { name: "Luna", instructions: "bot/instructions.md" } } }) };
    const child: FakePluginInput = { id: "luna/tarot", manifest: m({ name: "Tarot", contributes: { commands: [{ name: "draw", description: "Draw", handler: "draw" }] } }) };
    const reg = make({ plugins: [parent, child] });
    expect(reg.get("luna")).toMatchObject({ children: ["luna/tarot"], state: "running" });
    expect(reg.get("luna/tarot")).toMatchObject({ parent: "luna", version: "1.2.0", namespace: "luna", state: "running" });
    expect(reg.entries("commands").map((c) => c.entryId)).toEqual(["luna.draw"]);
    await reg.setEnabled("luna", false);
    expect(reg.get("luna/tarot")).toMatchObject({ state: "off", reason: "its parent is off", enabled: true });
    await reg.setEnabled("luna", true);
    await reg.setEnabled("luna/tarot", false);
    expect(reg.get("luna/tarot")?.state).toBe("off");
    expect(reg.get("luna")?.state).toBe("running");
  });

  test("one OK covers a plugin and its children, with a checkbox each", async () => {
    const reg = make({
      plugins: [
        { id: "pack", manifest: m({ name: "Pack" }), approved: false },
        { id: "pack/luna", manifest: m({ name: "Luna" }) },
        { id: "pack/sol", manifest: m({ name: "Sol" }) },
      ],
    });
    expect(reg.list().map((p) => p.state)).toEqual(["found", "found", "found"]);
    expect(await reg.approve("pack", hashOf(reg, "pack"), { "pack/sol": false })).toBe("approved");
    expect(reg.list().map((p) => [p.id, p.state])).toEqual([["pack", "running"], ["pack/luna", "running"], ["pack/sol", "off"]]);
  });

  test("the OK is bound to the tree the card showed: a changed folder refuses it (review S7)", async () => {
    const reg = make({ plugins: [{ ...webhook, approved: false }] });
    const shown = hashOf(reg, "webhook");
    reg.put({ ...webhook, approved: false, manifest: { ...webhook.manifest, capabilities: ["files"] } });
    expect(await reg.approve("webhook", shown)).toBe("changed");
    expect(reg.get("webhook")?.state).toBe("found");
    expect(await reg.approve("webhook", hashOf(reg, "webhook"))).toBe("approved");
    expect(reg.get("webhook")).toMatchObject({ state: "running", okHash: hashOf(reg, "webhook") });
  });

  test("after its OK, a change that asks again waits; a data edit applies; card styling waits alone (§5.6)", async () => {
    const reg = make({ plugins: [webhook] });
    const first = hashOf(reg, "webhook");
    reg.put({ ...webhook, manifest: { ...webhook.manifest, capabilities: ["files"] } });
    expect(reg.get("webhook")).toMatchObject({ state: "found", okHash: first });
    expect(await reg.approve("webhook", hashOf(reg, "webhook"))).toBe("approved");
    reg.put({ ...webhook, manifest: { ...webhook.manifest, description: "Edited" }, change: "applies" });
    expect(reg.get("webhook")).toMatchObject({ state: "running", okHash: hashOf(reg, "webhook") });
    const okd = hashOf(reg, "webhook");
    reg.put({ ...webhook, manifest: { ...webhook.manifest, description: "Restyled" }, change: "card-styling" });
    expect(reg.get("webhook")).toMatchObject({ state: "running", okHash: okd, cardStylingHeld: true });
    expect(await reg.approve("webhook", hashOf(reg, "webhook"))).toBe("approved");
    expect(reg.get("webhook")?.cardStylingHeld).toBeUndefined();
  });

  test("a child whose manifest says enabledByDefault: false starts off", () => {
    const reg = make({ plugins: [{ id: "suite", manifest: m() }, { id: "suite/extra", manifest: m({ enabledByDefault: false }) }] });
    expect(reg.get("suite/extra")?.state).toBe("off");
  });

  test("a plugin that may contain adult content stays off until the user confirms they are 18 or older", () => {
    const reg = make({ plugins: [{ id: "spicy", manifest: m({ adult: true }) }, { id: "spicy/part", manifest: m() }] });
    expect(reg.get("spicy")?.state).toBe("off");
    expect(reg.get("spicy/part")?.state).toBe("off");
    reg.confirmAdult();
    expect(reg.get("spicy")?.state).toBe("running");
  });
});

describe("FakePluginRegistry: points", () => {
  test("an entry for a missing point waits, and starts when a plugin declares it", () => {
    const reg = make({ plugins: [forwarder] });
    expect(reg.entries("webhook.ingress")).toMatchObject([{ state: "waiting", reason: "waiting for `webhook.ingress`" }]);
    expect(reg.get("forwarder")).toMatchObject({ state: "waiting", waitingFor: ["webhook.ingress"] });
    reg.put(webhook);
    expect(reg.entries("webhook.ingress")).toMatchObject([{ state: "active", entryId: "waifucave" }]);
    expect(reg.get("forwarder")?.state).toBe("running");
    expect(reg.points().find((p) => p.name === "webhook.ingress")).toMatchObject({ declaredBy: { pluginId: "webhook", ref: "host" }, spot: false, active: true });
  });

  test("a UI spot exists while the entry that declares it is active; the app's own spots always do", () => {
    const reg = make({ plugins: [usageTab] });
    expect(reg.entries("ui")).toMatchObject([{ state: "waiting", reason: "waiting for `island.tab`" }]);
    reg.put(island);
    expect(reg.entries("ui").map((c) => [c.pluginId, c.state])).toEqual([["usage-tab", "active"], ["island", "active"]]);
    expect(reg.points().find((p) => p.name === "island.tab")).toMatchObject({ spot: true, declaredBy: { pluginId: "island", ref: "ui/0" } });
  });

  test("dependents stop before their declarer, and start after it", async () => {
    const reg = make({ plugins: [island, usageTab] });
    const changes: RegistryChange[] = [];
    reg.watch((c) => changes.push(c));
    await reg.setEnabled("island", false);
    expect(changes).toEqual([
      { type: "entries", point: "ui" },
      { type: "plugin", id: "usage-tab", state: "waiting" },
      { type: "plugin", id: "island", state: "off" },
    ]);
    changes.length = 0;
    await reg.setEnabled("island", true);
    expect(changes[0]).toMatchObject({ type: "plugin", id: "island" });
    expect(changes.at(-1)).toEqual({ type: "entries", point: "ui" });
  });

  test("a well-known name is recorded with the catalog's declaration, whatever its declarer wrote (review S2)", () => {
    const view: FakePluginInput = {
      id: "conversation-view",
      manifest: m({ client: { entry: "c.tsx" }, contributes: { ui: [{ spot: "bot.tab", id: "tab", component: "Tab", declares: { "conversation.message": { shape: "keyed", props: {} } } }] } }),
    };
    const reg = make({ plugins: [view] });
    const point = reg.points().find((p) => p.name === "conversation.message")!;
    expect(point).toMatchObject({ spot: true, shape: "keyed", decl: { keep: ["approval"], needs: ["conversation.read"] } });
    expect(point.decl?.props).toMatchObject({ type: "object" });
  });

  test("a private point takes entries only from its declarer's own tree", () => {
    const luna: FakePluginInput = {
      id: "luna",
      manifest: m({ client: { entry: "c.tsx" }, contributes: { ui: [{ spot: "bot.tab", id: "tab", component: "Tab", declares: { "luna.deck": { shape: "list", props: {}, private: true } } }] } }),
    };
    const own: FakePluginInput = { id: "luna/cards", manifest: m({ client: { entry: "c.tsx" }, contributes: { ui: [{ spot: "luna.deck", id: "c", component: "C" }] } }) };
    const stranger: FakePluginInput = { id: "sol", manifest: m({ client: { entry: "c.tsx" }, contributes: { ui: [{ spot: "luna.deck", id: "s", component: "S" }] } }) };
    const reg = make({ plugins: [luna, own, stranger] });
    expect(reg.entries("ui").filter((c) => c.value && (c.value as { spot: string }).spot === "luna.deck").map((c) => [c.pluginId, c.state, c.reason])).toEqual([
      ["luna/cards", "active", undefined],
      ["sol", "refused", "`luna.deck` is private to `luna`"],
    ]);
  });

  test("a second declarer of a point that isn't a spot waits until the user picks", () => {
    const other: FakePluginInput = { ...webhook, id: "webhook2" };
    const reg = make({ plugins: [webhook, other] });
    const decls = reg.points().filter((p) => p.name === "webhook.ingress");
    expect(decls.map((d) => [typeof d.declaredBy === "object" ? d.declaredBy.pluginId : d.declaredBy, d.active])).toEqual([["webhook", true], ["webhook2", false]]);
  });
});

describe("FakePluginRegistry: entry ids", () => {
  const fish = (id: string): FakePluginInput => ({
    id,
    manifest: m({ host: { entry: "host/index.ts" }, contributes: { voices: [{ id: "fish", name: "Fish", handler: "speak" }] } }),
  });

  test("the plugin enabled first keeps an id; only the clashing entry is refused, and gets it once the first is off", async () => {
    const reg = make({ plugins: [fish("fish-audio"), fish("fish-copy")] });
    expect(reg.entries("voices").map((c) => [c.pluginId, c.state, c.reason])).toEqual([
      ["fish-audio", "active", undefined],
      ["fish-copy", "refused", "`fish` is taken by `fish-audio`"],
    ]);
    expect(reg.get("fish-copy")?.state).toBe("running");
    await reg.setEnabled("fish-audio", false);
    expect(reg.entries("voices").map((c) => [c.pluginId, c.state])).toEqual([["fish-copy", "active"]]);
  });

  test("commands are unique within a namespace, not across them", () => {
    const cmd = (id: string, namespace?: string): FakePluginInput => ({
      id, manifest: m({ ...(namespace ? { namespace } : {}), host: { entry: "h.ts" }, contributes: { commands: [{ name: "go", description: "Go", handler: "go" }] } }),
    });
    const reg = make({ plugins: [cmd("aa"), cmd("bb"), cmd("cc", "bb")] });
    expect(reg.entries("commands").map((c) => [c.entryId, c.state])).toEqual([["aa.go", "active"], ["bb.go", "active"]]);
    // One enabled plugin per namespace (§6.7): the later one stays off and says whose it is.
    expect(reg.get("cc")).toMatchObject({ state: "off", reason: "the namespace `bb` is `bb`'s" });
  });

  test("a namespace frees up when the plugin using it goes off", async () => {
    const reg = make({ plugins: [{ id: "aa", manifest: m() }, { id: "cc", manifest: m({ namespace: "aa" }) }] });
    expect(reg.get("cc")?.state).toBe("off");
    await reg.setEnabled("aa", false);
    expect(reg.get("cc")?.state).toBe("running");
  });

  test("the unique fields agree with the plugin SDK's catalog", () => {
    const fromCatalog = Object.fromEntries(CORE_POINTS.filter((p) => p.uniqueBy && p.name !== "commands").map((p) => [p.name, p.uniqueBy]));
    expect(UNIQUE_ENTRY_FIELD).toEqual(fromCatalog);
  });

  test("entries carry their manifest place, key and value", () => {
    const reg = make({ plugins: [{ id: "blender", manifest: m({ contributes: { mcpServers: { blender: { type: "stdio", command: "uvx", args: ["blender-mcp"] } } } }) }] });
    expect(reg.entries("mcpServers")).toEqual([{ point: "mcpServers", pluginId: "blender", ref: "mcpServers/blender", entryId: "blender", value: { type: "stdio", command: "uvx", args: ["blender-mcp"], name: "blender" }, state: "active" }]);
  });
});
