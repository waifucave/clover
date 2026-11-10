// Lane M: what a binary signed `--options runtime,restrict` still does (scripts/verify-fd-receiver-compiled.ts, step 4).
// The gate starts it with a dummy variable it made up, reads the process's arguments and environment from outside
// (KERN_PROCARGS2, as any same-user process can), and closes stdin to end it. This side reports only true/false: that
// the variable reached it (never its value), whether dyld removed a DYLD_ variable (reported, not required: that
// depends on SIP, and GitHub's macOS runners run with it off), and that Bun.serve, fetch and bun:ffi work. Only in a build with `--define CLOVER_PLUGIN_RUN_PROBE=true`; never in a release build. Touches no home, no
// Keychain, no daemon. The plugin Bun runs the same function from a script file (it is plain Bun).

/** The dummy variable the gate sets; its value is the gate's own random string, never a real secret. */
export const RESTRICT_PROBE_VARIABLE = "CLOVER_RESTRICT_PROBE_DUMMY";
/** A DYLD_ variable the gate sets, which dyld must have removed before `main`. */
export const RESTRICT_PROBE_DYLD_VARIABLE = "DYLD_CLOVER_RESTRICT_PROBE";

export interface RestrictProbeReady {
  ready: true;
  pid: number;
  /** The dummy variable reached the process (its value is never printed). */
  envSet: boolean;
  /** No DYLD_ variable reached the process (SIP on, or `restrict`); reported only. */
  dyldRemoved: boolean;
  /** A Bun.serve on loopback answered this process's own fetch. */
  fetch: boolean;
  /** bun:ffi called libSystem's getpid and got this process's pid. */
  ffi: boolean;
  error?: string;
}

/** Runs the checks, prints one JSON line, then waits for stdin to close (the gate reads the process meanwhile). */
export async function runRestrictProbe(): Promise<void> {
  const out: RestrictProbeReady = {
    ready: true,
    pid: process.pid,
    envSet: (process.env[RESTRICT_PROBE_VARIABLE] ?? "") !== "",
    dyldRemoved: !Object.keys(process.env).some((k) => k.startsWith("DYLD_")),
    fetch: false,
    ffi: false,
  };
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("restrict-probe") });
    try {
      out.fetch = (await (await fetch(`http://127.0.0.1:${server.port}/`)).text()) === "restrict-probe";
    } finally {
      server.stop(true);
    }
    const { dlopen } = await import("bun:ffi");
    const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { getpid: { args: [], returns: "i32" } });
    out.ffi = lib.symbols.getpid() === process.pid;
    lib.close();
  } catch (err) {
    out.error = (err as Error).message.slice(0, 300);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  for await (const _ of Bun.stdin.stream()) { /* until the gate closes stdin */ }
  process.exit(out.envSet && out.fetch && out.ffi ? 0 : 1);
}

if (import.meta.main) await runRestrictProbe();
