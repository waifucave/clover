// P5 (the owner, 2026-11-15: "Yes, named on the card"): the programs of the user's a plugin's host half runs OUTSIDE the
// plugin sandbox, and the folders of the user's it reads.
//
// * `outside.run(program, args, opts)`: only a program its manifest names (`host.outside.programs`, a top-level plugin's,
//   each on its OK card with a warning) runs, and the daemon starts it, not the plugin's fenced process, so it runs with
//   the user's own access: their sign-ins, their Keychain, their files and their network. A bare name is found on the
//   user's PATH (the login shell's, which the daemon merged into its own); an absolute path is taken as it is. No shell:
//   `args` go to it as given. Its output comes back as text, each stream cut at `OUTSIDE_OUTPUT_MAX` bytes; its time is
//   60 s unless asked, at most 10 minutes, and it is killed when that runs out. Every run is one line in the daemon's
//   log (the plugin, the program and how it ended; never its arguments or its output).
// * The folders (`host.outside.read`): `outsideReadFolders` turns them into real paths for the plugin's host process's
//   fence, read only, never inside the Clover home (the fence's last denies, the Keychain's files and the tools'
//   credential files, still hold).
// * Everything else the plugin does stays fenced as before.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { OUTSIDE_OUTPUT_MAX, OUTSIDE_TIMEOUT_MAX_MS, OUTSIDE_TIMEOUT_MS } from "@waifucave/clover-plugin-sdk/api-calls";
import { ContractError } from "../../contracts/common";
import type { PluginRecord } from "../../contracts/plugin-registry";
import type { ApiHandlers } from "./router";

/** What a manifest names outside its sandbox (`host.outside`), as its record's manifest has it. */
export function outsideOf(record: Pick<PluginRecord, "manifest"> | undefined): { programs: string[]; read: string[] } {
  const o = (record?.manifest as { host?: { outside?: { programs?: unknown; read?: unknown } } } | undefined)?.host?.outside;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { programs: list(o?.programs), read: list(o?.read) };
}

/** A path as the manifest gives it (`~/…` or absolute), in the user's home. */
export function expandUserPath(p: string, userHome: string): string {
  return p === "~" ? userHome : p.startsWith("~/") ? join(userHome, p.slice(2)) : resolve(p);
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The folders a plugin's host process reads outside its sandbox: its manifest's `host.outside.read`, in the user's home,
 *  as real paths; never the Clover home or anything in it, and never the whole home. */
export function outsideReadFolders(record: Pick<PluginRecord, "manifest"> | undefined, o: { userHome: string; cloverHome: string }): string[] {
  const home = real(o.userHome);
  const clover = real(o.cloverHome);
  const out: string[] = [];
  for (const p of outsideOf(record).read) {
    const at = expandUserPath(p, o.userHome);
    const r = real(at);
    if (r === home || r === "/" || inside(r, clover) || inside(clover, r)) continue;
    out.push(r);
    if (r !== at) out.push(at);
  }
  return [...new Set(out)];
}

/** Where a named program is: an absolute path as it is; a bare name, the first executable file of that name on `PATH`. */
export function findProgram(name: string, path: string | undefined): string | undefined {
  if (isAbsolute(name)) return name;
  for (const dir of (path ?? "").split(":")) {
    if (dir === "") continue;
    const at = join(dir, name);
    try {
      const st = statSync(at);
      if (st.isFile() && (st.mode & 0o111) !== 0) return at;
    } catch { /* not here */ }
  }
  return undefined;
}

/** Reads a stream to text, keeping at most `max` bytes. */
async function capped(stream: ReadableStream<Uint8Array> | null | undefined, max: number): Promise<{ text: string; cut: boolean }> {
  if (stream === null || stream === undefined) return { text: "", cut: false };
  const parts: Uint8Array[] = [];
  let kept = 0;
  let cut = false;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    if (kept >= max) { cut = true; continue; }
    const take = chunk.subarray(0, max - kept);
    if (take.length < chunk.length) cut = true;
    parts.push(take);
    kept += take.length;
  }
  return { text: new TextDecoder().decode(Buffer.concat(parts)), cut };
}

/** The environment a program outside the sandbox gets: the daemon's, which is the user's (their login PATH merged in),
 *  without Clover's own variables. */
function userEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLOVER|WAIFUCAVE)_/.test(k)) env[k] = v;
  return env;
}

export function outsideApi(o: { userHome?: string; log?: (line: string) => void; path?: () => string | undefined }): ApiHandlers {
  const userHome = o.userHome ?? homedir();
  return {
    "outside.run": async (ctx, args) => {
      const program = args[0];
      if (typeof program !== "string" || program === "") throw new ContractError("invalid", "outside.run takes the program's name as its manifest names it");
      const named = outsideOf(ctx.record).programs;
      if (!named.includes(program)) {
        throw new ContractError("refused", `${program} isn't a program ${ctx.pluginId} names outside its sandbox (host.outside.programs), so it doesn't run there`);
      }
      const argv = args[1] === undefined ? [] : args[1];
      if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) throw new ContractError("invalid", "outside.run's arguments are a list of strings");
      const opts = (args[2] ?? {}) as { cwd?: unknown; input?: unknown; timeoutMs?: unknown };
      const cwd = typeof opts.cwd === "string" && opts.cwd !== "" ? expandUserPath(opts.cwd, userHome) : userHome;
      if (!existsSync(cwd)) throw new ContractError("invalid", `outside.run's folder ${opts.cwd as string} isn't there`);
      const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.min(OUTSIDE_TIMEOUT_MAX_MS, Math.max(1_000, Math.floor(opts.timeoutMs))) : OUTSIDE_TIMEOUT_MS;
      const env = userEnv();
      const at = findProgram(program, o.path?.() ?? env.PATH);
      if (at === undefined) throw new ContractError("failed", `${program} isn't on your PATH`);
      let timedOut = false;
      const child = Bun.spawn([at, ...(argv as string[])], {
        cwd, env, stdin: typeof opts.input === "string" ? new TextEncoder().encode(opts.input) : "ignore", stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      try {
        const [out, err, code] = await Promise.all([capped(child.stdout, OUTSIDE_OUTPUT_MAX), capped(child.stderr, OUTSIDE_OUTPUT_MAX), child.exited]);
        const ended = timedOut ? "its time ran out" : child.signalCode !== null && child.signalCode !== undefined ? `signal ${child.signalCode}` : `exit ${code}`;
        o.log?.(`[plugins] ${ctx.pluginId} ran ${program} outside its sandbox: ${ended}`);
        return {
          code: child.signalCode !== null && child.signalCode !== undefined ? null : code,
          stdout: out.text, stderr: err.text,
          ...(out.cut || err.cut ? { truncated: true } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
