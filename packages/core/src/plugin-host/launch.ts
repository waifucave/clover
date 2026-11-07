// Starting a plugin-host process (spec §5.2): the daemon runs `process-main.ts` on the plugin Bun (#234's
// `pluginBunLaunch` gives the command and the guarded environment), with the link on fd 3, a pipe only the daemon and
// that process hold. The process's stdout and stderr are never read as messages; their lines go to `onOutput` (the
// plugin host's own log).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { linesOf, streamPeer, type RpcPeer } from "./link";

/** The host process's entry, for the launch command. */
export const HOST_PROCESS_ENTRY = fileURLToPath(new URL("./process-main.ts", import.meta.url));

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
