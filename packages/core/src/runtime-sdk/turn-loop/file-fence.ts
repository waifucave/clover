// The Clover home for a bot's own file tools (lane C's fence). Owner: lane A. A bot's Read, Glob, Grep and writes are
// judged here by the same fence the other runners' real-path checks use (`Fence.forCaller(…).check`), and a read of a
// file that carries keys is refused on top (`botReadDenied`). Every path is judged as it really is: a link from a bot's
// folder is judged where it points, and a pattern's `..` like a path's. The bot's Bash meets the same fence through its
// sandbox (lane C's `sandboxSettingsOf`).
import { isAbsolute, join, resolve } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { BOT_READ_DENIED, type FenceOp, type FenceVerdict } from "../../contracts/fence";
import { homeReach, realPathOf } from "../../agents/memory";
import { CONFIG_COPY_FILES } from "./home-deny";
import { RESUME_STAGING_PREFIX } from "../host/vendor-paths";
import { placesOf, secretPlaceOf, secretPlacesUnder, secretReadRefusal, SKIPPED_NOTE, type SecretReadOptions } from "../../fence/secret-reads";

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

/** What a bot never reads in the Clover home, relative to it: lane C's `BOT_READ_DENIED` (#355), the one list (its
 *  `*` patterns match no literal path here; the provider-state files are judged below). */
export const BOT_KEY_PATHS: readonly (readonly string[])[] = BOT_READ_DENIED;

/** The fence's read-denied kinds in the home (the run folder, the secret store's files): refused here too, so a link to
 *  them is refused whatever the fence says of the link. */
const READ_DENIED_KIND_PATHS: readonly (readonly string[])[] = [["run"], ["secrets.enc"], ["secrets.key"], ["secrets.key.cred"]];

/** The runtime stores whose provider state files (`*.provider-state.jsonl`, at any depth) carry a provider's session. */
const PROVIDER_STATE_STORES: readonly (readonly string[])[] = [["projects"], ["sdk", "projects"]];
const PROVIDER_STATE_SUFFIX = ".provider-state.jsonl";

/** Whether a path, as written or as it really is, carries keys: in `BOT_KEY_PATHS` or the read-denied kinds, a
 *  provider state file in a runtime store, or a config copy (a `.clover.json`, `.claude.json` or `.credentials.json`
 *  in the home or a staging root, or a staging root's `backups/`). */
