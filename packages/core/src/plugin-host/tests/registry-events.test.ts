// The registry's transitions as the protocol's plugin events, in order, one per transition; who receives them over the
// real routing (`sendCoreEvent` with grants the registry computes from the real manifest); and the gate's audit: the
// events-only capability `plugins.watch` opens nothing callable.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CALLS, catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { CLOVER_EVENTS, CLOVER_METHODS, type Card, type Caller, type CloverRole } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { grantsInForce } from "../../contracts/plugin-registry";
import type { Manifest } from "../../contracts/sdk-types";
import type { CloverConn } from "../../ipc/clover";
import { sendCoreEvent } from "../../ipc/core-events";
import { RegistryCore } from "../../registry/core";
import { brokerOkCards } from "../../registry/ok-cards";
import { memoryRegistryStore } from "../../registry/state";
import { plainNote } from "../card-yes";
import { registryEvents } from "../registry-events";

const m = (name: string, over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name, ...over });
const flush = () => new Promise((r) => setTimeout(r, 5));

function world() {
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards: brokerOkCards(broker, (id) => ({ title: id, lines: [], source: "Found on disk" })) });
  const events: Record<string, unknown>[] = [];
  const stop = registryEvents({ registry: reg, okCards: (fn) => reg.watchOkCards(fn), trees: (fn) => reg.watchTrees(fn), emit: (e) => events.push(e) });
  const click = async (card: Card, optionId: "approve" | "deny") => broker.answer(card.id, { optionId, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: Date.now() } }, { role: "app" });
  return { broker, reg, events, stop, click };
}

