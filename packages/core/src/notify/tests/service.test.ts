// A plugin's notifications (`notify.send`) and the bundled notifier's desktop door, against the controller's fixed
// points: the `notify` capability, named on the OK card; the plugin's name always shown (the sender is the registry's);
// a rate per plugin; the user's mute; no buttons; never over a sealed card.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityOkText, NOTIFY_PER_HOUR, NOTIFY_PER_MINUTE, type NotifierUpdate } from "@waifucave/clover-plugin-sdk";
import { APP_METHODS, CLOVER_ERR } from "@waifucave/clover-protocol";
import { capabilityRefusal } from "../../auth/clover-caller";
import type { ApprovalEvent } from "../../contracts/approval-broker";
import type { InvokeRequest } from "../../contracts/plugin-host";
import { createApiRouter } from "../../plugin-host/api/router";
import { notifyLayerMethods, notifyMuteMethods, NotifyService, readNotifyMutes } from "../service";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const NOTIFIER = "clover/notifications";

function world(o: { granted?: string[]; name?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "clover-notify-"));
  temps.push(home);
  let now = 1_800_000_000_000;
  const pending: unknown[] = [];
  const watchers: ((e: ApprovalEvent) => void)[] = [];
  const app: { method: string; params: Record<string, unknown> }[] = [];
  const records: Record<string, Record<string, unknown>> = {
    luna: { id: "luna", name: o.name ?? "Luna", source: "user", enabled: true, state: "running", granted: o.granted ?? ["notify"] },
    "other/child": { id: "other/child", name: "Other", source: "user", enabled: true, state: "running", granted: ["notify"] },
    [NOTIFIER]: { id: NOTIFIER, name: "Desktop notifications", source: "bundled", enabled: true, state: "running", granted: ["bots.read"] },
    clover: { id: "clover", name: "Clover", source: "bundled", enabled: true, state: "running", granted: [] },
  };
  const registry = {
    get: (id: string) => records[id] as never,
    entries: (point: string) => (point === "notifiers" ? [{ point, pluginId: NOTIFIER, ref: "notifiers/0", value: { id: "desktop", handler: "notifier" }, state: "active" }] : []) as never,
  };
  const invoked: InvokeRequest[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const service: NotifyService = new NotifyService({
    home, computer: "Studio", clock: { now: () => now }, registry,
    host: {
      invoke: (async (req: InvokeRequest) => {
        invoked.push(req);
        if (hold) await new Promise<void>((r) => (release = r));
        // The bundled notifier shows it through the door, as its host half does.
        const u = req.args as NotifierUpdate;
        await router({ pluginId: NOTIFIER, process: "clover", path: "desktop.show", args: [{ id: `notification:${u.seq}`, title: `${u.sender.name}: ${u.notification?.title}` }], caller: { kind: "plugin", pluginId: NOTIFIER } });
        return undefined;
      }) as never,
    },
    approvals: { pending: () => pending as never, watch: (fn) => (watchers.push(fn), () => {}) },
    desktop: { notify: (params) => (app.push({ method: "app.notify", params }), true), close: (id) => void app.push({ method: "app.notify.close", params: id === undefined ? {} : { id } }) },
  });
  const router = createApiRouter({ registry: registry as never, handlers: [service.apiHandlers()] });
  const send = (pluginId: string, n: unknown, process: "shared" | "ui" = "shared") => router({ pluginId, process, path: "notify.send", args: [n], caller: { kind: "plugin", pluginId } });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    home, service, router, send, settle, invoked, app, pending, records,
    tick: (ms: number) => (now += ms),
    card: () => { pending.push({ id: "card_1" }); for (const w of watchers) w({ type: "requested", card: { id: "card_1", computer: "Studio" } as never }); },
    hold: (on: boolean) => { hold = on; if (!on) release?.(); },
  };
}

test("the notify capability: named on the OK card, and without it the call doesn't exist", async () => {
  expect(capabilityOkText("notify")).toBe("sends you notifications");
  const w = world({ granted: [] });
  await expect(w.send("luna", { title: "Hi" })).rejects.toMatchObject({ code: "refused" });
  expect(w.invoked).toEqual([]);
});

