// The process-wide identity the SDK's provider adapters put on the wire (C0, review S1): the product token in
// `User-Agent` and vendor identity headers, the Codex backend's `originator` (spec §3.3, the owner's decision:
// "clover") and the contact URL.
//
// The SDK keeps ONE identity per process (`@yanlinglabs/winter-provider-runtime`'s `setWinterIdentity`), and it is
// the SDK's own default until something sets it. A runtime session installs its brand's identity for its own
// calls, but the daemon's own provider calls — titles, the bash reviewer, the dreamer, the cleaner — and the CLI's
// run outside any session. So this module installs Clover's identity, from `CORE_BRAND`, as soon as core is
// loaded: every process that loads core presents as Clover. `startDaemon` and the CLI call it again at start (a
// no-op), so the intent is visible where they begin.
import { setWinterIdentity } from "@yanlinglabs/winter-provider-runtime";
import { CORE_BRAND } from "./brand";

let installed = false;

/** Installs Clover's identity process-wide, once. The bottom frame: a session's own frame sits above it. */
export function installCloverProcessIdentity(): void {
  if (installed) return;
  installed = true;
  setWinterIdentity({ product: CORE_BRAND.packageName, codexOriginator: CORE_BRAND.codexOriginator, contactUrl: CORE_BRAND.contactUrl });
}

installCloverProcessIdentity();
