// `routines.*` in a real plugin host (a worker of the shared process and a process of the plugin's own) over lane D's
// real routine engine (its routine files and its kept runs): a bot plugin lists its own bot's routines and reads their
// runs with no capability; with `routines.read` every bot's; without it, no other bot's. Read-only. Temp home, the fake
// approval broker, an in-memory secret store and a stand-in for the bot side's side threads; nothing opens a window.
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
import { RoutineEngine, routineFilePath } from "../../routines/engine";
import type { BotSide } from "../../bots/wiring";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const list = async (args, ctx) => tried(() => ctx.api.routines.list(args));
export const runs = async (args, ctx) => tried(() => ctx.api.routines.runs(args.id, args.page));
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

describe("routines.* in a real plugin host", () => {
  test("a bot plugin sees its own bot's routines and runs with no capability; routines.read sees every bot's; nothing else", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-routines-")));
    temps.push(home);
    for (const bot of ["luna", "sol", "gone"]) {
      const path = routineFilePath(home, bot, "brief");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `---\nname: ${bot} brief\ntriggers:\n  - schedule: "0 8 * * *"\n---\nDo the thing.\n`);
    }
    const engine = new RoutineEngine({
      home, computer: "Studio", clock: new FakeClock({ start: Date.UTC(2026, 10, 12, 6) }), computerLevel: () => "ask-risky", watchFiles: false, userTimeZone: () => "UTC",
      bots: {
        has: (id) => id === "luna" || id === "sol", // "gone" was removed: its routine is `bot-removed`
        runSideThread: async (_bot, run) => {
          run.onSession?.(`s_${run.routine}`);
          return { routine: run.routine, session: `s_${run.routine}`, startedAt: 1, endedAt: 2, outcome: "done", summary: "Done." };
        },
      },
    });
    await engine.start();
    const idOf = (bot: string) => engine.list(bot)[0]!.id;
    await engine.runNow(idOf("luna"));
    await engine.runNow(idOf("sol"));
    for (let i = 0; i < 100 && (engine.runs(idOf("luna")).runs.length === 0 || engine.runs(idOf("sol")).runs.length === 0); i++) await Bun.sleep(10);
    plugin(home, "luna", { capabilities: [] });
    plugin(home, "gone", { capabilities: [] });
    plugin(home, "planner", { capabilities: ["routines.read"] });
    plugin(home, "plannerown", { process: "own", capabilities: ["routines.read"] });
    plugin(home, "nosy", { process: "own", capabilities: [] });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({
      home, computer: "Studio", registry: opened.registry, secrets, fence: false,
      areas: { bots: () => ({ routines: engine, bots: { has: (id: string) => id === "luna" || id === "sol" } }) as unknown as BotSide, node: () => undefined, links: () => undefined },
    });
    try {
      for (const id of ["luna", "gone", "planner", "plannerown", "nosy"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      expect(opened.folders.okText("planner", "macos").lines).toContain("It sees your routines and their runs.");
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER });
      // Its own bot's, with no capability: whatever it asks, only its own bot's.
      expect((await call<{ bot: string }[]>("luna", "list", {})).map((r) => r.bot)).toEqual(["luna"]);
      expect((await call<{ runs: { outcome: string }[] }>("luna", "runs", { id: idOf("luna") })).runs.map((r) => r.outcome)).toEqual(["done"]);
      expect(await call("luna", "list", { bot: "sol" })).toEqual({ error: expect.stringMatching(/^refused: sol's routines need the capability routines\.read/) });
      expect(await call("luna", "runs", { id: idOf("sol") })).toEqual({ error: expect.stringMatching(/^refused: sol's routines need the capability routines\.read/) });
      // A removed bot's routine (`bot-removed`) isn't the own bot's of a plugin that later takes its id.
      expect(engine.list("gone")[0]!.state).toBe("bot-removed");
      expect(await call("gone", "list", {})).toEqual([]);
      expect(await call("gone", "list", { bot: "gone" })).toEqual({ error: expect.stringMatching(/^refused: gone's routines need the capability routines\.read/) });
      expect(await call("gone", "runs", { id: idOf("gone") })).toEqual({ error: expect.stringMatching(/^refused: gone's routines need the capability routines\.read/) });
      // Every bot's with routines.read, worker and own process.
      for (const id of ["planner", "plannerown"]) {
        expect((await call<{ bot: string }[]>(id, "list", {})).map((r) => r.bot).sort()).toEqual(["gone", "luna", "sol"]);
        expect((await call<{ bot: string }[]>(id, "list", { bot: "sol" })).map((r) => r.bot)).toEqual(["sol"]);
        const page = await call<{ runs: unknown[] }>(id, "runs", { id: idOf("sol"), page: { limit: 1 } });
        expect(page.runs).toHaveLength(1);
        expect(await call(id, "runs", { id: "r_nothere" })).toEqual({ error: expect.stringMatching(/^not_found: no routine r_nothere/) });
      }
      // Without it, a plugin that isn't a bot's sees no bot's routines.
      expect(await call("nosy", "list", {})).toEqual([]);
      expect(await call("nosy", "list", { bot: "luna" })).toEqual({ error: expect.stringMatching(/need the capability routines\.read/) });
      expect(await call("nosy", "runs", { id: idOf("luna") })).toEqual({ error: expect.stringMatching(/need the capability routines\.read/) });
    } finally {
      await ph.close();
      opened.close();
      engine.stop();
    }
  }, 90_000);
});
