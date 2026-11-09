// The real-OS-store half runs in CI (every OS; Linux inside scripts/with-private-secret-service.sh), or when a
// developer asks with CLOVER_SECRET_STORE_TESTS=1. On macOS it is this test process's throwaway keychain file, never
// the login keychain.
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
    const bus = "unix:path=/tmp/dbus-private,guid=abc";
    expect(throwawaySecretStoreAvailable({ CLOVER_PRIVATE_SECRET_SERVICE: bus, DBUS_SESSION_BUS_ADDRESS: bus }, "linux")).toBe(true);
    // A bare flag, or a bus that isn't the session's, never counts.
    expect(throwawaySecretStoreAvailable({ CLOVER_PRIVATE_SECRET_SERVICE: "1" }, "linux")).toBe(false);
    expect(throwawaySecretStoreAvailable({ CLOVER_PRIVATE_SECRET_SERVICE: bus, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, "linux")).toBe(false);
    expect(throwawaySecretStoreAvailable({}, "darwin")).toBe(true);
  });

  test.if(realStoreTests)("round-trips a value in the OS store under its own service, and dispose removes it", async () => {
    const store = createThrowawaySecretStore();
    const other = createThrowawaySecretStore();
    try {
      expect(store.service.startsWith(TEST_SERVICE_PREFIX)).toBe(true);
      expect(store.env.CLOVER_KEYCHAIN_SERVICE).toBe(store.service);
      if (store.backend === "keychain") expect(store.env.CLOVER_TEST_KEYCHAIN).toBe(process.env.CLOVER_TEST_KEYCHAIN!);
      expect(await store.get("probe")).toBeNull();
      await store.set("probe", "not-a-real-secret");
      expect(await store.get("probe")).toBe("not-a-real-secret");
      expect(await other.get("probe")).toBeNull();
    } finally {
      await store.dispose();
      await other.dispose();
    }
    expect(await store.get("probe")).toBeNull();
  });
});
