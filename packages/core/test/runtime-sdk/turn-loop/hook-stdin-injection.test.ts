// A hook's stdin is its input as JSON: tool results, prompts, pasted text, a fetched page. It is data, never a script
// (the adversarial review of c88eeec11). A hook whose program read its stdin as a script would run whatever a web
// page put there, inside the plugin's fence, which for a wrapper the user brought has the whole network. These run the
// bots' real hook path (`pluginHooks` through `pluginHookSpawner`, the real Seatbelt door) on this Mac.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../../src/contracts/fakes/approval-broker";
import { FakeClock } from "../../../src/contracts/fakes/clock";
import { MemorySecretStore } from "../../../src/contracts/fakes/secret-store";
import { filePluginSettings, PluginSettings } from "../../../src/plugin-host/api/settings";
import { pluginRegistryMethods } from "../../../src/plugin-host/registry-methods";
import { openPluginRegistry } from "../../../src/registry/open";
import { ensurePluginRunFiles } from "../../../src/registry/plugin-run";
import { pluginHooks, type HookSession } from "../../../src/runtime-sdk/turn-loop/hooks";
import { hookArgv, pluginDataFolder, pluginHookSpawner } from "../../../src/runtime-sdk/turn-loop/plugin-hook-spawn";
import { darwinDescribe } from "../../helpers/darwin-only";

const caller: Caller = { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" };
const session: HookSession = { id: "b_luna", kind: "bot", caller, bot: "luna", computer: "Studio" };
const APP = { caller: { kind: "user", client: "app" } } as never;

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

/** An option value a shell would take apart if it were ever spliced into a script. */
const NASTY = `it's "eu" $(touch PWNED_OPT) \`touch PWNED_OPT2\` a  b * c\nsecond line; touch PWNED_OPT3`;

async function world() {
  // A home whose path has a `*` (a Clover home may hold no space: Bun's options can't carry one, `ensurePluginRunFiles`):
  // every path the hooks get must stay one word, unglobbed. A plugin folder with spaces is tried below (a dev folder).
  const home = temp("clover-hook*inj-");
  const userHome = join(home, "user");
  mkdirSync(userHome, { recursive: true });
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
  const methods = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, secrets });
  const settings = new PluginSettings({ registry: opened.registry, backend: filePluginSettings(home), secrets });
  const approve = async (id: string, card: string | undefined) => {
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    await new Promise<void>((resolve) => {
      const done = () => opened.registry.get(id)?.state !== "found";
      if (done()) return resolve();
      const off = opened.registry.watch(() => { if (done()) { off(); resolve(); } });
    });
  };
  const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: { userHome } };
  const skipped: string[] = [];
  const hooks = pluginHooks({
    registry: opened.registry,
    host: { invoke: (async () => { throw new Error("no handler hooks here"); }) as never },
    onSkipped: (s) => skipped.push(`${s.pluginId}/${s.hook}: ${s.reason}`),
    commandSpawner: pluginHookSpawner({ guard, pluginRoot: (id) => opened.registry.get(id)?.folder, settings }),
  });
  return { home, opened, methods, settings, approve, hooks, skipped };
}

/** A tool result carrying shell a web page could hold: `$(…)`, backticks, and a newline then a command. */
const hostileResult = (data: string) => `page text $(touch ${data}/PWNED1) and \`touch ${data}/PWNED2\`\ntouch ${data}/PWNED3; done`;

