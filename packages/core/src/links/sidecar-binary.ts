// Where the daemon finds its link sidecar, clover-link (native/link): beside its own executable. Lane M ships the two
// side by side in the app's resources/daemon/ (apps/desktop/electron-builder.yml; scripts/build-packages.ts stages
// them, and its package check holds a package to it), so a compiled clover-core finds the sidecar that came with it,
// and never one from the environment or the PATH: the sidecar is handed the device key. A daemon run from source has
// no sidecar beside it (its executable is Bun); tests pass `SidecarWireOptions.binary` themselves.
import { posix, win32 } from "node:path";

/** The sidecar's file name on `platform`: Windows needs the `.exe`. */
export function linkBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "clover-link.exe" : "clover-link";
}

/** The sidecar beside the daemon's executable (`SidecarWireOptions.binary`). */
export function bundledLinkBinary(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(path.dirname(execPath), linkBinaryName(platform));
}
