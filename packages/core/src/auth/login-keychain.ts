// Clover's own Keychain items live in the account's LOGIN keychain, and every production read and write names it
// (#243 check 3). `Bun.secrets`, `SecItem*` and a `null` keychain-ffi target all search the user's keychain search
// list (and create in the default keychain), which a same-user process can change (`security list-keychains -d
// user -s <its keychain> …`, `security default-keychain -s`): a look-alike item in a keychain put first would be
// read in place of the real one, and a new item written where that process can read it. Opening the login
// keychain by path pins both, and the path comes from the password database's home by real path
// (`getpwuid(getuid())->pw_dir`, startup-guard.ts's `accountHome`), never from HOME.
//
// TESTS NEVER REACH IT (#243 check 4, fail closed). A process under a test preload — `CLOVER_KEYCHAIN_SERVICE`,
// `WINTER_TEST_KEYCHAIN` or `CLOVER_TEST_KEYCHAIN` in its environment, a test keychain installed in-process, or (not a
// release) `NODE_ENV=test` —
// can't open the real login keychain: `loginKeychain()` throws. It gets the throwaway keychain FILE the preload made
// for it (packages/core/test/test-keychain.ts): installed in-process, or named by `CLOVER_TEST_KEYCHAIN` for the test
// daemons it spawns. A release build never takes that variable (a path in the environment must not choose the
// core's keychain): a release refuses to start at all with any of them set (startup-guard.ts, exit 78).
//
// The item calls themselves run on a worker thread (keychain-worker.ts), so a consent prompt can't stall the
// daemon's event loop.
//
// macOS only. On Linux and Windows `Bun.secrets` (libsecret, the Credential Manager) stays the backend.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DIST_BUILD } from "../build-kind";
import { accountHome } from "../startup-guard";
import { ERR_SEC_NO_SUCH_KEYCHAIN, KeychainFfiError, openKeychainFile, openKeychainPath, type KeychainFile } from "./keychain-ffi";
import { keychainWorkerBackend } from "./keychain-worker";

import { TEST_KEYCHAIN_ENV, UNDER_TEST_ENV } from "./test-isolation";

/** Names a throwaway test keychain file for a test daemon (non-release builds only); any of `UNDER_TEST_ENV` in the
 *  environment means a test preload set this process up: the real login keychain is refused (test-isolation.ts). */
export { TEST_KEYCHAIN_ENV, UNDER_TEST_ENV };
/** Every throwaway test keychain's password (it guards nothing: the file is a test's own, in its temp root). */
export const TEST_KEYCHAIN_PASSWORD = "clover-throwaway-test-keychain";

/** `<pw_dir>/Library/Keychains/login.keychain-db`, by real path. Throws when the account's home can't be read. */
export function loginKeychainPath(account: () => string | undefined = accountHome): string {
  const home = account();
  if (home === undefined) throw new KeychainFfiError("login keychain (the account's home could not be read)", ERR_SEC_NO_SUCH_KEYCHAIN);
  const path = join(realpathSync(home), "Library", "Keychains", "login.keychain-db");
  try {
    return realpathSync(path);
  } catch {
    throw new KeychainFfiError("login keychain (none at the account's home)", ERR_SEC_NO_SUCH_KEYCHAIN);
  }
}

export interface KeychainResolution {
  env: Record<string, string | undefined>;
  distBuild: boolean;
  /** A test keychain installed in-process (the preload's). */
  testFile: string | undefined;
  loginPath: () => string;
  /** Opens a throwaway test keychain file (unlocking it with `TEST_KEYCHAIN_PASSWORD`). */
  openFile: (path: string) => KeychainFile;
  /** Opens the login keychain (no unlock: the login session did that). */
  openPath: (path: string) => KeychainFile;
}

