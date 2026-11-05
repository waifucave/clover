// Real daemons in this test process, each on its own temp home with a file secret store.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { linkTransportFake, startDaemons, startTestDaemon, UNLINKED, type DaemonCluster, type HarnessDaemon, type HarnessLink } from "../src/daemons";
import { daemonSupported } from "../src/platform";

let cluster: DaemonCluster | undefined;
let single: HarnessDaemon | undefined;
afterEach(async () => {
  await cluster?.stop();
  await single?.stop();
  cluster = undefined;
  single = undefined;
});

// The daemon runs on macOS only until lane C's C1 (`src/platform.ts`).
describe.if(daemonSupported())("daemons in a test", () => {
  test("one daemon, driven by a fake app client", async () => {
    single = await startTestDaemon({ name: "solo" });
    expect(single.home.home.startsWith(tmpdir())).toBe(true);
    const app = await single.connectApp();
    const status = (await app.call("daemon.status")) as { socketPath: string; sessionsCount: number };
    expect(status.socketPath).toBe(single.socketPath);
    expect(status.sessionsCount).toBe(0);
    await expect(app.call("no.such.method")).rejects.toThrow();
  }, 60_000);

  test("several daemons side by side: their own homes, sockets and tokens", async () => {
    cluster = await startDaemons(["mac", "linux-box", "server"]);
    expect(cluster.link).toBe(UNLINKED);
    const homes = new Set(cluster.daemons.map((d) => d.home.home));
    const sockets = new Set(cluster.daemons.map((d) => d.socketPath));
    expect(homes.size).toBe(3);
    expect(sockets.size).toBe(3);
    for (const d of cluster.daemons) {
      const app = await d.connectApp({ clientName: `app on ${d.name}` });
      expect(((await app.call("daemon.status")) as { socketPath: string }).socketPath).toBe(d.socketPath);
    }
    expect(cluster.get("server").name).toBe("server");
    expect(() => cluster!.get("nope")).toThrow(/no daemon called nope/);
    const stopped = cluster;
    cluster = undefined;
    await stopped.stop();
    for (const h of homes) expect(existsSync(h)).toBe(false);
  }, 120_000);

  test("the link seam: a HarnessLink joins the cluster's daemons and closes before they stop", async () => {
    const seen: string[] = [];
    const link: HarnessLink = {
      name: "recording",
      join: (daemons) => { seen.push(`join ${daemons.map((d) => d.name).join(",")}`); },
      close: () => { seen.push("close"); },
    };
    cluster = await startDaemons(2, { link });
    expect(seen).toEqual(["join device-1,device-2"]);
    await cluster.stop();
    cluster = undefined;
    expect(seen).toEqual(["join device-1,device-2", "close"]);
  }, 120_000);

  test("the fake link is lane B's, and says so until it lands", () => {
    expect(() => linkTransportFake()).toThrow(/LinkTransport fake/);
  });

  test("names must be unique", async () => {
    await expect(startDaemons(["a", "a"])).rejects.toThrow(/unique/);
  });
});
