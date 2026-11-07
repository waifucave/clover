// #243 check 3: Clover's own items are read and written in ONE keychain named by path (the login keychain in
// production), never through the search list a same-user process can reorder. Against THROWAWAY keychain files
// only (`security create-keychain` in a temp dir, deleted after; the same practice as app-token-acl.test.ts,
// measured not to touch the user's search list): one stands in for the login keychain, the other holds a
// look-alike item. No search list is changed, the user's or any other: the look-alike-first case is a search over
// the two files in that order (`keychainSearchOrder`), which is how `SecKeychainFind*` walks a search list.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { darwinDescribe, darwinTest } from "../helpers/darwin-only";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGenericPasswordWithAccess, ERR_SEC_NO_SUCH_KEYCHAIN, KeychainFfiError, keychainSearchOrder, openKeychainFile, openKeychainPath, readGenericPassword, setGenericPassword, type KeychainFile } from "../../src/auth/keychain-ffi";
import { loginKeychain, loginKeychainPath, pinnedSecretsBackend, resolveKeychain, setKeychainOpenersForTests, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_PASSWORD, type KeychainResolution } from "../../src/auth/login-keychain";
import { defaultSecretsBackend, KeychainSecretStore } from "../../src/auth/secret-store";

const SERVICE = "lane-m.login-keychain.test";
const PASSWORD = "lane-m-throwaway";
const CALCULATOR = "/System/Applications/Calculator.app";

let dir: string;
let loginPath: string;
let lookalikePath: string;
let login: KeychainFile;
let lookalike: KeychainFile;

function create(path: string): KeychainFile {
  const made = Bun.spawnSync(["security", "create-keychain", "-p", PASSWORD, path]);
  if (made.exitCode !== 0) throw new Error(`create-keychain failed: ${made.stderr.toString()}`);
  return openKeychainFile(path, PASSWORD);
}

darwinDescribe("the login keychain by path", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lane-m-login-kc-"));
    loginPath = join(dir, "login-standin.keychain-db");
    lookalikePath = join(dir, "lookalike.keychain-db");
    login = create(loginPath);
    lookalike = create(lookalikePath);
  });
  afterAll(() => {
    login?.close();
    lookalike?.close();
    for (const p of [loginPath, lookalikePath]) if (p) Bun.spawnSync(["security", "delete-keychain", p]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a look-alike item in a keychain searched first is never read: the store reads only its own keychain", async () => {
    const store = new KeychainSecretStore(pinnedSecretsBackend(() => login), SERVICE);
    await store.set("harness-token", "the-real-one");
    setGenericPassword(lookalike, SERVICE, "harness-token", "the-look-alike");
    // The attack's shape: a search list with the look-alike's keychain first finds the look-alike.
    const order = keychainSearchOrder([lookalike, login]);
    try {
      expect(readGenericPassword(order, SERVICE, "harness-token")).toBe("the-look-alike");
    } finally {
      order.close();
    }
    // The pinned store never does.
    expect(await store.get("harness-token")).toBe("the-real-one");
    // A token only the look-alike keychain holds reads as absent, never from there.
    setGenericPassword(lookalike, SERVICE, "admin-token", "planted");
    expect(await store.get("admin-token")).toBeNull();
  });

  test("writes land in the pinned keychain only; a replace keeps the item's access list; an empty value deletes", async () => {
    const store = new KeychainSecretStore(pinnedSecretsBackend(() => login), SERVICE);
    await store.set("remote-token", "r-1");
    expect(readGenericPassword(login, SERVICE, "remote-token")).toBe("r-1");
    expect(readGenericPassword(lookalike, SERVICE, "remote-token")).toBeNull();
    // An item made with an explicit access list (the app tokens') keeps it when its value is replaced.
    addGenericPasswordWithAccess(login, { service: SERVICE, account: "app-token", value: "a-1", trustedApplications: [null, CALCULATOR] });
    await store.set("app-token", "a-2");
    expect(await store.get("app-token")).toBe("a-2");
    const acl = Bun.spawnSync(["security", "dump-keychain", "-a", loginPath]).stdout.toString();
    expect(acl).toContain(CALCULATOR);
    // `Bun.secrets.set`'s rules: an empty value deletes; delete answers whether there was one.
    await store.set("remote-token", "");
    expect(await store.get("remote-token")).toBeNull();
    expect(await store.delete("app-token")).toBe(true);
    expect(await store.delete("app-token")).toBe(false);
  });

  test("a keychain is opened by path only when one is there", () => {
    const again = openKeychainPath(loginPath);
    try {
      expect(readGenericPassword(again, SERVICE, "harness-token")).toBe("the-real-one");
    } finally {
      again.close();
    }
    let err: unknown;
    try { openKeychainPath(join(dir, "none.keychain-db")); } catch (e) { err = e; }
    expect(err instanceof KeychainFfiError && err.status === ERR_SEC_NO_SUCH_KEYCHAIN).toBe(true);
  });

  test("production's backend on macOS is the pinned one, not Bun.secrets", () => {
    expect(defaultSecretsBackend()).not.toBe(Bun.secrets);
  });
});

