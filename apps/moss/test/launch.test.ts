// How MOSS starts: no debugging door (debug-guard.ts), and where its answer key is kept (answer-key.ts `vaultChoice`,
// `fileVault`): the dev app's key stays across starts in its own user data, a packaged app's is in the OS's store, a test
// or headless run's in memory (or the acceptance's kept file).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileVault, ProgramAnswerKey, vaultChoice } from "../src/main/answer-key";
import { refusedLaunchSwitches } from "../src/main/debug-guard";

const dir = mkdtempSync(join(tmpdir(), "moss-launch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("no debugging door", () => {
  const none = () => false;
  test("a packaged app refuses the DevTools port, the inspector and the net log", () => {
    expect(refusedLaunchSwitches({ argv: ["MOSS", "--remote-debugging-port=9222", "--inspect", "--log-net-log=/tmp/x"], hasSwitch: none, packaged: true, env: {} })).toEqual(["inspect", "log-net-log", "remote-debugging-port"]);
    // Chromium's own command line counts as well as the arguments.
    expect(refusedLaunchSwitches({ argv: ["MOSS"], hasSwitch: (n) => n === "remote-debugging-pipe", packaged: true, env: {} })).toEqual(["remote-debugging-pipe"]);
    // The dev opt-in is never read by a packaged app.
    expect(refusedLaunchSwitches({ argv: ["MOSS", "--inspect"], hasSwitch: none, packaged: true, env: { MOSS_DEV_DEBUG: "1" } })).toEqual(["inspect"]);
  });

  test("the dev app debugs only on its opt-in; a test build's DevTools port alone, never the pipe or the address", () => {
    expect(refusedLaunchSwitches({ argv: ["e", "--inspect"], hasSwitch: none, packaged: false, env: {} })).toEqual(["inspect"]);
    expect(refusedLaunchSwitches({ argv: ["e", "--inspect"], hasSwitch: none, packaged: false, env: { MOSS_DEV_DEBUG: "1" } })).toEqual([]);
    expect(refusedLaunchSwitches({ argv: ["e", "--remote-debugging-port=0"], hasSwitch: none, packaged: false, env: {}, testDebug: true })).toEqual([]);
    expect(refusedLaunchSwitches({ argv: ["e", "--remote-debugging-port=0", "--remote-debugging-address=0.0.0.0", "--remote-debugging-pipe"], hasSwitch: none, packaged: false, env: {}, testDebug: true })).toEqual(["remote-debugging-address", "remote-debugging-pipe"]);
  });
});

describe("where the answer key is kept", () => {
  const base = { packaged: false, headless: false, testBuild: false, profile: "dist" as const, platform: "darwin" as const };
  test("the dev app: a file of its own, so it registers the same key at every start", () => {
    expect(vaultChoice({ ...base, profile: "dev" })).toEqual({ kind: "dev-file" });
    expect(vaultChoice({ ...base, profile: "dev", packaged: true })).toEqual({ kind: "dev-file" });
  });

  test("a packaged dist app: the OS's store; Linux's plain-text store: memory", () => {
    expect(vaultChoice({ ...base, packaged: true })).toEqual({ kind: "safe-storage" });
    expect(vaultChoice({ ...base, packaged: true, platform: "linux", linuxPlainText: true })).toEqual({ kind: "memory" });
  });

  test("headless or test-marked runs: memory, or the acceptance's kept file (an absolute path, a test-marked headless run only)", () => {
    expect(vaultChoice({ ...base, headless: true, profile: "dev" })).toEqual({ kind: "memory" });
    expect(vaultChoice({ ...base, testBuild: true })).toEqual({ kind: "memory" });
    expect(vaultChoice({ ...base, testBuild: true, headless: true, testKeyFile: "/tmp/key" })).toEqual({ kind: "file", file: "/tmp/key" });
    expect(vaultChoice({ ...base, testBuild: true, headless: true, testKeyFile: "relative/key" })).toEqual({ kind: "memory" });
    expect(vaultChoice({ ...base, headless: true, testKeyFile: "/tmp/key" })).toEqual({ kind: "memory" });
    expect(vaultChoice({ ...base })).toEqual({ kind: "memory" });
  });

  test("a file-kept key is the same key after a restart, in a file only its owner reads", () => {
    const file = join(dir, "user-data", "answer-key.dev");
    const first = new ProgramAnswerKey(fileVault(file));
    const key = first.publicKey();
    // Owner-only where the OS keeps POSIX modes (Windows has none: its file is in the user's own profile folder).
    if (process.platform !== "win32") expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(new ProgramAnswerKey(fileVault(file)).publicKey()).toBe(key);
    expect(fileVault(file).held).toBe("none");
  });
});