export function botReadDenied(home: string, path: string, cwd: string): boolean {
  for (const p of new Set([isAbsolute(path) ? resolve(path) : resolve(cwd, path), realPathOf(path, cwd)])) {
    const segs = p.split(/[\\/]/);
    if ([...BOT_KEY_PATHS, ...READ_DENIED_KIND_PATHS].some((rel) => homeReach(join(home, ...rel), p, cwd) === "inside")) return true;
    if ((segs.at(-1) ?? "").endsWith(PROVIDER_STATE_SUFFIX) && PROVIDER_STATE_STORES.some((rel) => homeReach(join(home, ...rel), p, cwd) === "inside")) return true;
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
  /** The user's home: its secret places (`SECRET_READ_PLACES`) are never read, and a search from above skips them. */
  userHome?: string;
}

/** The secret-place options for this fence, or undefined without a user's home. */
function secretsOf(fence: FileFence, cwd: string): SecretReadOptions | undefined {
  return fence.userHome === undefined ? undefined : { userHome: fence.userHome, os: fence.os ?? hostOs(), cwd };
}

function hostOs(): Os {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}

/** Why a bot's file tool call may not run, or undefined: a path the fence refuses, a config copy that carries keys,
 *  one of the user's secret places (`SECRET_READ_PLACES`: read or written), or a pattern that climbs out after a
 *  wildcard. A path is judged as the runtime opens it (trimmed, relative ones the session's folder's, no `~`
 *  expansion) and, for the secret places, with a leading `~` expanded too (`askedForms`). */
export function fileToolFenceRefusal(name: string, input: unknown, fence: FileFence, cwd: string): string | undefined {
  const tool = FILE_TOOLS[name];
  if (tool === undefined) return undefined;
  const args = (input ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) if (typeof args[key] === "string" && args[key].trim() !== "") paths.push(args[key] as string);
  if (tool.search && paths.length === 0) paths.push(cwd);
  // Glob's pattern and Grep's `glob` start in a fixed folder, absolute or against the search's own (Grep's `pattern` is
  // a regex): that folder is searched, so it is judged too, `..` and all.
  const searchBase = opened(paths[0] ?? cwd, cwd);
  for (const g of [name === "Glob" ? args["pattern"] : undefined, name === "Grep" ? args["glob"] : undefined]) {
    if (typeof g !== "string" || g === "") continue;
    // A `..` past the pattern's first wildcard climbs from wherever the wildcard matched: no fixed folder says where.
    const parts = g.split(/[\\/]/);
    const wild = parts.findIndex((p) => /[*?[{]/.test(p));
    if (wild !== -1 && parts.slice(wild).includes("..")) return `${name} was not run: its pattern climbs out with \`..\` after a wildcard.`;
    paths.push(globRoot(g, searchBase));
  }
  const secrets = secretsOf(fence, cwd);
  const places = secrets === undefined ? undefined : placesOf(secrets.userHome, secrets.os);
  for (const raw of paths) {
    const path = opened(raw, cwd);
    const verdict = fence.check({ op: tool.op, path });
    if (verdict.allowed && tool.op === "read" && botReadDenied(fence.home, path, cwd)) return `${name} was not run: ${raw} holds secrets or keys, which bots never read.`;
    const cls = secrets === undefined ? undefined : secretPlaceOf(raw, secrets, places);
    if (cls !== undefined) return secretReadRefusal(name, raw, cls);
    if (!verdict.allowed) return `${name} was not run: ${raw} is in Clover's folder, outside what this session may ${tool.op === "read" ? "read" : "write"}.`;
  }
  return undefined;
}

/** A path as the runtime's Read, Grep and Glob open it: trimmed, and resolved against the session's folder. */
function opened(raw: string, cwd: string): string {
  const t = raw.trim();
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t);
}

/** Whether a search's hit may be shown: the fence lets the session read it, as it really is, it carries no keys, and
 *  it is in none of the user's secret places. A relative hit is the search's folder's. */
function hitShown(hit: string, fence: FileFence, root: string, cwd: string, places: ReturnType<typeof placesOf> | undefined): boolean {
  const path = isAbsolute(hit) ? resolve(hit) : resolve(root, hit);
  for (const p of new Set([path, realPathOf(path, root)])) {
    if (!fence.check({ op: "read", path: p }).allowed) return false;
  }
  if (botReadDenied(fence.home, path, root)) return false;
  const secrets = secretsOf(fence, cwd);
  return secrets === undefined || secretPlaceOf(path, secrets, places) === undefined;
}

/** What a search's result is replaced with when it isn't in the runtime's own form, so it can't be checked. */
export const UNCHECKED_SEARCH = "The search's result wasn't in the form Clover checks, so it isn't shown. Search again with a narrower path.";

/** The runtime's one-line error for a search (`Error: path not found: …`, `Error: invalid pattern: …`): its own text,
 *  which names only what the call asked. */
const SEARCH_ERROR = /^Error: [^\n]*$/;

/** A Glob or Grep result with every hit the session may not read dropped, or undefined when nothing changes. The
 *  search starts in a folder the session reads, but a link there may lead out (to `run/` or a file in it): each hit is
 *  judged by its real path, a relative one against the search's folder. The runtime's forms (0.0.76's glob.ts and
 *  grep.ts, pinned in file-fence.test): Glob's result is one absolute path a line, a blank line and a `[Truncated …]`
 *  note at the end when there are more; Grep's is JSON with `files`, `counts` or `content` rows' `file`. A result in
 *  neither form, but the runtime's one-line error, is replaced (`UNCHECKED_SEARCH`), never passed. When the search's
 *  folder holds any of the user's secret places, the result says some were skipped (`SKIPPED_NOTE`), naming none. */
export function fenceSearchOutput(name: string, output: unknown, fence: FileFence, cwd: string, input?: unknown): string | undefined {
  if (name !== "Glob" && name !== "Grep") return undefined;
  if (typeof output !== "string") return UNCHECKED_SEARCH;
  if (SEARCH_ERROR.test(output)) return undefined;
  const args = (input ?? {}) as Record<string, unknown>;
  const base = typeof args["path"] === "string" && args["path"].trim() !== "" ? opened(args["path"], cwd) : cwd;
  const pattern = name === "Glob" && typeof args["pattern"] === "string" ? args["pattern"] : undefined;
  const root = pattern !== undefined && isAbsolute(pattern) ? globRoot(pattern, base) : base;
  const secrets = secretsOf(fence, cwd);
  const places = secrets === undefined ? undefined : placesOf(secrets.userHome, secrets.os);
  const skipped = secrets !== undefined && secretPlacesUnder(root, secrets, places);
  const shownHere = (f: string) => hitShown(f, fence, base, cwd, places);
  if (name === "Glob") {
    const lines = output.split("\n");
    const kept = lines.filter((l) => l === "" || /^\[Truncated to \d+ of \d+ total matches/.test(l) || shownHere(l));
    if (skipped) kept.push(SKIPPED_NOTE);
    return kept.length === lines.length && !skipped ? undefined : kept.join("\n");
  }
  let r: { files?: unknown; counts?: unknown; content?: unknown; skippedOversized?: unknown };
  try {
    r = JSON.parse(output) as typeof r;
  } catch {
    return UNCHECKED_SEARCH;
  }
  if (r === null || typeof r !== "object" || Array.isArray(r)) return UNCHECKED_SEARCH;
  const forms = [Array.isArray(r.files), r.counts !== null && typeof r.counts === "object" && !Array.isArray(r.counts), Array.isArray(r.content)].filter(Boolean).length;
  if (forms !== 1) return UNCHECKED_SEARCH;
  let dropped = false;
  // Fails closed: an entry that names no file (or not as a string) can't be checked, so it's dropped too.
  const shown = (f: unknown) => {
    const ok = typeof f === "string" && shownHere(f);
    if (!ok) dropped = true;
    return ok;
  };
  if (Array.isArray(r.files)) r.files = r.files.filter(shown);
  // The files Grep skipped as too large: a list of names is filtered as `files` is. (The runtime of agent SDK 0.0.75
  // reports a COUNT here, which names nothing and so is left as it is; that count is taken before the runtime's own
  // path check, which is the SDK's to fix.)
  if (Array.isArray(r.skippedOversized)) r.skippedOversized = r.skippedOversized.filter(shown);
  if (r.counts !== null && typeof r.counts === "object" && !Array.isArray(r.counts)) r.counts = Object.fromEntries(Object.entries(r.counts).filter(([f]) => shown(f)));
  if (Array.isArray(r.content)) r.content = r.content.filter((row: unknown) => shown((row as { file?: unknown } | null)?.file));
  if (skipped) (r as Record<string, unknown>)["note"] = SKIPPED_NOTE;
  return dropped || skipped ? JSON.stringify(r) : undefined;
}
