// The Clover home for a bot's own file tools (the owner's ruling of November 9, amended; lane C's fence). Owner: lane A.
// The bot's Bash meets it in its sandbox (`botHomeSandbox`); its Read, Glob, Grep and writes meet it here, through the
// same fence the other runners' real-path checks use (`Fence.forCaller(…).check`): a bot reads the whole home but the
// escalation list (the fence's read-denied items, plugin data, and the config copies that carry keys, `carriesKeys`),
// and writes any bot's scratch and memory and its own routines and outputs. Every path is judged as it really is (a
// link from a bot's folder is judged where it points, and a pattern's `..` like a path's). What a search walks into is
// filtered by the runtime against the same escalation list in the sandbox's `denyRead`.
import { isAbsolute, join, resolve } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import type { FenceOp, FenceVerdict } from "../../contracts/fence";
import { homeReach, realPathOf } from "../../agents/memory";
import { CONFIG_COPY_FILES } from "./home-deny";
import { RESUME_STAGING_PREFIX } from "../host/vendor-paths";

/** The file tools this check judges: what each does, and whether it searches. */
const FILE_TOOLS: Readonly<Record<string, { op: "read" | "write"; search: boolean }>> = {
  Read: { op: "read", search: false },
  Glob: { op: "read", search: true },
  Grep: { op: "read", search: true },
  // Writes stay the session's own (the owner's ruling of November 9: a bot reads other bots' memory, never writes it).
  Write: { op: "write", search: false },
  Edit: { op: "write", search: false },
  MultiEdit: { op: "write", search: false },
  NotebookEdit: { op: "write", search: false },
};

/** The fixed folder a glob pattern starts in, against `base` for a relative one (`../x/**` is `<base>/../x`): a
 *  pattern's `..` is judged like a path's. */
function globRoot(pattern: string, base: string): string {
  const fixed: string[] = [];
  for (const part of pattern.split(/[\\/]/)) {
    if (/[*?[{]/.test(part)) break;
    fixed.push(part);
  }
  const at = fixed.join("/");
  return isAbsolute(pattern) ? at || "/" : resolve(base, at);
}

/** Whether a path, as written or as it really is, is one of the config copies that carry keys (a run folder's or a
 *  staging root's `.clover.json`, `.claude.json`, `.credentials.json` or `backups/`, the store's `.clover.json`), the
 *  credential index or the secret store's files: the bots' escalation list, as their Bash meets it (`botDenyRead`). */
export function carriesKeys(home: string, path: string, cwd: string): boolean {
  for (const p of new Set([isAbsolute(path) ? resolve(path) : resolve(cwd, path), realPathOf(path, cwd)])) {
    const segs = p.split(/[\\/]/);
    if (segs.some((s) => (CONFIG_COPY_FILES as readonly string[]).includes(s)) && homeReach(home, p, cwd) === "inside") return true;
    if (segs.some((s) => s.startsWith(RESUME_STAGING_PREFIX)) && segs.some((s) => (CONFIG_COPY_FILES as readonly string[]).includes(s) || s === "backups")) return true;
    if (homeReach(join(home, "cache", "runs"), p, cwd) === "inside" && segs.includes("backups")) return true;
    if (homeReach(join(home, "credentials"), p, cwd) === "inside" || p === join(home, "credentials")) return true;
    // The secret store's files on every OS (the fence names them off macOS only, where the store is a file).
    if (["secrets.enc", "secrets.key", "secrets.key.cred"].some((n) => homeReach(join(home, n), p, cwd) === "inside" || p === join(home, n))) return true;
  }
  return false;
}

export interface FileFence {
  /** The fence as the session meets it (`Fence.forCaller(ctx.caller).check`). */
  check(op: FenceOp): FenceVerdict;
  /** The Clover home. */
  home: string;
  os?: Os;
}

/** Why a bot's file tool call may not run, or undefined: a path the fence refuses, a config copy that carries keys,
 *  or a pattern that climbs out after a wildcard. Relative paths are the session's folder's. */
export function fileToolFenceRefusal(name: string, input: unknown, fence: FileFence, cwd: string): string | undefined {
  const tool = FILE_TOOLS[name];
  if (tool === undefined) return undefined;
  const args = (input ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) if (typeof args[key] === "string" && args[key] !== "") paths.push(args[key] as string);
  if (tool.search && paths.length === 0) paths.push(cwd);
  // Glob's pattern and Grep's `glob` start in a fixed folder, absolute or against the search's own (Grep's `pattern` is
  // a regex): that folder is searched, so it is judged too, `..` and all.
  const searchBase = paths.length > 0 ? (isAbsolute(paths[0]!) ? paths[0]! : resolve(cwd, paths[0]!)) : cwd;
  for (const g of [name === "Glob" ? args["pattern"] : undefined, name === "Grep" ? args["glob"] : undefined]) {
    if (typeof g !== "string" || g === "") continue;
    // A `..` past the pattern's first wildcard climbs from wherever the wildcard matched: no fixed folder says where.
    const parts = g.split(/[\\/]/);
    const wild = parts.findIndex((p) => /[*?[{]/.test(p));
    if (wild !== -1 && parts.slice(wild).includes("..")) return `${name} was not run: its pattern climbs out with \`..\` after a wildcard.`;
    paths.push(globRoot(g, searchBase));
  }
  for (const raw of paths) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const verdict = fence.check({ op: tool.op, path });
    if (verdict.allowed && tool.op === "read" && carriesKeys(fence.home, path, cwd)) return `${name} was not run: ${raw} holds secrets or keys, which bots never read.`;
    if (!verdict.allowed) return `${name} was not run: ${raw} is in Clover's folder, outside what this session may ${tool.op === "read" ? "read" : "write"}.`;
  }
  return undefined;
}
