// Phase 8c Lane 3, Tasks 3.2/3.3 — proves the ASSEMBLED `sessionHooksFor(...).clover` (not just its
// individual callbacks, already covered unit-level in `hooks.test.ts`) against a REAL spawned
// `winter` child: multiple matcher groups on the same event (the unmatched plugin group alongside a
// `Bash`-matched group) fire together correctly, and the fileDiff producer's PreToolUse snapshot /
// PostToolUse diff+persist+attach round-trips through a real child's actual Write. It never skips:
// it runs on the embedded runtime every session runs (`describeWithEmbeddedRuntime`, A-M1 review S7).
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import { readStoredDiff } from "../../src/diffs/store";
import { takeFileDiff } from "../../src/runtime-sdk/diff-attach";
import { sessionHooksFor, type HookFacadeLike } from "../../src/runtime-sdk/hooks";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithEmbeddedRuntime } from "../helpers/embedded-runtime";

async function drive(spawn: SpawnClaudeCodeProcess, opts: {
  provider: string; sessionId: string; home: string; cwd: string; hooks: ReturnType<typeof sessionHooksFor>["clover"]; prompt: string;
}): Promise<Array<Record<string, unknown>>> {
  const queue = createHostPromptQueue();
  const messages: Array<Record<string, unknown>> = [];
  const q = query({
    prompt: queue,
    options: {
      spawnClaudeCodeProcess: spawn,
      // The router injects the session's brand; a child driven directly is handed the daemon's own.
      brand: CORE_BRAND,
      model: `winter-test/${opts.provider}`,
      cwd: opts.cwd,
      allowedTools: ["Bash", "Write"],
      sandbox: { enabled: false },
      hooks: opts.hooks,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // Pre-rename this set two distinct env keys — the daemon's own home var, and CLOVER_HOME (the SDK's
        // brand-derived home); the rename makes them the same key, so it is written once now.
        HOME: opts.home, TMPDIR: opts.home, CLOVER_HOME: opts.home,
        CLOVER_PROFILE: "test", WINTER_TEST_PROVIDER: opts.provider,
      },
    },
  });
  queue.push(opts.prompt);
  try {
    for await (const m of q) {
      messages.push(m as Record<string, unknown>);
      if ((m as { type?: string }).type === "result") break;
    }
  } finally {
    if (!queue.closed) queue.close();
  }
  return messages;
}

describeWithEmbeddedRuntime("sessionHooksFor — assembled against a real winter child", (spawn) => {
  test("the fileDiff producer round-trips through a real child's Write, alongside an observing plugin hook", async () => {
    const home = mkdtempSync(join(tmpdir(), "hooks-int-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "hooks-int-cwd-"));
    const target = join(cwd, "laneb-out.txt");
    const preToolCalls: string[] = [];
    const postToolCalls: string[] = [];
    const hookFacade: HookFacadeLike = {
      async runFor(event, extra) {
        (event === "pre-tool" ? preToolCalls : postToolCalls).push(String(extra.toolName));
        return [];
      },
    };
    const { clover } = sessionHooksFor({ sessionId: "s_hi1", home, roots: [cwd], hookFacade });

    const messages = await drive(spawn, { provider: "laneb", sessionId: "s_hi1", home, cwd, hooks: clover, prompt: `write it here:\n${target}` });

    expect(messages.map((m) => m.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
    expect(readFileSync(target, "utf8")).toBe("winter-t8-laneb-fixture-content\n");

    // The plugin hook observed BOTH ends of the SAME call the fileDiff hook also snapshot/diffed —
    // proving the unmatched plugin group and the Write-matched fileDiff group both fired for one call.
    expect(preToolCalls).toEqual(["Write"]);
    expect(postToolCalls).toEqual(["Write"]);

    const attached = takeFileDiff("s_hi1", "laneb-call-1");
    expect(attached).toMatchObject({ path: target, added: 1, removed: 0 });
    const stored = await readStoredDiff(home, "s_hi1", attached!.diffId);
    expect(stored?.patch).toContain("+winter-t8-laneb-fixture-content");

    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("a plugin PreToolUse deny (via sessionHooksFor, not a hand-built matcher) blocks a real Bash call", async () => {
    const home = mkdtempSync(join(tmpdir(), "hooks-int-home2-"));
    const cwd = mkdtempSync(join(tmpdir(), "hooks-int-cwd2-"));
    const hookFacade: HookFacadeLike = {
      async runFor(event) {
        if (event !== "pre-tool") return [];
        return [{ pluginId: "test-plugin", result: { status: "blocked", stdout: "", reason: "policy says no" } }];
      },
    };
    const { clover } = sessionHooksFor({ sessionId: "s_hi2", home, roots: [cwd], hookFacade });

    const messages = await drive(spawn, { provider: "lanec", sessionId: "s_hi2", home, cwd, hooks: clover, prompt: "go" });

    const denialNotice = messages.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied");
    expect(denialNotice).toMatchObject({ tool_name: "Bash", message: "blocked by plugin hook test-plugin: policy says no" });
    const toolResultMsg = messages.find((m) => m.type === "user") as { message?: { content?: Array<{ denied?: unknown; content?: unknown }> } } | undefined;
    const block = toolResultMsg?.message?.content?.[0];
    expect(block?.denied).toBe(true);
    expect(String(block?.content)).not.toContain("winter-t8-lanec");

    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);
});
