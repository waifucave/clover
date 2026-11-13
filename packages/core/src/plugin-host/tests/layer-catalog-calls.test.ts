// A component's reach of the whole plugin API (`plugin.layer.call`, `plugin.layer.api` and `plugin.layer.watch`): every
// member the SDK's catalog gives components goes into the same router as its host half's call, as the plugin from the
// `ui` side; bytes cross as `{ $bytes }` and a `net.fetch` response as `{ $response }`; what only a host half's process
// could ask stays held; a watch's values go to the one connection that opened it, and it ends (with why) when the plugin
// stops, is turned off or removed, or loses the capability, and silently when its connection closes or it is unwatched.
import { describe, expect, test } from "bun:test";
import { PLUGINS_EVENTS, PLUGINS_METHODS } from "@waifucave/clover-protocol";
import type { ApiRouter } from "../../contracts/plugin-host";
import type { PluginRecord, RegistryChange } from "../../contracts/plugin-registry";
import { LAYER_CALL_MAX_BYTES, LAYER_FETCHES_PER_PLUGIN, LAYER_WATCH_VALUE_MAX_BYTES, LAYER_WATCHES_PER_CONNECTION, pluginUi } from "../ui";

type Sent = { follows: Map<string, () => void>; event: { type: string; [k: string]: unknown } };

function world(o: { router?: ApiRouter; records?: Record<string, Partial<PluginRecord>> } = {}) {
  const records = new Map<string, PluginRecord>(Object.entries(o.records ?? { luna: {} }).map(([id, r]) => [id, { id, enabled: true, state: "running", source: "folder", granted: ["files", "logs.read", "usage.read", "network:api.example.com"], ...r } as PluginRecord]));
  const watchers = new Set<(c: RegistryChange) => void>();
  const registry = {
    list: () => [], entries: () => [], get: (id: string) => records.get(id),
    watch: (fn: (c: RegistryChange) => void) => { watchers.add(fn); return () => watchers.delete(fn); },
  } as never;
  const routed: { pluginId: string; path: string; args: unknown[]; process: string }[] = [];
  const listeners: ((v: unknown) => void)[] = [];
  const stopped: string[] = [];
  const router: ApiRouter = o.router ?? (async (call) => {
    routed.push({ pluginId: call.pluginId, path: call.path, args: call.args, process: call.process });
    if (call.path === "files.readBytes") return new Uint8Array([1, 2, 3]);
    if (call.path === "net.fetch") return new Response("hello", { status: 201, headers: { "x-a": "b" } });
    if (call.path === "files.watch" || call.path === "logs.follow" || call.path === "usage.watch") {
      const fn = call.args[call.path === "usage.watch" ? 0 : 1] as (v: unknown) => void;
      listeners.push(fn);
      return () => stopped.push(call.path);
    }
    return { ok: call.path };
  });
  const sent: Sent[] = [];
  const ui = pluginUi({ registry, router, emit: () => {}, emitTo: (follows, event) => sent.push({ follows, event }) });
  const conn = (pluginId: string) => {
    const follows = new Map<string, () => void>();
    return { follows, ctx: { caller: { kind: "plugin", pluginId }, stream: { send: () => {}, follows } } as never };
  };
  const change = (c: RegistryChange) => { for (const w of watchers) w(c); };
  return { ui, routed, listeners, stopped, sent, conn, records, change };
}

const M = PLUGINS_METHODS;