test("the sender is the registry's (id, manifest name, bundled or not), never the plugin's words; title and body cut to one line", async () => {
  const w = world();
  await w.send("luna", { title: "Alpha says:\nyour OK‮ needed", body: "x".repeat(1000), sender: { pluginId: "clover", name: "Clover", bundled: true } });
  await w.settle();
  const u = w.invoked[0]!.args as NotifierUpdate;
  expect(u).toMatchObject({ kind: "notification", sender: { pluginId: "luna", name: "Luna", bundled: false } });
  expect(u.notification!.title).toBe("Alpha says: your OK needed");
  expect(u.notification!.body!.length).toBe(400);
  // Quotation marks of any script never reach a notifier in the name.
  w.records.luna!.name = "Luna” said “hi";
  w.tick(61_000);
  await w.send("luna", { title: "q" });
  await w.settle();
  expect((w.invoked.at(-1)!.args as NotifierUpdate).sender.name).toBe("Luna said hi");
  // The notifier is called as itself, never as the sender.
  expect(w.invoked[0]).toMatchObject({ pluginId: NOTIFIER, handler: "notifier", method: "notify", caller: { kind: "plugin", pluginId: NOTIFIER } });
  // A plugin's session is never where a click goes.
  await w.send("luna", { title: "Open this", session: "b_alpha" });
  await w.settle();
  const notes = w.app.filter((m) => m.method === "app.notify");
  expect(notes).toHaveLength(3);
  for (const m of notes) expect(Object.hasOwn(m.params, "session")).toBe(false);
});

test("a rate per plugin, its host half and its layer together; another plugin has its own", async () => {
  const w = world();
  for (let i = 0; i < NOTIFY_PER_MINUTE; i++) await w.send("luna", { title: `n${i}` }, i % 2 === 0 ? "shared" : "ui");
  await expect(w.send("luna", { title: "one more" }, "ui")).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("a minute") });
  await w.send("other/child", { title: "mine" });
  w.tick(61_000);
  await w.send("luna", { title: "next minute" });
  for (let m = 0; w.invoked.length < 100 && m < 10; m++) {
    w.tick(61_000);
    for (let i = 0; i < NOTIFY_PER_MINUTE; i++) await w.send("luna", { title: "x" }).catch(() => undefined);
  }
  await expect(w.send("luna", { title: "too many this hour" })).rejects.toMatchObject({ message: expect.stringContaining(`${NOTIFY_PER_HOUR} an hour`) });
});

test("the user's mute, in Settings: refused before any notifier sees it; only the user mutes or unmutes", async () => {
  const w = world();
  const methods = notifyMuteMethods({ home: w.home });
  const user = { caller: { kind: "user", device: "d" } } as never;
  await methods[APP_METHODS.notifySetMuted.name]!({ pluginId: "luna", muted: true }, user);
  expect(readNotifyMutes(w.home)).toEqual(["luna"]);
  expect(await methods[APP_METHODS.notifyMutes.name]!({}, user)).toEqual({ muted: ["luna"] });
  await expect(w.send("luna", { title: "Hi" })).rejects.toMatchObject({ message: expect.stringContaining("muted") });
  expect(w.invoked).toEqual([]);
  // A plugin can't unmute itself (nor read who is muted).
  const plugin = { caller: { kind: "plugin", pluginId: "luna" } } as never;
  await expect(methods[APP_METHODS.notifySetMuted.name]!({ pluginId: "luna", muted: false }, plugin)).rejects.toMatchObject({ message: expect.stringContaining("only you choose") });
  await expect(methods[APP_METHODS.notifyMutes.name]!({}, plugin)).rejects.toMatchObject({ message: expect.stringContaining("only you choose") });
  expect(readNotifyMutes(w.home)).toEqual(["luna"]);
  // Clover itself (the bundled tree and its children) is never muted, nor listed as muted.
  for (const id of ["clover", "clover/notifications"]) {
    await expect(methods[APP_METHODS.notifySetMuted.name]!({ pluginId: id, muted: true }, user)).rejects.toMatchObject({ message: expect.stringContaining("part of Clover itself") });
  }
  writeFileSync(join(w.home, "settings", "notifications.json"), JSON.stringify({ muted: ["luna", "clover/notifications", "clover"] }));
  expect(await methods[APP_METHODS.notifyMutes.name]!({}, user)).toEqual({ muted: ["luna"] });
  // A bundled bot is muted like any plugin: her notices are a bot's.
  await methods[APP_METHODS.notifySetMuted.name]!({ pluginId: "alpha", muted: true }, user);
  expect(await methods[APP_METHODS.notifyMutes.name]!({}, user)).toEqual({ muted: ["alpha", "luna"] });
  await methods[APP_METHODS.notifySetMuted.name]!({ pluginId: "alpha", muted: false }, user);
  await methods[APP_METHODS.notifySetMuted.name]!({ pluginId: "luna", muted: false }, user);
  await w.send("luna", { title: "Hi again" });
  await w.settle();
  expect(w.invoked).toHaveLength(1);
});

