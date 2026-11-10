// #418's review: `daemon run` makes the daemon its own responsible process FIRST. That call may re-execute the process
// in place, so every boot hook after it runs exactly once per start: the boot count (two would roll an update back
// after one early crash), the update heal and the earlier layout's migration (they spawn launchctl), the bundled
// plugins' recovery and the log file. A spawned `daemon run` can't show it from a test (a test's daemon never re-execs,
// and a real one would touch the real Keychain), so this pins the order in the source.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("daemon run's start order", () => {
  test("ownResponsibilityAtStart comes before every boot hook", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const start = src.indexOf('case "daemon run": {');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("startDaemon()", start));
    const first = body.indexOf("ownResponsibilityAtStart();");
    expect(first).toBeGreaterThan(0);
    for (const hook of ["readInstallMarker(", "migrateEarlierLayout(", "healFromOld(", "beginUpdatedBoot(", "recoverServerPlugins(", "installDaemonLogFile("]) {
      const at = body.indexOf(hook);
      expect([hook, at > first]).toEqual([hook, true]);
    }
    // And only once in the case.
    expect(body.split("ownResponsibilityAtStart();").length).toBe(2);
  });
});
