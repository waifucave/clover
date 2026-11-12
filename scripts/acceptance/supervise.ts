// The source target's stand-in for `clover-core supervise` (packages/cli/src/main.ts runSupervise): the same restart
// loop (`superviseLoop`) waiting on the daemon the same way (`spawnDisclaimed` on macOS, else a child process), with
// the run's source daemon (daemon.ts) as the child. The run's idle step measures it beside the daemon: try 14's
// supervisor spun at ~80% of a core while its daemon was healthy. Never run it by hand: run.ts starts it.
import { join } from "node:path";
import { superviseLoop } from "../../packages/core/src/platform/login/supervise";
import { spawnDisclaimed } from "../../packages/core/src/platform/daemon-children";

const argv = [process.execPath, join(import.meta.dir, "daemon.ts")];
let alive = true;
let stopChild: (() => void) | undefined;
const stop = () => { alive = false; stopChild?.(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const result = await superviseLoop({
  spawnDaemon() {
    const d = process.platform === "darwin" ? spawnDisclaimed(argv) : null;
    if (d) {
      stopChild = () => { try { process.kill(d.pid, "SIGTERM"); } catch { /* gone */ } };
      return { exited: d.exited, stop: stopChild };
    }
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    stopChild = () => child.kill();
    return { exited: child.exited, stop: stopChild };
  },
  wait: async (ms) => { if (!alive) return false; await Bun.sleep(ms); return alive; },
  shouldContinue: () => alive,
});
console.error(`[supervise] loop ended: ${result.ended} (starts=${result.starts}, crashes=${result.crashes})`);
