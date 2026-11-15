import type { OutsideApi } from "../api/plugin-api";

// Running the user's own program through `api.outside.run` (P5): the daemon starts it, no shell, with the user's own
// access; its output comes back as text once it ends. This turns the door's answer into the few outcomes a source
// judges.

/** What a source runs programs through: `api.outside` (a test hands its own). */
export type Outside = OutsideApi;

export type OutsideOutcome =
  | { kind: "exited"; code: number | null; stdout: string }
  | { kind: "timeout"; stdout: string }
  | { kind: "spawn-failed" }
  | { kind: "not-installed" }
  | { kind: "too-large" };

/** `outside.run` refuses a program it does not find on the PATH with a message that says so; that is "not installed". */
const NOT_ON_PATH = /isn't on your PATH/;

export async function runOutside(outside: Outside, program: string, args: readonly string[], opts: { timeoutMs: number; input?: string }): Promise<OutsideOutcome> {
  try {
    const r = await outside.run(program, args, { timeoutMs: opts.timeoutMs, ...(opts.input === undefined ? {} : { input: opts.input }) });
    if (r.truncated === true) return { kind: "too-large" };
    if (r.timedOut === true) return { kind: "timeout", stdout: r.stdout };
    return { kind: "exited", code: r.code, stdout: r.stdout };
  } catch (err) {
    return NOT_ON_PATH.test(err instanceof Error ? err.message : String(err)) ? { kind: "not-installed" } : { kind: "spawn-failed" };
  }
}
