// Starting one headless shell over the DevTools pipe, never a port (spec §12.1): fds 3 and 4 on macOS and Linux
// (`fdpipe.ts`, through `Bun.spawn` only), inherited handles on Windows (`winpipe.ts`). A start that fails kills the
// browser (so its profile is free again) and says what it printed.
import { CdpError, PipeConnection, type CdpConnection } from "./cdp";
import { spawnWithFdPipes } from "./fdpipe";
import { spawnWithWinPipes } from "./winpipe";

export interface LaunchSpec {
  bin: string;
  /** The browser's switches (`headlessArgs`), less the pipe's own. */
  args: string[];
  /** The browser's environment on macOS and Linux (`browserEnv`); Windows passes the daemon's. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type Launcher = (spec: LaunchSpec) => Promise<CdpConnection>;

export const launchHeadlessShell: Launcher = async (spec) => {
  const started = process.platform === "win32"
    ? await spawnWithWinPipes(spec.bin, spec.args)
    : await spawnWithFdPipes(spec.bin, ["--remote-debugging-pipe", ...spec.args], spec.env);
  const conn = new PipeConnection(started.process, started.pipe);
  try {
    await conn.send("Browser.getVersion", {}, undefined, spec.timeoutMs ?? 30_000);
    return conn;
  } catch (e) {
    started.process.kill();
    await Promise.race([started.process.exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    const why = e instanceof Error ? e.message : String(e);
    const tail = started.process.stderrTail(8);
    throw new CdpError("closed", `the headless browser didn't start: ${why}${tail !== "" ? `; it said: ${tail}` : ""}`);
  }
};
