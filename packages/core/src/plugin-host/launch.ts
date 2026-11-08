// Starting a plugin-host process (spec §5.2): the daemon runs `process-main.ts` on the plugin Bun (#234's
// `pluginBunLaunch` gives the command and the guarded environment), with the link on fd 3, a pipe only the daemon and
// that process hold. The process's stdout and stderr are never read as messages; their lines go to `onOutput` (the
// plugin host's own log).
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { writeHostBundles } from "./bundles";
import { cloverSharedRoots, ensurePluginRunFiles, guardedPluginEnv, pluginBun, pluginBunFlags } from "../registry/plugin-run";
import { fdLink, linesOf, streamPeer, type RpcPeer } from "./link";

export { writeHostBundles } from "./bundles";

/** The host process's entry, for the launch command. */
export const HOST_PROCESS_ENTRY = fileURLToPath(new URL("./process-main.ts", import.meta.url));


/** How a plugin-host process starts, guarded (#234's run files, B-M2's host mode): the plugin Bun with Clover's flags
 *  and the load guard preloaded, `CLOVER_PLUGIN_HOST=1` so its own thread runs Clover's bundle unpinned while every
 *  worker it starts is pinned to its own plugin's folder (`cloverPluginRoot`), and the worker bundle beside the guard. */
export async function hostProcessLaunch(o: { runDir: string; computer: string; base: Readonly<Record<string, string | undefined>>; shared?: readonly string[]; onOutput?: (line: string) => void }): Promise<HostProcessLaunch> {
  const files = ensurePluginRunFiles(o.runDir);
  const bundles = await writeHostBundles(dirname(files.guard));
  const env = guardedPluginEnv(o.base, { pluginRoot: dirname(files.guard), files, shared: o.shared ?? cloverSharedRoots() });
  delete env.CLOVER_PLUGIN_ROOT;
  env.CLOVER_PLUGIN_HOST = "1";
  env.CLOVER_PLUGIN_WORKER = bundles.worker;
  env.CLOVER_COMPUTER = o.computer;
  return { cmd: [pluginBun(), ...pluginBunFlags(files), bundles.host], env, ...(o.onOutput ? { onOutput: o.onOutput } : {}) };
}

export interface HostProcessLaunch {
  /** The command: the plugin Bun and its flags, then `HOST_PROCESS_ENTRY`. */
  cmd: readonly string[];
  env: Record<string, string>;
  onOutput?: (line: string) => void;
}

export function spawnHostProcess(o: HostProcessLaunch): { peer: RpcPeer; pid: number | undefined; kill(): void } {
  // Through Bun.spawn: a node:child_process spawn with a descriptor past 2 is refused in Bun code (lane C's S7 finding,
  // `test/platform/child-process-stdio.test.ts`).
  const child = Bun.spawn([...o.cmd], { env: o.env, stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const link = fdLink(child.stdio[3] as unknown as number);
  const peer = streamPeer(link.lines, (line) => link.write(`${line}\n`));
  for (const s of [child.stdout, child.stderr]) {
    void (async () => {
      for await (const line of linesOf(s as unknown as AsyncIterable<Uint8Array>)) o.onOutput?.(line.slice(0, 4000));
    })();
  }
  void child.exited.then(() => peer.close());
  peer.onClose(() => {
    if (child.exitCode === null) child.kill();
  });
  return { peer, pid: child.pid, kill: () => child.kill() };
}
