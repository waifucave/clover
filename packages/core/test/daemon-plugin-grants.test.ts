// Picked files end to end on a real daemon (lane G's media fixture, try 14c: "the core keeps no grants yet
// (plugin.grant.add not served by this core)"). The app's main process registers the user's pick over its own
// connection (`plugin.grant.add`, app role, as `apps/desktop/src/main/ui/file-grants.ts` calls it); the plugin's page
// reaches its host half (`host.call` through the app's `plugin.layer.api`), whose `files.stat` on the token answers the
// picked file's size and whose `files.path` its real path; and a process of the plugin's own, fenced the way the daemon
// fences its stdio servers (the grants' `fencePaths`), reads that path and nothing beside it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { PluginGrants } from "../src/fence/plugin-grants";
import { MemoryNetwork } from "../src/links/memory-wire";
import { pluginFenceProfile } from "../src/registry/plugin-fence";
import { darwinTest } from "./helpers/darwin-only";

setDefaultTimeout(90_000);

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

const TOKEN = "grant:5f0c2a8e-1b3d-4c6e-9f7a-2d4b6c8e0a1f";

darwinTest("the app registers a pick; the plugin's host half stats it by its token and gets its real path; the plugin's own process reads it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-grants-")));
  const home = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(join(userHome, "Movies"), { recursive: true });
  const clip = join(userHome, "Movies", "clip.mp4");
  writeFileSync(clip, "0123456789");
  writeFileSync(join(userHome, "Movies", "other.mp4"), "OTHER");
  // A third-party plugin with the `files` capability and a host half that uses the token.
  const folder = join(home, "plugins", "cutter");
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id: "cutter", name: "Cutter", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" }, capabilities: ["files"] }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), [
    // What its page may call (`host.call` reaches the module's `ui` table only).
    "export const ui = {",
    "  stat: async (args, ctx) => ctx.api.files.stat(args.token),",
    "  realPath: async (args, ctx) => ctx.api.files.path(args.token),",
    "};",
    "",
  ].join("\n"));
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
  expect((await app.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] }))["error"]).toBeUndefined();

  // The user's OK for the plugin (its `files` capability with it): it runs.
  const stateOf = async () => ((await app.request("plugin.get", { id: "cutter" }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
  for (let i = 0; i < 300 && (await stateOf()) === undefined; i++) await Bun.sleep(10);
  const switched = (await app.request("plugin.setEnabled", { id: "cutter", enabled: true }))["result"] as { applied: boolean; card: string };
  const broker = daemon.cloverParts.broker()!;
  for (let i = 0; i < 300 && broker.cards().find((c) => c.id === switched.card) === undefined; i++) await Bun.sleep(10);
  const card = broker.cards().find((c) => c.id === switched.card)!;
  expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
  for (let i = 0; i < 500 && (await stateOf()) !== "running"; i++) await Bun.sleep(10);
  expect(await stateOf()).toBe("running");

  // Main registers the pick exactly as `file-grants.ts` does, right after the user chose the file.
  const added = await app.request("plugin.grant.add", { pluginId: "cutter", token: TOKEN, path: clip, kind: "file", access: "read" });
  expect(added["error"]).toBeUndefined();
  expect(added["result"]).toMatchObject({ grant: { token: TOKEN, path: clip, kind: "file", access: "read" } });
  expect((await app.request("plugin.grant.list", { pluginId: "cutter" }))["result"]).toMatchObject({ grants: [{ token: TOKEN }] });

  // The page asks its host half; the host half uses the token.
  const hostCall = async (handler: string) => app.request("plugin.layer.api", { pluginId: "cutter", call: "host.call", args: [handler, { token: TOKEN }] });
  const stat = await hostCall("stat");
  expect(stat["error"]).toBeUndefined();
  expect((stat["result"] as { result: unknown }).result).toMatchObject({ path: TOKEN, type: "file", size: 10 });
  const real = await hostCall("realPath");
  expect(real["error"]).toBeUndefined();
  const path = (real["result"] as { result: string }).result;
  expect(path).toBe(clip);

  // A process of the plugin's own, fenced as the daemon fences its stdio servers with the picks the daemon kept.
  const picked = new PluginGrants({ cloverHome: home, userHome }).fencePaths("cutter");
  expect(picked).toEqual({ read: [clip], write: [] });
  const profile = pluginFenceProfile({ cloverHome: home, userHome, read: [], write: [], picked: picked.read, exec: "any" });
  const cat = (p: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", p], { encoding: "utf8" });
  expect(cat(path).stdout).toBe("0123456789");
  expect(cat(join(userHome, "Movies", "other.mp4")).stdout).not.toContain("OTHER");

  // The user takes it back: the host half's token no longer reaches it.
  expect((await app.request("plugin.grant.remove", { pluginId: "cutter", token: TOKEN }))["result"]).toEqual({ removed: true });
  expect((await hostCall("stat"))["error"]).toBeDefined();
  app.close();
});
