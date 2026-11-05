// WHAT EVERY SEAM FACTORY IS HANDED (review r1, M3).
//
// The spine's promise is that a lane's wiring diff in `src/sdk.ts` — a spine-owned file four lanes
// compile against — is ONE LINE: `stubX(context)` becomes `createX(context)`. That property was true
// for shape and false for arguments while three of the four stubs took none: Lane A's real factory
// needs the injected `peers.claude` AND the `KeychainSeam` (WS-14 §12's credential fetch at spawn has
// no other owner) AND the resolved brand; Lane C's barrier needs the directory to compute
// `HandoffPlan.from`; Lane B's messaging needs the directory it is constructed beside.
//
// So there is ONE context object, built once in `createRuntimeSdk`, and every factory takes it. A
// lane that needs something new adds a field here — a spine edit, but a one-line one, and visible to
// the other three lanes in a single place rather than in four call sites.
//
// WS-23: the official leg's two fields (`peers.claude`, `vendoredOfficialRuntime`) went with it, and
// the keychain seam — which only the official leg's spawn-time credential fetch read — is optional.
import type { BrandProfile } from "@waifucave/clover-agent-sdk";

import type { HostSdk } from "../session-host";
import type { RuntimeDirectory } from "./directory";
import type { RuntimeDirectoryStore } from "./directory-store";
import type { KeychainSeam } from "./keychain";

/** Everything the directory itself needs. */
export interface SeamContext {
  /** The agent SDK's module namespace (`session-host.ts`'s `HostSdk`): the real one, or a test's fake. */
  sdk: HostSdk;
  /** WS-14 §12: the host's credential reads, when it passed any. Nothing in this package reads it (WS-23). */
  keychain?: KeychainSeam;
  /**
   * The RESOLVED profile (I2) — never `Partial`, never a literal, resolved exactly once at
   * construction through the SDK's own `resolveBrand`. Every Winter-owned name any seam
   * spells derives from this.
   */
  brand: BrandProfile;
  directoryStore: RuntimeDirectoryStore;
  /** The daemon's home, for the shared store's lazy resolver and the quarantine (defaults to the SDK's own resolution under `brand`). */
  home?: string;
  /**
   * WS-21: the shared runtime home (`sdkHomeOf(home)`) the canonical store is rooted at. The session
   * host always sets it; absent (a test's bare context), the store is rooted at `home` as before WS-21.
   */
  storeHome?: string;
}

/** What every OTHER seam needs: the same, plus the directory, which is built first. */
export interface SeamContextWithDirectory extends SeamContext {
  directory: RuntimeDirectory;
}
