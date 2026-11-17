// The one-time copy of an old install's home on a real daemon: a fresh home's first start raises the core's own card
// on the daemon's one broker; the user's press stages the copy and asks for the restart; the next start swaps it in
// (its registry switches written through the signed store, no "changed outside MOSS" line) and says what to set up
// again, once. The old home (a fixture under a temp folder, named through `MOSS_OLD_HOME`) is byte for byte what it
// was after both daemons ran on the copy.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { ConnWriter, encodeLine, LineDecoder, METHODS, MOSS_PROTOCOL_VERSION, type WritableSocket } from "@waifucave/moss-protocol";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";
import { KeychainValues, memoryVault, MossSecretStore } from "../src/secrets/moss-secret-store";
import { readChoice } from "../src/migration/old-home/choice";
import { OLD_HOME_ENV } from "../src/migration/old-home/locate";
import { NEW_MANIFEST_FILE, NEW_USAGE_LEDGER, OLD_MANIFEST_FILE, OLD_ROOT_PLUGIN } from "../src/migration/old-home/names";
import { OFFER_TEXT } from "../src/migration/old-home/offer";
import { oldHomePaths } from "../src/migration/old-home/paths";
import { OLD_INSTALL_HOME_DIR } from "../src/other-installs";
import { buildOldHome, treeHash } from "./migration/old-home/fixture";

setDefaultTimeout(90_000);

let daemon: RunningDaemon | undefined;
const savedOverride = process.env[OLD_HOME_ENV];
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  process.env[OLD_HOME_ENV] = savedOverride;
});

/** One secret store for every start of the home, as the OS store is (its device key and registry key stay). */
const vault = memoryVault();
const boot = (home: string, userHome: string, net: MemoryNetwork, requestRestart?: () => void) => startDaemon({
  home, secrets: new FileSecretStore(join(home, "..", "secrets.json")), agentProvider: null, appPeer: "none",
  contractSecrets: new MossSecretStore({ home, values: new KeychainValues(vault), status: { backend: "memory", plaintext: false, state: "unlocked" } }),
  ...(requestRestart ? { requestRestart } : {}),
  oldHome: { alive: async () => ({ alive: false }), loginItem: () => undefined },
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

/** A raw MOSS connection as the app: requests by id. */
async function asApp(d: RunningDaemon, home: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let next = 1;
  const socket = await Bun.connect({ unix: d.socketPath, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); }
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  const request = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = next++;
    writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((r) => pending.set(id, r));
  };
  const hello = await request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] });
  expect(hello["error"]).toBeUndefined();
  return { request, close: () => socket.end() };
}

