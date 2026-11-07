// Phase 9c Migration B — a `SecretStore` bound to the LEGACY Keychain service name, so
// `daemon.ts`'s production boot hook can hand `runMigrationB` a real `from` store without
// `auth/secret-store.ts`'s `KeychainSecretStore` (whose service is resolved ONCE at module load
// from the CURRENT profile — see that file's own doc comment — and so can never speak for a
// different, legacy service). This is the ONLY place in the tree that constructs a Keychain
// store (the login keychain by path on macOS, `defaultSecretsBackend`) bound to `LEGACY_KEYCHAIN_SERVICE[_DEV]`; every test path uses an in-memory/file
// `SecretStore` instead (Global Constraints: never `Bun.secrets` in a test).
import { defaultSecretsBackend, type SecretStore } from "../auth/secret-store";
import type { CloverProfile } from "../profile";
import { LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE_DEV } from "../legacy-names";
import { genericPasswordPresent, withKeychainUserInteractionDisabled } from "../auth/keychain-ffi";
import { loginKeychain } from "../auth/login-keychain";

export function legacyKeychainServiceFor(profile: CloverProfile): string {
  return profile === "dev" ? LEGACY_KEYCHAIN_SERVICE_DEV : LEGACY_KEYCHAIN_SERVICE;
}

/** Read/write against the pre-rename Keychain service for `profile`. Production wiring only —
 *  `daemon.ts`'s boot hook constructs this exactly once, only when no test override was supplied
 *  (see `startDaemon`'s migration seam). */
export class LegacyKeychainSecretStore implements SecretStore {
  private readonly service: string;
  /** The login keychain by path on macOS (`defaultSecretsBackend`), as every production store. */
  private readonly backend = defaultSecretsBackend();
  constructor(profile: CloverProfile) {
    this.service = legacyKeychainServiceFor(profile);
  }
  async get(name: string): Promise<string | null> {
    return (await this.backend.get({ service: this.service, name })) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    await this.backend.set({ service: this.service, name, value });
  }
  /** WS-19 (W19-2) completes the `SecretStore` interface here too, but NOTHING in Migration B calls
   *  it: the pre-rename Keychain items are the ROLLBACK SOURCE and must stay untouched (CLAUDE.md's
   *  own hard rule about the legacy app, home and Keychain service), so the migration only ever
   *  READS this store. It exists so the type is total, not so a caller can erase the fallback. */
  async delete(name: string): Promise<boolean> {
    return await this.backend.delete({ service: this.service, name });
  }
}

/**
 * WS-25 §7: `clover doctor`'s legacy-item COUNT, by presence alone — each item is located in the user's
 * keychains WITHOUT requesting its data (`keychain-ffi.ts`), so no decrypt happens and no consent dialog
 * can appear, whichever binary created the item. Production wiring only (the CLI's doctor); tests pass
 * their own probe.
 */
export function legacyKeychainPresence(profile: CloverProfile): (name: string) => boolean {
  const service = legacyKeychainServiceFor(profile);
  // User interaction off for each probe (restored after): a locked keychain answers without an unlock
  // dialog (measured: locating an item in a locked keychain is silent; this keeps it so).
  return (name) => withKeychainUserInteractionDisabled(() => genericPasswordPresent(loginKeychain(), service, name));
}
