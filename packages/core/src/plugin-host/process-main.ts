// A plugin-host process (spec §5.2): started by the daemon on the plugin Bun with the link on fd 3 (never stdout,
// which the plugins' own output can't reach the daemon through), it runs `HostMux` over that pipe until the daemon
// closes it. Its own console and stdout carry nothing the daemon reads.
import { createReadStream, createWriteStream } from "node:fs";
import { HostMux, bunWorker } from "./mux";
import { linesOf, streamPeer } from "./link";

const LINK_FD = 3;
const out = createWriteStream("", { fd: LINK_FD });
const peer = streamPeer(linesOf(createReadStream("", { fd: LINK_FD })), (line) => void out.write(`${line}\n`));
const mux = new HostMux({ daemon: peer, spawnWorker: bunWorker(process.env.CLOVER_COMPUTER ?? "") });
peer.onClose(() => {
  mux.close();
  process.exit(0);
});