darwinTest("the login keychain's path comes from the home it is given by real path, and must exist", () => {
  const home = mkdtempSync(join(tmpdir(), "lane-m-login-home-"));
  try {
    mkdirSync(join(home, "real", "Library", "Keychains"), { recursive: true });
    writeFileSync(join(home, "real", "Library", "Keychains", "login.keychain-db"), "");
    symlinkSync(join(home, "real"), join(home, "link"));
    const expected = loginKeychainPath(() => join(home, "real"));
    expect(expected.endsWith("/real/Library/Keychains/login.keychain-db")).toBe(true);
    expect(loginKeychainPath(() => join(home, "link"))).toBe(expected);
    let err: unknown;
    try { loginKeychainPath(() => join(home, "nobody")); } catch (e) { err = e; }
    expect(err).toBeDefined();
    let none: unknown;
    try { loginKeychainPath(() => undefined); } catch (e) { none = e; }
    expect(none instanceof KeychainFfiError).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The fail-closed guard: a process under a test never opens the real login keychain. Stubs stand in for the
// openers, recording each path; the login keychain's path is only computed (a real path), never opened.
describe("under a test, the real login keychain is never opened", () => {
  const LOGIN = "/Users/someone/Library/Keychains/login.keychain-db";
  function recorder(over: Partial<KeychainResolution> = {}) {
    const opened: string[] = [];
    const fake = (path: string) => ({ ref: 1n, close() {}, path });
    const r: KeychainResolution = {
      env: {}, distBuild: false, testFile: undefined, loginPath: () => LOGIN,
      openFile: (p) => { opened.push(`file ${p}`); return fake(p); },
      openPath: (p) => { opened.push(`path ${p}`); return fake(p); },
      ...over,
    };
    return { r, opened };
  }

  test("production (no test signal) opens the login keychain by its path", () => {
    const { r, opened } = recorder();
    resolveKeychain(r);
    expect(opened).toEqual([`path ${LOGIN}`]);
    // NODE_ENV=test marks a test only outside a release (a release refuses test variables at startup instead).
    const release = recorder({ distBuild: true, env: { NODE_ENV: "test" } });
    resolveKeychain(release.r);
    expect(release.opened).toEqual([`path ${LOGIN}`]);
  });

  test("any test signal without a test keychain refuses, and opens nothing", () => {
    for (const env of [{ CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-isolated" }, { WINTER_TEST_KEYCHAIN: "memory" }, { [TEST_KEYCHAIN_ENV]: "" }, { NODE_ENV: "test" }]) {
      const { r, opened } = recorder({ env });
      expect(() => resolveKeychain(r)).toThrow(KeychainFfiError);
      expect(opened).toEqual([]);
    }
  });

  test("a test keychain (in-process, or named for a non-release build) is opened instead; a release never takes the name", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-m-kc-guard-"));
    const file = join(dir, "t.keychain-db");
    writeFileSync(file, "");
    try {
      const inProcess = recorder({ testFile: file, env: { CLOVER_KEYCHAIN_SERVICE: "x" } });
      resolveKeychain(inProcess.r);
      expect(inProcess.opened).toEqual([`file ${realpathOf(file)}`]);
      const named = recorder({ env: { CLOVER_KEYCHAIN_SERVICE: "x", [TEST_KEYCHAIN_ENV]: file } });
      resolveKeychain(named.r);
      expect(named.opened).toEqual([`file ${realpathOf(file)}`]);
      // A release build: the variable never chooses a keychain, and it still marks a test, so nothing opens.
      const release = recorder({ distBuild: true, env: { [TEST_KEYCHAIN_ENV]: file } });
      expect(() => resolveKeychain(release.r)).toThrow(KeychainFfiError);
      expect(release.opened).toEqual([]);
      // A "test keychain" that is the login keychain (a link to it) is refused.
      symlinkSync(file, join(dir, "link.keychain-db"));
      const loop = recorder({ testFile: join(dir, "link.keychain-db"), loginPath: () => realpathOf(file) });
      expect(() => resolveKeychain(loop.r)).toThrow(KeychainFfiError);
      expect(loop.opened).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  darwinTest("under the preload, the default backend reads and writes only the test keychain, never the login keychain", async () => {
    const testKeychain = process.env[TEST_KEYCHAIN_ENV];
    expect(testKeychain).toBeString();
    // The real login keychain's path, computed by real path only (never opened).
    let login: string | undefined;
    try { login = loginKeychainPath(); } catch { login = undefined; }
    const paths: string[] = [];
    setKeychainOpenersForTests({
      openFile: (p) => { paths.push(p); if (p === login) throw new Error("opened the login keychain"); return openKeychainFile(p, TEST_KEYCHAIN_PASSWORD); },
      openPath: (p) => { paths.push(p); throw new Error(`opened ${p === login ? "the login keychain" : p} by path under a test`); },
    });
    try {
      const store = new KeychainSecretStore(defaultSecretsBackend(), SERVICE);
      await store.set("guard-probe", "only-in-the-test-keychain");
      expect(await store.get("guard-probe")).toBe("only-in-the-test-keychain");
      expect(await store.delete("guard-probe")).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p).toBe(realpathOf(testKeychain!));
        if (login !== undefined) expect(p).not.toBe(login);
      }
      expect(loginKeychain()).toBeDefined();
    } finally {
      setKeychainOpenersForTests(undefined);
    }
  });
});

function realpathOf(p: string): string {
  return realpathSync(p);
}
