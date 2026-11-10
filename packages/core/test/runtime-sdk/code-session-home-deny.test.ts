// A coding session's Bash meets the Clover home's default-deny (the owner's November 6 ruling, #347's review): what the
// spawn is sent (`childSandboxConfigFor`) reads the runtime's store but of its `projects/` only the session's own
// entries, the plugin views but of `cache/runs/` only its own run folder, the installed plugins, its own outputs and its
// working directories; never a config copy that carries keys, the bots' data, or the sessions' logs.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compatibilityKeys } from "@waifucave/clover-agent-sdk";
import { childSandboxConfigFor, codeSessionProjectKeys } from "../../src/runtime-sdk/mode-options";
import { deniedBy } from "../helpers/sandbox-glob";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

function setup() {
  const h = temp("clover-code-home-deny-");
  const cwd = temp("clover-code-home-deny-cwd-");
  const key = compatibilityKeys(cwd).transcriptProjectKey;
  for (const d of ["sessions", `sdk/projects/${key}/memory`, "sdk/projects/-other-project", "sdk/plugins/p", "cache/runs/run-own", "cache/runs/run-other", "cache/views/v", "plugins/pack",
    "outputs/s_1", "outputs/s_2", "bots/pack--luna/memory", "scratch/pack--luna", "transcripts/pack--luna", "transcripts/_", "work/project", "work/other"]) mkdirSync(join(h, d), { recursive: true });
  writeFileSync(join(h, "secrets.enc"), "x");
  const fs = childSandboxConfigFor(h, cwd, [join(h, "work", "project")], { outputsDir: join(h, "outputs", "s_1"), runDir: join(h, "cache", "runs", "run-own") }).filesystem!;
  return { h, cwd, key, list: fs.denyRead ?? [] };
}

