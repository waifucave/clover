// `logs.read` and `logs.follow` in a real plugin host (a worker of the shared process and a process of the plugin's
// own): a plugin with `logs.read` reads and follows its own log, the file its console writes; Clover's own log and
// another plugin's are refused; without the capability the calls don't exist for it. Temp home, the fake approval
// broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
export const say = async (args) => { for (const l of args.lines) console.log(l); return true; };
export const read = async (args, ctx) => {
  try { return await ctx.api.logs.read(args.source, args.opts); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; }
};
export const follow = async (args, ctx) => {
  const got = [];
  let off;
  try { off = ctx.api.logs.follow(args.source, (line) => got.push(line)); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; }
  await new Promise((r) => setTimeout(r, 300));
  console.log("followed " + args.mark);
  for (let i = 0; i < 60 && !got.some((l) => l.includes("followed " + args.mark)); i++) await new Promise((r) => setTimeout(r, 100));
  off();
  return got;
};
`;

function plugin(home: string, id: string, o: { process?: "own"; capabilities: string[] }): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", ...(o.process === undefined ? {} : { process: o.process }) }, capabilities: o.capabilities,
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
}

function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => { if (registry.get(id)?.state !== "found") { off(); resolve(); } });
    if (registry.get(id)?.state !== "found") { off(); resolve(); }
  });
}

describe("logs.* in a real plugin host", () => {
  test("a plugin reads and follows its own log, worker and own process alike; nothing else's, and nothing without logs.read", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-logs-")));
    temps.push(home);
    plugin(home, "diag", { capabilities: ["logs.read"] });
    plugin(home, "diagown", { process: "own", capabilities: ["logs.read"] });
    plugin(home, "plain", { capabilities: [] });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    try {
      for (const id of ["diag", "diagown", "plain"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      const call = <R>(id: string, handler: string, args: unknown) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER });
      for (const id of ["diag", "diagown"]) {
        await call(id, "say", { lines: ["first line", "second line", "third line"] });
        // Its console reaches its log a moment later (the host's batches).
        let lines: string[] = [];
        for (let i = 0; i < 100 && !lines.some((l) => l.includes("third line")); i++) {
          lines = await call<string[]>(id, "read", { source: { plugin: id } });
          await Bun.sleep(30);
        }
        expect(lines.some((l) => l.endsWith("first line"))).toBe(true);
        expect(lines.some((l) => l.endsWith("third line"))).toBe(true);
        const two = await call<string[]>(id, "read", { source: { plugin: id }, opts: { lines: 2 } });
        expect(two).toHaveLength(2);
        expect(two[1]!.endsWith("third line")).toBe(true);
        // Following: each line written from now on.
        const followed = await call<string[]>(id, "follow", { source: { plugin: id }, mark: id });
        expect(followed.some((l) => l.endsWith(`followed ${id}`))).toBe(true);
        expect(followed.some((l) => l.endsWith("first line"))).toBe(false);
        // Not Clover's own log, not another plugin's.
        expect(await call(id, "read", { source: "core" })).toEqual({ error: expect.stringMatching(/^refused: Clover's own log isn't open to plugins/) });
        expect(await call(id, "read", { source: { plugin: "plain" } })).toEqual({ error: expect.stringMatching(/^refused: .* reads only its own logs/) });
        // A watch answers at once and is refused in the core: it hears nothing of the other plugin's log.
        await call("plain", "say", { lines: ["plain's own line"] });
        expect(await call(id, "follow", { source: { plugin: "plain" }, mark: "x" })).toEqual([]);
      }
      // Without the capability, the call doesn't exist for the plugin.
      expect(await call("plain", "read", { source: { plugin: "plain" } })).toEqual({ error: expect.stringMatching(/logs\.read/) });
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
