// The files an app bundle ships beside its engine, as stand-ins for the engine-copy tests (`engineSidecars`, bundled-identities.ts):
// every name any OS places, so a bundle written for one platform is whole for any.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SIDECAR_NAMES = ["moss-plugin-bun", "moss-link", "moss-process-holder", "moss-plugin-bun.exe", "moss-link.exe"] as const;

/** Writes each stand-in into `daemonDir`, its content naming `tag` (so a test can tell one bundle's from another's). */
export function writeSidecars(daemonDir: string, tag = "sidecar"): void {
  for (const name of SIDECAR_NAMES) {
    writeFileSync(join(daemonDir, name), `${name} ${tag}\n`);
    chmodSync(join(daemonDir, name), 0o755);
  }
}
