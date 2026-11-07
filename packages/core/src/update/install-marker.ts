// What installed this Clover (M-M2): `<home>/install.json`, `{ "kind": "server" | "app" | "package" }`. It decides
// which installs update the daemon themselves: only `server` (`clover-core server install`: no app, the daemon alone
// under the OS's login start) does. The app updates itself and the daemon inside it (electron-updater), and a deb or
// rpm updates through apt or dnf. A missing, unreadable or unknown marker never self-updates.
//
// Who writes it: `clover-core server install` (`server`, with the channel it follows), the app at each start (`app`;
// on Linux outside an AppImage, `package`). A deb's or rpm's script runs as root, outside every user's home, so it
// writes the same marker beside the binary it installed (packaging/linux/after-install.sh); a marker there is read
// first, and wins.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const INSTALL_MARKER = "install.json";
export type InstallKind = "server" | "app" | "package";
export type InstallChannel = "latest" | "beta";

export interface InstallMarker {
  kind: InstallKind;
  /** The update channel a server's daemon follows (default latest). */
  channel?: InstallChannel;
  /** A server install turned lingering on for this user (Linux), so its uninstall turns it off again. */
  linger?: boolean;
}

/** The marker's text, read strictly; undefined for anything that isn't one. */
export function parseInstallMarker(text: string): InstallMarker | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "server" && r.kind !== "app" && r.kind !== "package") return undefined;
  if (r.channel !== undefined && r.channel !== "latest" && r.channel !== "beta") return undefined;
  if (r.linger !== undefined && typeof r.linger !== "boolean") return undefined;
  return { kind: r.kind, ...(r.channel !== undefined ? { channel: r.channel } : {}), ...(r.linger !== undefined ? { linger: r.linger } : {}) };
}

function readMarker(path: string): InstallMarker | undefined {
  try {
    return existsSync(path) ? parseInstallMarker(readFileSync(path, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}

/** This install's marker: the one beside `bin` (a package's) first, then the home's. */
export function readInstallMarker(home: string, bin?: string): InstallMarker | undefined {
  if (bin !== undefined) {
    const beside = readMarker(join(dirname(bin), INSTALL_MARKER));
    if (beside !== undefined) return beside;
  }
  return readMarker(join(home, INSTALL_MARKER));
}

/** Whether this daemon updates itself: a server install, and nothing else. */
export function updatesItself(marker: InstallMarker | undefined): boolean {
  return marker?.kind === "server";
}

/** Writes the home's marker (whole, through a rename). */
export function writeInstallMarker(home: string, marker: InstallMarker): void {
  const path = join(home, INSTALL_MARKER);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeInstallMarker(home: string): void {
  rmSync(join(home, INSTALL_MARKER), { force: true });
}