/** The core's own card, once it is up, answered from the app's sealed frame. */
async function press(d: RunningDaemon, title: string, option: string): Promise<void> {
  await d.mossParts.ready;
  const broker = d.mossParts.broker()!;
  let card = broker.cards().find((c) => c.kind === "change" && c.change === "home-copy");
  for (let i = 0; i < 500 && card === undefined; i++) {
    await Bun.sleep(10);
    card = broker.cards().find((c) => c.kind === "change" && c.change === "home-copy");
  }
  expect(card).toBeDefined();
  expect((card!.fields.title as { text: string }).text).toBe(title);
  expect(card!.pluginId).toBeUndefined();
  const frame = broker.frameChannel(card!.id)!;
  expect(await broker.answer(card!.id, { optionId: option, hash: card!.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
}

test("offered at a fresh home's first start; the press stages the copy; the next start swaps it in and says what stays behind", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-old-home-boot-")));
  const userHome = join(root, "user");
  const fx = buildOldHome(userHome, join(root, "scratch"), OLD_INSTALL_HOME_DIR);
  // A plugin the person installed from a folder, as the old build kept it: its manifest under the old name, the engine
  // it asks for under the old root's id, switched on in the old registry. Its files change in the copy, so it asks
  // for its OK again on the normal card.
  mkdirSync(join(fx.old, "plugins", "tarot"), { recursive: true });
  writeFileSync(join(fx.old, "plugins", "tarot", OLD_MANIFEST_FILE), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { [OLD_ROOT_PLUGIN]: `^${PLUGIN_API_VERSION}` } }));
  {
    const file = join(fx.old, "plugins-state", "installed.json");
    const env = JSON.parse(readFileSync(file, "utf8")) as { body: string; gen: number; mac: string };
    const body = JSON.parse(env.body) as { order: string[]; plugins: Record<string, unknown> };
    body.order.push("tarot");
    body.plugins.tarot = { enabled: true, okHash: `sha256:${"b".repeat(64)}` };
    writeFileSync(file, `${JSON.stringify({ ...env, body: JSON.stringify(body) })}\n`);
  }
  process.env[OLD_HOME_ENV] = fx.old;
  const before = treeHash(fx.old);
  const home = join(root, "moss-home");
  mkdirSync(join(root, "keys"), { recursive: true });
  const net = new MemoryNetwork();

  // The first start: the offer, on the daemon's broker.
  let restartAsked!: () => void;
  const restarted = new Promise<void>((r) => { restartAsked = r; });
  daemon = await boot(home, userHome, net, () => restartAsked());
  await daemon.mossParts.ready;
  // A fresh home is marked current at its first start (the upgrade's first row reads it).
  expect(existsSync(join(home, "migration", "c", "CURRENT_LAYOUT"))).toBe(true);
  await press(daemon, OFFER_TEXT.offer.title, "copy");
  await restarted;
  expect(existsSync(oldHomePaths(home).complete)).toBe(true);
  // Its exit-76 restart is not a release restart (RL): the engine's release switch neither fired nor left its one-shot marker.
  expect(existsSync(join(home, "bin", ".restarted-into.json"))).toBe(false);
  expect(await Promise.race([daemon.releaseRestart.then(() => "restarted"), Bun.sleep(50).then(() => "not asked")])).toBe("not asked");
  await daemon.stop();
  daemon = undefined;
  expect(treeHash(fx.old)).toBe(before);

  // The next start swaps it in, under the lock, before any store opens.
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try {
    daemon = await boot(home, userHome, net);
    await press(daemon, OFFER_TEXT.notice.title, "ok");
    for (let i = 0; i < 500 && readChoice(home)?.choice === "copied" && (readChoice(home) as { noticeShown?: boolean }).noticeShown !== true; i++) await Bun.sleep(10);
  } finally {
    spy.mockRestore();
  }
  expect(lines.some((l) => l.startsWith("old home: the copy from"))).toBe(true);
  expect(lines.filter((l) => /was changed outside MOSS|belongs to another device key|isn't trusted/.test(l))).toEqual([]);
  expect(readChoice(home)).toMatchObject({ choice: "copied", from: fx.old, noticeShown: true });
  // The data is here: settings, the conversation's index, the ledger under its new name, memory; the carry was written.
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).notifications).toEqual({ sound: "soft" });
  expect(existsSync(join(home, "sessions", "index.db"))).toBe(true);
  expect(existsSync(join(home, ...NEW_USAGE_LEDGER.split("/")))).toBe(true);
  expect(readFileSync(join(home, "memory", "notes.md"), "utf8")).toBe("# notes\nremember the meadow\n");
  expect(existsSync(oldHomePaths(home).carry)).toBe(false);
  // The folder plugin: rewritten, listed, not running on the old OK; its OK card comes on the normal broker, and the
  // user's yes starts it.
  expect(existsSync(join(home, "plugins", "tarot", NEW_MANIFEST_FILE))).toBe(true);
  const app = await asApp(daemon, home);
  const stateOf = async () => ((await app.request("plugin.get", { id: "tarot" }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
  for (let i = 0; i < 500 && (await stateOf()) === undefined; i++) await Bun.sleep(10);
  const first = await stateOf();
  expect(first).toBeDefined();
  expect(first).not.toBe("running");
  const broker = daemon.mossParts.broker()!;
  let ok = broker.cards().find((c) => c.kind === "plugin-ok" && c.pluginId === "tarot");
  const byItself = ok !== undefined;
  if (ok === undefined) {
    const switched = (await app.request("plugin.setEnabled", { id: "tarot", enabled: true }))["result"] as { applied?: boolean; card?: string } | undefined;
    for (let i = 0; i < 500 && ok === undefined; i++) {
      await Bun.sleep(10);
      ok = broker.cards().find((c) => c.kind === "plugin-ok" && c.pluginId === "tarot" && (switched?.card === undefined || c.id === switched.card));
    }
  }
  expect(ok).toBeDefined();
  console.info(`tarot's OK card came ${byItself ? "by itself (its carried switch is on)" : "on setEnabled"}; it was ${first} before`);
  const frame = broker.frameChannel(ok!.id)!;
  expect(await broker.answer(ok!.id, { optionId: "approve", hash: ok!.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
  for (let i = 0; i < 500 && (await stateOf()) !== "running"; i++) await Bun.sleep(10);
  expect(await stateOf()).toBe("running");
  app.close();
  await daemon.stop();
  daemon = undefined;
  // The old home, after two daemons ran (the second on the copy): as it was.
  expect(treeHash(fx.old)).toBe(before);
  // And a third start asks nothing.
  daemon = await boot(home, userHome, net);
  await daemon.mossParts.ready;
  await Bun.sleep(200);
  expect(daemon.mossParts.broker()!.cards().filter((c) => c.change === "home-copy")).toEqual([]);
});
