// Contract: SecretStore (spec §3.1, §3.3 "Logins stay in the core", §5.1 "Secrets stay out of the folder", §8.1, §8.5
// "Credentials", §9.1 "The secret store"). Owner: lane C.
//
// Where secrets live: on macOS, Keychain items that trust the daemon's binary alone; on Windows and Linux, one
// encrypted file whose key is in the OS store (Credential Manager, the Secret Service). A headless Linux computer with
// no unlocked keyring falls back as §8.5 says (the controller's ruling on spike S8): the key is sealed by
// `systemd-creds --user` (systemd 256 or later), with the TPM where one exists; otherwise it sits in a key file only
// the user can read, and the store's status says `plaintext`, which Settings shows on that computer
// (`ComputerView.secrets`). Bash's fence hides the secrets file and the key file from bots either way (§9.1).
// `secretKeySourceFor` makes the choice. Cloud computers run unattended, so a headless computer never waits locked;
// `locked` is only for a desktop store someone can unlock (a keyring still locked at the login screen), and a locked
// store answers `locked` until it is unlocked.
//
// What the contract promises everyone else:
// * A value leaves the store only through `get`, wrapped in a `Secret`, which prints and serializes as `[secret]`,
//   so a stray log line or error carries no value. Nothing else the store returns or emits carries a value.
// * Each owner reads only its own items: the core enforces a plugin's `${secret:<name>}` and `secrets.get(name)`
//   against `owner` (§5.1), and adapters get access tokens by reference with a generation number (§3.3).
// * Account-wide items sync end-to-end encrypted (§8.5); the device's own key never leaves the device (§8.1).
// * Every write gives the item a new generation, so a caller holding generation n asks for one newer after a 401.
import type { Os, SecretKeySource, SecretStoreView } from "@waifucave/clover-protocol";

export type SecretOwner =
  /** The core's own items: sign-ins, API keys, the bridge's per-session tokens. */
  | { kind: "core" }
  /** A plugin's own secrets (its settings of type `secret`, its `auth` sign-ins, wrapped `env` and `headers`). */
  | { kind: "plugin"; pluginId: string }
  /** This device's own items, never synced: its Ed25519 key, its link keys. */
  | { kind: "device" };

export interface SecretRef {
  owner: SecretOwner;
  /** `[A-Za-z0-9._:-]`, 1–128 characters: `anthropic:default`, `codex-oauth:default`, a plugin's `FISH_KEY`. */
  name: string;
}

export const SECRET_NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** What the store says about an item: never its value. */
export interface SecretMeta {
  ref: SecretRef;
  /** Rises with each write; adapters hold it to ask for a newer token after a 401 (§3.3). */
  generation: number;
  updatedAt: number;
  /** Account-wide and synced to the user's other devices (§8.5). Device items are never synced. */
  synced: boolean;
}

/** `keychain` on macOS (items whose ACL trusts the daemon's binary alone, §9.1); `encrypted-file` on Windows and
 *  Linux (one encrypted file, its key where `keySource` says, item 59); `memory` in tests and fakes. */
export type SecretBackend = SecretStoreView["backend"];

/** The store's status, as `ComputerView.secrets` carries it to Settings: its backend, where the file's key is, the
 *  `plaintext` label, and `locked` with its reason. Never a value. */
export type SecretStoreStatus = SecretStoreView;

/** What the daemon finds at start on Windows or Linux, for `secretKeySourceFor`. */
export interface KeyStoreProbe {
  os: Exclude<Os, "macos">;
  /** Linux: a Secret Service on the session bus, and whether its keyring is unlocked. */
  secretService?: "unlocked" | "locked" | "absent";
  /** Someone can unlock a keyring here: a graphical login session. A server or a cloud computer has none. */
  interactive: boolean;
  /** `systemd-creds --user` works here (systemd 256 or later). */
  systemdCreds: boolean;
  /** A TPM `systemd-creds` can seal to. */
  tpm: boolean;
}

