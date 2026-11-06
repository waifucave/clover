// A layer's own connection to the core (roles.ts): opened with a layer token for that plugin, after the daemon's
// proof, as that plugin; only the layer role's methods pass; its events go to that plugin's documents.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYER_METHODS, LayerLinks } from "../src/main/layer-links";
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
});
