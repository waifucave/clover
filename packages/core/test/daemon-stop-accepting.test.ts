// A daemon that is stopping must not look connectable (try 9: the owner quit with a turn running and reopened 4 s
// later; the old daemon, still going, took the new app's connection and never answered its proof). Once the pair
// stops the daemon, its listener is gone at once: a new connection is refused before the stop's tail has run, and the
// whole stop is bounded (`stopWithin`).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { startDaemon, stopWithin, type RunningDaemon } from "../src/daemon";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

const connects = (path: string): Promise<boolean> => Bun.connect({ unix: path, socket: { data() {} } }).then((s) => { s.end(); return true; }, () => false);

describe.skipIf(process.platform === "win32")("a daemon the pair stops", () => {
  test("takes no new connection from the moment the pair stops it, and its stop ends within the bound", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-stopacc-"));
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
      links: { binary: null, handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" } },
      parts: { userHome: mkdtempSync(join(tmpdir(), "clover-stopacc-user-")) },
    });
    expect(await connects(daemon.socketPath)).toBe(true);
    // The pair stops (no app: at once). The daemon's own stop runs a moment later (the pair's answer goes first).
    daemon.quitPair("quit");
    expect(await connects(daemon.socketPath)).toBe(false);
    const why = await daemon.pairStopped;
    expect(why).toContain("quit");
    const t0 = performance.now();
    const d = daemon;
    daemon = undefined;
    await stopWithin(d, 5_000);
    expect(performance.now() - t0).toBeLessThan(5_500);
    expect(existsSync(d.socketPath)).toBe(false);
  }, 60_000);
});
