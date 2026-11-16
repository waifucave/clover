// F3's question: could a third party ship a sixth usage source from a folder with no change outside it? This installs one
// (`acme-usage`: a folder with a manifest and a handler, naming the program `acme`) into a real daemon's plugins folder,
// says yes on its OK card, and reads its plan windows and its token counts through the daemon's own `usage.summary` and
// `usage.series` (what the Usage page draws). A FAKE `acme` program only; nothing of the user's.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_PROTOCOL_VERSION, PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/moss-protocol";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../../src/auth/secret-store";
import { Drivers } from "../../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { buildDevBundledPlugins } from "../../src/registry/bundled-stage";
import { planReadings } from "../../src/usage/rpc";
import { fakeExecutable } from "./fixtures";

setDefaultTimeout(300_000);
const REPO_PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "plugins");

let daemon: RunningDaemon | undefined;
let savedPath: string | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
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

test("a sixth usage source installed from a folder shows its plan windows and its tokens on the Usage page's doors", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-f3-sixth-")));
  const home = join(root, "moss-home");
  const userHome = join(root, "home");
  mkdirSync(userHome, { recursive: true });
  // The fake program, on the PATH the daemon's `api.outside` looks in: `acme plan` and `acme tokens`.
  const bin = join(root, "bin");
  fakeExecutable(bin, "acme", `
if (process.argv[2] === "plan") log({ used: 42, resets: ${Math.floor(Date.now() / 1000) + 7200} });
else log({ day: new Date().toISOString().slice(0, 10), input: 1200, output: 300 });
`);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  // The whole third-party plugin: a manifest and a handler. Nothing else in the repo knows it.
  const folder = join(home, "plugins", "acme-usage");
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "moss.json"), JSON.stringify({
    manifest: 1, id: "acme-usage", name: "Acme usage", version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", process: "own", outside: { programs: ["acme"] } },
    contributes: { "usage.sources": [{ id: "acme", name: "Acme", handler: "source", provides: ["plan", "usage"], planEveryMs: 60000 }] },
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), `
export const source = {
  async plan(args, ctx) {
    const r = await ctx.api.outside.run("acme", ["plan"], { timeoutMs: 10000 });
    const p = JSON.parse(r.stdout);
    return { keep: true, reading: { source: "acme-cli", at: args.now, windows: [{ id: "acme-five", kind: "five_hour", windowMinutes: 300, usedPercent: p.used, resetsAt: p.resets * 1000, stale: false }] } };
  },
  async ingest(args, ctx) {
    const r = await ctx.api.outside.run("acme", ["tokens"], { timeoutMs: 10000 });
    const t = JSON.parse(r.stdout);
    const at = args.now - 60000;
    return { records: [{ dedupe: "acme:" + t.day, at, provider: "acme", model: "acme-1", input: t.input, output: t.output, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 }] };
  },
};
`);
  // The Usage plugin (the owner of `usage.sources`) is the repository's, built and staged the way a source daemon does.
  await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["moss"], mossHome: home });
  const net = new MemoryNetwork();
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    usage: { sources: ["acme"], catchUp: false, background: false },
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
  await daemon.mossParts.ready;
  const app = await rpc(daemon.socketPath);
  expect((await app.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: ["app.quit"] }))["error"]).toBeUndefined();
  const harness = await rpc(daemon.socketPath);
  expect((await harness.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "orb" }))["error"]).toBeUndefined();

  const stateOf = async () => ((await app.request("plugin.get", { id: "acme-usage" }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
  for (let i = 0; i < 300 && (await stateOf()) === undefined; i++) await Bun.sleep(10);
  // Before the user's yes the source is not called: the Usage page has no slot for it.
  const before = ((await harness.request(METHODS.usageSummary, { range: "24h" }))["result"] as { plans: Record<string, { source: string }> }).plans["acme"];
  expect(before).toBeUndefined();

  const switched = (await app.request("plugin.setEnabled", { id: "acme-usage", enabled: true }))["result"] as { card: string };
  const broker = daemon.mossParts.broker()!;
  for (let i = 0; i < 300 && broker.cards().find((c) => c.id === switched.card) === undefined; i++) await Bun.sleep(10);
  const card = broker.cards().find((c) => c.id === switched.card)!;
  // The card says what it runs outside the sandbox, named.
  expect(JSON.stringify(card)).toContain("acme");
  const frame = broker.frameChannel(card.id)!;
  expect(await broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
  for (let i = 0; i < 300 && (await stateOf()) !== "running"; i++) await Bun.sleep(10);
  expect(await stateOf()).toBe("running");

  // The page's doors: the plan window and the day's tokens, from a plugin the core had never heard of.
  let plans: Record<string, { source: string; windows: Array<{ usedPercent: number; kind: string }> }> = {};
  for (let i = 0; i < 100; i++) {
    plans = ((await harness.request(METHODS.usageSummary, { range: "24h" }))["result"] as { plans: typeof plans }).plans;
    if (plans["acme"]?.source === "acme-cli") break;
    await Bun.sleep(100);
  }
  expect(plans["acme"]).toMatchObject({ source: "acme-cli", windows: [{ usedPercent: 42, kind: "five_hour" }] });
  type Series = { totals: { input: number; output: number; costUsd: number } };
  let series = (await harness.request(METHODS.usageSeries, { range: "24h", sources: ["acme"] }))["result"] as Series;
  for (let i = 0; i < 100 && series.totals.input === 0; i++) {
    await Bun.sleep(100); // the first ingest starts the plugin's process; the door waits only a moment for it
    series = (await harness.request(METHODS.usageSeries, { range: "24h", sources: ["acme"] }))["result"] as Series;
  }
  expect(series.totals).toMatchObject({ input: 1200, output: 300, costUsd: 0.5 });
  app.close(); harness.close();
});

test("the plan windows the Usage page asks for (`usage.plans`) carry a source no one named in advance, by its own id", async () => {
  const now = Date.now();
  const readers = {
    planSources: () => ["acme"],
    sourcePlan: async () => ({ provider: "acme", source: "acme-cli", at: now, planType: "team", windows: [{ id: "w", kind: "five_hour" as const, usedPercent: 42, stale: false, windowMinutes: 300, resetsAt: now + 3_600_000 }] }),
  };
  const out = await planReadings({ readers: readers as never, computer: () => "Studio", now: () => now });
  expect(out).toEqual([{ source: "acme", computer: "Studio", plan: "team", window: "five_hour", usedPercent: 42, resetsAt: now + 3_600_000, readAt: now }]);
});
