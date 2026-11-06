// WS-21 L3.7: `clover daemon run` treats Migration C's typed refusals exactly like Migration B's — a
// message and exit 1, never a stack (a launchd crash loop otherwise).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyRunningError, CredentialMigrationBusy, LockFailedError, LockHeldNoDaemonError, MigrationCRefused, MigrationRefused, OtherInstallHomeRefused, OTHER_INSTALL_HOMES } from "@waifucave/clover-core";
import { bootRefusalExitCode, CREDENTIAL_MIGRATION_BUSY_EXIT_CODE, migrationRefusalMessage } from "../src/daemon-boot-refusal";

describe("the home's daemon lock at boot (C-M1)", () => {
  test("a second daemon whose home's daemon answers exits 0, so its login item does not loop", () => {
    const err = new AlreadyRunningError(4242);
    expect(migrationRefusalMessage(err)).toContain("pid 4242");
    expect(bootRefusalExitCode(err)).toBe(0);
  });
  test("a lock held with no daemon answering, or refused by the OS, exits 1 so it is retried", () => {
    for (const err of [new LockHeldNoDaemonError("/h/run/core.lock"), new LockFailedError("/h/run/core.lock", 13)]) {
      expect(migrationRefusalMessage(err)).toBe(err.message);
      expect(bootRefusalExitCode(err)).toBe(1);
    }
  });
});

describe("migrationRefusalMessage", () => {
  test("Migration B's and Migration C's refusals are operator messages", () => {
    expect(migrationRefusalMessage(new MigrationRefused("home_half_migrated", "b says"))).toBe("b says");
    for (const code of ["sdk_home_migration_required", "sdk_home_migration_refused", "sdk_home_half_migrated"] as const) {
      expect(migrationRefusalMessage(new MigrationCRefused(code, `c says ${code}`))).toBe(`c says ${code}`);
    }
  });
  test("WS-27: a credential migration lock held past the boot's bound is an operator message too", () => {
    const busy = new CredentialMigrationBusy(4242, 60_000);
    expect(busy.code).toBe("credential_migration_busy");
    expect(migrationRefusalMessage(busy)).toBe(busy.message);
    expect(busy.message).toContain("pid 4242");
    // A distinct exit code the Mac app's supervisor backs off on (and a migration refusal keeps 1).
    expect(CREDENTIAL_MIGRATION_BUSY_EXIT_CODE).toBe(75);
    expect(bootRefusalExitCode(busy)).toBe(75);
    expect(bootRefusalExitCode(new MigrationRefused("home_half_migrated", "b"))).toBe(1);
  });
  test("anything else is not", () => {
    expect(migrationRefusalMessage(new Error("boom"))).toBeUndefined();
    expect(migrationRefusalMessage("nope")).toBeUndefined();
  });
});

// C0 review B1: `daemon run` refuses another install's home before its log file — or anything else — touches it.
// The CLI runs with HOME set to a stand-in user home, so the real one is never named.
describe("clover daemon run on another install's home", () => {
  test("is refused, with nothing written there", () => {
    const user = mkdtempSync(join(tmpdir(), "clover-fake-user-"));
    for (const o of OTHER_INSTALL_HOMES) {
      const home = join(user, o.dir);
      mkdirSync(home);
      const r = spawnSync("bun", [join(import.meta.dir, "..", "src", "main.ts"), "daemon", "run"], {
        env: { ...process.env, HOME: user, CLOVER_HOME: home },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(`it is ${o.what}`);
      expect(readdirSync(home)).toEqual([]);
      expect(existsSync(join(home, "logs"))).toBe(false);
    }
  }, 240_000);

  // C0 check (B1): the commands that write without a daemon refuse it too, before writing anything.
  test("a command that writes without a daemon is refused the same way", () => {
    const user = mkdtempSync(join(tmpdir(), "clover-fake-user-"));
    const o = OTHER_INSTALL_HOMES[0]!;
    const home = join(user, o.dir);
    mkdirSync(home);
    const r = spawnSync("bun", [join(import.meta.dir, "..", "src", "main.ts"), "mcp", "add", "-s", "user", "probe", "echo"], {
      env: { ...process.env, HOME: user, CLOVER_HOME: home },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(`it is ${o.what}`);
    expect(readdirSync(home)).toEqual([]);
  }, 60_000);

  test("startDaemon's own refusal prints as an operator message", () => {
    const o = OTHER_INSTALL_HOMES[0]!;
    const refused = new OtherInstallHomeRefused(join("/x", o.dir), o.what);
    expect(migrationRefusalMessage(refused)).toBe(refused.message);
    expect(bootRefusalExitCode(refused)).toBe(1);
  });
});