/** Which keychain this process uses, opened; throws rather than open the real login keychain under a test. */
export function resolveKeychain(r: KeychainResolution): KeychainFile {
  const named = r.distBuild ? undefined : r.env[TEST_KEYCHAIN_ENV];
  const testPath = r.testFile ?? (named !== undefined && named !== "" ? named : undefined);
  // A non-release build also counts NODE_ENV=test (bun test's own), so a suite that forgets the preload still can't.
  const underTest = r.testFile !== undefined || UNDER_TEST_ENV.some((k) => r.env[k] !== undefined) || (!r.distBuild && r.env.NODE_ENV === "test");
  if (testPath !== undefined) {
    // A test keychain must never be the login keychain itself, however it is spelled.
    let real: string;
    try { real = realpathSync(testPath); } catch { throw new KeychainFfiError(`test keychain (none at ${testPath})`, ERR_SEC_NO_SUCH_KEYCHAIN); }
    let login: string | undefined;
    try { login = r.loginPath(); } catch { login = undefined; }
    if (login !== undefined && real === login) throw new KeychainFfiError("test keychain (it is the login keychain)", -50);
    return r.openFile(real);
  }
  if (underTest) {
    // Say what to set (J's macOS audit: a throwaway daemon with only `CLOVER_KEYCHAIN_SERVICE` crashed here unexplained).
    const why = UNDER_TEST_ENV.filter((k) => r.env[k] !== undefined);
    throw new KeychainFfiError(
      `login keychain (refused: this process runs under a test${why.length > 0 ? ` (${why.join(", ")} set)` : " (NODE_ENV=test)"}; it uses only a throwaway keychain file: ` +
      `make one with \`security create-keychain -p ${TEST_KEYCHAIN_PASSWORD} <path>\` and set ${TEST_KEYCHAIN_ENV}=<path>)`, -50);
  }
  return r.openPath(r.loginPath());
}

let opened: KeychainFile | undefined;
let installedTestFile: string | undefined;
let openers: Pick<KeychainResolution, "openFile" | "openPath"> = { openFile: (p) => openKeychainFile(p, TEST_KEYCHAIN_PASSWORD), openPath: openKeychainPath };

/** A test-marked release build's keychain (scripts/test-build.ts): the throwaway keychain FILE only, named by
 *  `CLOVER_TEST_KEYCHAIN` as a dev build takes it, never the login keychain, whatever else is set: without the file it
 *  throws. Called only behind the compile-time `__CLOVER_TEST_BUILD__`, so a real build has none of it. */
export function resolveTestBuildKeychain(r: Omit<KeychainResolution, "distBuild">): KeychainFile {
  const named = r.env[TEST_KEYCHAIN_ENV];
  if (r.testFile === undefined && (named === undefined || named === "")) {
    throw new KeychainFfiError(`login keychain (refused: this is a test-marked build, which uses only a throwaway keychain file: set ${TEST_KEYCHAIN_ENV}=<path>)`, -50);
  }
  return resolveKeychain({ ...r, distBuild: false });
}

declare const __CLOVER_TEST_BUILD__: string | false | undefined;

/** The keychain Clover's items live in, opened once per process: the login keychain, or under a test its
 *  throwaway keychain (never the login one). A test-marked build's is only ever its throwaway file. */
export function loginKeychain(): KeychainFile {
  const r = { env: process.env, testFile: installedTestFile, loginPath: () => loginKeychainPath(), ...openers };
  opened ??= typeof __CLOVER_TEST_BUILD__ === "string" ? resolveTestBuildKeychain(r) : resolveKeychain({ ...r, distBuild: DIST_BUILD });
  return opened;
}

/** Tests only (the preload): this process's keychain is this throwaway file. In-process; nothing outside sets it. */
export function installTestKeychain(path: string): void {
  installedTestFile = path;
  opened = undefined;
}

/** Tests only: replace the openers (a recorder) and forget the opened keychain. `undefined` restores the real ones. */
export function setKeychainOpenersForTests(o: Pick<KeychainResolution, "openFile" | "openPath"> | undefined): void {
  openers = o ?? { openFile: (p) => openKeychainFile(p, TEST_KEYCHAIN_PASSWORD), openPath: openKeychainPath };
  opened = undefined;
}

/** The three `Bun.secrets` calls Clover uses, with its signatures. */
export type SecretsBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

/** `Bun.secrets`' get/set/delete on one keychain (production: `loginKeychain`), each call on the keychain worker
 *  thread. Same rules: a missing item reads `null`, an empty value deletes, delete answers whether there was one. */
export function pinnedSecretsBackend(keychain: () => KeychainFile = loginKeychain): SecretsBackend {
  return keychainWorkerBackend(keychain);
}
