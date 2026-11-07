// #243 check 3: Clover's own items are read and written in ONE keychain named by path (the login keychain in
// production), never through the search list a same-user process can reorder. Against THROWAWAY keychain files
// only (`security create-keychain` in a temp dir, deleted after; the same practice as app-token-acl.test.ts,
// measured not to touch the user's search list): one stands in for the login keychain, the other holds a
// look-alike item. No search list is changed, the user's or any other: the look-alike-first case is a search over
// the two files in that order (`keychainSearchOrder`), which is how `SecKeychainFind*` walks a search list.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGenericPasswordWithAccess, ERR_SEC_NO_SUCH_KEYCHAIN, KeychainFfiError, keychainSearchOrder, openKeychainFile, openKeychainPath, readGenericPassword, setGenericPassword, type KeychainFile } from "../../src/auth/keychain-ffi";
import { loginKeychainPath, pinnedSecretsBackend } from "../../src/auth/login-keychain";
import { defaultSecretsBackend, KeychainSecretStore } from "../../src/auth/secret-store";

const SERVICE = "lane-m.login-keychain.test";
const PASSWORD = "lane-m-throwaway";
const CALCULATOR = "/System/Applications/Calculator.app";
const darwin = process.platform === "darwin";

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

describe.if(darwin)("the login keychain by path", () => {
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

test.if(darwin)("the login keychain's path comes from the home it is given by real path, and must exist", () => {
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
