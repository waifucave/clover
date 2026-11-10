// Tests never reach the user's own secret store (the hard rule). Lane K's find: `openCloverSecretStore`'s default vault
// called `Bun.secrets` directly, so a daemon booted in a test without `secrets` wrote its items into the account's
// LOGIN keychain under the test service. Every default path now goes through `defaultSecretsBackend`, which under a
// test reaches only an isolated store, and `Bun.secrets` itself throws for an un-isolated call
// (src/auth/test-isolation.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeychainFile } from "../../src/auth/keychain-ffi";
import { setKeychainOpenersForTests, TEST_KEYCHAIN_PASSWORD } from "../../src/auth/login-keychain";
import { defaultSecretsBackend } from "../../src/auth/secret-store";
import {
  isolatedTestBackend, osStoreIsolated, PRIVATE_SECRET_SERVICE_ENV, THROWAWAY_SERVICE_PREFIX, underTest, unisolatedSecretsMessage, type SecretsCalls,
} from "../../src/auth/test-isolation";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { bunVault, openCloverSecretStore } from "../../src/secrets/clover-secret-store";
import { onDarwin } from "../helpers/darwin-only"; // the macOS-only checks are its branches, and the file runs on both jobs

type Call = { op: string; service: string; name: string };

/** Stands in for `Bun.secrets` for one test: records every call, answers from memory. */
function recorder(): SecretsCalls & { calls: Call[] } {
  const calls: Call[] = [];
  const items = new Map<string, string>();
  return {
    calls,
    get: (async (o: { service: string; name: string }) => { calls.push({ op: "get", ...o }); return items.get(`${o.service}\0${o.name}`) ?? null; }) as SecretsCalls["get"],
    set: (async (o: { service: string; name: string; value: string }) => { calls.push({ op: "set", service: o.service, name: o.name }); if (o.value === "") items.delete(`${o.service}\0${o.name}`); else items.set(`${o.service}\0${o.name}`, o.value); }) as SecretsCalls["set"],
    delete: (async (o: { service: string; name: string }) => { calls.push({ op: "delete", ...o }); return items.delete(`${o.service}\0${o.name}`); }) as SecretsCalls["delete"],
  };
}

const SERVICE = process.env.CLOVER_KEYCHAIN_SERVICE!;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

/** `Bun.secrets` replaced by a recorder until the test ends. */
function recordBunSecrets(): ReturnType<typeof recorder> {
  const real = Bun.secrets;
  const r = recorder();
  (Bun as { secrets: unknown }).secrets = r;
  const before = restore;
  restore = () => { (Bun as { secrets: unknown }).secrets = real; before?.(); };
  return r;
}

