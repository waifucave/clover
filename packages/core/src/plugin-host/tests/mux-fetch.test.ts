// The process's mux in front of the link: a worker's fetch head over a limit (a 20 MiB body would be a line past the
// link's limit as base64, ending the link and every plugin of the process) fails that call there, never forwarded,
// even from a worker that skips the worker's own check (it posts straight to its port).
import { expect, test } from "bun:test";
import { HostMux } from "../mux";
import { loopbackPeers, type RpcPeer } from "../link";

test("an oversized fetch head from a worker is refused by the mux and never reaches the daemon's link", async () => {
  const [daemonEnd, processEnd] = loopbackPeers();
  const toDaemon: string[] = [];
  for (const m of ["pluginHost.fetch", "pluginHost.api"]) daemonEnd.handle(m, (p: unknown) => { toDaemon.push(m); return p; });
  let worker: RpcPeer | undefined;
  const mux = new HostMux({
    daemon: processEnd,
    spawnWorker: () => {
      const [muxSide, workerSide] = loopbackPeers();
      workerSide.handle("pluginHost.start", () => ({ ok: true }));
      worker = workerSide;
      return { peer: muxSide, terminate: () => muxSide.close(), onExit: () => {} };
    },
  });
  try {
    await daemonEnd.request("pluginHost.start", { pluginId: "clover/rogue", folder: "/x", entry: "e.js", runtime: "bun", dataFolder: "/x/d", process: "clover" });
    const err = (await worker!.request("pluginHost.fetch", { pluginId: "clover/rogue", fetchId: "f1", url: "https://api.example.com/", method: "POST", headers: [], body: new Uint8Array(20 * 1024 * 1024) }).catch((e: unknown) => e)) as { code?: string; message?: string };
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("16777216 bytes");
    const pairs = Array.from({ length: 300 }, (_, i) => [`x-${i}`, "v"]);
    expect(((await worker!.request("pluginHost.fetch", { pluginId: "clover/rogue", fetchId: "f2", url: "https://api.example.com/", method: "GET", headers: pairs }).catch((e: unknown) => e)) as { code?: string }).code).toBe("invalid");
    expect(toDaemon).toEqual([]);
    expect(daemonEnd.closed).toBe(false);
  } finally {
    mux.close();
  }
});
