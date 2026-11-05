// MEASUREMENT (lane B, 2026-09-22) — on a REAL, spawned `winter` child, under the daemon's own
// `buildCloverOptions`: does a SAVED allow rule take effect without asking the host, and does the
// control-plane DENY still beat a saved allow rule that matches the same call?
//
// The scripted `winter-test/laneb` double makes exactly ONE `Write` to the path on the prompt's last
// line (`provider/mock.ts`). The session runs under `ask`, and `canUseTool` REFUSES everything and
// records what it was asked, so:
//   1. with NO saved rule, a Write in the working directory reaches `canUseTool` and is refused;
//   2. with the saved rule `Edit`, the SAME Write lands and `canUseTool` is never asked — the rule
//      reached the child and the child applied it itself;
//   3. with the same `Edit` rule, a Write to `<home>/settings.json` (a control-plane file) is refused
//      and never lands — deny before allow.
// HERMETIC: `env` is built by `buildChildEnv` from a temp home; the model is a scripted double.
// Runs on the embedded runtime every session runs (`describeWithEmbeddedRuntime`, A-M1 review S7).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import type { CredentialPresence } from "../../src/runtime-sdk/host";
import { buildCloverOptions } from "../../src/runtime-sdk/mode-options";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithEmbeddedRuntime } from "../helpers/embedded-runtime";

async function writeOnce(spawn: SpawnClaudeCodeProcess, opts: { home: string; cwd: string; target: string; persistedAllow?: string[] }): Promise<{ asked: string[] }> {
  const asked: string[] = [];
  const canUseTool: CanUseTool = async (name) => {
    asked.push(name);
    return { behavior: "deny", message: "measurement: the host refuses everything" };
  };
  const options = buildCloverOptions({
    mode: "code", policy: "ask", sessionId: crypto.randomUUID(), home: opts.home, cwd: opts.cwd,
    model: "winter-test/laneb" as ModelTag, credentials: { byProvider: {} } as unknown as CredentialPresence,
    systemPrompt: "You are a measurement.", exaKeyPresent: false,
    // As production spawns every session (`create.ts`): the path is only a label, the hook runs the Worker.
    spawn: { pathToClaudeCodeExecutable: "clover-embedded", spawnClaudeCodeProcess: spawn }, canUseTool, abort: new AbortController(),
    baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: opts.home, TMPDIR: opts.home },
    ...(opts.persistedAllow === undefined ? {} : { persistedAllow: opts.persistedAllow }),
  });
  const queue = createHostPromptQueue();
  // The router injects the session's brand; a child driven directly is handed the daemon's own.
  const q = query({ prompt: queue, options: { ...options, brand: CORE_BRAND } });
  queue.push(opts.target);
  try {
    for await (const m of q) {
      if (process.env.CLOVER_DEBUG_MEASURE === "1") console.warn(JSON.stringify(m).slice(0, 600));
      if ((m as { type?: string }).type === "result") break;
    }
  } finally {
    if (!queue.closed) queue.close();
  }
  return { asked };
}

describeWithEmbeddedRuntime("saved allow rules on a real winter child — applied natively, and never over a deny", (spawn) => {
  test("no rule → asked and refused; `Edit` saved → written unasked; `Edit` saved → a control-plane file is still denied", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-allow-measure-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clover-allow-measure-cwd-")));
    try {
      const first = join(cwd, "first.txt");
      const without = await writeOnce(spawn, { home, cwd, target: first });
      expect(without.asked).toContain("Write");
      expect(existsSync(first)).toBe(false);

      const second = join(cwd, "second.txt");
      const withRule = await writeOnce(spawn, { home, cwd, target: second, persistedAllow: ["Edit"] });
      expect(existsSync(second)).toBe(true);
      expect(withRule.asked).not.toContain("Write");

      const controlPlane = join(home, "settings.json");
      const fenced = await writeOnce(spawn, { home, cwd, target: controlPlane, persistedAllow: ["Edit"] });
      expect(existsSync(controlPlane)).toBe(false);
      expect(fenced.asked).not.toContain("Write"); // refused by the deny rule, before any ask
    } finally {
      for (const dir of [home, cwd]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }, 120_000);
});