describe("a coding session's Bash sandbox (childSandboxConfigFor)", () => {
  test("its own store entries, run folder, outputs and working directories are readable", () => {
    const { h, key, list } = setup();
    for (const p of [`sdk/projects/${key}/memory/MEMORY.md`, `sdk/projects/${key}/s.jsonl`, "sdk/projects/_global/memory/M.md", "sdk/projects/_assistant/memory/M.md", "sdk/plugins/p/skills/x/SKILL.md",
      "sdk/skills/a/run.sh", "cache/runs/run-own/settings.json", "cache/runs/run-own/plugins/x", "cache/views/v/SKILL.md", "plugins/pack/clover.json", "outputs/s_1/r.md", "work/project/a.ts"]) {
      expect([p, deniedBy(list, join(h, p))]).toEqual([p, false]);
    }
  });

  test("another session's transcript, run folder and outputs are refused (S1); one made after the spawn at the next spawn", () => {
    const { h, cwd, list } = setup();
    for (const p of ["sdk/projects/-other-project/s.jsonl", "cache/runs/run-other/settings.json", "outputs/s_2/r.md", "work/other/x"]) {
      expect([p, deniedBy(list, join(h, p))]).toEqual([p, true]);
    }
    // Made after this spawn's list was built: readable until the next spawn, whose list has them (S1, S2: per spawn).
    for (const d of ["sdk/projects/-later-project", "cache/runs/run-later", "outputs/s_9"]) mkdirSync(join(h, d), { recursive: true });
    const next = childSandboxConfigFor(h, cwd, [join(h, "work", "project")], { outputsDir: join(h, "outputs", "s_1"), runDir: join(h, "cache", "runs", "run-own") }).filesystem!.denyRead ?? [];
    for (const p of ["sdk/projects/-later-project/s.jsonl", "cache/runs/run-later/x", "outputs/s_9/r.md"]) expect([p, deniedBy(next, join(h, p))]).toEqual([p, true]);
  });

  test("the config copies that carry keys are refused, its own run folder's and a staging root's included (the blocker)", () => {
    const { h, list } = setup();
    for (const p of ["cache/runs/run-own/.clover.json", "cache/runs/run-other/.clover.json", "cache/runs/run-own/.claude.json", "cache/runs/run-own/.credentials.json",
      "cache/runs/run-own/backups/.claude.json.backup.1", "cache/runs/run-own/nested/deeper/.clover.json", "sdk/.clover.json"]) {
      expect([p, deniedBy(list, join(h, p))]).toEqual([p, true]);
    }
    for (const f of [".clover.json", ".claude.json", ".credentials.json", "backups/x"]) {
      const staged = join(tmpdir(), "claude-resume-0000", f);
      expect([f, deniedBy(list, staged) || deniedBy(list, join(realpathSync(tmpdir()), "claude-resume-0000", f))]).toEqual([f, true]);
    }
  });

  test("its own run folder's MCP list is denied by its exact name, so the runtime still loads it (a link to it isn't named)", () => {
    const h = temp("clover-code-own-mcp-");
    const runDir = join(h, "cache", "runs", "run-own");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, ".clover.json"), "{}");
    symlinkSync("./.clover.json", join(runDir, ".claude.json"));
    const list = childSandboxConfigFor(h, null, [], { runDir }).filesystem?.denyRead ?? [];
    expect(list).toContain(join(runDir, ".clover.json"));
    expect(list).not.toContain(join(runDir, ".claude.json"));
    // No pattern names the top-level file too (the agent SDK's own read wants the exact denial alone).
    expect(list.filter((e) => /[*?]/.test(e) && deniedBy([e], join(runDir, ".clover.json")))).toEqual([]);
  });

  test("the bots' data, the sessions' logs and the secrets file are refused", () => {
    const { h, list } = setup();
    for (const p of ["bots/pack--luna/memory/MEMORY.md", "scratch/pack--luna/x", "transcripts/pack--luna/b.ndjson", "transcripts/_/s_1.ndjson", "sessions/s_1.jsonl",
      "secrets.enc", "secrets.key.cred", "run/core.sock", "runtimes/bin/winter"]) {
      expect([p, deniedBy(list, join(h, p))]).toEqual([p, true]);
    }
  });

  test("before the run folder is built, every run folder is refused", () => {
    const { h, cwd } = setup();
    const list = childSandboxConfigFor(h, cwd).filesystem?.denyRead ?? [];
    expect(deniedBy(list, join(h, "cache", "runs", "run-own", "settings.json"))).toBe(true);
    expect(deniedBy(list, join(h, "cache", "views", "v", "SKILL.md"))).toBe(false);
  });

  test("cheap for the runtime: the home's denials are literal paths, never per-letter globs (each glob is a Seatbelt regex)", () => {
    const { h, cwd } = setup();
    const own = { outputsDir: join(h, "outputs", "s_1"), runDir: join(h, "cache", "runs", "run-own") };
    for (let i = 0; i < 1000; i++) {
      mkdirSync(join(h, "outputs", `s_${i.toString(16).padStart(12, "0")}`));
      mkdirSync(join(h, "cache", "runs", `r-${i}`));
      mkdirSync(join(h, "sdk", "projects", `-p-${i}`));
    }
    const list = childSandboxConfigFor(h, cwd, [], own).filesystem!.denyRead!;
    // Only the fixed config-copy globs (staging roots, run folders) and the any-depth project fence's: none per session or
    // per letter, whatever the home holds (#347's merge-queue failure: hundreds of them made `session.setPolicy` slow).
    const globsInHome = list.filter((e) => e.startsWith(`${h}/`) && /[[]/.test(e.slice(h.length)));
    expect(globsInHome).toEqual([]);
    expect(list.filter((e) => /[*?[]/.test(e)).length).toBeLessThan(40);
    // Every one of those sessions' folders is refused.
    for (const p of ["outputs/s_0000000003e7/r.md", "cache/runs/r-999/x", "sdk/projects/-p-999/s.jsonl"]) expect([p, deniedBy(list, join(h, p))]).toEqual([p, true]);
  });

  test("the session's project keys: its transcripts' and its memory's, and the shared buckets", () => {
    const cwd = temp("clover-code-keys-");
    const k = compatibilityKeys(cwd);
    expect(codeSessionProjectKeys(cwd)).toEqual(expect.arrayContaining(["_global", "_assistant", k.transcriptProjectKey, k.memoryProjectKey]));
  });
});
