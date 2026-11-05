// The other installs on this machine (src/other-installs.ts): a Clover daemon never runs on their homes. Every case
// uses a stand-in user home under the test's temp root; the real one is never named.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE_DEV } from "../src/legacy-names";
import { startDaemon } from "../src/daemon";
import { installDaemonLogFile } from "../src/daemon-log-file";
import { assertNotOtherInstallHome, otherInstallHome, OtherInstallHomeRefused, OTHER_INSTALL_HOMES, OTHER_INSTALL_KEYCHAIN_SERVICES, realPathOf } from "../src/other-installs";

function fakeUserHome(): string {
  const user = mkdtempSync(join(tmpdir(), "clover-fake-user-"));
  for (const o of OTHER_INSTALL_HOMES) mkdirSync(join(user, o.dir));
  return user;
}

describe("other installs' homes", () => {
  test("each one, and anything inside it, is refused; Clover's own homes and others are not", () => {
    const user = fakeUserHome();
    expect(OTHER_INSTALL_HOMES.map((o) => o.dir)).toEqual([".winter", ".winter-dev", LEGACY_HOME_DIR, LEGACY_DEV_HOME_DIR]);
    expect(OTHER_INSTALL_KEYCHAIN_SERVICES.map((o) => o.service)).toEqual(["com.winter.core", "com.winter.core.dev", LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE_DEV]);
    for (const o of OTHER_INSTALL_HOMES) {
      expect(otherInstallHome(join(user, o.dir), user)?.what).toBe(o.what);
      expect(otherInstallHome(join(user, o.dir, "nested", "home"), user)?.what).toBe(o.what);
      expect(() => assertNotOtherInstallHome(join(user, o.dir), user)).toThrow(OtherInstallHomeRefused);
    }
    for (const fine of [".clover", ".clover-dev", ".winterish", "projects/.winter-notes"]) expect(otherInstallHome(join(user, fine), user)).toBeUndefined();
    expect(otherInstallHome(join(tmpdir(), "clover-home-x"), user)).toBeUndefined();
  });

  test("by real path: a link that leads into one is refused, and a home that does not exist yet too", () => {
    const user = fakeUserHome();
    const link = join(mkdtempSync(join(tmpdir(), "clover-link-")), "looks-harmless");
    symlinkSync(join(user, ".winter"), link);
    expect(otherInstallHome(link, user)?.what).toContain("live Winter");
    expect(otherInstallHome(join(link, "not", "there", "yet"), user)?.what).toContain("live Winter");
    expect(realPathOf(join(link, "missing"))).toBe(join(realPathOf(join(user, ".winter")), "missing"));
  });

  test("startDaemon refuses such a home before writing anything into it", async () => {
    const user = fakeUserHome();
    for (const o of OTHER_INSTALL_HOMES) {
      const home = join(user, o.dir);
      await expect(startDaemon({ home, secrets: new FileSecretStore(join(mkdtempSync(join(tmpdir(), "clover-secrets-")), "s")), userHomeForTests: user })).rejects.toThrow(OtherInstallHomeRefused);
      expect(readdirSync(home)).toEqual([]);
    }
  });

  test("the daemon log is never opened inside one", () => {
    const user = fakeUserHome();
    expect(() => installDaemonLogFile(join(user, ".winter"), { userHomeForTests: user })).toThrow(OtherInstallHomeRefused);
    expect(existsSync(join(user, ".winter", "logs"))).toBe(false);
  });
});