darwinDescribe("a hook's stdin is data, never a script (the real fenced door)", () => {
  test("a wrapped Claude Code plugin's PostToolUse hook: its own script runs and reads the input as data; nothing in the input or its option runs", async () => {
    const w = await world();
    try {
      const src = join(temp("clover-hookinj-src-"), "logger");
      mkdirSync(join(src, ".claude-plugin"), { recursive: true });
      mkdirSync(join(src, "hooks"), { recursive: true });
      writeFileSync(join(src, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "logger", userConfig: { region: { type: "string", title: "Region", default: NASTY } } }));
      writeFileSync(join(src, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "WebFetch", hooks: [
        { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/log.sh \"${user_config.region}\"" },
        // Unquoted, as Claude Code plugins often write them: the root and the option are each still one word.
        { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/count.sh ${user_config.region} '${CLAUDE_PLUGIN_ROOT}'" },
      ] }] } }));
      writeFileSync(join(src, "hooks", "count.sh"), "#!/bin/sh\nprintf '%s|%s|%s' \"$#\" \"$1\" \"$2\" > \"$CLAUDE_PLUGIN_DATA/count\"\n");
      chmodSync(join(src, "hooks", "count.sh"), 0o755);
      writeFileSync(join(src, "hooks", "log.sh"), [
        "#!/bin/sh",
        "cat > \"$CLAUDE_PLUGIN_DATA/seen.json\"",
        "printf '%s' \"$CLAUDE_PLUGIN_OPTION_REGION\" > \"$CLAUDE_PLUGIN_DATA/option-env\"",
        "printf '%s' \"$1\" > \"$CLAUDE_PLUGIN_DATA/option-arg\"",
        "echo ran > \"$CLAUDE_PLUGIN_DATA/ran\"",
        "",
      ].join("\n"));
      chmodSync(join(src, "hooks", "log.sh"), 0o755);
      const r = (await w.methods["plugin.install"]!({ source: { from: "wrap", kind: "claude-plugin", value: src } }, APP)) as { id: string; card?: string };
      await w.approve(r.id, r.card);
      const data = pluginDataFolder(w.home, r.id);
      mkdirSync(data, { recursive: true });
      const result = hostileResult(data);
      await w.hooks.toolAfter(session, { name: "WebFetch", callId: "c1" }, { url: "https://example.com" }, result);
      // Nothing from the input or the option ran.
      for (const m of ["PWNED1", "PWNED2", "PWNED3"]) expect(existsSync(join(data, m))).toBe(false);
      for (const m of ["PWNED_OPT", "PWNED_OPT2", "PWNED_OPT3"]) expect(existsSync(join(data, m)) || existsSync(join(w.opened.registry.get(r.id)!.folder, m))).toBe(false);
      // The plugin's own script ran, and read the input as data on its stdin.
      expect(w.skipped).toEqual([]);
      expect(readFileSync(join(data, "ran"), "utf8")).toBe("ran\n");
      const seen = JSON.parse(readFileSync(join(data, "seen.json"), "utf8")) as { tool_response?: unknown; result?: unknown };
      expect(JSON.stringify(seen)).toContain("$(touch");
      expect(JSON.stringify(seen)).toContain("`touch");
      // The option reached it whole, in its environment and as its argument, never parsed.
      expect(readFileSync(join(data, "option-env"), "utf8")).toBe(NASTY);
      expect(readFileSync(join(data, "option-arg"), "utf8")).toBe(NASTY);
      const folder = w.opened.registry.get(r.id)!.folder;
      expect(folder).toContain("*");
      expect(readFileSync(join(data, "count"), "utf8")).toBe(`2|${NASTY}|${folder}`);
    } finally {
      w.opened.close();
    }
  }, 60_000);

  test("a native hook with `args`: the program runs with them, each placeholder filled whole, no shell between; the input stays on stdin", async () => {
    const w = await world();
    try {
      const root = join(w.home, "plugins", "native");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "clover.json"), JSON.stringify({
        manifest: 1, id: "native", name: "Native", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
        settings: { label: { type: "string", title: "Label", default: NASTY } },
        contributes: { hooks: [
          { id: "log", on: ["tool.after"], tools: ["WebFetch"], command: "${plugin}/log.sh", args: ["${setting:label}", "${data}"] },
          // No `args`: a shell line whose placeholders are unquoted; each is still one word, never split or globbed.
          { id: "line", on: ["tool.after"], tools: ["WebFetch"], command: "${plugin}/count.sh ${setting:label} ${data}" },
        ] },
      }));
      writeFileSync(join(root, "count.sh"), "#!/bin/sh\nprintf '%s|%s' \"$#\" \"$1\" > \"$2/count\"\n");
      chmodSync(join(root, "count.sh"), 0o755);
      writeFileSync(join(root, "log.sh"), "#!/bin/sh\ncat > \"$2/seen.json\"\nprintf '%s' \"$1\" > \"$2/arg1\"\necho ran > \"$2/ran\"\n");
      chmodSync(join(root, "log.sh"), 0o755);
      await w.opened.folders.scan();
      const { card } = await w.opened.registry.installed("native", "app");
      await w.approve("native", card);
      const data = pluginDataFolder(w.home, "native");
      mkdirSync(data, { recursive: true });
      await w.hooks.toolAfter(session, { name: "WebFetch", callId: "c1" }, {}, hostileResult(data));
      expect(w.skipped).toEqual([]);
      expect(readFileSync(join(data, "ran"), "utf8")).toBe("ran\n");
      expect(readFileSync(join(data, "arg1"), "utf8")).toBe(NASTY);
      expect(readFileSync(join(data, "count"), "utf8")).toBe(`2|${NASTY}`);
      expect(readFileSync(join(data, "seen.json"), "utf8")).toContain("$(touch");
      for (const m of ["PWNED1", "PWNED2", "PWNED3", "PWNED_OPT", "PWNED_OPT2", "PWNED_OPT3"]) expect(existsSync(join(data, m)) || existsSync(join(root, m))).toBe(false);
    } finally {
      w.opened.close();
    }
  }, 60_000);

  test("a bare interpreter as a hook's whole command is refused before it runs: it would take its stdin as a script", async () => {
    const w = await world();
    try {
      const root = join(w.home, "plugins", "bare");
      mkdirSync(root, { recursive: true });
      // Written past validation (as an older core might have kept it): the door still refuses it.
      writeFileSync(join(root, "clover.json"), JSON.stringify({
        manifest: 1, id: "bare", name: "Bare", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
        contributes: { hooks: [{ id: "sh", on: ["tool.after"], command: "sh" }] },
      }));
      await w.opened.folders.scan();
      // Validation refuses it: the plugin is invalid, so its hook never runs.
      const rec = w.opened.registry.get("bare");
      expect(rec?.issues.some((i) => i.code === "hook_reads_stdin")).toBe(true);
      const data = pluginDataFolder(w.home, "bare");
      mkdirSync(data, { recursive: true });
      await w.hooks.toolAfter(session, { name: "WebFetch", callId: "c1" }, {}, hostileResult(data));
      for (const m of ["PWNED1", "PWNED2", "PWNED3"]) expect(existsSync(join(data, m))).toBe(false);
    } finally {
      w.opened.close();
    }
  }, 60_000);
});

