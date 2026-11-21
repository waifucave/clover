// The source target's daemon for the acceptance run: `startDaemon` from this checkout, as `moss daemon run` starts it,
// with two differences a test daemon needs:
//   - the `app` role's caller check accepts the acceptance run itself and the processes it started directly (the
//     driver speaks as the app, and the headless app is unsigned): `MOSS_ACCEPTANCE_RUN_PID`. A daemon from source
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
import { fakeExa, searchOnlySeam } from "./fake-exa";
import { hostLockPid } from "./host-step";
import { scaled } from "./time-scale";

const runPid = Number(process.env.MOSS_ACCEPTANCE_RUN_PID);
const userHome = process.env.MOSS_ACCEPTANCE_USER_HOME;
if (!Number.isInteger(runPid) || runPid <= 1 || userHome === undefined || userHome === "") {
  console.error("acceptance daemon: start it through scripts/acceptance/run.ts");
  process.exit(2);
}
if (!process.env.MOSS_HOME || !process.env.MOSS_TEST_KEYCHAIN) {
  console.error("acceptance daemon: refusing to start without a temp MOSS_HOME and a throwaway keychain file");
  process.exit(2);
}

// lane HS: and the background host this daemon's engine started from the checkout (MOSS_HOST_COMMAND, through Launch
// Services, so launchd's child and not the run's): the process holding the home's host lock (an OS lock, host-step.ts).
const hostRun = process.env.MOSS_HOST_COMMAND !== undefined;
const appPeer = (peer: PeerFacts): boolean => peer.pid !== null && (peer.pid === runPid || peer.ancestors[0] === runPid || (hostRun && peer.pid === hostLockPid(process.env.MOSS_HOME!)));

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
const opening = Number(process.env.MOSS_ACCEPTANCE_REGISTRY_DELAY_MS);
const answering = Number(process.env.MOSS_ACCEPTANCE_REGISTRY_ANSWER_DELAY_MS);
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
}, (host) => console.error(`acceptance daemon: net.fetch to ${host} refused: the run reaches no network`),
// The run's fake plugin index and npm registry (fake-exa.ts pluginWorldResponse): files the run writes to publish.
process.env.MOSS_ACCEPTANCE_PLUGIN_WORLD);
// The one-time copy of an old home staged: stop with the app kept, and exit 76 (start me again now), as `moss daemon run`
// does; the run starts the next daemon, which swaps the copy in.
const requestRestart = (): void => {
  console.error("acceptance daemon: restarting to swap the old home's copy in");
  void (async () => { try { await stopWithin(daemon, undefined, { keepApp: true }); } finally { process.exit(76); } })();
};
const daemon = await startDaemon({ appPeer, heartbeatTimeoutMs: scaled(15_000), parts: { userHome }, links, usage: USAGE_INERT, pluginFetch, requestRestart, ...(Number.isFinite(opening) && opening > 0 ? { pluginsOpenDelayMs: opening } : {}), ...(Number.isFinite(answering) && answering > 0 ? { pluginsOpenAnswerDelayMs: answering } : {}) });
console.error(`acceptance daemon: listening on ${daemon.socketPath}`);
// A CI runner (run.ts sets MOSS_ACCEPT_DIAGNOSE): a tick every 500 ms; one that comes more than a second late says this daemon's loop was
// held up (or the machine was), with the time, which the daemon's own lines do not carry. See stall-watch.ts.
if (process.env.MOSS_ACCEPT_DIAGNOSE === "1") {
  let last = Date.now();
  const beat = setInterval(() => {
    const t = Date.now();
    if (t - last > 1_500) console.error(`${new Date(t).toISOString()} acceptance daemon: its loop ran ${t - last - 500} ms late (a tick every 500 ms)`);
    last = t;
  }, 500);
  beat.unref();
}
let stopping = false;
// A stop cut off at its bound (MOSS_TEST_STOP_BUDGET_MS, the capped reopen step's): the bound a slow stop hits
// (try 9's took about 20 s against the 5 s one), made short, so the process ends while the stop's tail still runs.
const budget = Number(process.env.MOSS_TEST_STOP_BUDGET_MS);
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await (Number.isFinite(budget) && budget > 0 ? stopWithin(daemon, budget) : stopWithin(daemon));
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// A daemon slow to go (MOSS_TEST_STOP_HOLD_FILE, the reopen step's, as a test-marked core takes it in
// packages/cli/src/main.ts): once the pair stopped (the listener already closed by the core), it holds the process, its
// lock and its runtime until the run writes that file (once the reopened app has dialled), at most 30 s, as a daemon
// finishing a turn's teardown does.
const holdFile = process.env.MOSS_TEST_STOP_HOLD_FILE;
void daemon.pairStopped.then(async (why) => {
  console.error(`acceptance daemon: the pair stopped (${why})`);
  if (holdFile !== undefined && holdFile !== "") {
    console.error("acceptance daemon: holding until the run lets it go (a daemon slow to go)");
    const until = Date.now() + 30_000;
    while (Date.now() < until && !existsSync(holdFile)) await new Promise((r) => setTimeout(r, 100));
  }
  void stop();
});
