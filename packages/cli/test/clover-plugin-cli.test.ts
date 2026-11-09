// `clover plugin` as Clover's registry (clover-plugin-cli.ts): `new` writes a folder from each of the plugin SDK's
// templates that `clover plugin validate` passes as it is; `dev` sends the daemon an absolute folder that exists;
// `logs` and `list` read through the daemon; the Claude-plugin manager's old verbs say where they went. The command
// line itself runs as a process for `new`, `validate`, a moved verb, and `dev` with no Clover running.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "@waifucave/clover-core";
import { PLUGIN_TEMPLATES } from "@waifucave/clover-plugin-sdk/templates";
import { CLAUDE_PLUGIN_VERBS, movedVerbHint, runPluginDev, runPluginList, runPluginLogs, runPluginNew } from "../src/clover-plugin-cli";

const temp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A stand-in daemon: records each call, answers from `answers`, or rejects as the server would. */
function daemon(answers: Record<string, unknown | ((params: unknown) => unknown)> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    const a = answers[method];
    if (a === undefined) throw Object.assign(new Error(`${method} is not served`), { code: -32601 });
    return typeof a === "function" ? (a as (p: unknown) => unknown)(params) : a;
  };
  return { calls, call };
}

const filesIn = (dir: string, base = ""): string[] =>
  readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(dir, join(base, e.name)) : [join(base, e.name)])).sort();

