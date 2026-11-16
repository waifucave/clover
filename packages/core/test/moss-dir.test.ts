import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapMossDir, resolveMossHome } from "../src/moss-dir";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "moss-home-"));
}

// P9b-7/P9b-12: this is the daemon's OWN home resolver — `MOSS_HOME` when set, `~/.moss`
// otherwise. It is what `resolveMossHome()` from the SDK, given `CORE_BRAND`, must equal
// (pinned in `test/runtime-sdk/brand.test.ts`).
describe("resolveMossHome", () => {
  test("MOSS_HOME wins when set", () => {
    const saved = process.env.MOSS_HOME;
    try {
      process.env.MOSS_HOME = "/tmp/some-moss-home";
      expect(resolveMossHome()).toBe("/tmp/some-moss-home");
    } finally {
      if (saved === undefined) delete process.env.MOSS_HOME;
      else process.env.MOSS_HOME = saved;
    }
  });

  test("falls back to ~/.moss when unset", () => {
    const saved = process.env.MOSS_HOME;
    try {
      delete process.env.MOSS_HOME;
      expect(resolveMossHome()).toBe(join(homedir(), ".moss"));
    } finally {
      if (saved === undefined) delete process.env.MOSS_HOME;
      else process.env.MOSS_HOME = saved;
    }
  });
});

describe("bootstrapMossDir", () => {
  test("creates the full directory layout", () => {
    const home = tmpHome();
    const dirs = bootstrapMossDir(home);
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
    bootstrapMossDir(home);
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
    bootstrapMossDir(home);
    for (const d of ["projects", "backups", "skills", "agents", "workflows"]) expect(existsSync(join(home, d))).toBe(false);
  });

  test("an existing old-layout projects/ is left exactly as found (only Migration C moves data)", () => {
    const home = tmpHome();
    mkdirSync(join(home, "projects", "k"), { recursive: true });
    writeFileSync(join(home, "projects", "k", "s.jsonl"), "{}\n");
    bootstrapMossDir(home);
    expect(lstatSync(join(home, "projects")).isDirectory()).toBe(true);
    expect(readFileSync(join(home, "projects", "k", "s.jsonl"), "utf8")).toBe("{}\n");
  });

  test("run dir is 0700", () => {
    const home = tmpHome();
    bootstrapMossDir(home);
    expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
  });

  test("writes default settings.json once, never overwrites", () => {
    const home = tmpHome();
    bootstrapMossDir(home);
    const settingsPath = join(home, "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("schemaVersion", 1);
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, custom: true }));
    bootstrapMossDir(home); // idempotent
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toHaveProperty("custom", true);
  });

  test("respects MOSS_HOME env override (no-arg call)", () => {
    const saved = process.env.MOSS_HOME;
    const home = mkdtempSync(join(tmpdir(), "moss-env-"));
    try {
      process.env.MOSS_HOME = home;
      const dirs = bootstrapMossDir(); // no explicit arg
      expect(dirs.home).toBe(home);
    } finally {
      if (saved === undefined) delete process.env.MOSS_HOME;
      else process.env.MOSS_HOME = saved;
    }
  });

  test("settings.json is 0600", () => {
    const home = tmpHome();
    bootstrapMossDir(home);
    expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
  });
});
