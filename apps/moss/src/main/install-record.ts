// Where this copy of MOSS is, written under the engine's home before any engine runs (spec §3.1 "Where the copies are found";
// RL). MOSS Code writes the same file the same way (apps/desktop/src/main/release.ts `writeOwnRecord`): the engine reads
// `<home>/apps/moss.json` when this app, ahead of the engine, asks `release.bring`, and when it starts the host. The shape is the
// protocol's (`AppInstallRecord`), so there is one rule for what a record is; the engine's `release.record` (index.ts) refreshes it
// once connected. Whole through a rename, for the user alone; never throws.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { AppInstallRecord } from "@waifucave/moss-protocol";

/** The folder that is this copy of MOSS: the .app on macOS, the install folder elsewhere, the source folder unpackaged. */
export function bundlePathOf(o: { packaged: boolean; platform: NodeJS.Platform; resourcesPath: string; execPath: string; appPath: string }): string {
  if (!o.packaged) return normalize(o.appPath);
  return normalize(o.platform === "darwin" ? join(o.resourcesPath, "..", "..") : dirname(o.execPath));
}

export function recordPath(home: string): string {
  return join(home, "apps", "moss.json");
}

/** Writes MOSS's record; false (and a line in the log) when it couldn't. `carries.host` is false until the host ships in MOSS. */
export function writeOwnRecord(home: string, o: { bundlePath: string; release: string; build?: string; carriesEngine: boolean; now?: number }, log: (line: string) => void): boolean {
  try {
    const record = AppInstallRecord.parse({
      record: 1, program: "moss", bundlePath: o.bundlePath, release: o.release, ...(o.build !== undefined ? { build: o.build } : {}),
      carries: { engine: o.carriesEngine, host: false }, seenAt: o.now ?? Date.now(),
    });
    const path = recordPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log(`release: this copy of MOSS was not recorded: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
