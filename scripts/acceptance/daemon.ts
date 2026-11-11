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
import { existsSync } from "node:fs";
import { startDaemon, stopWithin } from "../../packages/core/src/daemon";
import type { PeerFacts } from "../../packages/core/src/platform/caller-probe";
import { MemoryNetwork } from "../../packages/core/src/links/memory-wire";
import { USAGE_INERT } from "../../packages/core/src/usage/wiring";
import { fakeExa, REVIEWER_SAFE_HOST, searchOnlySeam } from "./fake-exa";

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
// A wait before the plugin registry opens (the cold-start step widens the window the app can connect into).
const opening = Number(process.env.CLOVER_ACCEPTANCE_REGISTRY_DELAY_MS);
const answering = Number(process.env.CLOVER_ACCEPTANCE_REGISTRY_ANSWER_DELAY_MS);
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
// A safety reviewer that never calls a model: "safe" only for what names the run's reviewer-safe host (stage 2's
// network request), "unsafe" for anything else, so what it can't vouch for still raises its card as before.
const reviewer = {
  review: async (input: unknown) => (JSON.stringify(input).includes(REVIEWER_SAFE_HOST) ? { verdict: "safe" as const, reason: "the acceptance run's own host" } : { verdict: "unsafe" as const, reason: "the acceptance reviewer vouches only for its own host" }),
};
const daemon = await startDaemon({ appPeer, parts: { userHome, reviewer }, links, usage: USAGE_INERT, pluginFetch, ...(Number.isFinite(opening) && opening > 0 ? { pluginsOpenDelayMs: opening } : {}), ...(Number.isFinite(answering) && answering > 0 ? { pluginsOpenAnswerDelayMs: answering } : {}) });
console.error(`acceptance daemon: listening on ${daemon.socketPath}`);
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await stopWithin(daemon);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// A daemon slow to go (CLOVER_TEST_STOP_HOLD_FILE, the reopen step's, as a test-marked core takes it in
// packages/cli/src/main.ts): once the pair stopped (the listener already closed by the core), it holds the process, its
// lock and its runtime until the run writes that file (once the reopened app has dialled), at most 30 s, as a daemon
// finishing a turn's teardown does.
const holdFile = process.env.CLOVER_TEST_STOP_HOLD_FILE;
void daemon.pairStopped.then(async (why) => {
  console.error(`acceptance daemon: the pair stopped (${why})`);
  if (holdFile !== undefined && holdFile !== "") {
    console.error("acceptance daemon: holding until the run lets it go (a daemon slow to go)");
    const until = Date.now() + 30_000;
    while (Date.now() < until && !existsSync(holdFile)) await new Promise((r) => setTimeout(r, 100));
  }
  void stop();
});