describe("a component's calls of the catalog", () => {
  test("any member the catalog gives components goes to the router as the plugin, from the ui side; bytes and responses cross as the wire carries them", async () => {
    const w = world();
    const { ctx } = w.conn("luna");
    const call = (c: string, args: unknown[]) => w.ui.methods[M.pluginLayerCall.name]!({ call: c, args }, ctx);
    expect(await call("memory.list", ["luna"])).toEqual({ result: { ok: "memory.list" } });
    expect(await call("files.readBytes", ["home/Studio/a.bin"])).toEqual({ result: { $bytes: "AQID" } });
    await call("files.write", ["home/Studio/a.bin", { $bytes: "AQID" }]);
    expect(w.routed.at(-1)!.args[1]).toEqual(new Uint8Array([1, 2, 3]));
    const fetched = (await call("net.fetch", ["https://api.example.com/x", { method: "POST", headers: [["a", "b"]], body: "q" }])) as { result: { $response: { status: number; headers: [string, string][]; body: string } } };
    expect(fetched.result.$response.status).toBe(201);
    expect(fetched.result.$response.headers).toContainEqual(["x-a", "b"]);
    expect(Buffer.from(fetched.result.$response.body, "base64").toString()).toBe("hello");
    // A `{ $response }` a page hands over is data, never turned into a Response.
    await call("conversation.note", ["s_1", { text: "hi", label: { $response: { status: 200, statusText: "", headers: [], body: "" } } }]);
    expect(w.routed.at(-1)!.args[1]).toEqual({ text: "hi", label: { $response: { status: 200, statusText: "", headers: [], body: "" } } });
    expect(w.routed.every((r) => r.pluginId === "luna" && r.process === "ui")).toBe(true);
    // The app's door for a component (`plugin.layer.api`) is the same.
    expect(await w.ui.methods[M.pluginLayerApi.name]!({ pluginId: "luna", call: "usage.rows", args: [{ since: 0 }] }, { caller: { kind: "user", client: "app" } } as never)).toEqual({ result: { ok: "usage.rows" } });
    w.ui.close();
  });

  test("never a host-only, own-process or clover-process member, a listener member, the account token from a third party, or args past the cap", async () => {
    const w = world({ records: { luna: {}, "clover/notifier": { source: "bundled" } } });
    const refused = async (pluginId: string, c: string, args: unknown[]) => ((await w.ui.methods[M.pluginLayerCall.name]!({ call: c, args }, w.conn(pluginId).ctx).catch((e: unknown) => e)) as Error).message;
    for (const c of ["secrets.get", "keys.open", "desktop.show", "ui.send", "storage.synced.set", "routines.fire", "computers.takeHold", "files.path"]) expect(await refused("luna", c, [])).toContain("exists only in a plugin's host code");
    expect(await refused("luna", "files.watch", ["home/Studio/x", null])).toContain("plugin.layer.watch");
    expect(await refused("luna", "nope", [])).toContain("isn't a call of the plugin API");
    expect(await refused("luna", "net.fetch", ["https://api.example.com/x", {}, { auth: "waifucave" }])).toContain("only from the bundled clover tree");
    // The bundled tree's own component may ask for it (the core places the account token; the page never sees it).
    expect((await w.ui.methods[M.pluginLayerCall.name]!({ call: "net.fetch", args: ["https://api.example.com/x", {}, { auth: "waifucave" }] }, w.conn("clover/notifier").ctx) as { result: unknown }).result).toHaveProperty("$response");
    expect(await refused("luna", "conversation.note", ["s_1", { text: "x".repeat(LAYER_CALL_MAX_BYTES) }])).toContain(`at most ${LAYER_CALL_MAX_BYTES}`);
    // A clip may be bigger.
    await w.ui.methods[M.pluginLayerCall.name]!({ call: "audio.play", args: [{ format: "mp3", data: { $bytes: "A".repeat(LAYER_CALL_MAX_BYTES * 2) } }] }, w.conn("luna").ctx);
    expect(w.routed.filter((r) => r.path !== "net.fetch").map((r) => r.path)).toEqual(["audio.play"]);
    w.ui.close();
  });

  test("a plugin's pages hold at most LAYER_FETCHES_PER_PLUGIN fetches open; a fetch's headers are capped", async () => {
    const release: (() => void)[] = [];
    const w = world({ router: (call) => (call.path === "net.fetch" ? new Promise((r) => release.push(() => r(new Response("ok")))) : Promise.resolve(null)) });
    const fetch = (pluginId: string, init: unknown = {}) => w.ui.methods[M.pluginLayerCall.name]!({ call: "net.fetch", args: ["https://api.example.com/x", init] }, w.conn(pluginId).ctx);
    const open = Array.from({ length: LAYER_FETCHES_PER_PLUGIN }, () => fetch("luna"));
    await Bun.sleep(10);
    expect(((await fetch("luna").catch((e: unknown) => e)) as Error).message).toContain(`${LAYER_FETCHES_PER_PLUGIN} fetches open`);
    for (const r of release) r();
    await Promise.all(open);
    expect(((await fetch("luna", { headers: Array.from({ length: 257 }, (_, i) => [`h${i}`, "v"]) }).catch((e: unknown) => e)) as Error).message).toContain("at most 256 headers");
    w.ui.close();
  });
});

