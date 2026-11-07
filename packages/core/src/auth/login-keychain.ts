// Clover's own Keychain items live in the account's LOGIN keychain, and every production read and write names it
// (#243 check 3). `Bun.secrets`, `SecItem*` and a `null` keychain-ffi target all search the user's keychain search
// list (and create in the default keychain), which a same-user process can change (`security list-keychains -d
// user -s <its keychain> …`, `security default-keychain -s`): a look-alike item in a keychain put first would be
// read in place of the real one, and a new item written where that process can read it. Opening the login
// keychain by path pins both, and the path comes from the password database's home by real path
// (`getpwuid(getuid())->pw_dir`, startup-guard.ts's `accountHome`), never from HOME.
//
// macOS only. On Linux and Windows `Bun.secrets` (libsecret, the Credential Manager) stays the backend.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { accountHome } from "../startup-guard";
import { deleteGenericPassword, ERR_SEC_NO_SUCH_KEYCHAIN, KeychainFfiError, openKeychainPath, readGenericPassword, setGenericPassword, type KeychainFile } from "./keychain-ffi";

/** `<pw_dir>/Library/Keychains/login.keychain-db`, by real path. Throws when the account's home can't be read. */
export function loginKeychainPath(account: () => string | undefined = accountHome): string {
  const home = account();
  if (home === undefined) throw new KeychainFfiError("login keychain (the account's home could not be read)", ERR_SEC_NO_SUCH_KEYCHAIN);
  const path = join(realpathSync(home), "Library", "Keychains", "login.keychain-db");
  try {
    return realpathSync(path);
  } catch {
    throw new KeychainFfiError("login keychain (none at the account's home)", ERR_SEC_NO_SUCH_KEYCHAIN);
  }
}

let opened: KeychainFile | undefined;

/** The account's login keychain, opened once per process. */
export function loginKeychain(): KeychainFile {
  opened ??= openKeychainPath(loginKeychainPath());
  return opened;
}

/** The three `Bun.secrets` calls Clover uses, with its signatures. */
export type SecretsBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

/** `Bun.secrets`' get/set/delete over keychain-ffi, pinned to one keychain (the login keychain in production).
 *  Same rules: a missing item reads `null`, an empty value deletes, delete answers whether there was one. */
export function pinnedSecretsBackend(keychain: () => KeychainFile = loginKeychain): SecretsBackend {
  return {
    get: async ({ service, name }) => readGenericPassword(keychain(), service, name),
    set: async ({ service, name, value }) => {
      if (value === "") deleteGenericPassword(keychain(), service, name);
      else setGenericPassword(keychain(), service, name, value);
    },
    delete: async ({ service, name }) => deleteGenericPassword(keychain(), service, name),
  };
}
