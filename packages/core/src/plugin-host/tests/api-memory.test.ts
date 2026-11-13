// `memory.*` in a real plugin host (a worker of the shared process and a process of the plugin's own) over lane D's real
// memory folders (`<home>/bots/<bot>/memory/`): a bot plugin reads its own bot's memory with no capability; with
// `memory.read` a plugin reads any bot's; without it, no other bot's. Read-only. Temp home, the fake approval broker and
// an in-memory secret store; nothing opens a window.
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
import type { BotSide } from "../../bots/wiring";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const list = async (args, ctx) => tried(() => ctx.api.memory.list(args.bot));
export const read = async (args, ctx) => tried(() => ctx.api.memory.read(args.bot, args.path));
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

describe("memory.* in a real plugin host", () => {
  test("a bot plugin reads its own bot's memory with no capability; memory.read reads any bot's; nothing else", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-memory-")));
    temps.push(home);
    for (const [bot, text] of [["luna", "Luna remembers the moon."], ["sol", "Sol remembers the sun."]] as const) {
      mkdirSync(join(home, "bots", bot, "memory", "notes"), { recursive: true });
      writeFileSync(join(home, "bots", bot, "memory", "MEMORY.md"), `- [notes](notes/${bot}.md)\n`);
      writeFileSync(join(home, "bots", bot, "memory", "notes", `${bot}.md`), text);
    }
    plugin(home, "luna", { capabilities: [] });
    // A plugin installed under the id of a bot the user removed: the old bot's folder stays, and isn't its own.
    plugin(home, "sol", { capabilities: [] });
    plugin(home, "reader", { capabilities: ["memory.read"] });
    plugin(home, "readerown", { process: "own", capabilities: ["memory.read"] });
    plugin(home, "nosy", { process: "own", capabilities: [] });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({
      home, computer: "Studio", registry: opened.registry, secrets, fence: false,
      // The bot side has luna live; sol was removed (its memory folder left behind).
      areas: { bots: () => ({ bots: { has: (id: string) => id === "luna" } }) as unknown as BotSide, node: () => undefined, links: () => undefined },
    });
    try {
      for (const id of ["luna", "sol", "reader", "readerown", "nosy"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      expect(opened.folders.okText("reader", "macos").lines).toContain("It reads your bots' memories.");
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER });
      // Its own bot's, with no capability.
      const own = await call<{ path: string }[]>("luna", "list", { bot: "luna" });
      expect(own.map((e) => e.path).sort()).toEqual(expect.arrayContaining(["MEMORY.md", "notes/luna.md"]));
      expect(await call("luna", "read", { bot: "luna", path: "notes/luna.md" })).toBe("Luna remembers the moon.");
      expect(await call("luna", "read", { bot: "sol", path: "MEMORY.md" })).toEqual({ error: expect.stringMatching(/^refused: sol's memory needs the capability memory\.read/) });
      // A removed bot's folder isn't the own bot's of a plugin that later takes its id: it needs memory.read.
      expect(await call("sol", "list", { bot: "sol" })).toEqual({ error: expect.stringMatching(/^refused: sol's memory needs the capability memory\.read/) });
      expect(await call("sol", "read", { bot: "sol", path: "notes/sol.md" })).toEqual({ error: expect.stringMatching(/^refused: sol's memory needs the capability memory\.read/) });
      // Any bot's with memory.read, worker and own process (a removed bot's left folder too).
      for (const id of ["reader", "readerown"]) {
        expect(await call(id, "read", { bot: "sol", path: "notes/sol.md" })).toBe("Sol remembers the sun.");
        expect((await call<{ path: string }[]>(id, "list", { bot: "luna" })).length).toBeGreaterThanOrEqual(2);
        // Inside the memory folder only.
        expect(await call(id, "read", { bot: "sol", path: "../../../plugins/reader/clover.json" })).toEqual({ error: expect.any(String) });
        expect(await call(id, "list", { bot: "nobody" })).toEqual({ error: expect.stringMatching(/^not_found: no bot nobody/) });
      }
      // Without it, no other bot's.
      expect(await call("nosy", "list", { bot: "luna" })).toEqual({ error: expect.stringMatching(/needs the capability memory\.read/) });
      expect(await call("nosy", "read", { bot: "luna", path: "MEMORY.md" })).toEqual({ error: expect.stringMatching(/needs the capability memory\.read/) });
    } finally {
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
