// Picked files (the coordinator's ruling for the owner's video-editor test, agreed with lane G): a file or folder the
// user picked in a third-party plugin's page (lane G's `files.pickOpen`, `pickFolder`, `pickSave`) is that plugin's to
// reach, and nothing else of the user's is. Main mints a token (`grant:<uuid>`, bound to one plugin, never a path) and
// registers it here (`plugin.grant.add`, app role) before the page sees it; the core keeps the records.
//
// * What a grant gives, to THAT plugin alone: an open grant reads its file (or folder, everything under it); a save
//   grant reads and writes exactly its file (which may not exist yet); a folder picked for writing (an export folder)
//   reads and writes everything under it. Its host half reaches it through `files.*` with `grant:<uuid>` or
//   `grant:<uuid>/<relative path>` (a folder grant) as the path, and learns the real path with `files.path` (the host
//   half only, never the page) to hand to a program (ffmpeg takes paths); the plugin's own processes (its stdio MCP
//   servers, its hooks, a supervised host) get the same paths in their fence (`fencePaths`).
// * What a grant can never be: `/`, the user's home folder as a whole or a folder holding it, the Clover home or
//   anything in it or holding it (its plugins folder included), one of the user's secret places (`SECRET_READ_PLACES`)
//   or a folder holding one, or any fenced item (settings, the login-start places, the browser profiles, the coding
//   agents' installs and configs, the development folders) or a folder holding one. Refused when it is added, with a
//   sentence main can show; and checked again, on the real path, every time it is used, so a link swapped in later
//   leads nowhere.
// * How long: until the user removes it (the plugin's page in Settings lists them, `plugin.grant.list`) or the plugin
//   is removed. Records live in `<clover home>/plugins-state/grants.json`, inside the Clover home's default-deny: no
//   bot, plugin or session writes it; the core is its only writer.
import { closeSync, constants as FS, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";
import { isAnyPluginId, PLUGINS_METHODS, type FileStat, type Os } from "@waifucave/clover-protocol";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { ContractError } from "../contracts/common";
import { secretReadPlaces, type FencedPath } from "../contracts/fence";
import { readJsonFile, writeJsonFile } from "../devices/json-file";
import { foldPath } from "./fold";

/** A token as main mints it: `grant:` and a UUID. */
export const GRANT_TOKEN = /^grant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many grants one plugin holds at most (an editor's recent projects; more is a page picking in a loop). */
export const GRANTS_PER_PLUGIN = 256;

export type GrantKind = "file" | "folder";
export type GrantAccess = "read" | "write";

export interface PluginGrant {
  token: string;
  pluginId: string;
  /** The real, absolute path the user picked (a save target's folder resolved, its name as given). */
  path: string;
  kind: GrantKind;
  /** `read`: an open grant. `write`: a save grant (that one file) or an export folder; reads too. */
  access: GrantAccess;
  addedAt: number;
}

export interface PluginGrantsOptions {
  cloverHome: string;
  userHome: string;
  os?: Os;
  /** The fenced items now (the fence's `fencedSet`): a grant may neither be in one nor hold one. */
  fenced?: () => readonly FencedPath[];
  /** Whether a plugin id is installed here (the registry's): a grant for an unknown plugin is refused. */
  installed?: (pluginId: string) => boolean;
  now?: () => number;
}

const osOf = (): Os => (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether `p` is `root` or inside it, both folded (the disk's own rules: case, Unicode form). */
function within(p: string, root: string, os: Os): boolean {
  const a = foldPath(p, os), r = foldPath(root, os).replace(/\/+$/, "");
  return a === r || a.startsWith(`${r}/`) || r === "";
}

/** A path's real form: its real path, or (a file not made yet) its folder's real path and its name. Throws `refused`
 *  when the folder isn't there either. */
export function realGrantPath(path: string, kind: GrantKind): string {
  if (!isAbsolute(path) || CONTROL.test(path)) throw new ContractError("refused", "a picked path is absolute, with no control characters");
  try {
    return realpathSync(path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (kind === "file" && code === "ENOENT") {
      try { return join(realpathSync(dirname(path)), basename(path)); } catch { /* below */ }
    }
    throw new ContractError("refused", `${path} can't be opened here (${code ?? "unknown"})`);
  }
}

/** Why `real` (a real, absolute path) can never be a plugin's grant, or undefined when it can be. */
export function grantRefusal(real: string, o: { cloverHome: string; userHome: string; os?: Os; fenced?: () => readonly FencedPath[] }): string | undefined {
  const os = o.os ?? osOf();
  const p = os === "windows" ? win32 : posix;
  if (CONTROL.test(real)) return "a picked path has no control characters";
  if (p.dirname(real) === real) return "the whole disk can't be given to a plugin";
  const holdsOrIn = (place: string) => within(real, place, os) || within(place, real, os);
  if (within(o.userHome, real, os)) return "the whole home folder can't be given to a plugin: pick a folder or file in it";
  if (holdsOrIn(o.cloverHome)) return "Clover's own folder can't be given to a plugin";
  for (const s of secretReadPlaces(os, o.userHome)) {
    if (holdsOrIn(s.path)) return `that ${within(real, s.path, os) ? "is in" : "holds"} a place that holds ${s.cls}, which no plugin is given`;
  }
  for (const item of o.fenced?.() ?? []) {
    if (holdsOrIn(item.path)) return `that ${within(real, item.path, os) ? "is in" : "holds"} a place Clover keeps from plugins (${item.kind})`;
  }
  return undefined;
}

interface GrantsFile { version: 1; grants: PluginGrant[] }

/** The records, and what a plugin reaches through them. */
export class PluginGrants {
  readonly #o: PluginGrantsOptions;
  readonly #os: Os;
  readonly #file: string;
  #grants: PluginGrant[];
  readonly #watchers = new Set<(pluginId: string) => void>();

  constructor(o: PluginGrantsOptions) {
    this.#o = o;
    this.#os = o.os ?? osOf();
    this.#file = join(o.cloverHome, "plugins-state", "grants.json");
    let stored: GrantsFile | undefined;
    try { stored = readJsonFile<GrantsFile>(this.#file); } catch { stored = undefined; } // unreadable: none kept
    this.#grants = (stored?.grants ?? []).filter((g) => GRANT_TOKEN.test(g.token) && isAnyPluginId(g.pluginId) && typeof g.path === "string"
      && (g.kind === "file" || g.kind === "folder") && (g.access === "read" || g.access === "write"));
  }

  #save(pluginId: string): void {
    writeJsonFile(this.#file, { version: 1, grants: this.#grants } satisfies GrantsFile);
    for (const fn of this.#watchers) {
      try { fn(pluginId); } catch { /* a watcher's failure is its own */ }
    }
  }

  /** Hears which plugin's grants changed (added, removed, dropped with it), after they are saved. */
  watch(fn: (pluginId: string) => void): () => void {
    this.#watchers.add(fn);
    return () => this.#watchers.delete(fn);
  }

  #refusal(real: string): string | undefined {
    return grantRefusal(real, { cloverHome: this.#o.cloverHome, userHome: this.#o.userHome, os: this.#os, ...(this.#o.fenced ? { fenced: this.#o.fenced } : {}) });
  }

  /** Main registers a pick (`plugin.grant.add`). Refused, with a sentence for the user, for what a grant can never be. */
  add(g: { pluginId: string; token: string; path: string; kind: GrantKind; access: GrantAccess }): PluginGrant {
    if (!isAnyPluginId(g.pluginId)) throw new ContractError("invalid", "not a plugin id");
    if (this.#o.installed && !this.#o.installed(g.pluginId)) throw new ContractError("refused", `${g.pluginId} isn't installed here`);
    if (!GRANT_TOKEN.test(g.token)) throw new ContractError("invalid", "a grant's token is grant:<uuid>");
    const other = this.#grants.find((x) => x.token === g.token && x.pluginId !== g.pluginId);
    if (other) throw new ContractError("refused", "that token is another plugin's");
    const real = realGrantPath(g.path, g.kind);
    let st: Stats | undefined;
    try { st = lstatSync(real); } catch { st = undefined; }
    if (g.kind === "folder" && !st?.isDirectory()) throw new ContractError("refused", `${g.path} isn't a folder`);
    if (g.kind === "file" && st !== undefined && !st.isFile()) throw new ContractError("refused", `${g.path} isn't a file`);
    if (g.kind === "file" && st === undefined && g.access === "read") throw new ContractError("refused", `${g.path} isn't there`);
    const why = this.#refusal(real);
    if (why !== undefined) throw new ContractError("refused", why);
    const kept = this.#grants.filter((x) => x.pluginId === g.pluginId && x.token !== g.token);
    if (kept.length >= GRANTS_PER_PLUGIN) throw new ContractError("refused", `${g.pluginId} holds ${GRANTS_PER_PLUGIN} picked files already: remove some on its page in Settings`);
    const grant: PluginGrant = { token: g.token, pluginId: g.pluginId, path: real, kind: g.kind, access: g.access, addedAt: (this.#o.now ?? Date.now)() };
    this.#grants = [...this.#grants.filter((x) => x.token !== g.token), grant];
    this.#save(g.pluginId);
    return { ...grant };
  }

  remove(pluginId: string, token: string): boolean {
    const before = this.#grants.length;
    this.#grants = this.#grants.filter((x) => !(x.pluginId === pluginId && x.token === token));
    if (this.#grants.length === before) return false;
    this.#save(pluginId);
    return true;
  }

  list(pluginId: string): PluginGrant[] {
    return this.#grants.filter((x) => x.pluginId === pluginId).map((x) => ({ ...x }));
  }

  /** The plugin was removed: its grants go with it. */
  dropPlugin(pluginId: string): number {
    const before = this.#grants.length;
    this.#grants = this.#grants.filter((x) => x.pluginId !== pluginId);
    const dropped = before - this.#grants.length;
    if (dropped > 0) this.#save(pluginId);
    return dropped;
  }

  /** `grant:<uuid>` or `grant:<uuid>/<relative path>` (a folder grant) as the real path it reaches for `pluginId`, for
   *  `need`. Refused: another plugin's token, an unknown one, a write on an open grant, a relative path on a file
   *  grant or one that climbs (`..`), and a real path that leaves the grant (a link) or that a grant can never be. */
  resolve(pluginId: string, ref: string, need: GrantAccess): { path: string; grant: PluginGrant } {
    const m = /^(grant:[0-9a-f-]{36})(?:\/(.*))?$/i.exec(ref);
    if (!m || !GRANT_TOKEN.test(m[1]!)) throw new ContractError("invalid", "a picked file's path is grant:<uuid>, or grant:<uuid>/<path> under a picked folder");
    const grant = this.#grants.find((x) => x.token === m[1] && x.pluginId === pluginId);
    if (!grant) throw new ContractError("not_found", "no such picked file for this plugin");
    if (need === "write" && grant.access !== "write") throw new ContractError("refused", "that file was picked to open, not to save");
    const rel = m[2] ?? "";
    if (rel !== "" && grant.kind !== "folder") throw new ContractError("refused", "only a picked folder has paths under it");
    const names = rel === "" ? [] : rel.split("/");
    if (names.some((n) => n === "" || n === "." || n === ".." || CONTROL.test(n) || n.includes("\\"))) throw new ContractError("invalid", "a path under a picked folder is plain names, no `..`");
    const target = names.length === 0 ? grant.path : join(grant.path, ...names);
    // Where it really lands: its real path, or its nearest folder that is there and the names below it.
    let real: string;
    try { real = realpathSync(target); } catch {
      let at = dirname(target);
      const below = [basename(target)];
      for (;;) {
        try { real = join(realpathSync(at), ...below); break; } catch { /* not there yet */ }
        if (dirname(at) === at) throw new ContractError("refused", "that path can't be reached");
        below.unshift(basename(at));
        at = dirname(at);
      }
    }
    const inside = grant.kind === "folder" ? within(real, grant.path, this.#os) : foldPath(real, this.#os) === foldPath(grant.path, this.#os);
    if (!inside) throw new ContractError("refused", "that path leads out of what the user picked");
    const why = this.#refusal(real);
    if (why !== undefined) throw new ContractError("refused", why);
    return { path: real, grant };
  }

  /** What the plugin's own processes reach (their fence): every grant still allowed where it is now. */
  fencePaths(pluginId: string): { read: string[]; write: string[] } {
    const read: string[] = [], write: string[] = [];
    for (const g of this.#grants) {
      if (g.pluginId !== pluginId) continue;
      let real: string;
      try { real = realGrantPath(g.path, g.kind); } catch { continue; } // gone: nothing to open
      if (foldPath(real, this.#os) !== foldPath(g.path, this.#os) || this.#refusal(real) !== undefined) continue; // moved or now refused
      (g.access === "write" ? write : read).push(real);
    }
    return { read: [...new Set(read)], write: [...new Set(write)] };
  }
}

// ---- `files.*` on a picked file (the plugin's host half) -----------------------------------------------------------

const statOf = (ref: string, st: Stats): FileStat => ({
  path: ref,
  type: st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other",
  size: st.isFile() ? st.size : 0,
  modifiedAt: Math.max(0, Math.floor(st.mtimeMs)),
  executable: st.isFile() && (st.mode & 0o111) !== 0,
});

/** Opens `real` without following a link at its last name, and checks the file opened is the one the path names. */
function openChecked(real: string, flags: number, mode?: number): number {
  const fd = openSync(real, flags | (FS.O_NOFOLLOW ?? 0), mode);
  try {
    const opened = fstatSync(fd), named = lstatSync(real);
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw new ContractError("refused", "the picked file changed while it was opened");
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** `files.*` for a `grant:` path, for one plugin's host half: the picked file's own, nothing else. */
export function grantFiles(grants: PluginGrants) {
  return {
    stat(pluginId: string, ref: string): FileStat | null {
      const { path } = grants.resolve(pluginId, ref, "read");
      try { return statOf(ref, lstatSync(path)); } catch { return null; }
    },
    read(pluginId: string, ref: string, o: { offset?: number; length?: number } = {}): Buffer {
      const { path } = grants.resolve(pluginId, ref, "read");
      const fd = openChecked(path, FS.O_RDONLY);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new ContractError("refused", "not a file");
        const start = Math.max(0, Math.floor(o.offset ?? 0));
        const length = Math.max(0, Math.min(Math.floor(o.length ?? st.size), st.size - start));
        const buf = Buffer.alloc(Math.max(0, length));
        let got = 0;
        while (got < buf.length) {
          const n = readSync(fd, buf, got, buf.length - got, start + got);
          if (n === 0) break;
          got += n;
        }
        return buf.subarray(0, got);
      } finally { closeSync(fd); }
    },
    write(pluginId: string, ref: string, data: Buffer, o: { createDirs?: boolean } = {}): void {
      const { path, grant } = grants.resolve(pluginId, ref, "write");
      if (o.createDirs === true && grant.kind === "folder") mkdirSync(dirname(path), { recursive: true });
      const fd = openChecked(path, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o644);
      try {
        let done = 0;
        while (done < data.length) done += writeSync(fd, data, done, data.length - done);
      } finally { closeSync(fd); }
    },
    list(pluginId: string, ref: string): FileStat[] {
      const { path, grant } = grants.resolve(pluginId, ref, "read");
      if (grant.kind !== "folder") throw new ContractError("refused", "a picked file has nothing to list");
      const base = ref.replace(/\/+$/, "");
      const out: FileStat[] = [];
      for (const name of readdirSync(path)) {
        try { out.push(statOf(`${base}/${name}`, lstatSync(join(path, name)))); } catch { /* gone meanwhile */ }
      }
      return out;
    },
    /** The real path, for the host half to hand to a program of its own (never the page). */
    path(pluginId: string, ref: string): string {
      return grants.resolve(pluginId, ref, "read").path;
    },
  };
}

// ---- `plugin.grant.*` (app role) -----------------------------------------------------------------------------------

/** `plugin.grant.add`, `.remove` and `.list` on the app's connections (main registers each pick; Settings lists and
 *  removes them). Adding and removing are the user's. */
export function pluginGrantMethods(grants: PluginGrants): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  const view = (g: PluginGrant) => ({ token: g.token, path: g.path, kind: g.kind, access: g.access, addedAt: g.addedAt });
  return {
    [M.pluginGrantAdd.name]: handler(M.pluginGrantAdd, async (p, ctx) => {
      requireUser(ctx, "give a plugin a picked file");
      return { grant: view(grants.add(p)) };
    }),
    [M.pluginGrantRemove.name]: handler(M.pluginGrantRemove, async (p, ctx) => {
      requireUser(ctx, "take a picked file back from a plugin");
      return { removed: grants.remove(p.pluginId, p.token) };
    }),
    [M.pluginGrantList.name]: handler(M.pluginGrantList, async (p) => ({ grants: grants.list(p.pluginId).map(view) })),
  };
}
