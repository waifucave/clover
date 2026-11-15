// `clover plugin` as Clover's registry (clover-plugin-cli.ts): `new` writes a folder from each of the plugin SDK's
// templates that `clover plugin validate` passes as it is; `dev` sends the daemon an absolute folder that exists;
// `logs` and `list` read through the daemon; the Claude-plugin manager's old verbs say where they went. The command
// line itself runs as a process for `new`, `validate`, a moved verb, and `dev` with no Clover running.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry } from "@waifucave/clover-core";
import { PLUGIN_TEMPLATES } from "@waifucave/clover-plugin-sdk/templates";
import { CLAUDE_PLUGIN_VERBS, CLOVER_PLUGIN_VERBS, movedVerbHint, runPluginCommand, runPluginDev, runPluginList, runPluginLogs, runPluginNew } from "../src/clover-plugin-cli";

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
      if (template === "tool") {
        expect(v.plugin?.toolNames).toEqual(["mcp__my-tool__hello"]);
        expect(Object.keys(JSON.parse(readFileSync(join(folder, "clover.json"), "utf8")).contributes.mcpServers)).toEqual(["tools"]);
      }
      // Its code parses.
      for (const f of filesIn(folder).filter((f) => /\.(ts|tsx)$/.test(f))) {
        expect(() => new Bun.Transpiler({ loader: f.endsWith(".tsx") ? "tsx" : "ts", ...({ macro: false } as object) }).transformSync(readFileSync(join(folder, f), "utf8"))).not.toThrow();
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
    // The server is `tools`, never the id: the served key `<id>-tools` stays within 64 for the longest id (40).
    expect(Object.keys(mod.mcp)).toEqual(["tools"]);
    await mod.mcp.tools!(transport);
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

  test("refuses the ids Clover ships, ids out of the protocol's rule, and makes the longest id's tool server fit", async () => {
    const cwd = temp("clover-pnew-");
    for (const id of ["clover", "alpha"]) {
      expect(runPluginNew(["bot", id], cwd)).toMatchObject({ code: 2, output: expect.stringContaining("one of the plugins Clover ships") });
      expect(existsSync(join(cwd, id))).toBe(false);
    }
    for (const id of ["1abc", "a", "a--b", "a".repeat(41), "Caps", "a_b", "a.b"]) {
      expect({ id, code: runPluginNew(["bot", id], cwd).code }).toEqual({ id, code: 2 });
      expect(existsSync(join(cwd, id))).toBe(false);
    }
    // A case variant of a reserved id isn't an id at all; `x/..` names the folder `x` is in, here a taken one.
    expect(runPluginNew(["bot", "Clover"], cwd).code).toBe(2);
    mkdirSync(join(cwd, "parent", "x"), { recursive: true });
    expect(runPluginNew(["bot", "parent/x/.."], cwd)).toMatchObject({ code: 1, output: expect.stringContaining("isn't an empty folder") });
    const longest = `t${"o".repeat(39)}`;
    expect(runPluginNew(["tool", longest], cwd).code).toBe(0);
    const v = await registry.validatePluginFolder(join(cwd, longest), { os: "macos" });
    expect({ ok: v.ok, issues: v.issues }).toEqual({ ok: true, issues: [] });
    expect(`${longest}-tools`.length).toBeLessThanOrEqual(64);
  });

  test("--name loses control, format and line-separator characters, and can't be empty, too long or reserved", async () => {
    const cwd = temp("clover-pnew-");
    expect(runPluginNew(["tool", "named", "--name", "Ada\n// injected\u2028x\u0007\u200b  Lovelace\t"], cwd).code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, "named", "clover.json"), "utf8")) as { name: string };
    expect(manifest.name).toBe("Ada// injectedx Lovelace");
    // The name is in a line comment in the host code: it stays one line, and the code still parses and validates.
    const host = readFileSync(join(cwd, "named", "host", "index.ts"), "utf8");
    expect(host.split("\n")[0]).toBe("// Ada// injectedx Lovelace's host half: one MCP server, `tools`, served on the in-process transport Clover hands it. It speaks");
    const v = await registry.validatePluginFolder(join(cwd, "named"), { os: "macos" });
    expect({ ok: v.ok, issues: v.issues }).toEqual({ ok: true, issues: [] });
    for (const bad of ["\u0001\u0002", "x".repeat(81), "Clover", "Needs you"]) {
      expect(runPluginNew(["bot", "refused", "--name", bad], cwd).code).toBe(2);
      expect(existsSync(join(cwd, "refused"))).toBe(false);
    }
    expect(runPluginNew(["bot", "refused", "--name", "  "], cwd).code).toBe(2);
  });

  test("a write that fails part-way leaves nothing behind: the folder it made, or only its own entries in an empty one", () => {
    const cwd = temp("clover-pnew-");
    const failThird = () => {
      let n = 0;
      return (file: string, text: string) => {
        if (++n === 3) throw new Error("disk full");
        writeFileSync(file, text, { flag: "wx" });
      };
    };
    // A folder (and a parent) this run made: both go.
    const run = runPluginNew(["ui", "deep/made"], cwd, failThird());
    expect(run).toMatchObject({ code: 1, output: expect.stringContaining("disk full; nothing was left behind") });
    expect(existsSync(join(cwd, "deep"))).toBe(false);
    // An empty folder that was there: it stays, empty.
    mkdirSync(join(cwd, "there"));
    expect(runPluginNew(["ui", "there"], cwd, failThird()).code).toBe(1);
    expect(readdirSync(join(cwd, "there"))).toEqual([]);
    // A file that appears beside this run's before its write (wx refuses) isn't this run's, and stays.
    mkdirSync(join(cwd, "raced"));
    let n = 0;
    const raced = (file: string, text: string) => {
      if (++n === 3) writeFileSync(file, "theirs");
      writeFileSync(file, text, { flag: "wx" });
    };
    expect(runPluginNew(["ui", "raced"], cwd, raced).code).toBe(1);
    expect(filesIn(join(cwd, "raced")).map((f) => readFileSync(join(cwd, "raced", f), "utf8"))).toEqual(["theirs"]);
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

  test("the Claude-plugin manager's verbs that aren't Clover's own now say where they went", () => {
    for (const v of CLAUDE_PLUGIN_VERBS) {
      if ((CLOVER_PLUGIN_VERBS as readonly string[]).includes(v)) expect(movedVerbHint(v)).toBeUndefined();
      else expect(movedVerbHint(v)).toContain(`clover plugin claude ${v}`);
    }
    expect(movedVerbHint("uninstall")).toContain("clover plugin claude uninstall");
    expect(movedVerbHint("dev")).toBeUndefined();
  });
});

