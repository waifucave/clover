// Which model a plugin card's Review and the bash safety reviewer run on, on a real daemon (the controller's rule,
// 2026-11-13): the reviewer role names a model whose provider is signed in → they run on it, default model or not; the
// role unset → the user's default model; neither → "No model is set for reviews…". The settings file is changed while
// the daemon runs, as Settings › Models does, and each answer is the live one (`plugin.review { peek }`).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../src/auth/secret-store";
import { writeCredentialMaterial } from "../src/auth/credential-material";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";
import { REVIEW_NO_MODEL } from "../src/registry/plugin-review";

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
        // The daemon's own requests (app.ping): answered, as the app does.
        if (typeof m["method"] === "string" && m["id"] !== undefined) writer.enqueue(encodeLine({ jsonrpc: "2.0", id: m["id"], result: {} }));
        else if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); }
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

/** A daemon whose only credential is an Anthropic key, its default model `provider` (Settings › Models), a found
 *  plugin's OK card up; returns a way to set the settings file and to peek the card's Review. */
async function home(provider: string, withBundled = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-review-model-")));
  const cloverHome = join(root, "clover-home");
  const userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(join(cloverHome, "plugins", "tarot"), { recursive: true });
  writeFileSync(join(cloverHome, "plugins", "tarot", "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
  const settingsFile = join(cloverHome, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 3, provider: { model: provider } }, null, 2));
  const secrets = new FileSecretStore(join(cloverHome, "secrets.json"));
  await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant-test" });
  if (withBundled) {
    const { buildDevBundledPlugins } = await import("../src/registry/bundled-stage");
    await buildDevBundledPlugins({ sources: join(import.meta.dir, "..", "..", "..", "plugins"), ids: ["clover"], cloverHome });
  }
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home: cloverHome, secrets, appPeer: "none",
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
  await app.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(join(cloverHome, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] });
  for (let i = 0; i < 300 && (await app.request("plugin.get", { id: "tarot" }))["error"] !== undefined; i++) await Bun.sleep(10);
  const card = ((await app.request("plugin.setEnabled", { id: "tarot", enabled: true }))["result"] as { card: string }).card;
  const settings = (patch: Record<string, unknown>) => {
    const now = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    writeFileSync(settingsFile, JSON.stringify({ ...now, ...patch }, null, 2));
  };
  const peek = async () => (await app.request("plugin.review", { card, peek: true }))["result"] as { state: string; model?: string; why?: string };
  /** The peek once it says `want` (the settings are read live: a moment after the file changes). */
  const peekUntil = async (want: (v: { state: string; model?: string }) => boolean) => {
    let v = await peek();
    for (let i = 0; i < 600 && !want(v); i++) { await Bun.sleep(25); v = await peek(); }
    return v;
  };
  return { app, settings, peek, peekUntil };
}

test("the reviewer role names a signed-in provider's model: Review runs on it though the default model is elsewhere, within a few seconds with the bundled model plugins watched", async () => {
  // The bundled tree (178 model plugins and the rest) staged as a source run stages it: the registry's watches on its
  // folders are what delayed the settings file's own event (14f's second table: past 30 s).
  const h = await home("codex-oauth/gpt-5.6-sol", true);
  // Before the role is set: Clover chooses no model on Anthropic by itself, and the default is elsewhere.
  expect(await h.peek()).toMatchObject({ state: "unavailable", why: REVIEW_NO_MODEL });
  const t0 = Date.now();
  h.settings({ reviewer: { model: "anthropic/claude-sonnet-5-5" } });
  expect(await h.peekUntil((v) => v.state !== "unavailable")).toMatchObject({ state: "idle", model: "anthropic/claude-sonnet-5-5" });
  // The settings watcher's stat look takes it within its second, whatever the file event does.
  expect(Date.now() - t0).toBeLessThan(5_000);
  h.app.close();
}, 600_000);

test("the role unset: Review runs on the user's default model", async () => {
  const h = await home("anthropic/claude-sonnet-5-5");
  expect(await h.peekUntil((v) => v.state !== "unavailable")).toMatchObject({ state: "idle", model: "anthropic/claude-sonnet-5-5" });
  h.app.close();
});

test("neither a role nor a default it can run on: Review says no model is set", async () => {
  const h = await home("codex-oauth/gpt-5.6-sol");
  expect(await h.peek()).toMatchObject({ state: "unavailable", why: REVIEW_NO_MODEL });
  h.app.close();
});
