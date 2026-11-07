// The daemon's own link sidecar (the daemon integration lane): a real daemon in a temp home starts the built
// `clover-link` on loopback (no relay, nothing published), the Clover server's `linkPid` is that child, and the stop
// ends it: no child is left behind. Run by the link job, which builds the sidecar (`CLOVER_LINK_REQUIRE_BINARY=1`);
// skipped where it isn't built, and on Windows, whose process list this test doesn't read.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../daemon";

const BIN = process.env.CLOVER_LINK_BIN ?? join(import.meta.dir, "../../../../../native/link/target/release/clover-link");
const built = existsSync(BIN);
if (!built && process.env.CLOVER_LINK_REQUIRE_BINARY === "1") throw new Error(`CLOVER_LINK_REQUIRE_BINARY=1, but there is no clover-link at ${BIN}`);

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

/** This process's children running `clover-link`. */
function sidecarChildren(): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  return out.split("\n").map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && Number(f[1]) === process.pid && f.slice(2).join(" ").endsWith("clover-link")).map((f) => Number(f[0]));
}

async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe.skipIf(!built || process.platform === "win32")("the daemon's link sidecar", () => {
  test("the stop ends the link sidecar it started, which is the Clover server's linkPid: no child is left behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-int-home-"));
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false,
      // Loopback only, no relay, nothing published: nothing leaves the machine.
      links: {
        binary: BIN, sidecar: { relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0" }, handshake: null, publicTime: null,
        mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {},
      },
      parts: { userHome: mkdtempSync(join(tmpdir(), "clover-int-user-")), bots: false },
    });
    await daemon.cloverParts.ready;
    expect(daemon.cloverParts.node()).toBeDefined();
    expect(sidecarChildren()).toEqual([daemon.cloverParts.links()!.sidecarPid()!]);
    await daemon.stop();
    daemon = undefined;
    await waitFor("the sidecar to exit", () => sidecarChildren().length === 0);
  }, 30_000);
});