describe("clover plugin install, wrap, enable, remove, update, pin, index, info", () => {
  const io = (o: { yes?: boolean; cwd?: string } = {}) => {
    const asked: string[] = [];
    return { asked, io: { cwd: o.cwd ?? temp("clover-pcmd-"), confirm: async (q: string) => (asked.push(q), o.yes === true) } };
  };
  const found = { id: "tarot", state: "found" };

  test("install: a folder (absolute), an index id, npm with a version; each says its OK waits on a card", async () => {
    const d = daemon({ "plugin.install": found });
    const { io: i } = io();
    mkdirSync(join(i.cwd, "tarot"));
    expect((await runPluginCommand("install", ["./tarot"], d.call, i)).output).toContain("installed tarot: it waits for your OK on a card");
    await runPluginCommand("install", ["tarot-panel", "--index", "https://plugins.example.com/index.json"], d.call, i);
    await runPluginCommand("install", ["npm:@scope/clover-tarot@1.2.0"], d.call, i);
    await runPluginCommand("install", ["npm:clover-tarot", "--version", "2.0.0"], d.call, i);
    expect(d.calls.map((c) => c.params)).toEqual([
      { source: { from: "folder", path: join(i.cwd, "tarot") } },
      { source: { from: "index", id: "tarot-panel", index: "https://plugins.example.com/index.json" } },
      { source: { from: "npm", name: "@scope/clover-tarot", version: "1.2.0" } },
      { source: { from: "npm", name: "clover-tarot", version: "2.0.0" } },
    ]);
    expect((await runPluginCommand("install", [], d.call, i)).code).toBe(2);
  });

  test("wrap: a config from its file (each server's card), an address, a folder made absolute; a missing folder refused", async () => {
    const d = daemon({ "plugin.install": { id: "mcp-a", state: "found", more: [{ id: "mcp-b", state: "found" }] } });
    const { io: i } = io();
    writeFileSync(join(i.cwd, "mcp.json"), '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}');
    const r = await runPluginCommand("wrap", ["mcp-config", "mcp.json"], d.call, i);
    expect(r.output.split("\n")).toHaveLength(2);
    await runPluginCommand("wrap", ["mcp-url", "https://mcp.example.com/mcp"], d.call, i);
    mkdirSync(join(i.cwd, "skill"));
    await runPluginCommand("wrap", ["skill-folder", "skill"], d.call, i);
    expect(d.calls.map((c) => c.params)).toEqual([
      { source: { from: "wrap", kind: "mcp-config", value: '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}' } },
      { source: { from: "wrap", kind: "mcp-url", value: "https://mcp.example.com/mcp" } },
      { source: { from: "wrap", kind: "skill-folder", value: join(i.cwd, "skill") } },
    ]);
    expect((await runPluginCommand("wrap", ["agent-file", "nope.md"], d.call, i)).output).toContain("doesn't exist");
    expect((await runPluginCommand("wrap", ["zip", "x"], d.call, i)).code).toBe(2);
  });

  test("remove asks y/N with what it deletes; no means nothing removed; --yes doesn't ask", async () => {
    const d = daemon({ "plugin.get": { plugin: { name: "Tarot" } }, "plugin.remove": { ok: true } });
    const no = io();
    const r = await runPluginCommand("remove", ["tarot"], d.call, no.io);
    expect(r).toEqual({ code: 1, output: "tarot wasn't removed (answer y, or add --yes)" });
    expect(no.asked).toEqual(["Remove Tarot (tarot)? Its saved keys and settings on this computer are deleted. Its data is set aside. [y/N] "]);
    expect(d.calls.some((c) => c.method === "plugin.remove")).toBe(false);
    expect(await runPluginCommand("remove", ["tarot"], d.call, io({ yes: true }).io)).toEqual({ code: 0, output: "removed tarot" });
    const quiet = io();
    expect(await runPluginCommand("remove", ["tarot", "--yes"], d.call, quiet.io)).toEqual({ code: 0, output: "removed tarot" });
    expect(quiet.asked).toEqual([]);
    // The terminal's removal carries no card: the y/N is its question.
    expect(d.calls.filter((c) => c.method === "plugin.remove").map((c) => c.params)).toEqual([{ id: "tarot" }, { id: "tarot" }]);
    expect(await runPluginCommand("remove", ["tarot", "--delete-data", "--yes"], d.call, quiet.io)).toEqual({ code: 0, output: "removed tarot and its data" });
    expect(d.calls.filter((c) => c.method === "plugin.remove").at(-1)!.params).toEqual({ id: "tarot", deleteData: true });
  });

  test("enable, disable, restart, pin, unpin, update (all or one), index list/add/remove, info", async () => {
    const d = daemon({
      "plugin.setEnabled": { applied: true }, "plugin.restart": { ok: true }, "plugin.pin": { applied: true },
      "plugin.update": (p: unknown) => ((p as { id?: string }).id ? { updated: [{ id: "tarot", from: "1.0.0", to: "1.1.0" }] } : { updated: [], offered: [{ id: "luna", from: "1.0.0", to: "2.0.0", why: "it asks for your OK again: it adds notify" }] }),
      "plugin.index.list": { indexes: [{ url: "https://plugins.example.com/index.json", name: "Friends' plugins", lastCheckedAt: 1 }] },
      "plugin.index.add": { applied: true }, "plugin.index.remove": { ok: true },
      "plugin.get": { plugin: { id: "tarot", name: "Tarot", version: "1.0.0", state: "running", source: "index", enabled: true, pinned: false, capabilities: ["notify"], networkHosts: ["api.tarot.example"], manifest: { contributes: { mcpServers: { tarot: { type: "host", tools: { Draw: "preload" } } } } }, provenance: { by: "user-app", index: { url: "https://plugins.example.com/index.json" } } } },
      "plugin.settings.get": { settings: [{ key: "TAROT_KEY", type: "secret", set: true }, { key: "deck", type: "string", value: "rws" }] },
    });
    const { io: i } = io();
    expect((await runPluginCommand("enable", ["tarot"], d.call, i)).output).toBe("tarot is on");
    expect((await runPluginCommand("disable", ["tarot"], d.call, i)).output).toBe("tarot is off");
    expect((await runPluginCommand("restart", ["tarot"], d.call, i)).output).toBe("restarted tarot");
    expect((await runPluginCommand("pin", ["tarot"], d.call, i)).output).toBe("tarot stays at its version; no updates are offered for it");
    expect((await runPluginCommand("unpin", ["tarot"], d.call, i)).output).toBe("tarot is offered updates again");
    expect((await runPluginCommand("update", ["tarot"], d.call, i)).output).toBe("updated tarot 1.0.0 → 1.1.0");
    expect((await runPluginCommand("update", [], d.call, i)).output).toBe("luna 1.0.0 → 2.0.0 not applied: it asks for your OK again: it adds notify");
    expect((await runPluginCommand("index", ["list"], d.call, i)).output).toBe("https://plugins.example.com/index.json  Friends' plugins");
    // By URL alone: no key (indexes are unsigned, the owner's ruling, 2026-11-13).
    expect((await runPluginCommand("index", ["add", "https://x.example/index.json", "a".repeat(64)], d.call, i)).code).toBe(2);
    expect((await runPluginCommand("index", ["add", "https://x.example/index.json"], d.call, i)).output).toBe("added https://x.example/index.json: each plugin from it asks for your OK before it runs");
    await runPluginCommand("index", ["remove", "https://x.example/index.json"], d.call, i);
    const info = (await runPluginCommand("info", ["tarot"], d.call, i)).output;
    expect(info).toContain("Tarot (tarot) 1.0.0");
    expect(info).toContain("tools: Draw (servers: tarot)");
    expect(info).toContain("setting TAROT_KEY: a key is saved");
    expect(info).not.toContain("undefined");
    expect(d.calls.filter((c) => c.method.startsWith("plugin.index.") && c.method !== "plugin.index.list").map((c) => [c.method, c.params])).toEqual([
      ["plugin.index.add", { url: "https://x.example/index.json" }],
      ["plugin.index.remove", { url: "https://x.example/index.json" }],
    ]);
    // The terminal's update and removal carry no card (the rulings).
    expect(d.calls.filter((c) => c.method === "plugin.update").every((c) => !("card" in (c.params as object)))).toBe(true);
  });
});