describe("a component's watches (plugin.layer.watch)", () => {
  test("the core's listener in the listener's place; each value to the opening connection alone; unwatch and a closed connection end it", async () => {
    const w = world();
    const a = w.conn("luna");
    const b = w.conn("luna");
    const watch = (c: { ctx: never }, call: string, args: unknown[]) => w.ui.methods[M.pluginLayerWatch.name]!({ call, args }, c.ctx) as Promise<{ watch: string }>;
    const { watch: id } = await watch(a, "files.watch", ["home/Studio/notes", null]);
    expect(typeof w.routed[0]!.args[1]).toBe("function");
    w.listeners[0]!({ type: "changed", paths: ["home/Studio/notes/a.md"] });
    w.listeners[0]!(new Uint8Array([9]));
    expect(w.sent.map((s) => [s.follows === a.follows, s.event])).toEqual([
      [true, { type: PLUGINS_EVENTS.pluginApiEvent.type, pluginId: "luna", watch: id, value: { type: "changed", paths: ["home/Studio/notes/a.md"] } }],
      [true, { type: PLUGINS_EVENTS.pluginApiEvent.type, pluginId: "luna", watch: id, value: { $bytes: "CQ==" } }],
    ]);
    // Another connection's unwatch of it is nothing.
    await w.ui.methods[M.pluginLayerUnwatch.name]!({ watch: id }, b.ctx);
    expect(w.stopped).toEqual([]);
    await w.ui.methods[M.pluginLayerUnwatch.name]!({ watch: id }, a.ctx);
    expect(w.stopped).toEqual(["files.watch"]);
    w.listeners[0]!({ late: true });
    expect(w.sent.length).toBe(2);
    // The connection's close (its follows stopped by the server) ends its watches, with nothing sent.
    await watch(a, "logs.follow", [{ plugin: "luna" }, null]);
    for (const stop of a.follows.values()) stop();
    expect(w.stopped).toEqual(["files.watch", "logs.follow"]);
    expect(w.ui.watchCount()).toBe(0);
    expect(w.sent.length).toBe(2);
    // A value too large for the page is a marker in its place.
    await watch(a, "usage.watch", [null]);
    w.listeners[2]!("x".repeat(LAYER_WATCH_VALUE_MAX_BYTES + 1));
    expect(w.sent.at(-1)!.event.value).toEqual({ $tooLarge: LAYER_WATCH_VALUE_MAX_BYTES + 3 });
    w.ui.close();
  });

  test("ended, with why, when the plugin is turned off, stops, is removed or loses the capability; refused where a call would be; capped per connection", async () => {
    const w = world();
    const a = w.conn("luna");
    const watch = (call: string, args: unknown[], c = a) => w.ui.methods[M.pluginLayerWatch.name]!({ call, args }, c.ctx) as Promise<{ watch: string }>;
    const ended = () => w.sent.filter((s) => s.event.ended !== undefined).map((s) => (s.event.ended as { reason: string }).reason);
    await watch("files.watch", ["home/Studio/notes", null]);
    w.records.set("luna", { ...w.records.get("luna")!, granted: ["logs.read"] });
    w.change({ type: "plugin", id: "luna" } as RegistryChange);
    expect(ended()).toEqual(["luna's OK no longer lists what files.watch needs"]);
    await watch("logs.follow", [{ plugin: "luna" }, null]);
    w.records.set("luna", { ...w.records.get("luna")!, state: "stopped" } as PluginRecord);
    w.change({ type: "plugin", id: "luna" } as RegistryChange);
    w.records.set("luna", { ...w.records.get("luna")!, state: "running", enabled: false } as PluginRecord);
    await watch("logs.follow", [{ plugin: "luna" }, null]);
    w.change({ type: "plugin", id: "luna" } as RegistryChange);
    w.records.set("luna", { ...w.records.get("luna")!, enabled: true } as PluginRecord);
    await watch("logs.follow", [{ plugin: "luna" }, null]);
    w.records.delete("luna");
    w.change({ type: "removed", id: "luna" } as RegistryChange);
    expect(ended()).toEqual(["luna's OK no longer lists what files.watch needs", "luna is stopped", "luna was turned off", "luna was removed"]);
    expect(w.ui.watchCount()).toBe(0);
    const refusal = async (call: string, args: unknown[]) => ((await watch(call, args).catch((e: unknown) => e)) as Error).message;
    expect(await refusal("files.stat", ["x"])).toContain("takes no listener");
    expect(await refusal("browser.onCdpEvent", ["t", null])).toContain("isn't available yet");
    expect(await refusal("storage.synced.watch", [null])).toContain("host code");
    w.ui.close();

    const v = world();
    const c = v.conn("luna");
    for (let i = 0; i < LAYER_WATCHES_PER_CONNECTION; i++) {
      await v.ui.methods[M.pluginLayerWatch.name]!({ call: "usage.watch", args: [null] }, c.ctx);
      if (i % 15 === 14) await Bun.sleep(1_050); // under the calls-per-second cap
    }
    await Bun.sleep(1_050);
    expect(((await v.ui.methods[M.pluginLayerWatch.name]!({ call: "usage.watch", args: [null] }, c.ctx).catch((e: unknown) => e)) as Error).message).toContain(`${LAYER_WATCHES_PER_CONNECTION} watches open`);
    v.ui.close();
  });

  test("a source that fails to open leaves nothing held", async () => {
    const w = world({ router: async () => { throw new Error("the ledger isn't running"); } });
    const a = w.conn("luna");
    expect(((await w.ui.methods[M.pluginLayerWatch.name]!({ call: "usage.watch", args: [null] }, a.ctx).catch((e: unknown) => e)) as Error).message).toContain("the ledger isn't running");
    expect(w.ui.watchCount()).toBe(0);
    expect(a.follows.size).toBe(0);
    w.ui.close();
  });
});
