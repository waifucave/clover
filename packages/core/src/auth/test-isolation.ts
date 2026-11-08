// Tests never reach the user's own secret store (the hard rule; #243 check 4, and lane K's find on the C-M3 round:
// `openCloverSecretStore`'s default vault went to `Bun.secrets` directly, so a daemon booted in a test without
// `secrets` wrote its items into the account's LOGIN keychain under the test service). A process is under a test
// when the preload set it up (`UNDER_TEST_ENV`), or, outside a release, when `NODE_ENV` is `test`; a test daemon a
// test spawns inherits those variables, so the same rules hold there.
//
// Under a test, every default path to the OS store lands in an isolated one, per OS:
//   macOS    the throwaway keychain FILE the preload made (`login-keychain.ts`'s pinned backend); `Bun.secrets`
//            (which searches the user's keychain list and creates in the login keychain) is never isolated
//   Linux    the Secret Service only on the private session bus `scripts/with-private-secret-service.sh` gives
//            the test command (`CLOVER_PRIVATE_SECRET_SERVICE=1`)
//   Windows  Credential Manager only under a throwaway test service (`THROWAWAY_SERVICE_PREFIX…`, the harness's)
// and anything else goes to a store in this process's memory (`isolatedTestBackend`). `Bun.secrets` itself is
// fenced the same way (`guardBunSecrets`): an un-isolated call throws, rather than reach the user's store.
import { DIST_BUILD } from "../build-kind";

/** Names a throwaway test keychain file for a test daemon (non-release builds only). */
export const TEST_KEYCHAIN_ENV = "CLOVER_TEST_KEYCHAIN";
/** Any of these in the environment means a test preload set this process up. */
export const UNDER_TEST_ENV = ["CLOVER_KEYCHAIN_SERVICE", "WINTER_TEST_KEYCHAIN", TEST_KEYCHAIN_ENV] as const;
/** Set by scripts/with-private-secret-service.sh: the session bus is the wrapper's private one. */
export const PRIVATE_SECRET_SERVICE_ENV = "CLOVER_PRIVATE_SECRET_SERVICE";
/** Every throwaway test service starts with this (packages/test-harness's `TEST_SERVICE_PREFIX`). */
export const THROWAWAY_SERVICE_PREFIX = "com.waifucave.clover.core.test.";

type Env = Readonly<Record<string, string | undefined>>;

/** The three `Bun.secrets` calls, with its signatures. */
export type SecretsCalls = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

/** Whether this process runs under a test. A release never counts `NODE_ENV` (and refuses to start with any of
 *  `UNDER_TEST_ENV` set: startup-guard.ts). */
export function underTest(env: Env = process.env, distBuild: boolean = DIST_BUILD): boolean {
  return UNDER_TEST_ENV.some((k) => env[k] !== undefined) || (!distBuild && env.NODE_ENV === "test");
}

/** Whether a test may reach the OS store through `Bun.secrets` for `service`: never on macOS, on Linux only on the
 *  private bus, on Windows only under a throwaway test service. */
export function osStoreIsolated(service: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "darwin") return false;
  if (platform === "win32") return service.startsWith(THROWAWAY_SERVICE_PREFIX) && /^[A-Za-z0-9._-]+$/.test(service.slice(THROWAWAY_SERVICE_PREFIX.length)) && service.length > THROWAWAY_SERVICE_PREFIX.length;
  return env[PRIVATE_SECRET_SERVICE_ENV] === "1";
}

/** This process's in-memory store (shared by every isolated backend in it), by service and name. */
const memory = new Map<string, string>();

/** Under a test: `real` for a call whose service is isolated (`osStoreIsolated`), this process's memory for any
 *  other. Same rules as `Bun.secrets`: a missing item reads null, an empty value deletes. */
export function isolatedTestBackend(real: SecretsCalls, env: Env = process.env, platform: NodeJS.Platform = process.platform): SecretsCalls {
  const key = (o: { service: string; name: string }) => `${o.service}\0${o.name}`;
  return {
    get: (async (o: { service: string; name: string }) => (osStoreIsolated(o.service, env, platform) ? real.get(o) : memory.get(key(o)) ?? null)) as SecretsCalls["get"],
    set: (async (o: { service: string; name: string; value: string }) => {
      if (osStoreIsolated(o.service, env, platform)) return real.set(o);
      if (o.value === "") memory.delete(key(o)); else memory.set(key(o), o.value);
    }) as SecretsCalls["set"],
    delete: (async (o: { service: string; name: string }) => (osStoreIsolated(o.service, env, platform) ? real.delete(o) : memory.delete(key(o)))) as SecretsCalls["delete"],
  };
}

/** The error an un-isolated `Bun.secrets` call throws under a test. */
export function unisolatedSecretsMessage(service: string, platform: NodeJS.Platform = process.platform): string {
  const where = platform === "darwin" ? "the test keychain file (the preload's), through the pinned backend"
    : platform === "win32" ? `a throwaway ${THROWAWAY_SERVICE_PREFIX}<id> service`
    : `the private Secret Service (run under scripts/with-private-secret-service.sh)`;
  return `Bun.secrets was called for ${JSON.stringify(service)} in a test process with no isolated store: a test reaches only ${where}, never the user's own`;
}

let guarded = false;

/** Under a test (the preload; a test daemon at its start): `Bun.secrets` throws for any call that isn't isolated
 *  (`osStoreIsolated`), and passes the isolated ones to the real one. Once per process; a no-op outside a test. */
export function guardBunSecrets(env: Env = process.env, platform: NodeJS.Platform = process.platform, distBuild: boolean = DIST_BUILD): void {
  if (guarded || !underTest(env, distBuild) || typeof Bun === "undefined") return;
  const real = Bun.secrets;
  const check = (service: string) => { if (!osStoreIsolated(service, env, platform)) throw new Error(unisolatedSecretsMessage(service, platform)); };
  const fenced = {
    get: (async (o: { service: string; name: string }) => { check(o.service); return real.get(o); }) as SecretsCalls["get"],
    set: (async (o: { service: string; name: string; value: string }) => { check(o.service); return real.set(o); }) as SecretsCalls["set"],
    delete: (async (o: { service: string; name: string }) => { check(o.service); return real.delete(o); }) as SecretsCalls["delete"],
  };
  (Bun as { secrets: unknown }).secrets = fenced;
  guarded = true;
}