darwinDescribe("a plugin folder with spaces and a `*` (a development folder can be anywhere)", () => {
  test("an unquoted ${plugin} and ${setting:…} in a shell line each stay one word", async () => {
    const base = temp("clover-hookspace-");
    const home = join(base, "clover");
    const root = join(base, "my plugins *", "dev kit");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(root, "count.sh"), "#!/bin/sh\nprintf '%s|%s|%s' \"$#\" \"$1\" \"$2\" > \"$CLOVER_PLUGIN_DATA/count\"\n");
    chmodSync(join(root, "count.sh"), 0o755);
    const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: { userHome: join(base, "user") } };
    mkdirSync(join(base, "user"), { recursive: true });
    const settings = { fields: () => [["label", { type: "string" }]] as never, get: () => "a  b * c" } as never;
    const door = pluginHookSpawner({ guard, pluginRoot: () => root, settings });
    const r = await door.run({ command: "${plugin}/count.sh ${setting:label} ${plugin}", cwd: "/ignored", env: { PATH: "/usr/bin:/bin" }, stdin: "{}", timeoutMs: 20_000, who: { caller, hook: "h", pluginId: "devkit" } });
    expect(r.kind).toBe("exited");
    expect((r as { code: number }).code).toBe(0);
    expect(readFileSync(join(pluginDataFolder(home, "devkit"), "count"), "utf8")).toBe(`2|a  b * c|${root}`);
  }, 60_000);
});

describe("placeholders", () => {
  test("NASTY holds every shell metacharacter the tests rely on", () => {
    for (const c of ["'", "\"", "$(", "`", "\n", ";", " ", "*"]) expect(NASTY).toContain(c);
  });
  test("a shell line's placeholder becomes a quoted reference for where it sits: none, double or single quotes", () => {
    const fill = { plugin: "/p q", data: "/d", setting: (k: string) => (k === "x" ? "v" : undefined) };
    expect(hookArgv({ command: "${plugin}/a.sh ${setting:x}" }, fill, "sh")).toEqual({ line: '"${CLOVER_PLUGIN_ROOT}"/a.sh "${CLOVER_SETTING_x}"', env: { CLOVER_PLUGIN_ROOT: "/p q", CLOVER_SETTING_x: "v" } });
    expect(hookArgv({ command: "\"${plugin}/a.sh\" '${data}' 'it''s ${data}'" }, fill, "sh").line).toBe(`"\${CLOVER_PLUGIN_ROOT}/a.sh" ''"\${CLOVER_PLUGIN_DATA}"'' 'it''s '"\${CLOVER_PLUGIN_DATA}"''`);
    expect(hookArgv({ command: "echo \\\" ${data}" }, fill, "sh").line).toBe('echo \\" "${CLOVER_PLUGIN_DATA}"');
    expect(hookArgv({ command: "${plugin}\\x.cmd" }, fill, "cmd").line).toBe("%CLOVER_PLUGIN_ROOT%\\x.cmd");
    expect(hookArgv({ command: "${plugin}/a", args: ["${setting:x}"] }, fill, "sh")).toEqual({ argv: ["/p q/a", "v"], env: {} });
    expect(() => hookArgv({ command: "sh" }, fill, "sh")).toThrow("never a script");
  });
});
