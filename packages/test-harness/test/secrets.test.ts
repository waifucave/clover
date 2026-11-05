// The real-OS-store half runs in CI (every OS; Linux inside scripts/with-private-secret-service.sh), or when a
// developer asks with CLOVER_SECRET_STORE_TESTS=1: on a developer's Mac it would write to the login Keychain, which
// a test there leaves alone (plan §9).
import { describe, expect, test } from "bun:test";
import { assertThrowawayService, createThrowawaySecretStore, REAL_SECRET_SERVICES, secretBackend, TEST_SERVICE_PREFIX, throwawaySecretStoreAvailable } from "../src/secrets";

const realStoreTests = (process.env.CI === "true" || process.env.CLOVER_SECRET_STORE_TESTS === "1") && throwawaySecretStoreAvailable();

describe("throwaway secret stores", () => {
  test("only a test service is ever accepted", () => {
    for (const real of REAL_SECRET_SERVICES) expect(() => assertThrowawayService(real)).toThrow();
    expect(() => assertThrowawayService(TEST_SERVICE_PREFIX)).toThrow();
    expect(() => assertThrowawayService(`${TEST_SERVICE_PREFIX}x/y`)).toThrow();
    expect(() => assertThrowawayService(`${TEST_SERVICE_PREFIX}abc-1`)).not.toThrow();
  });

  test("each OS has its store", () => {
    expect(secretBackend("darwin")).toBe("keychain");
    expect(secretBackend("win32")).toBe("credential-manager");
    expect(secretBackend("linux")).toBe("secret-service");
  });

  test("on Linux only inside the private bus wrapper", () => {
    expect(throwawaySecretStoreAvailable({}, "linux")).toBe(false);
    expect(throwawaySecretStoreAvailable({ CLOVER_PRIVATE_SECRET_SERVICE: "1" }, "linux")).toBe(true);
    expect(throwawaySecretStoreAvailable({}, "darwin")).toBe(true);
  });

  test.if(realStoreTests)("round-trips a value in the OS store under its own service, and dispose removes it", async () => {
    const store = createThrowawaySecretStore();
    const other = createThrowawaySecretStore();
    try {
      expect(store.service.startsWith(TEST_SERVICE_PREFIX)).toBe(true);
      expect(store.env).toEqual({ CLOVER_KEYCHAIN_SERVICE: store.service });
      expect(await store.get("probe")).toBeNull();
      await store.set("probe", "not-a-real-secret");
      expect(await store.get("probe")).toBe("not-a-real-secret");
      expect(await other.get("probe")).toBeNull();
    } finally {
      await store.dispose();
      await other.dispose();
    }
    expect(await Bun.secrets.get({ service: store.service, name: "probe" })).toBeNull();
  });
});
