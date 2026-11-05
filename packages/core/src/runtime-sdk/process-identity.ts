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
import { installBrandIdentity } from "@waifucave/clover-provider-runtime";
import { CORE_BRAND } from "./brand";

let installed = false;

/** Installs Clover's identity process-wide, once. The bottom frame: a session's own frame sits above it. */
export function installCloverProcessIdentity(): void {
  if (installed) return;
  installed = true;
  installBrandIdentity(CORE_BRAND);
}

installCloverProcessIdentity();