describe("which stores a test may reach", () => {
  test("this process runs under a test; a release never counts NODE_ENV", () => {
    expect(underTest()).toBe(true);
    expect(underTest({ NODE_ENV: "test" }, false)).toBe(true);
    expect(underTest({ NODE_ENV: "test" }, true)).toBe(false);
    expect(underTest({ CLOVER_TEST_KEYCHAIN: "/x" }, true)).toBe(true);
    expect(underTest({}, false)).toBe(false);
  });

  test("the OS store: never on macOS, on Linux only on the private bus, on Windows only under a throwaway service", () => {
    const t = `${THROWAWAY_SERVICE_PREFIX}1234-ab`;
    const bus = "unix:path=/tmp/dbus-private,guid=abc";
    const PRIVATE = { [PRIVATE_SECRET_SERVICE_ENV]: bus, DBUS_SESSION_BUS_ADDRESS: bus };
    // A bare flag, or a bus that isn't the session's (#327's minor), never counts.
    expect(osStoreIsolated(SERVICE, { [PRIVATE_SECRET_SERVICE_ENV]: "1", DBUS_SESSION_BUS_ADDRESS: "1" }, "linux")).toBe(false);
    expect(osStoreIsolated(SERVICE, { [PRIVATE_SECRET_SERVICE_ENV]: bus, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, "linux")).toBe(false);
    expect(osStoreIsolated(t, PRIVATE, "darwin")).toBe(false);
    expect(osStoreIsolated(SERVICE, {}, "linux")).toBe(false);
    expect(osStoreIsolated(SERVICE, PRIVATE, "linux")).toBe(true);
    expect(osStoreIsolated(SERVICE, {}, "win32")).toBe(false);
    expect(osStoreIsolated(t, {}, "win32")).toBe(true);
    expect(osStoreIsolated(THROWAWAY_SERVICE_PREFIX, {}, "win32")).toBe(false);
    expect(osStoreIsolated(`${THROWAWAY_SERVICE_PREFIX}a/b`, {}, "win32")).toBe(false);
  });

  test("the isolated backend: the real one only for an isolated call, this process's memory for the rest", async () => {
    const bus = "unix:path=/tmp/dbus-private,guid=abc";
    const PRIVATE = { [PRIVATE_SECRET_SERVICE_ENV]: bus, DBUS_SESSION_BUS_ADDRESS: bus };
    for (const [platform, env, service, real] of [
      ["darwin", {}, SERVICE, false], ["linux", {}, SERVICE, false], ["linux", PRIVATE, SERVICE, true],
      ["win32", {}, SERVICE, false], ["win32", {}, `${THROWAWAY_SERVICE_PREFIX}x`, true],
    ] as const) {
      const r = recorder();
      const b = isolatedTestBackend(r, env, platform);
      await b.set({ service, name: "k", value: "v" });
      expect([platform, service, await b.get({ service, name: "k" })]).toEqual([platform, service, "v"]);
      await b.set({ service, name: "k", value: "" }); // an empty value deletes, as Bun.secrets does
      expect(await b.get({ service, name: "k" })).toBeNull();
      expect([platform, service, r.calls.length > 0]).toEqual([platform, service, real]);
    }
  });
});

describe("Bun.secrets itself, in this test process", () => {
  test("an un-isolated call throws, saying where a test may go", async () => {
    if (osStoreIsolated(SERVICE)) return; // Linux on the private bus: the OS store there is the test's own
    await expect(Bun.secrets.get({ service: SERVICE, name: "probe" })).rejects.toThrow(unisolatedSecretsMessage(SERVICE));
    await expect(Bun.secrets.set({ service: `${SERVICE}.items`, name: "probe", value: "x" })).rejects.toThrow("no isolated store");
    await expect(Bun.secrets.delete({ service: "com.waifucave.clover.core", name: "probe" })).rejects.toThrow("no isolated store");
  });
});

describe("every default path lands in an isolated store", () => {
  /** On macOS: the keychain openers record which keychain was opened; the login keychain is refused outright. */
  function recordKeychains(): { files: string[]; login: number } {
    const seen = { files: [] as string[], login: 0 };
    if (!onDarwin) return seen;
    setKeychainOpenersForTests({
      openFile: (p) => { seen.files.push(p); return openKeychainFile(p, TEST_KEYCHAIN_PASSWORD); },
      openPath: () => { seen.login++; throw new Error("the login keychain was opened in a test"); },
    });
    const before = restore;
    restore = () => { setKeychainOpenersForTests(undefined); before?.(); };
    return seen;
  }

  test("openCloverSecretStore with no vault, KeychainValues and bunVault: never Bun.secrets, never the login keychain", async () => {
    const calls = recordBunSecrets();
    const keychains = recordKeychains();
    const home = mkdtempSync(join(tmpdir(), "clover-test-vault-"));
    const store = await openCloverSecretStore({ home, service: SERVICE });
    const ref = { kind: "core", name: "lane-c-vault-probe" } as unknown as Parameters<typeof store.set>[0];
    await store.set(ref, "a value").catch(() => undefined); // whatever the store's refs, its vault is the point
    await bunVault(`${SERVICE}.items`).set("lane-c-probe", "x");
    expect(await bunVault(`${SERVICE}.items`).get("lane-c-probe")).toBe("x");
    expect(await bunVault(`${SERVICE}.items`).delete("lane-c-probe")).toBe(true);
    await defaultSecretsBackend().get({ service: SERVICE, name: "anything" });
    expect(calls.calls.filter((c) => !osStoreIsolated(c.service))).toEqual([]);
    if (onDarwin) {
      expect(calls.calls).toEqual([]);
      expect(keychains.login).toBe(0);
      expect(keychains.files.length).toBeGreaterThan(0);
      expect(keychains.files.every((f) => f === process.env.CLOVER_TEST_KEYCHAIN || f.endsWith("test.keychain-db"))).toBe(true);
    }
  });

  test("startDaemon with no `secrets` in a temp home: nothing reaches Bun.secrets un-isolated, nor the login keychain", async () => {
    const calls = recordBunSecrets();
    const keychains = recordKeychains();
    const home = mkdtempSync(join(tmpdir(), "clover-test-vault-daemon-"));
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await startDaemon({ home, agentProvider: null });
    } finally {
      await daemon?.stop();
    }
    expect(calls.calls.filter((c) => !osStoreIsolated(c.service))).toEqual([]);
    if (onDarwin) {
      expect(calls.calls).toEqual([]);
      expect(keychains.login).toBe(0);
    }
  }, 60_000);
});
