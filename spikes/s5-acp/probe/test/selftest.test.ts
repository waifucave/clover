// Self-test: the probe against its own fake agent and stubs. No real agent, no model.
// POSIX only (process groups, /bin/ps); run on macOS for M0.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const runs = mkdtempSync(join(tmpdir(), "s5-selftest-"));
const RUN = resolve(import.meta.dir, "../src/run.ts");
afterAll(() => rmSync(runs, { recursive: true, force: true }));

function check(name: string, ...extra: string[]) {
  const r = spawnSync(process.execPath, [RUN, name, "--agent", "fake", "--runs", runs, "--timeout", "60", "--settle", "1", ...extra], {
    encoding: "utf8",
    timeout: 90_000,
  });
  const dir = readdirSync(runs)
    .filter((d) => d.endsWith(`-fake-${name}`))
    .sort()
    .pop()!;
  return { code: r.status, summary: JSON.parse(readFileSync(join(runs, dir, "summary.json"), "utf8")) };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const T = 60_000;

describe("probe against the fake agent", () => {
  test("initialize negotiates v1 and reads capabilities", () => {
    const { code, summary } = check("initialize");
    expect(code).toBe(0);
    expect(summary.initialize.protocolVersion).toBe(1);
    expect(summary.initialize.agentCapabilities.mcpCapabilities.http).toBe(true);
  }, T);

  test("prompt: both MCP servers, instructions, permissions, fs, terminal, a refusal", () => {
    const { code, summary } = check("prompt", "--model", "fake-large");
    expect(code).toBe(0);
    expect(summary.result.verdict).toEqual({
      stdioToolResultReachedModel: true,
      httpToolResultReachedModel: true,
      stdioInstructionsReachedModel: true,
      httpInstructionsReachedModel: true,
      fileWritten: true,
      fileHasBothResults: true,
      rejectedCommandDidNotRun: true,
      usedClientFs: true,
      usedClientTerminal: true,
      permissionRequests: 3,
    });
    expect(summary.mcp.stdio.envTokenMatches).toBe(true);
    expect(summary.mcp.http.authCheck).toEqual(["match"]);
    expect(summary.modelSet.current).toBe("fake-large");
  }, T);

  test("cancel ends the turn with stopReason cancelled and kills the command", () => {
    const { code, summary } = check("cancel", "--cancel-after", "1");
    expect(code).toBe(0);
    expect(summary.result.verdict).toEqual({ stopReasonCancelled: true, commandKilled: true });
  }, T);

  test("load replays the earlier session in a fresh agent process", () => {
    const { code, summary } = check("load");
    expect(code).toBe(0);
    expect(summary.load.replayedUpdates).toBeGreaterThan(0);
    expect(summary.load.previousNoncesInReplay).toEqual({ stdio: true, http: true });
  }, T);

  test("no token reaches any file the runs wrote, in any form", () => {
    // Bridge tokens are 32 hex characters, and nothing else the probe writes is: any match is a leak.
    const leaks = filesUnder(runs).filter((f) => /\b[0-9a-f]{32}\b/.test(readFileSync(f, "utf8")));
    expect(leaks).toEqual([]);
  }, T);
});
