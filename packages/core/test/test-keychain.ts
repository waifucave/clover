// macOS: this test process's own throwaway keychain FILE, made in its temp root and removed with it (#243 check 4).
// Clover's keychain code refuses the real login keychain in any process under a test (`CLOVER_KEYCHAIN_SERVICE` and
// the rest of auth/login-keychain.ts's `UNDER_TEST_ENV`), so every read and write a test makes, in-process or in a
// test daemon it spawns (`CLOVER_TEST_KEYCHAIN`, honoured by non-release builds only), lands here. `security
// create-keychain` with a path does not add the file to the user's search list (measured 2026-09-27,
// app-token-acl.test.ts), and nothing here changes any search list.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTestKeychain, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_PASSWORD } from "../src/auth/login-keychain";

if (process.platform === "darwin" && process.env[TEST_KEYCHAIN_ENV] === undefined) {
  const path = join(mkdtempSync(join(tmpdir(), "clover-test-keychain-")), "test.keychain-db");
  const made = spawnSync("security", ["create-keychain", "-p", TEST_KEYCHAIN_PASSWORD, path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`the test keychain could not be made: ${made.stderr.trim()}`);
  // No auto-lock (no timeout, not on sleep): a locked keychain's data read would wait on an unlock dialog.
  const settings = spawnSync("security", ["set-keychain-settings", path], { encoding: "utf8" });
  if (settings.status !== 0) throw new Error(`the test keychain's settings could not be set: ${settings.stderr.trim()}`);
  process.env[TEST_KEYCHAIN_ENV] = path;
}
if (process.platform === "darwin") installTestKeychain(process.env[TEST_KEYCHAIN_ENV]!);
