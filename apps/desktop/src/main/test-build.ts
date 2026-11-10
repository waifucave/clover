// A test-marked build of the app (scripts/test-build.ts; scripts/release/build.ts --test-build). The marker is the
// compile-time `__CLOVER_TEST_BUILD__` define, tested in index.ts itself (`typeof __CLOVER_TEST_BUILD__ === "string"`),
// so a real build compiles the branch out and this module with it. In a test build the app keeps off the login
// keychain: Chromium's mock keychain (cookies, os_crypt), the answer key in memory, and its own data under the daemon's
// home; and it refuses to start where it would reach the login keychain or the live home anyway.
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Why a test-marked app refuses to start, or undefined. `mockKeychain` is whether Chromium's `use-mock-keychain` is
 *  on (else cookie encryption and safeStorage reach the login keychain); `home` is the daemon's home, where the app
 *  keeps its own data in a test build; `account` is this account's home from the password database. */
export function testBuildAppRefusal(o: { mockKeychain: boolean; home: string; account: string; real?: (p: string) => string }): string | undefined {
  const refuse = (why: string) => `clover: refusing to start: this is a test-marked build, and ${why}. It runs only on a mock keychain and a temp home, never the login keychain or the live home.`;
  if (!o.mockKeychain) return refuse("Chromium's mock keychain is off (safeStorage would reach the login keychain)");
  const real = o.real ?? ((p: string) => { try { return realpathSync(p); } catch { return resolve(p); } });
  const own = real(o.account);
  const at = real(o.home);
  if (o.home === "" || at === own || at.startsWith(`${own}${sep}`)) return refuse(`its home (${o.home}) is inside this account's home: set HOME or CLOVER_HOME to a temp folder`);
  return undefined;
}
