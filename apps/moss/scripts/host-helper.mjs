// MOSS carries the background host too (spec §3.1: each app carries the engine and the host; R7: the host has ONE fixed
// identity, the same in both apps; lane PK). electron-builder's `afterPack` (electron-builder.yml): after MOSS.app is laid
// out and before its fuses are flipped and it is signed, it puts the host helper MOSS Code's build just made into
// `MOSS.app/Contents/Frameworks/MOSS Host.app`, so MOSS's own signing seals it with MOSS.
//
// The helper is MOSS Code's, byte for byte (its app.asar is MOSS Code's main process, which is the host when it runs from the
// helper: apps/desktop/src/main/host-program.ts), never one made from MOSS's own app.asar, which has no host in it. So it is
// made once, by MOSS Code's afterPack (apps/desktop/scripts/host-helper.mjs), and copied from the stash the release build
// names (`MOSS_HOST_HELPER_STASH`), which also refuses a MOSS without it (scripts/release/build.ts). A plain `bun run dist`
// names none: MOSS is packaged without a host, and says so.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const HOST_HELPER_STASH_ENV = "MOSS_HOST_HELPER_STASH";

/** The helper's name MOSS's profile carries (the engine's `hostProductName`): `.dev` ids carry the dev host. */
export function hostHelperName(appId) {
  return appId.endsWith(".dev") ? "MOSS Host Dev.app" : "MOSS Host.app";
}

/** Copies the stashed helper into the laid-out app; returns its path, or undefined when the stash holds none for this profile. */
export function carryHostHelper({ appPath, appId, stash }) {
  const name = hostHelperName(appId);
  const from = join(stash, name);
  if (!existsSync(join(from, "Contents", "Info.plist"))) return undefined;
  const to = join(appPath, "Contents", "Frameworks", name);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  return to;
}

/** electron-builder's `afterPack`. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const packager = context.packager;
  const appPath = join(context.appOutDir, `${packager.appInfo.productFilename}.app`);
  const stash = process.env[HOST_HELPER_STASH_ENV];
  if (!stash) {
    console.log("  • no host helper for MOSS (a plain dist: the release build stages MOSS Code's)");
    return;
  }
  const host = carryHostHelper({ appPath, appId: packager.appInfo.id, stash });
  if (host === undefined) throw new Error(`MOSS's build was given ${HOST_HELPER_STASH_ENV} but it holds no ${hostHelperName(packager.appInfo.id)} (found: ${existsSync(stash) ? readdirSync(stash).join(", ") || "nothing" : "no folder"})`);
  console.log(`  • host helper (MOSS Code's)  ${host}`);
}
