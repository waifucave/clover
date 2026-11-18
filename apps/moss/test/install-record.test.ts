// MOSS's own install record (src/main/install-record.ts): the file the engine reads for `release.bring` and the host start.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { AppInstallRecord } from "@waifucave/moss-protocol";
import { hostHelperPath } from "../../../packages/core/src/host/world";
import { hostHelperIn } from "@waifucave/moss-app-release/release";
import { bundlePathOf, carriesHost, recordPath, writeOwnRecord } from "../src/main/install-record";

const root = mkdtempSync(join(tmpdir(), "moss-rec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("writes apps/moss.json in the protocol's shape, whole, for the user alone, and again over the old one", () => {
  const home = join(root, "h1");
  const lines: string[] = [];
  expect(writeOwnRecord(home, { bundlePath: "/Apps/MOSS.app", release: "1.2.0", carriesEngine: true, carriesHost: false, now: 5 }, (l) => lines.push(l))).toBe(true);
  const rec = AppInstallRecord.parse(JSON.parse(readFileSync(recordPath(home), "utf8")));
  expect(rec).toMatchObject({ program: "moss", bundlePath: "/Apps/MOSS.app", release: "1.2.0", carries: { engine: true, host: false }, seenAt: 5 });
  if (process.platform !== "win32") expect(statSync(recordPath(home)).mode & 0o777).toBe(0o600);
  expect(writeOwnRecord(home, { bundlePath: "/Apps/MOSS.app", release: "1.3.0", carriesEngine: true, carriesHost: false, now: 6 }, (l) => lines.push(l))).toBe(true);
  expect(JSON.parse(readFileSync(recordPath(home), "utf8")).release).toBe("1.3.0");
  expect(readdirSync(join(home, "apps"))).toEqual(["moss.json"]);
  expect(lines).toEqual([]);
});

test("a bad record is not written and the write never throws", () => {
  const home = join(root, "h2");
  const lines: string[] = [];
  expect(writeOwnRecord(home, { bundlePath: "/Apps/MOSS.app", release: "not a release", carriesEngine: true, carriesHost: false }, (l) => lines.push(l))).toBe(false);
  expect(existsSync(recordPath(home))).toBe(false);
  expect(lines[0]).toContain("was not recorded");
});

test("the bundle is the .app on macOS, the install folder elsewhere, the source folder unpackaged", () => {
  const base = { execPath: "/opt/moss/moss", appPath: "/src/apps/moss" };
  expect(bundlePathOf({ ...base, packaged: true, platform: "darwin", resourcesPath: "/Applications/MOSS.app/Contents/Resources", execPath: "/Applications/MOSS.app/Contents/MacOS/MOSS" })).toBe(normalize("/Applications/MOSS.app"));
  expect(bundlePathOf({ ...base, packaged: true, platform: "linux", resourcesPath: "/opt/moss/resources" })).toBe(normalize("/opt/moss"));
  expect(bundlePathOf({ ...base, packaged: false, platform: "darwin", resourcesPath: "/x" })).toBe(normalize("/src/apps/moss"));
});

test("a copy that carries the host helper says so (lane PK): the engine starts the host from it when only MOSS is installed", () => {
  const home = join(root, "h3");
  const bundle = "/Applications/MOSS.app";
  const helper = hostHelperIn(bundle, "dist");
  // The engine's own rule for where the helper sits, and the apps' copy of it, are one.
  for (const profile of ["dist", "dev"] as const) expect(hostHelperIn(bundle, profile)).toBe(hostHelperPath(bundle, profile));
  expect(carriesHost(bundle, "dist", "darwin", (p) => p === helper)).toBe(true);
  expect(carriesHost(bundle, "dist", "darwin", () => false)).toBe(false);
  // No helper bundle on Windows and Linux: the host there is MOSS Code's own executable.
  expect(carriesHost(bundle, "dist", "linux", () => true)).toBe(false);
  expect(writeOwnRecord(home, { bundlePath: bundle, release: "1.2.0", carriesEngine: true, carriesHost: true, now: 7 }, () => {})).toBe(true);
  expect(AppInstallRecord.parse(JSON.parse(readFileSync(recordPath(home), "utf8"))).carries).toEqual({ engine: true, host: true });
});
