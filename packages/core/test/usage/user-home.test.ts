// J's macOS audit: a temp-home daemon read the REAL `~/.claude` (the usage readers fell back to the user's home
// folder). Whose apps usage tracking reads is the daemon's `userHome` (`usage/wiring.ts`): the user's home folder only
// for the daemon on its default home, none for any other, which then reads no root and runs no executable outside its
// home (no home folder, `$CODEX_HOME`, `$CLAUDE_CONFIG_DIR`, install place or `$PATH`), unless one is named explicitly.
//
// The "real" home here is a stand-in: `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `PATH` point into a temp folder
// holding every file and executable the readers would look for, and the preload's `CLOVER_USAGE_*` are lifted for
// the test, so a reader that still fell back would find them.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { createUsageService } from "../../src/usage/wiring";

const temps: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `clover-usage-home-${name}-`));
  temps.push(d);
  return d;
};
const saved = new Map<string, string | undefined>();
const setEnv = (key: string, value: string | undefined) => {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in user home with every app's files and executables, and the environment pointing into it. */
function standInUser(): string {
  const user = temp("user");
  mkdirSync(join(user, ".codex", "sessions", "2026", "11", "09"), { recursive: true });
  writeFileSync(join(user, ".codex", "sessions", "2026", "11", "09", "rollout-x.jsonl"), "{}\n");
  mkdirSync(join(user, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(join(user, ".claude", "projects", "p", "t.jsonl"), "{}\n");
  writeFileSync(join(user, ".claude", "stats-cache.json"), "{}");
  writeFileSync(join(user, ".claude.json"), "{}");
  const bin = join(user, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["codex", "claude", "agy", "opencode"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  for (const key of ["CLOVER_USAGE_CODEX_HOME", "CLOVER_USAGE_CLAUDE_HOME", "CLOVER_USAGE_CLAUDE_JSON", "CLOVER_USAGE_CODEX_EXECUTABLE",
    "CLOVER_USAGE_CLAUDE_EXECUTABLE", "CLOVER_USAGE_AGY_EXECUTABLE", "CLOVER_USAGE_OPENCODE_EXECUTABLE"]) setEnv(key, undefined);
  setEnv("HOME", user);
  setEnv("CODEX_HOME", join(user, ".codex"));
  setEnv("CLAUDE_CONFIG_DIR", join(user, ".claude"));
  setEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return user;
}

describe("usage tracking reads only its daemon's user home", () => {
  test("no user home: no root, no executable, whatever HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and PATH say", () => {
    standInUser();
    const usage = createUsageService({ home: temp("clover"), userHome: undefined, settings: () => undefined, injection: { catchUp: false, background: false } })!;
    try {
      expect(usage.sources.codexHome).toBeUndefined();
      expect(usage.sources.claudeHome).toBeUndefined();
      expect(usage.sources.claudeJsonPath).toBeUndefined();
      expect(usage.sources.executables()).toEqual({ codex: undefined, claude: undefined, agy: undefined, opencode: undefined });
    } finally {
      usage.close();
    }
  });

  test("with a user home it reads that home's apps (the readers would find the stand-in, so the test above means something)", () => {
    const user = standInUser();
    setEnv("CODEX_HOME", undefined);
    setEnv("CLAUDE_CONFIG_DIR", undefined);
    const usage = createUsageService({ home: temp("clover"), userHome: user, settings: () => undefined, injection: { catchUp: false, background: false } })!;
    try {
      expect(usage.sources).toMatchObject({ codexHome: join(user, ".codex"), claudeHome: join(user, ".claude"), claudeJsonPath: join(user, ".claude.json") });
      // Found (the stand-in's own, or a system install place ahead of it): never looked for without a user home.
      expect(usage.sources.executables().claude).toBeDefined();
    } finally {
      usage.close();
    }
  });

  test("an explicit root or executable is still used without a user home (a test's fixtures)", () => {
    const user = standInUser();
    setEnv("CLOVER_USAGE_CLAUDE_HOME", join(user, ".claude"));
    const usage = createUsageService({
      home: temp("clover"), userHome: undefined, settings: () => undefined,
      injection: { catchUp: false, background: false, codexExecutable: join(user, ".local", "bin", "codex") },
    })!;
    try {
      expect(usage.sources.claudeHome).toBe(join(user, ".claude"));
      expect(usage.sources.codexHome).toBeUndefined();
      expect(usage.sources.executables()).toEqual({ codex: join(user, ".local", "bin", "codex"), claude: undefined, agy: undefined, opencode: undefined });
    } finally {
      usage.close();
    }
  });

  test("a daemon on a temp home reads nothing outside it", async () => {
    standInUser();
    const home = temp("daemon");
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false, links: false,
      parts: { bots: false, node: false },
    });
    const sources = daemon.usageSources!;
    expect(sources).toBeDefined();
    expect(sources.codexHome).toBeUndefined();
    expect(sources.claudeHome).toBeUndefined();
    expect(sources.claudeJsonPath).toBeUndefined();
    expect(sources.executables()).toEqual({ codex: undefined, claude: undefined, agy: undefined, opencode: undefined });
  });
});
