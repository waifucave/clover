// One at a time (spec §5.4 "One at a time", the owner's general capability P4): a point that says `oneAtATime` has one
// active entry: the user's choice while it runs, else the first bundled filler, else the first installed. The choice is
// kept with the registry's records (a restart keeps it), outlives its plugin being off, and goes with its plugin's
// removal; when the active one stops, the next takes over and the user is told once. Plugins read it (the declarer's
// tree and the fillers, never another), and only the user's own door changes it.
import { describe, expect, test } from "bun:test";
import { CORE_POINTS, catalogPointDecl, validateManifest } from "@waifucave/moss-plugin-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { commandListMethods } from "../../commands/views";
import { ContractError } from "../../contracts/common";
import type { Manifest } from "../../contracts/sdk-types";
import { pointsApi } from "../../plugin-host/api/points";
import { ActiveNotices, activeOne, mayReadActive, oneAtATimePoints, refOf } from "../active-one";
import { RegistryCore, type RegistryInput } from "../core";
import { memoryRegistryStore } from "../state";

const m = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over });
const DECK: RegistryInput = {
  id: "deck", approved: true, treeHash: "sha256:d",
  manifest: m({ name: "Deck", host: { entry: "host/index.js", declares: { "deck.mode": { shape: "list", oneAtATime: true, title: "Deck mode", fields: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } } }),
};
const filler = (id: string, name: string, source?: "bundled"): RegistryInput => ({
  id, approved: true, treeHash: `sha256:${id}`, ...(source ? { source } : {}),
  manifest: m({ name: `${name} plugin`, contributes: { "deck.mode": [{ id, name }] } as Manifest["contributes"] }),
});
const OTHER: RegistryInput = { id: "other", approved: true, treeHash: "sha256:o", manifest: m({ name: "Other" }) };
const ref = (r: { pluginId: string; entryId: string } | undefined) => (r === undefined ? undefined : `${r.pluginId}/${r.entryId}`);
const activeRef = (reg: RegistryCore) => ref(activeOne(reg, "deck.mode")?.active && refOf(activeOne(reg, "deck.mode")!.active!));

describe("the active one", () => {
  test("the manifest: oneAtATime needs a title and a list or keyed point", () => {
    const codes = (decl: Record<string, unknown>) => validateManifest({ manifest: 1, id: "deck", name: "Deck", engines: { moss: "^1.0.0" }, host: { entry: "host/index.ts", declares: { "deck.mode": { shape: "list", fields: { type: "object", properties: { id: { type: "string" } } }, ...decl } } } }, { folderName: "deck" }).issues.filter((i) => i.severity === "error").map((i) => i.code);
    expect(codes({ oneAtATime: true, title: "Deck mode" })).toEqual([]);
    expect(codes({ oneAtATime: true })).toEqual(["point_one_title"]);
    expect(codes({ oneAtATime: true, title: "Deck mode", shape: "single" })).toEqual(["point_one_single"]);
  });

  test("a core point the catalog marks one at a time is one, with no plugin declaring it; its fillers read it", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const mode = (id: string, source?: "bundled"): RegistryInput => ({ id, approved: true, treeHash: `sha256:${id}`, ...(source ? { source } : {}), manifest: m({ name: id, contributes: { computerProviders: [{ id, name: id, auth: [], handler: "provide" }] } as Manifest["contributes"] }) });
    reg.putAll([mode("theirs"), mode("ours", "bundled"), OTHER]);
    const catalog = [...CORE_POINTS.filter((p) => p.name !== "computerProviders"), { ...CORE_POINTS.find((p) => p.name === "computerProviders")!, oneAtATime: true, title: "Cloud computers" }];
    const one = activeOne(reg, "computerProviders", catalog);
    expect([one?.point.declaredBy, one?.title, ref(one?.active && refOf(one.active))]).toEqual(["core", "Cloud computers", "ours/ours"]);
    expect(oneAtATimePoints(reg, catalog).map((o) => o.point.name)).toEqual(["computerProviders"]);
    expect(mayReadActive(reg, "computerProviders", "theirs", catalog).name).toBe("computerProviders");
    expect(() => mayReadActive(reg, "computerProviders", "other", catalog)).toThrow(/only the plugin that declares/);
    // As shipped, no core point is one at a time: the one-at-a-time points are plugins' own (MOSS Voice's voices).
    expect(oneAtATimePoints(reg).map((o) => o.point.name)).toEqual([]);
  });

  test("a declarer that fills its own point is one of its fillers, and the default when it is bundled (MOSS Voice's way)", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const self: RegistryInput = { ...DECK, source: "bundled", manifest: m({ ...DECK.manifest, contributes: { "deck.mode": [{ id: "own", name: "Its own" }] } as Manifest["contributes"] }) };
    reg.putAll([filler("one", "First"), self, filler("two", "Second")]);
    const one = activeOne(reg, "deck.mode");
    expect(one?.fillers.map((f) => f.pluginId)).toContain("deck");
    expect(activeRef(reg)).toBe("deck/own");
  });

  test("the default is the first bundled filler, else the first installed; a point that isn't one-at-a-time has none", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([DECK, filler("one", "First"), filler("two", "Second")]);
    expect(activeRef(reg)).toBe("one/one");
    expect(activeOne(reg, "deck.mode")?.title).toBe("Deck mode");
    reg.putAll([DECK, filler("one", "First"), filler("two", "Second"), filler("shipped", "Shipped", "bundled")]);
    expect(activeRef(reg)).toBe("shipped/shipped");
    expect(activeOne(reg, "models")).toBeUndefined();
    expect(activeOne(reg, "deck.nothing")).toBeUndefined();
  });

  test("the user's choice: active while it runs, kept through off and a restart, forgotten when its plugin goes", async () => {
    const store = memoryRegistryStore();
    const reg = new RegistryCore({ catalog: catalogPointDecl, store });
    reg.putAll([DECK, filler("one", "First"), filler("two", "Second")]);
    const changes: string[] = [];
    reg.watch((c) => { if (c.type === "entries") changes.push(c.point); });
    reg.choose("deck.mode", { pluginId: "two", entryId: "two" });
    expect(activeRef(reg)).toBe("two/two");
    expect(changes).toContain("deck.mode");
    expect(store.state.active).toEqual({ "deck.mode": { pluginId: "two", entryId: "two" } });
    // A restart reads it back.
    const again = new RegistryCore({ catalog: catalogPointDecl, store });
    again.putAll([DECK, filler("one", "First"), filler("two", "Second")]);
    expect(activeRef(again)).toBe("two/two");
    // Turned off: the default stands in; the choice is kept and comes back with it.
    await again.setEnabled("two", false);
    expect([activeRef(again), ref(again.chosen("deck.mode"))]).toEqual(["one/one", "two/two"]);
    await again.setEnabled("two", true);
    expect(activeRef(again)).toBe("two/two");
    // Removed: the choice goes with it.
    again.remove("two");
    expect([activeRef(again), again.chosen("deck.mode"), store.state.active]).toEqual(["one/one", undefined, undefined]);
  });

  test("the user is told once when the active one stops and another takes over; never for their own pick", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([DECK, filler("one", "First"), filler("two", "Second")]);
    const told: string[] = [];
    const notices = new ActiveNotices({ registry: reg, tell: (p, title, text) => told.push(`${p.name}|${title}|${text}`) });
    reg.choose("deck.mode", { pluginId: "two", entryId: "two" });
    expect(told).toEqual([]);
    await reg.setEnabled("two", false);
    expect(told).toEqual(["deck.mode|Deck mode|Second isn't running, so First takes its place for now."]);
    await reg.setEnabled("two", true);
    await reg.setEnabled("one", false);
    expect(told).toHaveLength(1);
    await reg.setEnabled("two", false);
    expect(told[1]).toBe("deck.mode|Deck mode|Second isn't running, and nothing else fills Deck mode for now.");
    notices.close();
  });

  test("who reads it: the declarer's tree and the fillers; another plugin is refused, and a point that isn't one-at-a-time too", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([DECK, filler("one", "First"), OTHER]);
    for (const id of ["deck", "one"]) expect(mayReadActive(reg, "deck.mode", id).name).toBe("deck.mode");
    const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return (e as ContractError).code; } };
    expect(code(() => mayReadActive(reg, "deck.mode", "other"))).toBe("refused");
    expect(code(() => mayReadActive(reg, "deck.nothing", "deck"))).toBe("not_found");
  });

  test("points.active and points.onActive answer the reader; points.onActive hears the user's pick", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([DECK, filler("one", "First"), filler("two", "Second"), OTHER]);
    const api = pointsApi({ registry: reg, host: { invoke: async () => undefined } as never, assetUrl: (id, p) => `asset://${id}/${p}` });
    const ctx = (pluginId: string) => ({ pluginId, caller: { kind: "plugin", pluginId } as Caller, record: reg.get(pluginId) }) as never;
    const call = (name: string, pluginId: string, args: unknown[]) => ((api as Record<string, unknown>)[name] as (c: unknown, a: unknown[]) => unknown)(ctx(pluginId), args);
    expect(await call("points.active", "deck", ["deck.mode"])).toEqual({ pluginId: "one", entryId: "one" });
    expect(await call("points.active", "two", ["deck.mode"])).toEqual({ pluginId: "one", entryId: "one" });
    expect(() => call("points.active", "other", ["deck.mode"])).toThrow(/only the plugin that declares deck.mode/);
    const heard: unknown[] = [];
    const off = call("points.onActive", "two", ["deck.mode", (a: unknown) => heard.push(a)]) as () => void;
    reg.choose("deck.mode", { pluginId: "two", entryId: "two" });
    reg.choose("deck.mode", { pluginId: "two", entryId: "two" });
    expect(heard).toEqual([{ pluginId: "two", entryId: "two" }]);
    off();
  });

  test("point.active.list and point.active.set: the user's own, a filler running now only", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([DECK, filler("one", "First"), filler("two", "Second")]);
    const methods = commandListMethods(reg);
    const user = { caller: { kind: "user", client: "app" } as Caller } as never;
    const plugin = { caller: { kind: "plugin", pluginId: "one" } as Caller } as never;
    const list = await methods["point.active.list"]!({}, user) as { points: unknown[] };
    expect(list.points).toEqual([{
      point: "deck.mode", title: "Deck mode", declaredBy: "deck",
      fillers: [{ pluginId: "one", entryId: "one", name: "First" }, { pluginId: "two", entryId: "two", name: "Second" }],
      active: { pluginId: "one", entryId: "one" },
    }]);
    const failed = async (p: unknown, ctx: never) => { try { await methods["point.active.set"]!(p, ctx); return "set"; } catch (e) { return (e as Error).message; } };
    expect(await failed({ point: "deck.mode", entry: { pluginId: "two", entryId: "two" } }, plugin)).toContain("only the user");
    expect(await failed({ point: "deck.mode", entry: { pluginId: "two", entryId: "nope" } }, user)).toContain("has no entry nope");
    expect(await failed({ point: "deck.mode", entry: { pluginId: "two", entryId: "two" } }, user)).toBe("set");
    expect(activeRef(reg)).toBe("two/two");
  });
});
