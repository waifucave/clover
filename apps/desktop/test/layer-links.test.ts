// A layer's own connection to the core (roles.ts): opened with a layer token for that plugin, after the daemon's
// proof, as that plugin; only the layer role's methods pass; its events go to that plugin's documents.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AVATAR_CHANGED_EVENT as CORE_CHANGED, AVATAR_CUE_EVENT as CORE_CUE } from "../../../packages/core/src/plugin-host/api/avatar";
import { AVATAR_CHANGED_EVENT, AVATAR_CUE_EVENT, LAYER_METHODS, LayerLinks, OWN_EVENT_KEYS, OwnEventMailbox } from "../src/main/layer-links";
import { Pair } from "../src/main/pair/pair";
import { appHello, readAppToken } from "../src/main/pair/start";
import { daemonEndpoint, dial } from "../src/main/protocol/client";
import { readCalls, startFakeDaemon, type FakeDaemon } from "./fake-core/fake-daemon";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "clover-links-"));
  const fake: FakeDaemon = await startFakeDaemon({ home });
  const pair = new Pair({ endpoint: daemonEndpoint(home), hello: () => appHello(readAppToken(home, {})!, "0.0.0-test", 1), prove: { pid: process.pid } });
  await pair.start();
  const events: { pluginId: string; method: string; params: unknown }[] = [];
  const links = new LayerLinks({
    appClient: () => pair.client, dial: () => dial(daemonEndpoint(home)), appToken: () => readAppToken(home, {}), pid: process.pid, appVersion: "0.0.0-test",
    onEvent: (pluginId, method, params) => events.push({ pluginId, method, params }), log: () => {},
  });
  cleanup.push(() => links.closeAll(), () => pair.stop(), () => fake.close(), () => rmSync(home, { recursive: true, force: true }));
  // The plugins the app's last `plugin.ui` list shows.
  links.closeGone(new Set(["clover/panel-terminal", "vn"]));
  return { home, links, events };
}

describe("a layer's connection to the core", () => {
  test("opened for its plugin: a layer token, the daemon's proof, then a hello as that plugin's layer", async () => {
    const { home, links, events } = await setup();
    expect(await links.call("clover/panel-terminal", "terminal.open", { computer: "Laptop", cols: 80, rows: 24 })).toEqual({ terminalId: "term_1" });
    const calls = readCalls(home).filter((c) => c.event === "request");
    expect(calls.map((c) => c.method)).toEqual(["protocol.prove", "protocol.hello", "layer.token", "protocol.prove", "protocol.hello", "terminal.open"]);
    expect(calls[4]).toMatchObject({ role: "layer" });
    // The output it subscribed to comes back on that connection, for that plugin.
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContainEqual({ pluginId: "clover/panel-terminal", method: "core.event", params: expect.objectContaining({ type: "terminal_output", terminalId: "term_1" }) });
    // One connection per plugin: the next call reuses it.
    await links.call("clover/panel-terminal", "terminal.resize", { terminalId: "term_1", cols: 100, rows: 30 });
    expect(readCalls(home).filter((c) => c.method === "layer.token")).toHaveLength(1);
  });

  test("only the layer role's methods pass", async () => {
    const { links } = await setup();
    expect(LAYER_METHODS.has("terminal.write")).toBe(true);
    for (const m of ["layer.token", "pill.send", "app.quit", "pair.quit", "plugin.auth.signIn"]) {
      expect(LAYER_METHODS.has(m)).toBe(false);
      await expect(links.call("clover/panel-terminal", m, {})).rejects.toThrow(`a layer doesn't call ${m}`);
    }
  });

  test("terminal.write goes only from the main process's own path: the general door refuses it, the app's really own way (the key and the paste checks onward) doesn't", async () => {
    const { home, links } = await setup();
    await expect(links.call("clover/panel-terminal", "terminal.write", { terminalId: "t1", data: "whoami" })).rejects.toThrow("terminal.write goes only from the main process");
    // The main process's own door: `terminalInput`'s own bytes.
    await links.hand("clover/panel-terminal", "terminal.write", { terminalId: "t1", data: "no" });
    expect(readCalls(home).some((c) => c.method === "terminal.write")).toBe(true);
  });

  test("a connection opened again says its plugin's subscriptions again", async () => {
    const { home, links } = await setup();
    await links.call("vn", "events.subscribe", { areas: ["plugins"] });
    links.closeAll();
    await links.call("vn", "bot.list", {}).catch(() => undefined);
    const after = readCalls(home).filter((c) => c.event === "request");
    const lastHello = after.map((c) => c.method).lastIndexOf("protocol.hello");
    expect(after.slice(lastHello + 1).find((c) => c.method === "events.subscribe")).toMatchObject({ params: { areas: ["plugins"] } });
  });
});

