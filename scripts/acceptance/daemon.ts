// The source target's daemon for the acceptance run: `startDaemon` from this checkout, as `clover daemon run` starts it,
// with two differences a test daemon needs:
//   - the `app` role's caller check accepts the acceptance run itself and the processes it started directly (the
//     driver speaks as the app, and the headless app is unsigned): `CLOVER_ACCEPTANCE_RUN_PID`. A daemon from source
//     has no signed app to check against; this predicate goes to `startDaemon` as the test seam it takes
//     (`appPeer`), never through the environment of a real daemon;
//   - the bots' `home/<this computer>` is the run's own user folder, not this user's home;
//   - its links run on an in-memory wire with a stand-in for public time (below), where a packaged daemon has its link
//     sidecar and SNTP.
// Never run it by hand: run.ts starts it on a temp home with a throwaway keychain file.
import { startDaemon } from "../../packages/core/src/daemon";
import type { PeerFacts } from "../../packages/core/src/platform/caller-probe";
import { MemoryNetwork } from "../../packages/core/src/links/memory-wire";
import { USAGE_INERT } from "../../packages/core/src/usage/wiring";
import { fakeExa, searchOnlySeam } from "./fake-exa";

const runPid = Number(process.env.CLOVER_ACCEPTANCE_RUN_PID);
const userHome = process.env.CLOVER_ACCEPTANCE_USER_HOME;
if (!Number.isInteger(runPid) || runPid <= 1 || userHome === undefined || userHome === "") {
  console.error("acceptance daemon: start it through scripts/acceptance/run.ts");
  process.exit(2);
}
if (!process.env.CLOVER_HOME || !process.env.CLOVER_TEST_KEYCHAIN) {
  console.error("acceptance daemon: refusing to start without a temp CLOVER_HOME and a throwaway keychain file");
  process.exit(2);
}

const appPeer = (peer: PeerFacts): boolean => peer.pid !== null && (peer.pid === runPid || peer.ancestors[0] === runPid);

// Links up and public time, as a packaged daemon has them (its link sidecar), so the source run sees what they change
// (a fractional SNTP offset once kept every card from the app, and only the packaged run showed it). Nothing leaves the
// machine: an in-memory wire with no other device on it, no account or handshake, no directories' driver or network
// watch, and a public time source that answers a fractional offset, as SNTP's is, without asking any server.
const links = {
  wire: (k: { publicKey: Uint8Array }) => new MemoryNetwork().endpoint(k.publicKey),
  handshake: null, account: null, driver: false as const, watch: () => () => {},
  publicTime: { sample: async () => ({ offsetMs: 37.5 + Math.random(), rttMs: 1.25 }) },
};
// Usage-inert (packages/core/src/usage/wiring.ts): it never reads or runs the user's own Codex, Claude Code, Antigravity or
// OpenCode, nor the plan beat, temp home or not.
// The plugins' keyed net.fetch reaches nothing outside this machine: the bundled web plugin's search host is answered
// here by the run's fake search backend (fake-exa.ts), and any other host is refused and logged (the run fails on it).
const exa = fakeExa();
const pluginFetch = searchOnlySeam({
  calls: exa.calls,
  handle: async (req) => {
    const res = await exa.handle(req);
    console.error(`acceptance daemon: the fake search backend answered ${req.method} ${new URL(req.url).pathname}`);
    return res;
  },
}, (host) => console.error(`acceptance daemon: net.fetch to ${host} refused: the run reaches no network`));
const daemon = await startDaemon({ appPeer, parts: { userHome }, links, usage: USAGE_INERT, pluginFetch });
console.error(`acceptance daemon: listening on ${daemon.socketPath}`);
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await daemon.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
void daemon.pairStopped.then((why) => { console.error(`acceptance daemon: the pair stopped (${why})`); void stop(); });
