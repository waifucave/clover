// Whether the old install's engine is running on its home (ruling 3: never copy while it is). Read only: the lock is
// never taken, not even for a moment (flock would be a lock on the old home), and nothing is written there.
//   * its endpoint answers a dial (its socket on macOS and Linux, its named pipe on Windows), or
//   * the pid its lock file records is a live process while the endpoint file is there (an engine still starting).
// The copy asks before it starts and again when it is done: an engine that came up meanwhile discards the copy.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { endpointAnswers, homePipeId, WINDOWS_PIPE_PREFIX } from "../../platform/transport";
import { OLD_PIPE_STEM } from "./names";

export interface AliveDeps {
  platform?: NodeJS.Platform;
  /** Dials an endpoint; the real one connects and closes at once. */
  answers?: (path: string) => Promise<boolean>;
  /** Whether a pid is a live process (`kill(pid, 0)`: no signal is delivered). */
  pidAlive?: (pid: number) => boolean;
}

/** The old engine's endpoint for its home. */
export function oldEndpoint(oldHome: string, platform: NodeJS.Platform = process.platform): string {
  const run = join(oldHome, "run");
  return platform === "win32" ? `${WINDOWS_PIPE_PREFIX}${OLD_PIPE_STEM}${homePipeId(run)}` : join(run, "core.sock");
}

function lockPid(oldHome: string, platform: NodeJS.Platform): number | undefined {
  const file = join(oldHome, "run", platform === "win32" ? "core.pid" : "core.lock");
  try {
    const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const realPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether the old engine runs on `oldHome` (see the file's header), and how that was seen. */
export async function oldEngineAlive(oldHome: string, deps: AliveDeps = {}): Promise<{ alive: boolean; how?: string }> {
  const platform = deps.platform ?? process.platform;
  const endpoint = oldEndpoint(oldHome, platform);
  if (await (deps.answers ?? ((p: string) => endpointAnswers(p, 500)))(endpoint)) return { alive: true, how: "its endpoint answers" };
  const pid = lockPid(oldHome, platform);
  const endpointThere = platform === "win32" || existsSync(endpoint);
  if (pid !== undefined && pid !== process.pid && endpointThere && (deps.pidAlive ?? realPidAlive)(pid)) return { alive: true, how: `its lock names a live process (${pid})` };
  return { alive: false };
}
