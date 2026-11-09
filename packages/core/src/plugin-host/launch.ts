// Starting a plugin-host process (spec §5.2): the daemon runs `process-main.ts` on the plugin Bun (#234's
// `pluginBunLaunch` gives the command and the guarded environment), with the link on fd 3, a pipe only the daemon and
// that process hold. The process's stdout and stderr are never read as messages; their lines go to `onOutput` (the
// plugin host's own log).
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { writeHostBundles } from "./bundles";
import { cloverSharedRoots, ensurePluginRunFiles, guardedPluginEnv, pluginBun, pluginHostBunFlags } from "../registry/plugin-run";
import { fdLink, linesOf, streamPeer, type RpcPeer } from "./link";

export { writeHostBundles } from "./bundles";

/** The host process's entry, for the launch command. */
export const HOST_PROCESS_ENTRY = fileURLToPath(new URL("./process-main.ts", import.meta.url));


/** How a plugin-host process starts, guarded (#234's run files, B-M2's host mode): the plugin Bun with Clover's flags and
 *  the host's own guard (`files.hostGuard`), which only these arguments name, so its own thread runs Clover's bundle
 *  unpinned while every worker it starts gets the plugin guard, pinned to its own plugin's folder (`cloverPluginRoot`),
 *  and the worker bundle beside the guard. No environment variable makes a process a host (#322's review, B1). */
export async function hostProcessLaunch(o: { runDir: string; computer: string; base: Readonly<Record<string, string | undefined>>; shared?: readonly string[]; cloverHome?: string; onOutput?: (line: string) => void }): Promise<HostProcessLaunch> {
  const files = ensurePluginRunFiles(o.runDir, o.cloverHome !== undefined ? { cloverHome: o.cloverHome } : {});
  const bundles = await writeHostBundles(dirname(files.guard));
  const env = guardedPluginEnv(o.base, { pluginRoot: dirname(files.guard), files, shared: o.shared ?? cloverSharedRoots() });
  delete env.CLOVER_PLUGIN_ROOT;
  // The flags are in the arguments: BUN_OPTIONS would preload the plugin guard into the host's own thread too (the
  // host's guard sets it for each worker).
  delete env.BUN_OPTIONS;
  env.CLOVER_PLUGIN_WORKER = bundles.worker;
  env.CLOVER_COMPUTER = o.computer;
  const bun = pluginBun(files.cloverHome);
  const shared = o.shared ?? cloverSharedRoots();
  return {
    cmd: [bun, ...pluginHostBunFlags(files), bundles.host], env,
    reads: [dirname(files.guard), ...shared, bun],
    ...(o.onOutput ? { onOutput: o.onOutput } : {}),
  };
}

export interface HostProcessLaunch {
  /** The command: the plugin Bun and its flags, then `HOST_PROCESS_ENTRY`. */
  cmd: readonly string[];
  env: Record<string, string>;
  /** What every host process reads besides its plugin's tree, under the fence: the run files, the shared packages and
   *  its Bun (`cmd[0]`, the one program it runs). */
  reads?: readonly string[];
  onOutput?: (line: string) => void;
}

/** How long a host process's group has between SIGTERM and SIGKILL when it's ended. */
export const HOST_KILL_GRACE_MS = 2_000;

/** Starts a host process in a process group of its own (POSIX), so ending it ends what its plugins started too (#322's
 *  review, S4): the daemon's stop and close (`kill`), the link closing, and the process exiting on its own (a crash)
 *  each signal the whole group, SIGTERM then SIGKILL after `HOST_KILL_GRACE_MS`. A process that goes on its own way
 *  (a new session, `setsid`) has left the group, and isn't reached. On Windows the process alone is ended. */
export function spawnHostProcess(o: HostProcessLaunch & { graceMs?: number }): { peer: RpcPeer; pid: number | undefined; kill(): void } {
  const group = process.platform !== "win32";
  // Through Bun.spawn: a node:child_process spawn with a descriptor past 2 is refused in Bun code (lane C's S7 finding,
  // `test/platform/child-process-stdio.test.ts`). `detached` makes the child its group's leader.
  const child = Bun.spawn([...o.cmd], { env: o.env, stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true, ...(group ? { detached: true } : {}) });
  const link = fdLink(child.stdio[3] as unknown as number);
  const peer = streamPeer(link.lines, (line) => link.write(`${line}\n`));
  for (const s of [child.stdout, child.stderr]) {
    void (async () => {
      for await (const line of linesOf(s as unknown as AsyncIterable<Uint8Array>)) o.onOutput?.(line.slice(0, 4000));
    })();
  }
  const pid = child.pid;
  const signal = (sig: "SIGTERM" | "SIGKILL"): boolean => {
    if (!group) {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
      return true;
    }
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false; // the group is empty
    }
  };
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    if (!signal("SIGTERM")) return;
    const timer = setTimeout(() => {
      // Only a group still there: none left means nothing to kill (and no later group reusing the id is touched).
      if (!group || (() => { try { process.kill(-pid, 0); return true; } catch { return false; } })()) signal("SIGKILL");
    }, o.graceMs ?? HOST_KILL_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  void child.exited.then(() => {
    peer.close();
    end();
  });
  peer.onClose(end);
  return { peer, pid, kill: end };
}
