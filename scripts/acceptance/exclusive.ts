// The machine-wide exclusive lock (scripts/heavy --exclusive, the coordinator's rule: one acceptance or try run at a
// time). An acceptance run that isn't already under it (CLOVER_HEAVY_EXCLUSIVE, which heavy sets for what runs under
// its hold: a try's watch.sh starting run.ts) runs itself again under it, queueing behind any other holder; a packaged
// run (`--app`) takes it as packaged, so ordinary heavy jobs wait while it runs. Signals reach the run under the lock
// (its own process group), so stopping this process by pid stops it too.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** heavy's arguments for this run, or undefined when it already runs under the hold (or there is no heavy). */
export function exclusiveArgs(repo: string, argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  if ((env.CLOVER_HEAVY_EXCLUSIVE ?? "") !== "") return undefined;
  const heavy = join(repo, "scripts", "heavy");
  if (!existsSync(heavy) || process.platform === "win32") return undefined;
  return [heavy, "--exclusive", ...(argv.includes("--app") ? ["--packaged"] : []), process.execPath, ...argv];
}

/** Runs `script` again under the lock and exits with its status; returns at once when it already runs under it. */
export async function holdMachine(repo: string, script: string, argv: readonly string[]): Promise<void> {
  const args = exclusiveArgs(repo, [script, ...argv]);
  if (args === undefined) return;
  const child = spawn(args[0]!, args.slice(1), { stdio: "inherit", detached: true });
  const forward = (sig: NodeJS.Signals) => () => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // already gone
    }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, forward(sig));
  const code = await new Promise<number>((resolve) => child.on("exit", (c, s) => resolve(c ?? (s === "SIGINT" ? 130 : 1))));
  process.exit(code);
}
