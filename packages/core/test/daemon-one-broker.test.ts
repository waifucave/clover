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
import { CloverApprovalBroker } from "../src/approvals/broker";
import { SystemClock } from "../src/clock/system-clock";
import type { ApprovalRequest } from "../src/contracts/approval-broker";
import { lateBroker } from "../src/daemon-parts";

setDefaultTimeout(60_000);

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

test("one broker and one fence: the node's paste card asks on the daemon's broker, and its fenced folders are made", async () => {
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
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  await daemon.cloverParts.ready;
  const broker = daemon.cloverParts.broker();
  // The broker runs with the node, agents or not.
  expect(broker).toBeDefined();
  const node = daemon.cloverParts.node()!;
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

test("the late-bound broker forwards request and get (a raise's card is read back through get: J's #342 fails closed without it)", async () => {
  let bound: CloverApprovalBroker | undefined;
  const late = lateBroker(() => bound);
  const req = { kind: "change", change: "computer-level", origin: "user", computers: ["Studio"], effect: "other", fields: { title: { type: "text", text: "Raise" } } } as unknown as ApprovalRequest;
  await expect(late.request(req)).rejects.toThrow(/aren't up on this computer yet/);
  expect(late.get("card_x")).toBeUndefined();
  bound = new CloverApprovalBroker({ clock: new SystemClock(), levels: () => "ask" });
  let cardId: string | undefined;
  const decided = late.request(req, { onCard: (id) => (cardId = id) });
  for (let i = 0; i < 100 && cardId === undefined; i++) await Bun.sleep(1);
  // The record `get` hands back is the broker's own, the one #342's registry compares the raise against.
  expect(late.get(cardId!)).toEqual(bound.get(cardId!));
  expect(late.get(cardId!)!.card.id).toBe(cardId!);
  bound.close();
  expect((await decided).allowed).toBe(false);
  expect(late.get(cardId!)).toEqual(bound.get(cardId!));
});
