import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainService, resolveCloverProfile } from "../profile";
import { isolatedTestBackend, underTest } from "./test-isolation";

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /**
   * WS-19 (W19-2): remove the item outright. `true` when something was actually removed, `false`
   * when there was nothing there — the exact shape `credential.remove`'s `removed` field reports.
   *
   * Clover used to have no delete at all: `clearCredentialMaterial` wrote an EMPTY STRING and every
   * reader treated a blank as absent (`readCredentialMaterial`'s own `if (!raw) return null`). That
   * blank-as-absent rule is NOT retired by this method — a home written by an older build still
   * holds blanked items, and they must keep reading as absent — but a *new* removal deletes rather
   * than blanks, so a removed credential leaves no row behind at all.
   */
  delete(name: string): Promise<boolean>;
}

// DD branch review rider: resolved ONCE at module load (unlike `launchdLabel()`'s call-time
// `resolveCloverProfile()` default param) — deliberate, but it means `CLOVER_PROFILE` must be set
// in the environment BEFORE this module is first imported. Mutating `process.env.CLOVER_PROFILE`
// afterward is inert; `SERVICE` will not re-resolve. This is why a launchd-installed dev daemon
// MUST have `CLOVER_PROFILE` baked into its plist's `EnvironmentVariables` (see
// `packages/cli/src/launchd.ts` `renderPlist`) rather than relying on any later mutation.
//
// ISOLATION FIX (2026-10-09): the home an EXPLICIT `CLOVER_HOME` names is passed through, so a process run on a
// custom home honours `CLOVER_KEYCHAIN_SERVICE` (`keychainService`'s own rule). Without it this store — the
// daemon's and the CLI's — always used the profile's REAL service: a hand-started daemon on a temp home probed
// `com.waifucave.clover.core[.dev]` and raised one Keychain prompt per item another binary created. No `CLOVER_HOME`
// still means "assert nothing" (the real service), exactly as before.
//
// LAZY (#243): resolved at the first store's construction, not at import, so nothing about the Keychain (its warning
// for an overridden service included) runs before main.ts's startup checks have had their say.
let defaultService: string | undefined;
export function defaultSecretService(): string {
  defaultService ??= keychainService(resolveCloverProfile(), explicitCloverHome());
  return defaultService;
}

function explicitCloverHome(): string | undefined {
  const home = process.env.CLOVER_HOME;
  return home !== undefined && home.length > 0 ? home : undefined;
}


/** `app-token-acl.ts`'s `APP_TOKEN_SHADOW_SUFFIX`, spelled here so this module stays free of the FFI. */
export const MIGRATION_SHADOW_SUFFIX = ".migrating";

let testBackend: Pick<typeof Bun.secrets, "get" | "set" | "delete"> | undefined;

/** Tests only: the backend every store built without one gets while this is set (an in-memory recorder), so a test
 *  that boots the daemon without injected secrets never reaches a real keychain. In-process: no environment variable
 *  or file can set it. */
export function setDefaultSecretsBackendForTests(backend: Pick<typeof Bun.secrets, "get" | "set" | "delete"> | undefined): void {
  testBackend = backend;
}

/** The production backend: on macOS keychain-ffi pinned to the account's login keychain (`login-keychain.ts` says
 *  why the search list `Bun.secrets` uses is not enough); elsewhere `Bun.secrets` (libsecret, the Credential
 *  Manager). Loaded only on macOS, so this module stays free of the FFI everywhere else. */
export function defaultSecretsBackend(): Pick<typeof Bun.secrets, "get" | "set" | "delete"> {
  if (testBackend !== undefined) return testBackend;
  // Under a test (a test daemon too, by the variables it inherits): an isolated store only (test-isolation.ts). On
  // macOS the pinned backend below already opens the test keychain file, or throws.
  if (process.platform !== "darwin") return underTest() ? isolatedTestBackend(Bun.secrets) : Bun.secrets;
  const { pinnedSecretsBackend } = require("./login-keychain") as typeof import("./login-keychain");
  return pinnedSecretsBackend();
}

/** Production store: the OS's secret store, on macOS the login keychain by path (`defaultSecretsBackend`). */
export class KeychainSecretStore implements SecretStore {
  /** `backend`/`service` exist for tests only (a recording fake, or a throwaway keychain — never the real one). */
  constructor(private readonly backend: Pick<typeof Bun.secrets, "get" | "set" | "delete"> = defaultSecretsBackend(), private readonly service: string = defaultSecretService()) {}
  async get(name: string): Promise<string | null> {
    return (await this.backend.get({ service: this.service, name })) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await this.backend.set({ service: this.service, name, value });
  }
  /** The backend's delete (`Bun.secrets.delete`'s contract) already answers the exact boolean this interface promises ("true if a
   *  credential was deleted, false if not found"), so nothing is re-derived here. WS-27: a migration
   *  shadow of the item (`<name>.migrating`, `auth/credential-acl.ts`) goes with it, so a removed
   *  credential can never be restored from one — deleted FIRST; its own result does not change the answer. */
  async delete(name: string): Promise<boolean> {
    // The shadow FIRST: a crash between the two deletes must never leave a shadow beside a missing original,
    // which recovery would restore.
    if (!name.endsWith(MIGRATION_SHADOW_SUFFIX)) {
      try { await this.backend.delete({ service: this.service, name: `${name}${MIGRATION_SHADOW_SUFFIX}` }); } catch { /* none, or not ours */ }
    }
    return await this.backend.delete({ service: this.service, name });
  }
}

/** Test/CI store: 0600 files in a directory. Never used in production paths. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  async get(name: string): Promise<string | null> {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  async set(name: string, value: string): Promise<void> {
    const p = join(this.dir, name);
    writeFileSync(p, value, { mode: 0o600 });
  }
  /** Unlink, reporting whether a file was actually there. `rmSync(..., {force:true})` never throws
   *  for a missing path, so the existence check decides the return value rather than a caught
   *  ENOENT. */
  async delete(name: string): Promise<boolean> {
    const p = join(this.dir, name);
    const existed = existsSync(p);
    rmSync(p, { force: true });
    return existed;
  }
}