describe("a plugin that no longer shows UI", () => {
  test("its connection closes, and only its; its next call, once it's back, opens a fresh one", async () => {
    const { home, links } = await setup();
    await links.call("vn", "bot.list", {}).catch(() => undefined);
    await links.call("clover/panel-terminal", "terminal.open", { computer: "Laptop", cols: 80, rows: 24 });
    const tokens = () => readCalls(home).filter((c) => c.method === "layer.token").length;
    expect(tokens()).toBe(2);
    // vn is off: its connection closes; the terminal panel, still shown, keeps its own.
    expect(links.closeGone(new Set(["clover/panel-terminal"]))).toEqual(["vn"]);
    await links.call("clover/panel-terminal", "terminal.resize", { terminalId: "term_1", cols: 100, rows: 30 });
    expect(tokens()).toBe(2);
    expect(links.closeGone(new Set(["clover/panel-terminal"]))).toEqual([]);
    // Still off (not in the list): it can't open its connection again; no layer token asked.
    await expect(links.call("vn", "bot.list", {})).rejects.toThrow("vn shows no UI now");
    expect(tokens()).toBe(2);
    // Back on, in the next list: a fresh connection.
    links.closeGone(new Set(["clover/panel-terminal", "vn"]));
    await links.call("vn", "bot.list", {}).catch(() => undefined);
    expect(tokens()).toBe(3);
  });

  test("before any plugin.ui list, no plugin gets a connection", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-links-"));
    const fake: FakeDaemon = await startFakeDaemon({ home });
    const links = new LayerLinks({ appClient: () => undefined, dial: () => dial(daemonEndpoint(home)), appToken: () => undefined, pid: process.pid, appVersion: "0.0.0-test", onEvent: () => {}, log: () => {} });
    cleanup.push(() => fake.close(), () => rmSync(home, { recursive: true, force: true }));
    await expect(links.call("vn", "bot.list", {})).rejects.toThrow("vn shows no UI now");
  });
});

describe("a plugin's own events, latest-wins", () => {
  test("within a tick only the last of each topic or key goes on, at most a fixed number per plugin; other events go at once", async () => {
    const got: [string, unknown][] = [];
    const box = new OwnEventMailbox((p, e) => got.push([p, e]), 5);
    for (let i = 0; i < 100; i++) expect(box.offer("vn", { type: "plugin_ui_message", event: "stage", value: i })).toBe(true);
    box.offer("vn", { type: "plugin_store_changed", key: "stage" });
    box.offer("sol", { type: "plugin_ui_message", event: "stage", value: "sol" });
    expect(box.offer("vn", { type: "terminal_output" })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([["vn", { type: "plugin_ui_message", event: "stage", value: 99 }], ["vn", { type: "plugin_store_changed", key: "stage" }], ["sol", { type: "plugin_ui_message", event: "stage", value: "sol" }]]);
    got.length = 0;
    for (let i = 0; i < OWN_EVENT_KEYS + 10; i++) box.offer("vn", { type: "plugin_ui_message", event: `t${i}`, value: i });
    box.flush();
    expect(got).toHaveLength(OWN_EVENT_KEYS);
    expect(got[0]![1]).toMatchObject({ event: "t10" });
  });

  test("every figure cue goes on, in order (an outfit's off never gives way to the next on); a figure's catalogue and box are kept apart", () => {
    expect([AVATAR_CUE_EVENT, AVATAR_CHANGED_EVENT]).toEqual([CORE_CUE, CORE_CHANGED]);
    const got: [string, unknown][] = [];
    const box = new OwnEventMailbox((p, e) => got.push([p, e]), 5);
    const cue = (part: string, on: boolean) => ({ type: "plugin_ui_message", event: AVATAR_CUE_EVENT, value: { bot: "alpha", cue: { type: "outfit", part, on } } });
    const cues = [cue("lilac-dress", false), cue("yellow-raincoat", false), cue("navy-uniform", true)];
    for (const c of cues) box.offer("clover", c);
    box.offer("alpha", { type: "plugin_ui_message", event: AVATAR_CHANGED_EVENT, value: { kind: "catalogue", catalogue: { outfits: [] } } });
    box.offer("alpha", { type: "plugin_ui_message", event: AVATAR_CHANGED_EVENT, value: { kind: "box", box: { canvas: { width: 1, height: 1 } } } });
    box.offer("alpha", { type: "plugin_ui_message", event: AVATAR_CHANGED_EVENT, value: { kind: "box", box: { canvas: { width: 2, height: 2 } } } });
    box.flush();
    expect(got.filter(([p]) => p === "clover").map(([, e]) => e)).toEqual(cues);
    expect(got.filter(([p]) => p === "alpha").map(([, e]) => (e as { value: { kind: string } }).value)).toEqual([{ kind: "catalogue", catalogue: { outfits: [] } }, { kind: "box", box: { canvas: { width: 2, height: 2 } } }]);
  });
});