/** Where the secrets file's key goes (§8.5): Windows' Credential Manager; an unlocked keyring; a locked one when
 *  someone can unlock it (the store waits `locked`); otherwise `systemd-creds` (with the TPM where there is one), and
 *  last a plaintext key file only the user can read. */
export function secretKeySourceFor(p: KeyStoreProbe): { source: SecretKeySource; tpm: boolean } | { locked: string } {
  if (p.os === "windows") return { source: "credential-manager", tpm: false };
  if (p.secretService === "unlocked") return { source: "secret-service", tpm: false };
  if (p.secretService === "locked" && p.interactive) return { locked: "the keyring is locked: unlock it to use saved logins" };
  if (p.systemdCreds) return { source: "systemd-creds", tpm: p.tpm };
  return { source: "key-file", tpm: false };
}

/** The status a store reports for a key source: `plaintext` exactly when the key sits unsealed in a file. */
export function encryptedFileStatus(source: SecretKeySource, tpm = false): SecretStoreStatus {
  return { backend: "encrypted-file", keySource: source, ...(source === "systemd-creds" ? { tpm } : {}), plaintext: source === "key-file", state: "unlocked" };
}

export type SecretChange = { meta: SecretMeta; deleted: boolean } | { status: SecretStoreStatus };

/** A secret's value in a wrapper that never prints it. `reveal()` is the one way out, at the point of use. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  get length(): number {
    return this.#value.length;
  }
  toString(): string {
    return "[secret]";
  }
  toJSON(): string {
    return "[secret]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[secret]";
  }
}

export interface SecretValue {
  value: Secret;
  generation: number;
}

export interface SecretStore {
  status(): SecretStoreStatus;
  /** The item, or null when there is none. Rejects with `locked` while the store is locked. */
  get(ref: SecretRef): Promise<SecretValue | null>;
  /** Writes an item and returns its new generation. `synced` defaults to true for core and plugin items and is
   *  always false for device items. Rejects with `locked`, or `invalid` for a bad name. */
  set(ref: SecretRef, value: string | Secret, opts?: { synced?: boolean }): Promise<SecretMeta>;
  /** Whether there was an item to delete. */
  delete(ref: SecretRef): Promise<boolean>;
  /** One owner's items, or every item, by name; works while locked when the backend can list without unlocking. */
  list(owner?: SecretOwner): Promise<SecretMeta[]>;
  /** Changes, without values: a write, a delete, the store locking or unlocking. */
  watch(fn: (change: SecretChange) => void): () => void;
}

export function secretOwnerKey(owner: SecretOwner): string {
  return owner.kind === "plugin" ? `plugin:${owner.pluginId}` : owner.kind;
}

export function secretRefKey(ref: SecretRef): string {
  return `${secretOwnerKey(ref.owner)}/${ref.name}`;
}

/** One key or token as the keyed fetch sends it, with its generation (lane A's `KeyedToken`). */
export interface KeyedToken {
  value: Secret;
  generation: number;
}

/** Where one `auth` entry's key or token comes from, in the shape of lane A's `KeyedTokenSource` (clover-sdk): the
 *  current one, or after a 401 one newer than the generation that was refused. Lane A's reference fetch takes the
 *  value as a string; the core's adapter calls `reveal()` only where it sets the header. */
export interface KeyedTokenSource {
  current(): Promise<KeyedToken | null>;
  newer(generation: number): Promise<KeyedToken | null>;
}

/** The token source for one stored item. `refresh`, the refresher's door (§8.5), is asked for a newer token after a
 *  401 when the stored one is no newer than the one refused; an API key has none, so a 401 is the answer. */
export function secretTokenSource(store: Pick<SecretStore, "get">, ref: SecretRef, refresh?: (generation: number) => Promise<void>): KeyedTokenSource {
  const read = async (): Promise<KeyedToken | null> => {
    const v = await store.get(ref);
    return v === null ? null : { value: v.value, generation: v.generation };
  };
  return {
    current: read,
    async newer(generation) {
      let t = await read();
      if ((t === null || t.generation <= generation) && refresh) {
        await refresh(generation);
        t = await read();
      }
      return t !== null && t.generation > generation ? t : null;
    },
  };
}
