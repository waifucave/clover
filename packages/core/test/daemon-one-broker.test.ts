// The daemon's one CloverFence and one approval broker (the daemon integration lane): the computer node, the bot side
// and the agents go through the same two, made in daemon-parts.ts. Here the node's half: the broker exists once the
// node runs (agents or not), a terminal's paste of several lines asks on that broker's card (lane J's `nodeParts`,
// bound late), and the node keeps the fence's folders. Fakes only where their lanes use them: H's in-memory network and
// D's plugin registry and drivers.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("one broker and one fence: the node's paste card asks on the daemon's broker, and its fenced folders are made", async () => {
  let driversFence: { home: string; cloverHome: string } | undefined;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-int-broker-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(join(userHome, "project1"), { recursive: true });
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" },
    },
    parts: {
      userHome,
      // A shell that only echoes what it's given, so nothing of the user's runs.
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: (p) => { driversFence = p.fence; return new Drivers().factory; }, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  await daemon.cloverParts.ready;
  const broker = daemon.cloverParts.broker();
  // The broker runs with the node, agents or not.
  expect(broker).toBeDefined();
  const node = daemon.cloverParts.node()!;
  // The bots' drivers get the parts' one fence, over the parts' user home (never a second fence over the real home).
  expect(driversFence?.home).toBe(userHome);
  expect(driversFence?.cloverHome).toBe(home);
  // The node holds the daemon's fence: its fenced folders under the Clover home are there.
  expect(existsSync(join(home, "connectors"))).toBe(true);
  // A folder kind's files stay files: settings.json and trust.json are never made as folders.
  expect(existsSync(join(home, "trust.json"))).toBe(false);
  expect(existsSync(join(home, "settings.json")) ? statSync(join(home, "settings.json")).isFile() : true).toBe(true);

  const { terminalId } = await node.terminals.open({ computer: "Studio", cwd: "home/Studio/project1", cols: 80, rows: 24 });
  // A paste of several lines waits on a card, on the daemon's one broker: not PASTE_CANT_ASK.
  const pasted = node.terminals.write(terminalId, "echo one\necho two\n", { paste: true });
  let settled = false;
  void pasted.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 200 && broker!.cards().length === 0; i++) await Bun.sleep(10);
  expect(broker!.cards()).toHaveLength(1);
  expect(settled).toBe(false);
  await node.terminals.close(terminalId);
});
