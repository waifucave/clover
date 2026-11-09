// A coding session's Bash meets the Clover home's default-deny (the owner's November 6 ruling): what the spawn is sent
// (`childSandboxConfigFor`) read-denies the sessions' logs, the secrets file and the rest of the home, and keeps the
// runtime's store, the run folders, the installed plugins, the outputs and the session's working directories.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childSandboxConfigFor, codeSessionHomeFolders } from "../../src/runtime-sdk/mode-options";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "clover-code-home-deny-"));
  temps.push(h);
  for (const d of ["sessions", "sdk/projects/-p/memory", "sdk/plugins", "cache/runs/r1", "plugins/pack", "outputs/s_1", "outputs/s_2", "bots/pack--luna/memory", "scratch/pack--luna", "work/project", "work/other"]) mkdirSync(join(h, d), { recursive: true });
  writeFileSync(join(h, "sessions", "s_1.jsonl"), "{}\n");
  writeFileSync(join(h, "secrets.enc"), "x");
  return h;
}

const denied = (list: readonly string[], p: string) => list.some((d) => p === d || p.startsWith(`${d}/`));

describe("a coding session's Bash sandbox (childSandboxConfigFor)", () => {
  test("denies the sessions' logs, the secrets file and the bots' folders; keeps what a coding session reads", () => {
    const h = home();
    const cwd = join(h, "work", "project");
    const list = childSandboxConfigFor(h, cwd).filesystem?.denyRead ?? [];
    for (const p of ["sessions", "sessions/s_1.jsonl", "secrets.enc", "secrets.key", "credentials", "bots/pack--luna/memory", "scratch/pack--luna", "work/other"]) {
      expect(denied(list, join(h, p))).toBe(true);
    }
    for (const p of ["sdk/projects/-p/memory", "sdk/plugins", "cache/runs/r1", "plugins/pack", "outputs/s_1", "outputs/s_2", "work/project"]) {
      expect(denied(list, join(h, p))).toBe(false);
    }
    // What was denied before still is: the run folder, the runtimes and the user scope's MCP list.
    for (const p of ["run", "runtimes", "sdk/.clover.json"]) expect(list).toContain(join(h, p));
  });

  test("a working directory outside the home changes nothing in it; one in the home is kept", () => {
    const h = home();
    const outside = mkdtempSync(join(tmpdir(), "clover-code-home-deny-cwd-"));
    temps.push(outside);
    expect(denied(childSandboxConfigFor(h, outside).filesystem?.denyRead ?? [], join(h, "work"))).toBe(true);
    expect(codeSessionHomeFolders(h, outside, [join(h, "work", "project")])).toContain(join(h, "work", "project"));
    expect(denied(childSandboxConfigFor(h, outside, [join(h, "work", "project")]).filesystem?.denyRead ?? [], join(h, "work", "project"))).toBe(false);
  });
});