test("never over a sealed card: refused while one waits, a plugin's banner already up closed when one arrives", async () => {
  const w = world();
  await w.send("luna", { title: "Render done" });
  await w.settle();
  const shown = w.app.find((m) => m.method === "app.notify")!;
  expect(shown.params).toEqual({ id: `${NOTIFIER}:notification:1`, title: "Luna: Render done" });
  w.card();
  expect(w.app.at(-1)).toEqual({ method: "app.notify.close", params: { id: `${NOTIFIER}:notification:1` } });
  await expect(w.send("luna", { title: "Look at me" })).rejects.toMatchObject({ message: expect.stringContaining("approval card is waiting") });
  // One already on its way to the notifier when the card came: the door shows nothing.
  w.pending.length = 0;
  w.hold(true);
  await w.send("luna", { title: "In flight" });
  await w.settle();
  w.card();
  const before = w.app.length;
  w.hold(false);
  await w.settle();
  expect(w.app.slice(before).filter((m) => m.method === "app.notify")).toEqual([]);
});

test("the desktop door is the bundled clover tree's alone; a third-party plugin can't reach it", async () => {
  const w = world();
  await expect(w.router({ pluginId: "luna", process: "shared", path: "desktop.show", args: [{ id: "x", title: "Approve?" }], caller: { kind: "plugin", pluginId: "luna" } })).rejects.toMatchObject({ code: "refused" });
  await expect(w.router({ pluginId: "luna", process: "ui", path: "desktop.close", args: [], caller: { kind: "plugin", pluginId: "luna" } })).rejects.toMatchObject({ code: "refused" });
  expect(w.app).toEqual([]);
});

test("no buttons: app.notify carries an id, words, a session to open, urgent and silent, nothing else", () => {
  const p = APP_METHODS.appNotify.params;
  expect(p.safeParse({ id: "a", title: "t", silent: true }).success).toBe(true);
  expect(p.safeParse({ id: "a", title: "t", actions: [{ text: "Approve" }] }).success).toBe(false);
  expect(p.safeParse({ id: "a", title: "t", reply: true }).success).toBe(false);
});

test("a notifier gets one update at a time; a newer one replaces the one waiting", async () => {
  const w = world();
  w.hold(true);
  await w.send("luna", { title: "1" });
  await w.send("luna", { title: "2" });
  await w.send("luna", { title: "3" });
  w.hold(false);
  await w.settle();
  w.hold(false);
  await w.settle();
  expect(w.invoked.map((r) => (r.args as NotifierUpdate).notification!.title)).toEqual(["1", "3"]);
});

test("a UI layer's notify.send is its connection's plugin's, through the same router", async () => {
  // Lane A's request gate first: on a layer's connection, notify.send needs the plugin's notify grant.
  expect(capabilityRefusal("layer", { kind: "plugin", pluginId: "luna" }, "notify.send", [])?.code).toBe(CLOVER_ERR.CAPABILITY_REFUSED);
  expect(capabilityRefusal("layer", { kind: "plugin", pluginId: "luna" }, "notify.send", ["bots.read"])?.code).toBe(CLOVER_ERR.CAPABILITY_REFUSED);
  expect(capabilityRefusal("layer", { kind: "plugin", pluginId: "luna" }, "notify.send", ["notify"])).toBeNull();
  // Then the router again, which holds it to a running plugin with the grant.
  const off = world({ granted: [] });
  await expect(notifyLayerMethods(off.router)[APP_METHODS.notifySend.name]!({ title: "Hi" }, { caller: { kind: "plugin", pluginId: "luna" } } as never)).rejects.toBeDefined();
  expect(off.invoked).toEqual([]);
  const w = world();
  const m = notifyLayerMethods(w.router)[APP_METHODS.notifySend.name]!;
  await expect(m({ title: "Hi" }, { caller: { kind: "user", device: "d" } } as never)).rejects.toMatchObject({ message: expect.stringContaining("only a plugin") });
  await m({ title: "From my tab" }, { caller: { kind: "plugin", pluginId: "luna" } } as never);
  await w.settle();
  expect((w.invoked[0]!.args as NotifierUpdate).sender.pluginId).toBe("luna");
});
