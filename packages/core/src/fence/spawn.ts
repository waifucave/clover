// The fenced spawn seam (lane C): one door for a process that runs under the fence for a session, a bot or a plugin
// hook. A-M3's turn loop calls it for a hook's `command` (Claude Code's hook protocol: JSON on stdin, JSON on
// stdout, exit code 2 to deny); bots' Bash goes through the same door when it runs under the fence on the three OSes
// (C-M2). Until then the door says it is closed (`available: false`) and every run is refused with the reason, so a
// caller skips the hook and reports it rather than running it outside the fence.

export interface FencedRun {
  /** A shell command line, run by the platform's shell (`/bin/sh -c` on macOS and Linux). */
  readonly command: string;
  readonly cwd: string;
  /** The child's whole environment: nothing is inherited past this. */
  readonly env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Whose run it is: the fence's set and the network rule are this caller's. */
  readonly who: { readonly sessionId: string; readonly bot?: string; readonly pluginId?: string; readonly hook?: string };
}

export type FencedRunResult =
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "refused"; readonly reason: string };

export interface FencedSpawner {
  /** False while no fenced process can be started on this OS: `run` refuses every call. */
  readonly available: boolean;
  run(run: FencedRun): Promise<FencedRunResult>;
}

/** The door until the fenced process lands for this OS (C-M2's Bash under the fence). */
export const FENCED_SPAWN_NOT_YET: FencedSpawner = {
  available: false,
  run: async () => ({ kind: "refused", reason: "a fenced process can't be started on this computer yet (lane C, C-M2)" }),
};