describe("the command line", () => {
  const main = join(import.meta.dir, "../src/main.ts");
  const run = (args: string[], cwd: string, home: string) =>
    Bun.spawnSync({ cmd: [process.execPath, main, "plugin", ...args], cwd, env: { ...process.env, CLOVER_HOME: home, CLOVER_NO_AUTOLAUNCH: "1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });

  test("new, then validate, as a process; a moved verb; dev and install with no Clover running start nothing", () => {
    const cwd = temp("clover-pmain-");
    const home = temp("clover-pmain-home-");
    const made = run(["new", "bot", "ada"], cwd, home);
    expect(made.exitCode).toBe(0);
    expect(made.stdout.toString()).toContain("made ");
    const checked = run(["validate", "ada"], cwd, home);
    expect(checked.exitCode).toBe(0);
    const moved = run(["uninstall", "x"], cwd, home);
    expect(moved.exitCode).toBe(2);
    expect(moved.stderr.toString()).toContain("clover plugin claude uninstall");
    // Clover's own install, with no Clover running: says so, starts nothing.
    const install = run(["install", "x"], cwd, home);
    expect(install.exitCode).toBe(1);
    expect(install.stderr.toString()).toContain("Clover isn't running");
    const dev = run(["dev", "ada"], cwd, home);
    expect(dev.exitCode).toBe(1);
    expect(dev.stderr.toString()).toContain("Clover isn't running");
    expect(readdirSync(home).includes("run") ? readdirSync(join(home, "run")) : []).not.toContain("core.sock");
  }, 60_000);
});

describe("clover plugin review", () => {
  test("waits for the report and prints it; no model says what to set", async () => {
    const { runReview } = await import("../src/clover-plugin-cli");
    let n = 0;
    const call = async (_m: string, _p: unknown) => (++n < 2 ? { state: "running", pluginId: "tarot" } : { state: "done", pluginId: "tarot", report: "It draws cards.\nNothing odd found." });
    expect(await runReview(["card_abcdef"], call as never, { everyMs: 1 })).toEqual({ code: 0, output: "tarot:\nIt draws cards.\nNothing odd found." });
    const none = await runReview(["card_abcdef"], (async () => ({ state: "unavailable", pluginId: "tarot", why: "No model is set for reviews." })) as never);
    expect([none.code, none.output]).toEqual([1, "No model is set for reviews."]);
  });
});
