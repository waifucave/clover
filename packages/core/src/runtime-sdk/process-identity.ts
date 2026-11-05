// The process-wide identity the SDK's provider adapters put on the wire (C0, review S1): the product token in
// `User-Agent` and vendor identity headers, the Codex backend's `originator` (spec §3.3, the owner's decision:
// "clover") and the contact URL.
//
// The SDK keeps ONE identity per process (`@waifucave/clover-provider-runtime`'s identity frames), and it is the
// SDK's own default until something sets it. A runtime session installs its brand's identity for its own
// calls, but the daemon's own provider calls — titles, the bash reviewer, the dreamer, the cleaner — and the CLI's
// run outside any session. So this module installs Clover's identity, from `CORE_BRAND`, as soon as core is
// loaded: every process that loads core presents as Clover. `startDaemon` and the CLI call it again at start (a
// no-op), so the intent is visible where they begin.
//
// A-M1: through the SDK's one brand-to-identity mapping (`installBrandIdentity`, SDK 0.0.63), so the identity carries
// `CORE_BRAND.productVersion`, Clover's own release: `User-Agent: clover-core/<release>`, never the SDK's version
// after Clover's name. Installed once and never removed: the bottom frame for the process's whole life.
//
// A-M1 review (the SDK has no default brand): the same place installs `CORE_BRAND` as the process's BRAND
// (`installBrand`). The SDK no longer falls back to a built-in profile anywhere: a reader that was not handed a brand
// reads the one installed for its process, and with none installed it refuses (`BrandRequiredError`). So in core's
// process an unthreaded SDK call reads Clover's names, never the live install's home, variables or Keychain service.
// Each embedded session's Worker installs its own session's brand (the SDK's production wiring does that).
// When another brand was installed first, core refuses to load: the SDK keeps the first install, so carrying on
// would run core under that brand's names (another product's home, variables and Keychain service).
import { installBrand, installedBrand } from "@waifucave/clover-agent-sdk";
import { installBrandIdentity } from "@waifucave/clover-provider-runtime";
import { CORE_BRAND } from "./brand";

let installed = false;

/**
 * Installs Clover's identity and brand process-wide, once. The identity is the bottom frame (a session's own
 * frame sits above it); the brand is the process's. The SDK's first install wins, so when another brand was
 * installed before core loaded this throws instead of running core under it.
 */
export function installCloverProcessIdentity(): void {
  if (installed) return;
  if (!installBrand(CORE_BRAND)) {
    throw new Error(
      `clover-core: this process already serves another brand (${installedBrand()?.packageName ?? "unknown"}), installed before core loaded; core runs only under ${CORE_BRAND.packageName}'s`,
    );
  }
  installBrandIdentity(CORE_BRAND);
  installed = true;
}

installCloverProcessIdentity();
