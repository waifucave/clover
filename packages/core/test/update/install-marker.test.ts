// `<home>/install.json` (src/update/install-marker.ts): only a server install updates the daemon itself; a missing or
// unknown marker never does, and a package's marker beside its binary wins over the home's.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInstallMarker, readInstallMarker, removeInstallMarker, updatesItself, writeInstallMarker } from "../../src/update/install-marker";

describe("the install marker", () => {
  test("only server self-updates; missing, unknown or malformed never does", () => {
    expect(updatesItself({ kind: "server" })).toBe(true);
    expect(updatesItself({ kind: "app" })).toBe(false);
    expect(updatesItself({ kind: "package" })).toBe(false);
    expect(updatesItself(undefined)).toBe(false);
    for (const bad of ["", "{", "null", "[]", '{"kind":"Server"}', '{"kind":"cloud"}', '{"kind":"server","channel":"nightly"}', '{"kind":"server","linger":"yes"}']) {
      expect(updatesItself(parseInstallMarker(bad))).toBe(false);
    }
    expect(parseInstallMarker('{"kind":"server","channel":"beta","linger":true,"extra":1}')).toEqual({ kind: "server", channel: "beta", linger: true });
  });

  test("written and read back from the home; a package's marker beside the binary wins", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-marker-"));
    expect(readInstallMarker(home)).toBeUndefined();
    writeInstallMarker(home, { kind: "server", channel: "beta" });
    expect(readInstallMarker(home)).toEqual({ kind: "server", channel: "beta" });
    const daemonDir = join(home, "opt", "resources", "daemon");
    mkdirSync(daemonDir, { recursive: true });
    const bin = join(daemonDir, "clover-core");
    expect(readInstallMarker(home, bin)).toEqual({ kind: "server", channel: "beta" });
    writeFileSync(join(daemonDir, "install.json"), '{"kind":"package"}\n');
    expect(readInstallMarker(home, bin)).toEqual({ kind: "package" });
    expect(updatesItself(readInstallMarker(home, bin))).toBe(false);
    removeInstallMarker(home);
    expect(readInstallMarker(home)).toBeUndefined();
  });
});
