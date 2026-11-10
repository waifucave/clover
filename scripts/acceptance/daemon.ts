// The source target's daemon for the acceptance run: `startDaemon` from this checkout, as `clover daemon run` starts it,
// with two differences a test daemon needs:
//   - the `app` role's caller check accepts the acceptance run itself and the processes it started directly (the
//     driver speaks as the app, and the headless app is unsigned): `CLOVER_ACCEPTANCE_RUN_PID`. A daemon from source
//     has no signed app to check against; this predicate goes to `startDaemon` as the test seam it takes
//     (`appPeer`), never through the environment of a real daemon;
//   - the bots' `home/<this computer>` is the run's own user folder, not this user's home.
// Never run it by hand: run.ts starts it on a temp home with a throwaway keychain file.
import { startDaemon } from "../../packages/core/src/daemon";
import type { PeerFacts } from "../../packages/core/src/platform/caller-probe";

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

const daemon = await startDaemon({ appPeer, parts: { userHome } });
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
