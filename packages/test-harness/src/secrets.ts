// A throwaway secret store for each OS (plan §3), for tests that need the REAL OS store under the daemon's own
// secret code (`Bun.secrets`): a fresh test service the daemon is pointed at with `CLOVER_KEYCHAIN_SERVICE`.
//   macOS    this test process's throwaway keychain FILE (core's test/test-keychain.ts, `CLOVER_TEST_KEYCHAIN`), under
//            the test service: Clover's keychain code refuses the real login keychain in any process under a test
//   Windows  Credential Manager, under the test service only (every test service starts with TEST_SERVICE_PREFIX)
//   Linux    the Secret Service on a PRIVATE session bus: the test command runs under
//            scripts/with-private-secret-service.sh, which gives it a dbus-daemon and an unlocked gnome-keyring of its
//            own, with their files in a temp folder, so a developer's own keyring is never opened
// Everything a store sets is deleted by `dispose`. Most tests need none of this: core's `FileSecretStore`, in the
// temp home, is the default.
import { randomBytes } from "node:crypto";
import { OTHER_INSTALL_KEYCHAIN_SERVICES, pinnedSecretsBackend, TEST_KEYCHAIN_ENV } from "@waifucave/clover-core";

/** Every throwaway service starts with this; it can never equal a real one. */
export const TEST_SERVICE_PREFIX = "com.waifucave.clover.core.test.";

/** Set by scripts/with-private-secret-service.sh, inside its private bus, to that bus's address. */
export const PRIVATE_SECRET_SERVICE_ENV = "CLOVER_PRIVATE_SECRET_SERVICE";

/** Services a test must never read or write: Clover's own, and the other installs' (core's `other-installs.ts`). */
export const REAL_SECRET_SERVICES: readonly string[] = [
  "com.waifucave.clover.core",
  "com.waifucave.clover.core.dev",
  ...OTHER_INSTALL_KEYCHAIN_SERVICES.map((o) => o.service),
];

export type SecretBackend = "keychain" | "credential-manager" | "secret-service";

export function secretBackend(platform: NodeJS.Platform = process.platform): SecretBackend {
  return platform === "darwin" ? "keychain" : platform === "win32" ? "credential-manager" : "secret-service";
}

/** Throws unless `service` is a throwaway test service. */
export function assertThrowawayService(service: string): void {
  if (REAL_SECRET_SERVICES.includes(service) || !service.startsWith(TEST_SERVICE_PREFIX) || !/^[A-Za-z0-9._-]+$/.test(service.slice(TEST_SERVICE_PREFIX.length))) {
    throw new Error(`refusing secret service ${JSON.stringify(service)}: a test uses only a throwaway ${TEST_SERVICE_PREFIX}<id> service`);
  }
}

/** Whether a throwaway OS store can be made here: on Linux only inside the private bus wrapper. */
export function throwawaySecretStoreAvailable(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  // The session bus must be the wrapper's own: the variable names its address (core's `privateBus`).
  const named = env[PRIVATE_SECRET_SERVICE_ENV];
  return secretBackend(platform) !== "secret-service" || (named !== undefined && /^(unix|tcp):/.test(named) && named === env.DBUS_SESSION_BUS_ADDRESS);
}

export interface ThrowawaySecretStore {
  backend: SecretBackend;
  /** The throwaway service: what `CLOVER_KEYCHAIN_SERVICE` names for a daemon on a temp home. */
  service: string;
  /** What a daemon on a temp home needs to use this store. */
  env: Record<string, string>;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  /** Deletes every item this store set. */
  dispose(): Promise<void>;
}

/** A fresh throwaway secret store on this OS. `id` names the service (default: random). */
export function createThrowawaySecretStore(opts: { id?: string } = {}): ThrowawaySecretStore {
  const backend = secretBackend();
  if (!throwawaySecretStoreAvailable()) {
    throw new Error("the throwaway Secret Service needs a private session bus: run the tests under scripts/with-private-secret-service.sh");
  }
  const service = `${TEST_SERVICE_PREFIX}${opts.id ?? `${process.pid}-${randomBytes(4).toString("hex")}`}`;
  assertThrowawayService(service);
  const touched = new Set<string>();
  // macOS: the same pinned backend the daemon uses, which under a test is this process's throwaway keychain file.
  const os = backend === "keychain" ? pinnedSecretsBackend() : Bun.secrets;
  const testKeychain = process.env[TEST_KEYCHAIN_ENV];
  if (backend === "keychain" && testKeychain === undefined) throw new Error("the throwaway keychain needs the test preload (core's test/test-keychain.ts)");
  return {
    backend,
    service,
    env: { CLOVER_KEYCHAIN_SERVICE: service, ...(backend === "keychain" ? { [TEST_KEYCHAIN_ENV]: testKeychain! } : {}) },
    get: (name) => os.get({ service, name }),
    set: async (name, value) => {
      touched.add(name);
      await os.set({ service, name, value });
    },
    delete: (name) => os.delete({ service, name }),
    dispose: async () => {
      for (const name of touched) {
        try {
          await os.delete({ service, name });
        } catch {
          /* already gone */
        }
      }
      touched.clear();
    },
  };
}
