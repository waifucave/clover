// A plugin-host process (spec §5.2): started by the daemon on the plugin Bun with the link on fd 3 (never stdout,
// which the plugins' own output can't reach the daemon through), it runs `HostMux` over that pipe until the daemon
// closes it. Its own console and stdout carry nothing the daemon reads.
import { HostMux, bunWorker } from "./mux";
import { fdLink, streamPeer } from "./link";

const LINK_FD = 3;
const link = fdLink(LINK_FD);
const peer = streamPeer(link.lines, (line) => link.write(`${line}\n`));
// The worker's entry: the bundle the daemon wrote beside the guard (CLOVER_PLUGIN_WORKER), which the guard lets every
// worker load; from source, the module beside this one.
const workerEntry = process.env.CLOVER_PLUGIN_WORKER;
delete process.env.CLOVER_PLUGIN_WORKER;
const mux = new HostMux({ daemon: peer, spawnWorker: bunWorker(process.env.CLOVER_COMPUTER ?? "", workerEntry === undefined || workerEntry === "" ? undefined : workerEntry) });
peer.onClose(() => {
  mux.close();
  // The daemon is gone (or ended this process): what the plugins started goes with it. The daemon starts this process
  // as its group's leader (`spawnHostProcess`), so the group is this process's; where it isn't, there's none to signal.
  if (process.platform !== "win32") {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      /* not a group leader */
    }
  }
  process.exit(0);
});