describe("clover plugin new", () => {
  test("every template writes a plugin folder that validates with no finding, asks for nothing it doesn't need, and parses", async () => {
    expect(Object.keys(PLUGIN_TEMPLATES).sort()).toEqual(["bot", "model", "point", "theme", "tool", "trigger", "ui"]);
    for (const template of Object.keys(PLUGIN_TEMPLATES)) {
      const cwd = temp("clover-pnew-");
      const run = runPluginNew([template, `my-${template}`], cwd);
      expect(run.code).toBe(0);
      const folder = join(cwd, `my-${template}`);
      const v = await registry.validatePluginFolder(folder, { os: "macos" });
      expect({ template, ok: v.ok, issues: v.issues }).toEqual({ template, ok: true, issues: [] });
      expect(v.plugin?.id).toBe(`my-${template}`);
      // No capability, no project files; the network only where the template is a provider's endpoint.
      expect(v.plugin?.capabilities).toEqual([]);
      expect(v.plugin?.helperPermissions).toEqual([]);
      expect(v.plugin?.networkHosts).toEqual(template === "model" ? ["api.example.com"] : []);
      if (template === "tool") expect(v.plugin?.toolNames).toEqual(["mcp__my-tool__hello"]);
      // Its code parses.
      for (const f of filesIn(folder).filter((f) => /\.(ts|tsx)$/.test(f))) {
        expect(() => new Bun.Transpiler({ loader: f.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(readFileSync(join(folder, f), "utf8"))).not.toThrow();
      }
    }
  });

  test("the tool template's MCP server answers initialize, tools/list and tools/call", async () => {
    const cwd = temp("clover-pnew-");
    expect(runPluginNew(["tool", "greeter"], cwd).code).toBe(0);
    const mod = (await import(join(cwd, "greeter", "host", "index.ts"))) as { mcp: Record<string, (t: unknown) => Promise<void>> };
    const sent: Record<string, unknown>[] = [];
    const transport: { start(): Promise<void>; send(m: Record<string, unknown>): Promise<void>; close(): Promise<void>; onmessage?: (m: Record<string, unknown>) => void } = {
      start: async () => {}, close: async () => {}, send: async (m) => void sent.push(m),
    };
    await mod.mcp.greeter!(transport);
    transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    transport.onmessage!({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    transport.onmessage!({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hello", arguments: { name: "Ada" } } });
    transport.onmessage!({ jsonrpc: "2.0", method: "notifications/initialized" });
    await Bun.sleep(0);
    expect(sent.map((m) => m.id)).toEqual([1, 2, 3]);
    expect((sent[1]!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["hello"]);
    expect(sent[2]!.result).toEqual({ content: [{ type: "text", text: "Hello, Ada!" }] });
  });

  test("never writes over anything, and names its folder by a plugin id", () => {
    const cwd = temp("clover-pnew-");
    mkdirSync(join(cwd, "taken"));
    writeFileSync(join(cwd, "taken", "keep.txt"), "mine");
    expect(runPluginNew(["bot", "taken"], cwd)).toMatchObject({ code: 1, output: expect.stringContaining("isn't an empty folder") });
    expect(readFileSync(join(cwd, "taken", "keep.txt"), "utf8")).toBe("mine");
    writeFileSync(join(cwd, "afile"), "x");
    expect(runPluginNew(["bot", "afile"], cwd).code).toBe(1);
    expect(runPluginNew(["bot", "Not_An_Id"], cwd).code).toBe(2);
    expect(runPluginNew(["nope"], cwd)).toMatchObject({ code: 2, output: expect.stringContaining("no template") });
    expect(runPluginNew([], cwd)).toMatchObject({ code: 2, output: expect.stringContaining("templates:") });
    // An empty folder is fine, and the default folder is my-<template>; --name names it.
    mkdirSync(join(cwd, "empty"));
    expect(runPluginNew(["bot", "empty", "--name", "Ada"], cwd).code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "empty", "clover.json"), "utf8"))).toMatchObject({ id: "empty", name: "Ada" });
    expect(runPluginNew(["theme"], cwd).code).toBe(0);
    expect(readdirSync(join(cwd, "my-theme"))).toContain("theme.json");
  });
});

describe("clover plugin dev", () => {
  test("adds the folder by its absolute path, as `dev <folder>` and `dev add <folder>`", async () => {
    const cwd = temp("clover-pdev-");
    mkdirSync(join(cwd, "plug"));
    const d = daemon({ "plugin.dev.add": { applied: true } });
    expect(await runPluginDev(["plug"], d.call, cwd)).toMatchObject({ code: 0, output: expect.stringContaining("reloads on every change") });
    expect(await runPluginDev(["add", "./plug/../plug"], d.call, cwd)).toMatchObject({ code: 0 });
    expect(d.calls).toEqual([
      { method: "plugin.dev.add", params: { path: join(cwd, "plug") } },
      { method: "plugin.dev.add", params: { path: join(cwd, "plug") } },
    ]);
  });

  test("refuses a folder that doesn't exist, or a file, before asking the daemon", async () => {
    const cwd = temp("clover-pdev-");
    writeFileSync(join(cwd, "afile"), "x");
    const d = daemon({ "plugin.dev.add": { applied: true } });
    expect(await runPluginDev(["missing"], d.call, cwd)).toMatchObject({ code: 1, output: expect.stringContaining("doesn't exist") });
    expect(await runPluginDev(["afile"], d.call, cwd)).toMatchObject({ code: 1, output: expect.stringContaining("isn't a folder") });
    expect(d.calls).toEqual([]);
  });

  test("a symlink is passed as written (the daemon resolves and fences it), never followed here", async () => {
    const cwd = temp("clover-pdev-");
    mkdirSync(join(cwd, "real"));
    symlinkSync(join(cwd, "real"), join(cwd, "link"));
    const d = daemon({ "plugin.dev.add": { applied: true } });
    await runPluginDev(["link"], d.call, cwd);
    expect(d.calls[0]!.params).toEqual({ path: join(cwd, "link") });
  });

  test("a card, a refusal, list, remove and renew", async () => {
    const cwd = temp("clover-pdev-");
    mkdirSync(join(cwd, "plug"));
    const now = 1_800_000_000_000;
    const d = daemon({
      "plugin.dev.list": { folders: [{ path: join(cwd, "plug"), pluginId: "plug", addedAt: now - 1000, expiresAt: now + 5 * 3_600_000 }] },
      "plugin.dev.remove": { ok: true },
      "plugin.dev.renew": { expiresAt: now + 24 * 3_600_000 },
    });
    expect(await runPluginDev(["list"], d.call, cwd, now)).toEqual({ code: 0, output: `${join(cwd, "plug")}  plug  on for 5 more hours` });
    expect(await runPluginDev(["remove", "plug"], d.call, cwd, now)).toEqual({ code: 0, output: `removed ${join(cwd, "plug")} from development` });
    expect(await runPluginDev(["renew", "plug"], d.call, cwd, now)).toMatchObject({ code: 0, output: expect.stringContaining("on for 24 more hours") });
    const card = daemon({ "plugin.dev.add": { applied: false, card: "card_abcdef" } });
    expect(await runPluginDev(["plug"], card.call, cwd)).toMatchObject({ code: 0, output: expect.stringContaining("waits for your answer") });
    const refused = daemon({ "plugin.dev.add": () => { throw Object.assign(new Error("only the user can add a development folder"), { code: -32010 }); } });
    expect(await runPluginDev(["plug"], refused.call, cwd)).toMatchObject({ code: 1, output: expect.stringContaining("only the user") });
    expect((await runPluginDev([], d.call, cwd)).code).toBe(2);
  });
});

describe("clover plugin logs and list", () => {
  test("logs reads the plugin's log, with -n bounded as the method is", async () => {
    const d = daemon({ "plugin.logs": (p: unknown) => ({ lines: (p as { id: string }).id === "quiet" ? [] : ["one", "two"] }) });
    expect(await runPluginLogs(["clover/web", "-n", "50"], d.call)).toEqual({ code: 0, output: "one\ntwo" });
    expect(d.calls[0]).toEqual({ method: "plugin.logs", params: { id: "clover/web", lines: 50 } });
    expect(await runPluginLogs(["quiet"], d.call)).toEqual({ code: 0, output: "quiet has logged nothing" });
    expect((await runPluginLogs(["x", "-n", "0"], d.call)).code).toBe(2);
    expect((await runPluginLogs(["x", "-n", "5001"], d.call)).code).toBe(2);
    expect((await runPluginLogs([], d.call)).code).toBe(2);
  });

  test("list shows the registry's plugins", async () => {
    const d = daemon({ "plugin.list": { plugins: [
      { id: "clover", name: "Clover", version: "1.0.0", state: "active", enabled: true, source: "bundled", dev: false },
      { id: "mine", name: "Mine", version: "0.1.0", state: "found", enabled: false, source: "local", dev: true },
    ], adultConfirmed: false } });
    expect(await runPluginList([], d.call)).toEqual({ code: 0, output: "clover  1.0.0  active\nmine  0.1.0  off  (development folder)" });
    expect((await runPluginList(["--json"], d.call)).output).toContain('"id": "mine"');
  });

  test("the Claude-plugin manager's verbs say where they went", () => {
    for (const v of CLAUDE_PLUGIN_VERBS) expect(movedVerbHint(v)).toContain(`clover plugin claude ${v}`);
    expect(movedVerbHint("dev")).toBeUndefined();
  });
});

describe("the command line", () => {
  const main = join(import.meta.dir, "../src/main.ts");
  const run = (args: string[], cwd: string, home: string) =>
    Bun.spawnSync({ cmd: [process.execPath, main, "plugin", ...args], cwd, env: { ...process.env, CLOVER_HOME: home, CLOVER_NO_AUTOLAUNCH: "1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });

  test("new, then validate, as a process; a moved verb; dev with no Clover running starts nothing", () => {
    const cwd = temp("clover-pmain-");
    const home = temp("clover-pmain-home-");
    const made = run(["new", "bot", "ada"], cwd, home);
    expect(made.exitCode).toBe(0);
    expect(made.stdout.toString()).toContain("made ");
    const checked = run(["validate", "ada"], cwd, home);
    expect(checked.exitCode).toBe(0);
    const moved = run(["install", "x"], cwd, home);
    expect(moved.exitCode).toBe(2);
    expect(moved.stderr.toString()).toContain("clover plugin claude install");
    const dev = run(["dev", "ada"], cwd, home);
    expect(dev.exitCode).toBe(1);
    expect(dev.stderr.toString()).toContain("Clover isn't running");
    expect(readdirSync(home).includes("run") ? readdirSync(join(home, "run")) : []).not.toContain("core.sock");
  }, 60_000);
});
