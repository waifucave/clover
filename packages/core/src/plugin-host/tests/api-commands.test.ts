// `commands.run` in a real plugin host (a worker of the shared process and a process of the plugin's own): a plugin runs
// its own tree's commands with no capability, and another plugin's with `call:<its id>`; without it, refused; the
// command's args are checked against its schema before its handler runs, and its handler is told who called. Temp home,
// the fake approval broker and an in-memory secret store; nothing opens a window.
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
const tried = async (f) => { try { return await f(); } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; } };
export const run = async (args, ctx) => tried(() => ctx.api.commands.run(args.name, args.args));
export const echo = async (args, ctx) => ({ said: args.text, by: ctx.caller.kind === "plugin" ? ctx.caller.pluginId : ctx.caller.kind });
`;

function plugin(home: string, id: string, o: { process?: "own"; capabilities: string[]; commands?: unknown[] }): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", ...(o.process === undefined ? {} : { process: o.process }) }, capabilities: o.capabilities,
    ...(o.commands === undefined ? {} : { contributes: { commands: o.commands } }),
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

describe("commands.run in a real plugin host", () => {
  test("its own tree's commands with no capability; another plugin's with call:<id>; without it, refused; args checked first", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-commands-")));
    temps.push(home);
    const echo = { name: "echo", description: "Says it back", handler: "echo", args: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
    plugin(home, "tools", { capabilities: [], commands: [echo] });
    plugin(home, "caller", { capabilities: ["call:tools"] });
    plugin(home, "callerown", { process: "own", capabilities: ["call:tools"] });
    plugin(home, "nocap", { process: "own", capabilities: [] });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    try {
      for (const id of ["tools", "caller", "callerown", "nocap"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      }
      expect(opened.folders.okText("caller", "macos").lines).toContain("It runs commands of tools.");
      const call = <R>(id: string, handler: string, args: unknown = null) => ph.host.invoke<R>({ pluginId: id, handler, args, caller: USER });
      // Its own command, no capability; the handler hears it was called by the plugin.
      expect(await call("tools", "run", { name: "tools.echo", args: { text: "hi" } })).toEqual({ said: "hi", by: "tools" });
      // Another plugin's, with call:tools, worker and own process; the handler hears which plugin.
      for (const id of ["caller", "callerown"]) {
        expect(await call(id, "run", { name: "tools.echo", args: { text: id } })).toEqual({ said: id, by: id });
        // Args that don't fit its schema never reach the handler.
        expect(await call(id, "run", { name: "tools.echo", args: { text: 3 } })).toEqual({ error: expect.stringMatching(/^invalid_args: tools\.echo: args at \/text fail "type"/) });
        expect(await call(id, "run", { name: "tools.nothere", args: {} })).toEqual({ error: expect.stringMatching(/^not_installed: no command tools\.nothere/) });
      }
      // Without call:tools, refused.
      expect(await call("nocap", "run", { name: "tools.echo", args: { text: "x" } })).toEqual({ error: expect.stringMatching(/call:tools/) });
    } finally {
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