describe("the registry's transitions as plugin events, one per transition, ids and states only", () => {
  test("what is there at the start is known, not announced", () => {
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards: brokerOkCards(broker, (id) => ({ title: id, lines: [], source: "" })) });
    reg.putAll([{ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t", approved: true }]);
    const events: unknown[] = [];
    registryEvents({ registry: reg, emit: (e) => events.push(e) });
    expect(events).toEqual([]);
  });

  test("found (by the watcher), then its OK card: plugin_changed found, then plugin_found with the card", async () => {
    const w = world();
    w.reg.put({ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t", approved: false, folder: "/plugins/tarot" } as never);
    expect(w.events).toEqual([{ type: "plugin_changed", id: "tarot", state: "found", enabled: true }]);
    const { card } = await w.reg.installed("tarot", "app");
    expect(w.events[1]).toEqual({ type: "plugin_found", id: "tarot", folder: "/plugins/tarot", card });
  });

  test("OK'd: found → running; off: running → off; on again: off → running; a reason alone is no transition", async () => {
    const w = world();
    w.reg.put({ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t", approved: false });
    const { card } = await w.reg.installed("tarot", "app");
    w.events.length = 0;
    expect(await w.click(w.broker.cards().find((c) => c.id === card)!, "approve")).toBe("accepted");
    await flush();
    expect(w.events).toEqual([{ type: "plugin_changed", id: "tarot", state: "running", enabled: true }]);
    await w.reg.setEnabled("tarot", false);
    await w.reg.setEnabled("tarot", true);
    expect(w.events.slice(1)).toEqual([
      { type: "plugin_changed", id: "tarot", state: "off", enabled: false },
      { type: "plugin_changed", id: "tarot", state: "running", enabled: true },
    ]);
    // Every event carries exactly these fields: never a reason, a name or manifest text.
    for (const e of w.events) expect(Object.keys(e).sort()).toEqual(e.type === "plugin_changed" ? ["enabled", "id", "state", "type"] : Object.keys(e).sort());
  });

  test("stopped by the crash rules and restarted; revoked (blocked) and its override; removed", () => {
    const w = world();
    w.reg.put({ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t", approved: true });
    w.events.length = 0;
    w.reg.setStopped("tarot", "plugin stopped: it crashed three times in two minutes");
    w.reg.setStopped("tarot", null);
    w.reg.put({ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t", blocked: { by: "Friends' plugins", reason: "it sends your conversations away" } } as never);
    w.reg.put({ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t" });
    w.reg.remove("tarot");
    expect(w.events.map((e) => [e.type, e.state])).toEqual([
      ["plugin_changed", "stopped"],
      ["plugin_changed", "running"],
      ["plugin_changed", "blocked"],
      ["plugin_changed", "running"],
      ["plugin_removed", undefined],
    ]);
    expect(w.events.at(-1)).toEqual({ type: "plugin_removed", id: "tarot" });
  });

  test("refused on its card: found → refused; a child goes with its parent", async () => {
    const w = world();
    w.reg.putAll([{ id: "pack", manifest: m("Pack"), treeHash: "sha256:p", approved: false }, { id: "pack/eyes", manifest: m("Eyes"), treeHash: "sha256:p" }]);
    const { card } = await w.reg.installed("pack", "app");
    w.events.length = 0;
    await w.click(w.broker.cards().find((c) => c.id === card)!, "deny");
    await flush();
    expect(w.events.map((e) => [e.id, e.state])).toEqual([["pack", "refused"], ["pack/eyes", "refused"]]);
    w.reg.remove("pack");
    expect(w.events.slice(2)).toEqual([{ type: "plugin_removed", id: "pack" }, { type: "plugin_removed", id: "pack/eyes" }]);
  });

  test("an update applied elsewhere that keeps it running (a new tree and version under the same id): one plugin_changed, the same payload; with a state change too, still one", async () => {
    const w = world();
    w.reg.put({ id: "tarot", manifest: m("Tarot", { version: "1.0.0" } as never), treeHash: "sha256:t1", approved: true });
    w.events.length = 0;
    w.reg.put({ id: "tarot", manifest: m("Tarot", { version: "1.1.0" } as never), treeHash: "sha256:t2", approved: true, change: "applies" } as never);
    expect(w.reg.get("tarot")?.state).toBe("running");
    expect(w.events).toEqual([{ type: "plugin_changed", id: "tarot", state: "running", enabled: true }]);
    // A changed tree that asks again: found, announced once.
    w.reg.put({ id: "tarot", manifest: m("Tarot", { version: "1.2.0" } as never), treeHash: "sha256:t3", change: "asks-again" } as never);
    await flush();
    expect(w.events.slice(1)).toEqual([{ type: "plugin_changed", id: "tarot", state: "found", enabled: true }]);
    // The same tree read again: nothing.
    w.reg.put({ id: "tarot", manifest: m("Tarot", { version: "1.2.0" } as never), treeHash: "sha256:t3" } as never);
    await flush();
    expect(w.events).toHaveLength(2);
  });

  test("an update applied elsewhere reaches the Plugins page's layer as plugin_changed (the routing below, end to end)", () => {
    const w = world();
    w.reg.put({ id: "tarot", manifest: m("Tarot", { version: "1.0.0" } as never), treeHash: "sha256:t1", approved: true });
    w.events.length = 0;
    w.reg.put({ id: "tarot", manifest: m("Tarot", { version: "1.1.0" } as never), treeHash: "sha256:t2", approved: true, change: "applies" } as never);
    const page = conn("layer", ["plugins"], { kind: "plugin", pluginId: "clover/plugin-index" });
    const grants = (id: string) => (id === "clover/plugin-index" ? ["plugins.watch"] : []);
    for (const e of w.events) sendCoreEvent({ connections: () => [page.c], pluginCapabilities: grants }, e as never);
    expect(page.got.map((e) => [e.type, e.id, e.state])).toEqual([["plugin_changed", "tarot", "running"]]);
  });

  test("stopped watching: nothing more", () => {
    const w = world();
    w.stop();
    w.reg.put({ id: "tarot", manifest: m("Tarot"), treeHash: "sha256:t", approved: true });
    expect(w.events).toEqual([]);
  });
});

let seq = 0;
function conn(role: CloverRole, areas: string[], caller: Caller = { kind: "user", client: "app" }) {
  const got: Record<string, unknown>[] = [];
  const c = {
    connId: ++seq, role, caller, features: [], clientName: role, areas: new Set(areas), follows: new Map(), send: () => "x",
    notify: (_method: string, params: unknown) => { got.push(params as Record<string, unknown>); },
  } as unknown as CloverConn;
  return { c, got };
}

describe("who hears them, over the real routing", () => {
  // The grants the registry computes from the bundled parts' real manifests (a bundled tree is OK'd as it is).
  const manifestOf = (part: string) => JSON.parse(readFileSync(join(import.meta.dir, "../../../../../plugins/clover/plugins", part, "clover.json"), "utf8")) as Manifest;
  const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
  reg.putAll([
    { id: "clover", manifest: m("Clover"), treeHash: "sha256:c", approved: true, source: "bundled" } as never,
    { id: "clover/plugin-index", manifest: manifestOf("plugin-index"), treeHash: "sha256:c", approved: true, source: "bundled" } as never,
    { id: "clover/composer", manifest: manifestOf("composer"), treeHash: "sha256:c", approved: true, source: "bundled" } as never,
    { id: "tarot", manifest: m("Tarot", { capabilities: ["approvals"] }), treeHash: "sha256:t", approved: true } as never,
    // A bot plugin with the avatar's read grant and no `plugins.watch` (the shape of Alpha's tab).
    { id: "puppet", manifest: m("Puppet", { capabilities: ["avatar.read"] }), treeHash: "sha256:p", approved: true } as never,
  ]);
  const routing = (conns: CloverConn[]) => ({ connections: () => conns, pluginCapabilities: (id: string) => grantsInForce(reg.get(id)), pluginRunning: (id: string) => { const r = reg.get(id); return r !== undefined && r.enabled && (r.state === "running" || r.state === "waiting"); } });

  test("the Plugins page's layer (clover/plugin-index holds plugins.watch) hears ids and states only; another part and a third-party layer hear nothing; the app and the terminal hear all", () => {
    expect(grantsInForce(reg.get("clover/plugin-index"))).toEqual(["plugins.watch"]);
    const page = conn("layer", ["plugins"], { kind: "plugin", pluginId: "clover/plugin-index" });
    const composer = conn("layer", ["plugins"], { kind: "plugin", pluginId: "clover/composer" });
    const tarot = conn("layer", ["plugins"], { kind: "plugin", pluginId: "tarot" });
    const app = conn("app", ["plugins"]);
    const cli = conn("cli", ["plugins"], { kind: "user", client: "cli" });
    const all = routing([page.c, composer.c, tarot.c, app.c, cli.c]);
    const changed = { type: "plugin_changed", ts: 1, id: "luna", state: "running", enabled: true, reason: "a reason that never reaches a layer" };
    const found = { type: "plugin_found", ts: 2, id: "luna", folder: "/Users/someone/.clover/plugins/luna", card: "card_0a1b2c3d" };
    const removed = { type: "plugin_removed", ts: 3, id: "luna" };
    const note = { type: "plugin_card_note", ts: 4, card: "card_0a1b2c3d", change: "plugin-remove", note: "It was already removed." };
    for (const e of [changed, found, removed, note]) expect([e.type, sendCoreEvent(all, e)]).toEqual([e.type, 3]);
    expect(page.got).toEqual([
      { type: "plugin_changed", ts: 1, id: "luna", state: "running", enabled: true },
      { type: "plugin_found", ts: 2, id: "luna", card: "card_0a1b2c3d" },
      removed, note,
    ]);
    expect(app.got).toEqual([changed, found, removed, note]);
    expect(cli.got).toEqual([changed, found, removed, note]);
    expect(composer.got).toEqual([]);
    expect(tarot.got).toEqual([]);
  });

  test("a plugin's settings change reaches only its own layer, as the key alone", () => {
    const own = conn("layer", ["plugins"], { kind: "plugin", pluginId: "tarot" });
    const page = conn("layer", ["plugins"], { kind: "plugin", pluginId: "clover/plugin-index" });
    const app = conn("app", ["plugins"]);
    const e = { type: "plugin_settings_changed", ts: 1, pluginId: "tarot", key: "TAROT_KEY", value: "never sent" };
    expect(sendCoreEvent(routing([own.c, page.c, app.c]), e)).toBe(1);
    expect(own.got).toEqual([{ type: "plugin_settings_changed", ts: 1, pluginId: "tarot", key: "TAROT_KEY" }]);
    expect(page.got).toEqual([]);
    expect(app.got).toEqual([]);
    // Turned off (or stopped): its frame's connection, still open, hears nothing of it.
    void reg.setEnabled("tarot", false);
    expect(sendCoreEvent(routing([own.c]), { ...e, ts: 2 })).toBe(0);
    void reg.setEnabled("tarot", true);
    expect(sendCoreEvent(routing([own.c]), { ...e, ts: 3 })).toBe(1);
    // No routing that says it runs: none.
    expect(sendCoreEvent({ connections: () => [own.c] }, { ...e, ts: 4 })).toBe(0);
  });

  test("a part with avatar.read and no plugins.watch hears its own avatar-changed message (`api.avatar.watch`) and a settings change (`api.settings.watch`), and never plugin_changed", () => {
    expect(grantsInForce(reg.get("puppet"))).not.toContain("plugins.watch");
    const own = conn("layer", ["plugins"], { kind: "plugin", pluginId: "puppet" });
    const other = conn("layer", ["plugins"], { kind: "plugin", pluginId: "tarot" });
    const changed = { type: "plugin_ui_message", ts: 1, pluginId: "puppet", event: "clover.avatar.changed", value: { kind: "catalogue", catalogue: { expressions: ["smile"] } } };
    expect(sendCoreEvent(routing([own.c, other.c]), changed)).toBe(1);
    expect(own.got).toEqual([changed]);
    expect(other.got).toEqual([]);
    // Its own settings key changing is heard the same way; a plugin's lifecycle (plugin_changed) is not.
    own.got.length = 0;
    expect(sendCoreEvent(routing([own.c]), { type: "plugin_settings_changed", ts: 2, pluginId: "puppet", key: "effects" })).toBe(1);
    expect(own.got.map((e) => e.type)).toEqual(["plugin_settings_changed"]);
    own.got.length = 0;
    expect(sendCoreEvent(routing([own.c]), { type: "plugin_changed", ts: 3, id: "tarot", state: "running", enabled: true })).toBe(0);
    expect(own.got).toEqual([]);
  });
});

describe("the gate: plugins.watch opens nothing callable", () => {
  test("no method, no plugin API call names it; exactly the four plugin events do", () => {
    expect([...CLOVER_METHODS.values()].filter((s) => (s as { capability?: string }).capability === "plugins.watch").map((s) => s.name)).toEqual([]);
    expect(Object.entries(API_CALLS).filter(([, c]) => (c as { capability?: string }).capability === "plugins.watch").map(([k]) => k)).toEqual([]);
    expect([...CLOVER_EVENTS.values()].filter((s) => (s as { capability?: string }).capability === "plugins.watch").map((s) => s.type).sort()).toEqual(["plugin_card_note", "plugin_changed", "plugin_found", "plugin_removed"]);
  });
});

describe("a card's note as plain text", () => {
  test("controls and line breaks become spaces; hidden and reordering characters go; cut to 500", () => {
    expect(plainNote("It wasn't updated:\n\tthe\u0000 index‮ said ​no⁦")).toBe("It wasn't updated: the index said no");
    expect(plainNote(`x${"\u{e0041}"}y`)).toBe("xy");
    const long = plainNote("é".repeat(800));
    expect([...long].length).toBe(500);
    expect(long.endsWith("…")).toBe(true);
  });
});
