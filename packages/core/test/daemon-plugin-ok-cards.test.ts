// A found plugin's OK card on a real daemon (B, after #353's broker swap): the plugin registry opens before the daemon's
// one approval broker, and its OK cards ask on that broker once it's up (`lateApprovalBroker`), so the app hears a
// found plugin's card (card_requested) and the user's yes starts it. Before, the registry had no broker and its cards
// were ids nobody showed. Fakes only where their lanes use them, as in daemon-broker-swap.test.ts.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";

setDefaultTimeout(60_000);

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

/** A raw Clover connection: requests by id, and every notification the daemon sends. */
async function rpc(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let next = 1;
  const notes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); } else if (typeof m["method"] === "string") notes.push(m as never);
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    notes,
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
}

const eventsOf = (notes: Array<{ method: string; params: Record<string, unknown> }>, type: string) =>
  notes.filter((n) => n.method === "core.event" && (n.params["type"] === type || (n.params["event"] as { type?: string } | undefined)?.type === type));

test("a found plugin's OK card reaches the app on the daemon's broker, and the user's yes starts the plugin", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-okcards-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  // A found plugin: in the plugins folder, never OK'd here.
  mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
  writeFileSync(join(home, "plugins", "tarot", "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: {
      userHome,
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  await daemon.cloverParts.ready;
  const app = await rpc(daemon.socketPath);
  const hello = await app.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] });
  expect(hello["error"]).toBeUndefined();
  expect((await app.request("events.subscribe", { areas: ["approvals"] }))["error"]).toBeUndefined();

  const stateOf = async () => ((await app.request("plugin.get", { id: "tarot" }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
  for (let i = 0; i < 300 && (await stateOf()) === undefined; i++) await Bun.sleep(10);
  expect(await stateOf()).toBe("found");

  // The user switches it on: its OK card, a real one on the daemon's broker, reaches the app.
  const switched = (await app.request("plugin.setEnabled", { id: "tarot", enabled: true }))["result"] as { applied: boolean; card: string };
  expect(switched.applied).toBe(false);
  for (let i = 0; i < 300 && eventsOf(app.notes, "card_requested").length === 0; i++) await Bun.sleep(10);
  const requested = eventsOf(app.notes, "card_requested");
  expect(requested).toHaveLength(1);
  expect(JSON.stringify(requested[0]!.params)).toContain(switched.card);
  const broker = daemon.cloverParts.broker()!;
  const card = broker.cards().find((c) => c.id === switched.card)!;
  expect(card).toMatchObject({ kind: "plugin-ok", pluginId: "tarot" });

  // The user's yes, from the app's sealed frame: the plugin runs.
  const frame = broker.frameChannel(card.id)!;
  expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
  for (let i = 0; i < 300 && (await stateOf()) !== "running"; i++) await Bun.sleep(10);
  expect(await stateOf()).toBe("running");
  app.close();
});

test("without links the parts start without a broker, and a found plugin's OK is refused with why, never an id nobody shows", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-okcards-")));
  const home = join(root, "clover-home");
  mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
  writeFileSync(join(home, "plugins", "tarot", "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
  daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none", links: false });
  await daemon.cloverParts.ready;
  const app = await rpc(daemon.socketPath);
  await app.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] });
  for (let i = 0; i < 300 && (await app.request("plugin.get", { id: "tarot" }))["error"] !== undefined; i++) await Bun.sleep(10);
  const switched = await app.request("plugin.setEnabled", { id: "tarot", enabled: true });
  expect(JSON.stringify(switched["error"])).toContain("the approval cards aren't up on this computer");
  app.close();
});
