// Starting a plugin-host process (spec §5.2): the daemon runs `process-main.ts` on the plugin Bun (#234's
// `pluginBunLaunch` gives the command and the guarded environment), with the link on fd 3, a pipe only the daemon and
// that process hold. The process's stdout and stderr are never read as messages; their lines go to `onOutput` (the
// plugin host's own log).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloverSharedRoots, ensurePluginRunFiles, guardedPluginEnv, pluginBun, pluginBunFlags } from "../registry/plugin-run";
import type { Readable, Writable } from "node:stream";
import { linesOf, streamPeer, type RpcPeer } from "./link";

/** The host process's entry, for the launch command. */
export const HOST_PROCESS_ENTRY = fileURLToPath(new URL("./process-main.ts", import.meta.url));

/** Writes the plugin host's two bundles (the process's thread and a plugin's worker, each one file with everything it
 *  imports) into `dir`, the run folder beside the load guard: a worker's guard lets it load from there and from its
 *  plugin's folder only, never Clover's sources or their node_modules. Rewritten only when the text changes. */
export async function writeHostBundles(dir: string): Promise<{ host: string; worker: string }> {
  const out = { host: join(dir, "plugin-host.js"), worker: join(dir, "plugin-worker.js") };
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./process-main.ts", import.meta.url)), fileURLToPath(new URL("./worker-main.ts", import.meta.url))],
    target: "bun", format: "esm", splitting: false, minify: false, sourcemap: "none", throw: false,
  });
  if (!result.success) throw new Error(`the plugin host's bundles didn't build: ${result.logs.map(String).join("; ")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const o of result.outputs) {
    const file = o.path.includes("worker-main") ? out.worker : out.host;
    const text = await o.text();
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== text) writeFileSync(file, text, { mode: 0o600 });
  }
  return out;
}

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
  const child = spawn(o.cmd[0]!, o.cmd.slice(1), { env: o.env, stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const link = child.stdio[3] as unknown as Readable & Writable;
  const peer = streamPeer(linesOf(link as AsyncIterable<Uint8Array>), (line) => void link.write(`${line}\n`));
  for (const s of [child.stdout, child.stderr]) {
    if (s === null) continue;
    void (async () => {
      for await (const line of linesOf(s as AsyncIterable<Uint8Array>)) o.onOutput?.(line.slice(0, 4000));
    })();
  }
  child.on("exit", () => peer.close());
  peer.onClose(() => {
    if (child.exitCode === null) child.kill();
  });
  return { peer, pid: child.pid, kill: () => child.kill() };
}
