// `usage.*` in a real plugin host (a worker of the shared process and a process of the plugin's own) over lane D's real
// usage ledger: with `usage.read` a plugin reads the rows, their summary and the plan readings, and hears when rows are
// added; without it the calls don't exist for it. Read-only: nothing it can call writes. Temp home, the fake approval
// broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller, PlanReading } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { UsageLedger } from "../../usage/ledger";
import { startPluginHost } from "../daemon-host";
import { areasParts, USAGE_WATCHES_PER_PLUGIN } from "../api/areas";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

const HOST_JS = `
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const rows = async (args, ctx) => tried(() => ctx.api.usage.rows(args));
export const summary = async (args, ctx) => tried(() => ctx.api.usage.summary(args));
export const plans = async (args, ctx) => tried(() => ctx.api.usage.plans());
export const has = async (args, ctx) => ({ usage: "usage" in ctx.api, write: ctx.api.usage !== undefined && "add" in ctx.api.usage });
let heard = [];
let off;
export const watch = async (args, ctx) => { heard = []; off = ctx.api.usage.watch((since) => heard.push(since)); return true; };
export const heardSince = async () => heard;
export const unwatch = async () => { off?.(); return true; };
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

describe("usage.* in a real plugin host", () => {
  test("with usage.read a plugin reads rows, summary and plans and hears new rows, worker and own process alike; without it, nothing", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-usage-")));
    temps.push(home);
    plugin(home, "meter", { capabilities: ["usage.read"] });
    plugin(home, "meterown", { process: "own", capabilities: ["usage.read"] });
    plugin(home, "plain", { capabilities: [] });
    const ledger = new UsageLedger({ path: join(home, "usage.db"), computer: "Studio", timeZone: "UTC" });
    const t0 = Date.UTC(2026, 10, 12, 10);
    ledger.add([
      { dedupe: "s1:1", source: "clover", at: t0, provider: "anthropic", model: "m1", bot: "alpha", session: "s1", inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      { dedupe: "s2:1", source: "clover", at: t0 + 1000, provider: "openai", model: "m2", bot: "luna", session: "s2", inputTokens: 50, outputTokens: 5 },
    ]);
    const plan: PlanReading = { source: "codex", computer: "Studio", plan: "plus", window: "5h", usedPercent: 42, readAt: t0 } as PlanReading;
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({
      home, computer: "Studio", registry: opened.registry, secrets, fence: false,
      areas: { bots: () => undefined, node: () => undefined, links: () => undefined, usage: () => ({ ledger, plans: async () => [plan] }) },
    });
    try {
      for (const id of ["meter", "meterown", "plain"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      expect(opened.folders.okText("meter", "macos").lines).toContain("It sees your usage and plan readings.");
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER });
      for (const id of ["meter", "meterown"]) {
        const all = await call<{ rows: { bot?: string; inputTokens: number }[] }>(id, "rows", { since: 0, until: t0 + 2000 });
        expect(all.rows.map((r) => r.bot)).toEqual(["alpha", "luna"]);
        expect((await call<{ rows: unknown[] }>(id, "rows", { since: 0, until: t0 + 2000, bot: "luna" })).rows).toHaveLength(1);
        expect(await call(id, "summary", { from: 0, to: t0 + 2000, groupBy: "bot" })).toEqual([
          expect.objectContaining({ key: "alpha", inputTokens: 100, outputTokens: 20 }),
          expect.objectContaining({ key: "luna", inputTokens: 50, outputTokens: 5 }),
        ]);
        expect(await call(id, "plans")).toEqual([plan]);
        expect(await call(id, "rows", { since: "yesterday" })).toEqual({ error: expect.stringMatching(/^invalid: usage\.rows takes/) });
        expect(await call(id, "rows", { since: 0, limit: 5000 })).toEqual({ error: expect.stringMatching(/^invalid: usage\.rows takes a limit of at most 1000/) });
        // Read-only: the area has nothing that writes.
        expect(await call(id, "has")).toEqual({ usage: true, write: false });
        // A row added: the watch hears from when.
        await call(id, "watch");
        // The watch is open once the core has it (a moment after the call answers in the host).
        await Bun.sleep(300);
        ledger.add([{ dedupe: `${id}:new`, source: "clover", at: t0 + 5000, bot: "alpha", inputTokens: 1, outputTokens: 1 }]);
        let heard: number[] = [];
        for (let i = 0; i < 150 && heard.length === 0; i++) { await Bun.sleep(20); heard = await call<number[]>(id, "heardSince"); }
        expect(heard).toEqual([t0 + 5000]);
        await call(id, "unwatch");
      }
      // Without usage.read the calls don't exist for the plugin.
      expect(await call("plain", "rows", { since: 0 })).toEqual({ error: expect.stringMatching(/usage\.read/) });
      expect(await call("plain", "plans")).toEqual({ error: expect.stringMatching(/usage\.read/) });
    } finally {
      await ph.close();
      opened.close();
      ledger.close();
    }
  }, 90_000);
});

describe("usage.* limits", () => {
  test("a plugin holds at most 8 usage watches", () => {
    const ledger = { rows: () => ({ rows: [] }), summary: () => [], watch: () => () => {} };
    const { handlers } = areasParts({ bots: () => undefined, node: () => undefined, links: () => undefined, usage: () => ({ ledger }) });
    const ctx = { pluginId: "meter", process: "shared", caller: { kind: "plugin", pluginId: "meter" }, record: { granted: ["usage.read"] }, path: "usage.watch" } as never;
    const offs = Array.from({ length: USAGE_WATCHES_PER_PLUGIN }, () => handlers["usage.watch"]!(ctx, [() => {}]) as () => void);
    expect(() => handlers["usage.watch"]!(ctx, [() => {}])).toThrow(`meter has ${USAGE_WATCHES_PER_PLUGIN} usage watches open`);
    offs[0]!();
    expect(typeof handlers["usage.watch"]!(ctx, [() => {}])).toBe("function");
  });
});
