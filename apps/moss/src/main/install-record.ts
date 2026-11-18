// Where this copy of MOSS is, written under the engine's home before any engine runs (spec §3.1 "Where the copies are found";
// RL). MOSS Code writes the same file the same way (apps/desktop/src/main/release.ts `writeOwnRecord`): the engine reads
// `<home>/apps/moss.json` when this app, ahead of the engine, asks `release.bring`, and when it starts the host. The shape is the
// protocol's (`AppInstallRecord`), so there is one rule for what a record is; the engine's `release.record` (index.ts) refreshes it
// once connected. Whole through a rename, for the user alone; never throws. Since lane PK MOSS carries the host too.
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { hostHelperIn, writeOwnRecord as writeRecord } from "@waifucave/moss-app-release/release";

/** The folder that is this copy of MOSS: the .app on macOS, the install folder elsewhere, the source folder unpackaged. */
export function bundlePathOf(o: { packaged: boolean; platform: NodeJS.Platform; resourcesPath: string; execPath: string; appPath: string }): string {
  if (!o.packaged) return normalize(o.appPath);
  return normalize(o.platform === "darwin" ? join(o.resourcesPath, "..", "..") : dirname(o.execPath));
}

export function recordPath(home: string): string {
  return join(home, "apps", "moss.json");
}

/** Writes MOSS's record (the apps' shared `writeOwnRecord`, so both apps write one rule): what this copy carries, the engine
 *  and the host helper, as found in its bundle. False (and a line in the log) when it couldn't. */
export function writeOwnRecord(home: string, o: { bundlePath: string; release: string; build?: string; carriesEngine: boolean; carriesHost: boolean; now?: number }, log: (line: string) => void): boolean {
  return writeRecord(home, { program: "moss", bundlePath: o.bundlePath, release: o.release, ...(o.build !== undefined ? { build: o.build } : {}), ...(o.now !== undefined ? { now: o.now } : {}), carries: { engine: o.carriesEngine, host: o.carriesHost } }, (line) => log(line.replace("this app's record was not written", "this copy of MOSS was not recorded")));
}

/** Whether this copy of MOSS carries the background host (macOS: the helper in its bundle; Windows and Linux carry none yet:
 *  there the host is MOSS Code's own executable). */
export function carriesHost(bundlePath: string, profile: "dist" | "dev", platform: NodeJS.Platform, exists: (p: string) => boolean = existsSync): boolean {
  return platform === "darwin" && exists(hostHelperIn(bundlePath, profile));
}
