// What Clover places in Claude Code (spec §9.3): the plugins' skills, agent definitions and command hooks, as one
// local Claude Code plugin per session in the fenced run folder, with every hook run through the shim that drops an
// allow. Whether Claude Code itself loads them through the adapter is a live gate; these check what Clover writes.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_SHIM_PATH, dropAllow, hookShimCommand, parseShimArgs, runHook } from "../claude-code/hook-shim";
import { CLAUDE_PLUGIN_FOLDER, MAX_HOOK_TIMEOUT_MS, matcherOf, placeInClaudeCode, shellQuote } from "../claude-code/placement";
import type { PluginParts } from "../placement";
import { waitFor, World } from "./world";

setDefaultTimeout(60_000);
const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-cc-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

function parts(): PluginParts {
  const skill = join(root, "src-skill");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: pdf\ndescription: Read PDFs\n---\nUse the script.\n");
  writeFileSync(join(skill, "scripts", "read.py"), "print('pdf')\n");
  const noSkill = join(root, "not-a-skill");
  mkdirSync(noSkill, { recursive: true });
  return {
    skills: [{ name: "pdf", pluginId: "acme/docs", dir: skill }, { name: "broken", pluginId: "acme/docs", dir: noSkill }],
    agents: [{ name: "reviewer", pluginId: "acme/docs", markdown: "---\nname: reviewer\ndescription: Reviews diffs\n---\nReview it.\n" }],
    hooks: [
      { id: "guard", pluginId: "acme/guard", on: ["tool.before"], tools: ["Bash", "mcp__*"], command: "/opt/acme/guard", args: ["--strict", "it's"], timeoutMs: 3_000 },
      { id: "after", pluginId: "acme/guard", on: ["compact.after", "turn.end"], command: "/opt/acme/note" },
      { id: "out", pluginId: "acme/guard", on: ["message.out"], command: "/opt/acme/out" },
    ],
  };
}

