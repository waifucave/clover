import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapCloverDir, resolveCloverHome } from "../src/clover-dir";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "clover-home-"));
}

// P9b-7/P9b-12: this is the daemon's OWN home resolver — `CLOVER_HOME` when set, `~/.clover`
// otherwise. It is what `resolveCloverHome()` from the SDK, given `CORE_BRAND`, must equal
// (pinned in `test/runtime-sdk/brand.test.ts`).
describe("resolveCloverHome", () => {
  test("CLOVER_HOME wins when set", () => {
    const saved = process.env.CLOVER_HOME;
    try {
      process.env.CLOVER_HOME = "/tmp/some-clover-home";
      expect(resolveCloverHome()).toBe("/tmp/some-clover-home");
    } finally {
      if (saved === undefined) delete process.env.CLOVER_HOME;
      else process.env.CLOVER_HOME = saved;
    }
  });

  test("falls back to ~/.clover when unset", () => {
    const saved = process.env.CLOVER_HOME;
    try {
      delete process.env.CLOVER_HOME;
      expect(resolveCloverHome()).toBe(join(homedir(), ".clover"));
    } finally {
      if (saved === undefined) delete process.env.CLOVER_HOME;
      else process.env.CLOVER_HOME = saved;
    }
  });
});

describe("bootstrapCloverDir", () => {
  test("creates the full directory layout", () => {
    const home = tmpHome();
    const dirs = bootstrapCloverDir(home);
    for (const d of ["sessions", "memory", "logs", "run", "runtimes", "runtimes/backups", "runtimes/handoff-leases"]) {
      expect(existsSync(join(home, d))).toBe(true);
    }
    expect(dirs.runDir).toBe(join(home, "run"));
    expect(dirs.socketPath).toBe(join(home, "run", "core.sock"));
    expect(dirs.runtimesDir).toBe(join(home, "runtimes"));
    expect(dirs.runtimeStatePath).toBe(join(home, "runtimes", "runtime-state.db"));
  });

  // WS-21 (spec §8 bootstrap): a fresh home is never in the old layout. `sdk/` and claude's
  // persistent set are created; the old-layout entries are not.
  test("creates sdk/ (0700), its store and the persistent set; none of the old-layout entries", () => {
    const home = tmpHome();
    bootstrapCloverDir(home);
    expect(statSync(join(home, "sdk")).mode & 0o777).toBe(0o700);
    for (const d of ["sdk/projects", "sdk/file-history", "sdk/tasks", "sdk/teams", "sdk/agent-memory", "sdk/workflows"]) {
      expect(statSync(join(home, d)).isDirectory()).toBe(true);
    }
    for (const d of ["skills", "agents", "plugins", "hooks", "runtimes/official-agent-spool"]) {
      expect(existsSync(join(home, d))).toBe(false);
    }
  });

  // No compatibility link is planted: the agent SDK's store refuses a symlink at <store>/projects on
  // every append, so a link there would break every child still writing the old path.
  test("plants no link at the old top-level paths", () => {
    const home = tmpHome();
    bootstrapCloverDir(home);
    for (const d of ["projects", "backups", "skills", "agents", "workflows"]) expect(existsSync(join(home, d))).toBe(false);
  });

  test("an existing old-layout projects/ is left exactly as found (only Migration C moves data)", () => {
    const home = tmpHome();
    mkdirSync(join(home, "projects", "k"), { recursive: true });
    writeFileSync(join(home, "projects", "k", "s.jsonl"), "{}\n");
    bootstrapCloverDir(home);
    expect(lstatSync(join(home, "projects")).isDirectory()).toBe(true);
    expect(readFileSync(join(home, "projects", "k", "s.jsonl"), "utf8")).toBe("{}\n");
  });

  test("run dir is 0700", () => {
    const home = tmpHome();
    bootstrapCloverDir(home);
    expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
  });

  test("writes default settings.json once, never overwrites", () => {
    const home = tmpHome();
    bootstrapCloverDir(home);
    const settingsPath = join(home, "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("schemaVersion", 1);
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, custom: true }));
    bootstrapCloverDir(home); // idempotent
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("custom", true);
  });

  test("respects CLOVER_HOME env override (no-arg call)", () => {
    const saved = process.env.CLOVER_HOME;
    const home = mkdtempSync(join(tmpdir(), "clover-env-"));
    try {
      process.env.CLOVER_HOME = home;
      const dirs = bootstrapCloverDir(); // no explicit arg
      expect(dirs.home).toBe(home);
    } finally {
      if (saved === undefined) delete process.env.CLOVER_HOME;
      else process.env.CLOVER_HOME = saved;
    }
  });

  test("settings.json is 0600", () => {
    const home = tmpHome();
    bootstrapCloverDir(home);
    expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
  });
});
