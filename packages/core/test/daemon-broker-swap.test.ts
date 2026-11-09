// The broker swap on a real daemon (the daemon integration lane, C-M3): the daemon's one approval broker raises its cards
// as `core.event`s to the app (lane C's `approvalCoreEvents` through the Clover server), and the device links' sensitive
// changes ask on that broker once the parts are up. Fakes only where their lanes use them: H's in-memory network and
// D's plugin registry and drivers; the app is a socket that says the app's hello with this run's token.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
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

test("the broker's cards reach the app as core events: a card raised on the daemon's broker is card_requested, and its end card_resolved", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-int-swap-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(join(userHome, "project1"), { recursive: true });
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null,
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

  // A card on the daemon's broker: a terminal's paste of several lines (lane J's node, bound to the broker in #292).
  const node = daemon.cloverParts.node()!;
  const broker = daemon.cloverParts.broker()!;
  const { terminalId } = await node.terminals.open({ computer: "Studio", cwd: "home/Studio/project1", cols: 80, rows: 24 });
  const pasted = node.terminals.write(terminalId, "echo one\necho two\n", { paste: true }).catch((e: Error) => e);
  for (let i = 0; i < 300 && eventsOf(app.notes, "card_requested").length === 0; i++) await Bun.sleep(10);
  const requested = eventsOf(app.notes, "card_requested");
  expect(requested).toHaveLength(1);
  const card = broker.cards()[0]!;
  expect(JSON.stringify(requested[0]!.params)).toContain(card.id);

  // The card ends (here the broker's close, as the stop's first step does): the app hears it resolved, and the paste
  // is refused with a reason.
  broker.close();
  for (let i = 0; i < 300 && eventsOf(app.notes, "card_resolved").length === 0; i++) await Bun.sleep(10);
  expect(JSON.stringify(eventsOf(app.notes, "card_resolved")[0]?.params)).toContain(card.id);
  expect(await pasted).toBeInstanceOf(Error);
  app.close();
});
