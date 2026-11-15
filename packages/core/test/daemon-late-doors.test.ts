// The late doors' race (try 14e: the acceptance's setup failed with "plugin.auth.list is not served yet" at load ~9,
// and passed on a retry). The plugin registry's `plugin.auth.*`, the links' `device.*` and the bot side's `bot.*` join
// the Clover server's handlers after the socket listens; a client that connects and says hello the instant the socket
// answers used to be told "not served yet" for them. Now such a call waits for its door. A real daemon, its late parts
// held back on purpose (as a loaded machine's slow start does), each door called right after the hello. Temp home,
// in-memory links; nothing opens a window.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";

setDefaultTimeout(90_000);

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

async function rpc(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let next = 1;
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); }
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
}

const DELAY = 1_500;
const notServed = (m: Record<string, unknown>) => /not served yet|no such method/.test(String((m["error"] as { message?: unknown } | undefined)?.message ?? ""));

test("a door that joins after the socket listens is answered when it is in, never 'not served yet' in between; a door already in answers at once", async () => {
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-a-late-doors-"))), "clover-home");
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    lateDoorsDelayMsForTests: DELAY,
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: {
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  // The instant the socket answers: hello, then every door at once.
  const t0 = Date.now();
  const app = await rpc(daemon.socketPath);
  const hello = await app.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: [] });
  expect(hello["error"]).toBeUndefined();
  const at = (p: Promise<Record<string, unknown>>) => p.then((m) => ({ m, ms: Date.now() - t0 }));
  const [list, auth, devices, bots] = await Promise.all([
    at(app.request("plugin.list", {})),
    at(app.request("plugin.auth.list", { id: "clover" })),
    at(app.request("device.list", {})),
    at(app.request("bot.list", {})),
  ]);
  // In from the start: answered at once, not held behind the late parts.
  expect(list.m["error"]).toBeUndefined();
  expect(list.ms).toBeLessThan(DELAY);
  // Late doors: each answered by its handler (a result, or its own refusal), after the parts came up.
  for (const [name, r] of [["plugin.auth.list", auth], ["device.list", devices], ["bot.list", bots]] as const) {
    expect({ name, notServed: notServed(r.m) }).toEqual({ name, notServed: false });
    expect(r.ms).toBeGreaterThanOrEqual(DELAY - 100);
  }
  expect(devices.m["result"]).toBeDefined();
  expect(bots.m["result"]).toBeDefined();
  // Once the parts are up, a method this daemon doesn't serve answers at once.
  await daemon.cloverParts.ready;
  const t1 = Date.now();
  const unserved = await app.request("codeAgent.send", { text: "x" });
  expect(unserved["error"]).toBeDefined();
  expect(Date.now() - t1).toBeLessThan(1_000);
  app.close();
});
