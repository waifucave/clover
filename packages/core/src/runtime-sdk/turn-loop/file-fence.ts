// The Clover home for a bot's own file tools (lane C's fence). Owner: lane A. A bot's Read, Glob, Grep and writes are
// judged here by the same fence the other runners' real-path checks use (`Fence.forCaller(…).check`), and a read of a
// file that carries keys is refused on top (`botReadDenied`). Every path is judged as it really is: a link from a bot's
// folder is judged where it points, and a pattern's `..` like a path's. The bot's Bash meets the same fence through its
// sandbox (lane C's `sandboxSettingsOf`).
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

/** The files in the home that hold keys, whatever the fence says of them: the secret store's files, the core's run
 *  folder and the credential index. */
const KEY_PATHS = ["secrets.enc", "secrets.key", "secrets.key.cred", "run", "credentials"] as const;

/** Whether a path, as written or as it really is, carries keys: one of `KEY_PATHS`, or a config copy (a `.clover.json`,
 *  `.claude.json` or `.credentials.json` in the home or a staging root, or a staging root's `backups/`). */
export function botReadDenied(home: string, path: string, cwd: string): boolean {
  for (const p of new Set([isAbsolute(path) ? resolve(path) : resolve(cwd, path), realPathOf(path, cwd)])) {
    const segs = p.split(/[\\/]/);
    if (KEY_PATHS.some((rel) => homeReach(join(home, rel), p, cwd) === "inside")) return true;
    if (segs.some((s) => (CONFIG_COPY_FILES as readonly string[]).includes(s)) && homeReach(home, p, cwd) === "inside") return true;
    if (segs.some((s) => s.startsWith(RESUME_STAGING_PREFIX)) && segs.some((s) => (CONFIG_COPY_FILES as readonly string[]).includes(s) || s === "backups")) return true;
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
    if (verdict.allowed && tool.op === "read" && botReadDenied(fence.home, path, cwd)) return `${name} was not run: ${raw} holds secrets or keys, which bots never read.`;
    if (!verdict.allowed) return `${name} was not run: ${raw} is in Clover's folder, outside what this session may ${tool.op === "read" ? "read" : "write"}.`;
  }
  return undefined;
}
