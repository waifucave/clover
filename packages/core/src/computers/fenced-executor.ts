// The computer node's Bash (the controller's wiring ruling, item 3; C-M2 part 2): a tool call on this computer's tree
// runs through lane C's fenced process (`fencedSpawner`): Seatbelt on macOS, bubblewrap on Linux, and on Windows the
// door is closed and every call is refused with the reason. Never unsandboxed: there is no fallback to a plain shell,
// and a spawner that can't start a fenced process here refuses each call.
//
// The run is the caller's (`who`): a bot's own session gets its bot's reach, a coding session its own, and another
// computer's call (a peer) the fence's floor. The child's environment is built here, whole: a fixed PATH and the
// user's home, nothing inherited from the daemon (no keys, no tokens).
import type { Os } from "@waifucave/clover-protocol";
import type { FencedRunResult, FencedSpawner } from "../fence/spawn";
import type { ToolExecutor } from "../tree/service";

/** How long a Bash call runs when it doesn't say (Claude Code's default). */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
/** The longest a Bash call may ask for (Claude Code's limit). */
export const BASH_MAX_TIMEOUT_MS = 600_000;

export interface FencedExecutorOptions {
  /** Lane C's fenced process for this computer (`fencedSpawner({ fence })`); never `FENCED_SPAWN_NOT_YET`. */
  spawner: FencedSpawner;
  /** The user's home folder: `HOME` in the child's environment. */
  home: string;
  os: Os;
}

/** The PATH a fenced Bash call sees: the system's standard places, never the daemon's own PATH. */
export function fencedPath(os: Os): string {
  return os === "macos" ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

/** The computer node's executor over `o.spawner`. */
export function fencedExecutor(o: FencedExecutorOptions): ToolExecutor {
  const env = { PATH: fencedPath(o.os), HOME: o.home, LANG: "en_US.UTF-8", TERM: "dumb" };
  return {
    async run(tool, input, ctx) {
      if (tool !== "Bash") return { output: { error: `${tool} doesn't run through this computer's executor; only Bash does` }, isError: true };
      const i = (typeof input === "object" && input !== null ? input : {}) as { command?: unknown; timeoutMs?: unknown };
      if (typeof i.command !== "string" || i.command.length === 0) return { output: { error: "Bash: no command" }, isError: true };
      const asked = typeof i.timeoutMs === "number" && Number.isInteger(i.timeoutMs) && i.timeoutMs > 0 ? i.timeoutMs : BASH_DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(asked, BASH_MAX_TIMEOUT_MS);
      if (ctx.signal.aborted) return { output: { stdout: "", stderr: "", code: null, aborted: true }, isError: true };
      let r: FencedRunResult;
      try {
        r = await o.spawner.run({ command: i.command, cwd: ctx.cwd, env, timeoutMs, signal: ctx.signal, who: { caller: ctx.as } });
      } catch (e) {
        // A spawner that throws ran nothing we can vouch for: refused, with the reason.
        return { output: { error: `this computer's fenced process failed to start: ${e instanceof Error ? e.message : String(e)}` }, isError: true };
      }
      if (r.kind === "refused") return { output: { error: `refused: ${r.reason}` }, isError: true };
      // The fenced process gives its output at the end; it goes to the caller's stream once, in order.
      if (r.stdout) ctx.output(r.stdout, "stdout");
      if (r.stderr) ctx.output(r.stderr, "stderr");
      if (r.kind === "timeout") return { output: { stdout: r.stdout, stderr: r.stderr, code: null, timedOut: true, aborted: ctx.signal.aborted }, isError: true };
      return { output: { stdout: r.stdout, stderr: r.stderr, code: r.code, aborted: ctx.signal.aborted }, isError: r.code !== 0 || ctx.signal.aborted };
    },
  };
}