describe("placing plugins' parts in Claude Code", () => {
  test("skills, agents and hooks become one local Claude Code plugin, every hook through the shim", () => {
    const dir = join(root, "setup-1");
    const r = placeInClaudeCode(parts(), { dir, shim: { command: "/opt/clover/clover-core", args: ["hook-shim"] } });
    const plugin = join(dir, CLAUDE_PLUGIN_FOLDER);
    expect(r.meta).toEqual({ claudeCode: { options: { plugins: [{ type: "local", path: plugin }] } } });
    expect(r.placed).toEqual({ skills: ["pdf"], agents: ["reviewer"], hooks: ["guard", "after"], skipped: [{ id: "broken", why: "no SKILL.md" }, { id: "out", why: "none of its events has a Claude Code hook" }] });
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("clover");
    expect(readFileSync(join(plugin, "skills", "pdf", "scripts", "read.py"), "utf8")).toContain("pdf");
    expect(readFileSync(join(plugin, "agents", "reviewer.md"), "utf8")).toContain("Reviews diffs");
    const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionStart", "Stop"]);
    expect(hooks.PreToolUse[0].matcher).toBe("^Bash$|^mcp__.*$");
    expect(hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: "/opt/clover/clover-core hook-shim --timeout 3000 -- /opt/acme/guard --strict 'it'\\''s'", timeout: 8 });
    expect(hooks.SessionStart[0].matcher).toBe("compact");
  });

  test("a hook whose command isn't an absolute path is skipped, and a timeout is capped (K-M2 review 9)", () => {
    const dir = join(root, "setup-9");
    const r = placeInClaudeCode({ skills: [], agents: [], hooks: [
      { id: "rel", pluginId: "acme/guard", on: ["tool.before"], command: "guard" },
      { id: "long", pluginId: "acme/guard", on: ["tool.before"], command: "/opt/acme/guard", timeoutMs: 10 * 60_000 },
    ] }, { dir, shim: { command: "/opt/clover/clover-core", args: ["hook-shim"] } });
    expect(r.placed.skipped).toEqual([{ id: "rel", why: "its command isn't an absolute path" }]);
    const hooks = JSON.parse(readFileSync(join(dir, CLAUDE_PLUGIN_FOLDER, "hooks", "hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse[0].hooks[0].command).toContain(`--timeout ${MAX_HOOK_TIMEOUT_MS} --`);
  });

  test("matchers and shell quoting", () => {
    expect(matcherOf(undefined)).toBeUndefined();
    expect(matcherOf(["*"])).toBeUndefined();
    expect(matcherOf(["Edit", "Write"])).toBe("^Edit$|^Write$");
    expect(shellQuote("/plain/path")).toBe("/plain/path");
    expect(shellQuote("a b")).toBe("'a b'");
  });
});

describe("the hook shim", () => {
  test("an allow is dropped; deny, ask and a replaced input pass", () => {
    const allow = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "trusted" } };
    expect(JSON.parse(dropAllow(JSON.stringify(allow)))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    expect(JSON.parse(dropAllow(JSON.stringify({ decision: "approve", reason: "ok", continue: true })))).toEqual({ continue: true });
    const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } };
    expect(JSON.parse(dropAllow(JSON.stringify(deny)))).toEqual(deny);
    const ask = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", updatedInput: { command: "ls" } } };
    expect(JSON.parse(dropAllow(JSON.stringify(ask)))).toEqual(ask);
    expect(dropAllow("plain text context")).toBe("plain text context");
    // Fail closed (K-M2 review 3): an allow followed by trailing text, a second object, a top-level array, a
    // permission request's allow and keys nobody listed are all dropped.
    const allowJson = JSON.stringify(allow);
    expect(dropAllow(`${allowJson} and more`)).toBe("");
    expect(dropAllow(`${allowJson}\n${allowJson}`)).toBe("");
    expect(dropAllow(`[${allowJson}]`)).toBe("");
    expect(JSON.parse(dropAllow(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })))).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest" } });
    expect(JSON.parse(dropAllow(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } })))).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });
    expect(dropAllow(JSON.stringify({ permissionDecision: "allow", whatever: 1 }))).toBe("");
    expect(parseShimArgs(["--timeout", "500", "--", "/bin/x", "a"])).toEqual({ timeoutMs: 500, command: "/bin/x", args: ["a"] });
    expect(parseShimArgs(["--", "/bin/x"])!.timeoutMs).toBe(10_000);
    expect(parseShimArgs(["nothing"])).toBeNull();
  });

  test("a block (exit 2) passes with its reason; a failing, missing or slow hook is skipped", async () => {
    const block = await runHook("/bin/sh", ["-c", "cat >/dev/null; echo 'not that file' >&2; exit 2"], "{}");
    expect(block).toMatchObject({ code: 2, stderr: "not that file\n" });
    expect((await runHook("/bin/sh", ["-c", "exit 1"], "{}")).code).toBe(0);
    expect((await runHook("/no/such/hook", [], "{}")).stderr).toContain("didn't start");
    const slow = await runHook("/bin/sh", ["-c", "sleep 5"], "{}", 200);
    expect(slow).toMatchObject({ code: 0, stdout: "" });
    expect(slow.stderr).toContain("ran past 200 ms");
  });

  test.skipIf(process.platform === "win32")("a hook's timeout ends what it started too (K-M2 review 8)", async () => {
    const pidFile = join(root, "grandchild.pid");
    await runHook("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], "{}", 300);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((r) => setTimeout(r, 200));
    const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    expect(alive).toBe(false);
  });

  test("as a process: Claude Code's input reaches the hook on stdin, and an allow never comes back", async () => {
    const hook = join(root, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\nread -r line\ncase "$line" in *rm*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}';; *) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}';; esac\n`, { mode: 0o755 });
    const run = (input: string) => new Promise<string>((resolve) => {
      const c = spawn(hookShimCommand().command, [...hookShimCommand().args, "--timeout", "5000", "--", hook], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", (x: string) => (out += x));
      c.on("close", () => resolve(out));
      c.stdin.end(`${input}\n`);
    });
    expect(hookShimCommand().args).toEqual([HOOK_SHIM_PATH]);
    expect(JSON.parse(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }))).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.parse(await run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))).hookSpecificOutput.permissionDecision).toBeUndefined();
  });
});

describe("a delegation to a backend that places parts", () => {
  test("the plugin folder is written in the fenced run folder, handed over at session/new, and removed at the end", async () => {
    const p = parts();
    const w = (world = new World({
      script: [[{ wait: true }]],
      pluginParts: { parts: async () => p },
      place: (pp, ctx) => placeInClaudeCode(pp, { dir: ctx.dir, shim: hookShimCommand() }),
    }));
    const r = await w.delegate();
    await waitFor(() => w.report("blocked").length > 0, "the agent to block");
    const plugin = join(w.cloverHome, "run", "agents", r.sessionId, CLAUDE_PLUGIN_FOLDER);
    expect(existsSync(join(plugin, "skills", "pdf", "SKILL.md"))).toBe(true);
    // The sandbox writer's _meta and the placement's are merged.
    expect(w.report("session")[0]!["meta"]).toMatchObject({ claudeCode: { options: { plugins: [{ type: "local", path: plugin }] } }, fakeSandbox: {} });
    expect(w.fence.touches([plugin])?.kind).toBe("run-folder");
    await w.manager.stop(r.sessionId, { bot: "alpha" });
    expect(existsSync(plugin)).toBe(false);
  });
});
