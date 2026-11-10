// The holder: one computer serving its own part of the folder tree from its own disk (spec §9.1; the owner's item 88:
// no OS mounts, the holder's daemon serves the tree over the link, behind the holder's fence).
//
// Everything that reaches a computer's files goes through its `LocalHolder`: its own tree calls, and every other
// computer's `tree.*` call, which the link service (`service.ts`) stamps as a `peer` before it gets here. The rules
// are spike S6's (edits 5 and 6, and the review's S2 and its round 2), ported from `spikes/s6-mounts/server/serve.ts`:
//
// * A path is resolved the way this computer's kernel would resolve it, links included, and checked where it really
//   lands: inside the area it names (the home folder, or the bot's folder) and, for anyone but the user and the core,
//   outside the fence. The folders above the last name are resolved with realpath, which also gives the stored case
//   on macOS and long names on Windows. The last name keeps its own form only for calls that act on a link itself
//   (stat, remove, move); its canonical spelling is still the disk's (a link's listed name; a short 8.3 name that the
//   disk answers to but doesn't list is refused).
// * The fence is asked twice: as is, and with the path and every fenced item folded (`names.ts`, review B1), so a name
//   that doesn't exist yet can't reach a fenced item in another case. Names a disk would read as something else
//   (`NUL`, `a:b`, `a.` on Windows) are refused.
// * Files are opened with `O_NOFOLLOW` on their real path, and what was opened is checked again: its device and inode
//   must be what the real path names after the open, and that path must still land inside the area and outside the
//   fence. A folder swapped for a link mid-call therefore can't lead into the fence. (Bun has no `openat`, so the walk
//   itself can still race a swap between two folders; see the report.)
// * Links that leave the area answer "refused" when read (`readlink`), and are never followed out of it.
// * `noFollow` (a `stat` or a `read` for the user's own file viewers, F-M3's review): no link is followed anywhere on
//   the way, from the area's root down (on Windows no reparse point either), the file is opened without following
//   one, and the opened file's real path, read back from its handle, must be the path walked (`nofollow.ts`).
// * `home/<this computer>/.clover/` is this computer's Clover home wherever it is on disk (`~/.clover-dev` for the dev
//   profile, `CLOVER_HOME`): the tree's one path to it, which the spec's `home/<Computer>/.clover/…` paths name.
// * A bot's memory (the owner's ruling for J-M3): `home/memory/` in a bot's own sessions is that bot's
//   `<Clover home>/bots/<bot>/memory/` here, on every computer that runs the core (lane H keeps the copies in sync,
//   so a write lands here even while another computer is off). Every bot reaches every bot's memory, read and write:
//   the owner's ruling of November 9 (and its amendment) opens the Clover home to bots through the tree (read
//   everything; write any bot's memory and scratch, and their own routines and outputs; secrets, `run/` and writes to
//   permission, trust, settings and plugin files stay blocked). The fence's `homeAllows` (lane C) decides all of a
//   bot's reach; the tree adds no deny of its own for a bot. Coding sessions, agents, plugins and another computer
//   don't reach a bot's memory; the user and the core do.
// * A peer's write, remove or move is judged at the stricter of this computer's level and the call's (review N2;
//   `judge.ts`, R1): at `ask-risky` this computer's reviewer passes what isn't risky, and where the level asks, only the
//   user's signed answer bound to exactly that call lets it through; the refusal carries this computer's card for the
//   calling computer to show. Reads, lists, glob and grep are fenced but never asked about.
import { constants as FS, promises as fsp, realpathSync, type Dirent, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  DEFAULT_LEVEL, pluginIdFromSegment, pluginIdToSegment,
  type Caller, type FileStat, type Level, type Os, type SignedCardAnswer, type TurnOrigin,
} from "@waifucave/clover-protocol";
import type { AnswerDevices, AnswerLedger, CallCardRenderer } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, type Unsubscribe } from "../contracts/common";
import { fenceContextFor, judge as fenceJudge, nonAsciiAlias, windowsAlias, type Fence, type FenceOp, type FenceVerdict } from "../contracts/fence";
import { isInside } from "../contracts/common";
import { splitTreePath, treeCallBinding, type TreeChange, type TreeData, type TreeReviewer } from "../contracts/tree";
import { atOps, type AtOps } from "./at";
import { checkSegment, foldName, foldPath, hostOs, mayBeShortName } from "./names";
import { fdRealPath, isReparsePoint } from "./nofollow";
import { FolderWatches, type TreeWatchEvent } from "./watch";
import { judgePeer } from "./judge";

/** Who a call is for, and what a peer's change carries (review N2). */
export interface HolderCall {
  as: Caller;
  /** A peer's change only: the calling computer's level for it. */
  level?: Level;
  /** A peer's change only: the user's signed answer bound to this call. */
  answer?: SignedCardAnswer;
  /** In-process only, never from the link: the change is part of a call already judged (an MCP call's files), so it
   *  isn't judged again. The fence still applies. */
  approved?: boolean;
  /** In-process only, never sent: what started the caller's turn, for the card askUser raises on this computer when
   *  another computer's holder needs the user's answer. */
  origin?: TurnOrigin;
}

/** The most one read returns, and the most one write carries: bigger files move in parts (`offset`, `length`). */
export const TREE_IO_MAX = 16 * 1024 * 1024;
/** Grep skips files larger than this, and files whose first 8 KiB hold a NUL (binary). */
const GREP_FILE_MAX = 8 * 1024 * 1024;
/** The most entries a glob or grep walks before it stops and says `truncated`. */
const WALK_MAX = 200_000;

/** What a holder does: the folder tree's operations, on tree paths in its own part of the tree. A `LocalHolder` does
 *  them on this disk; a `RemoteHolder` asks another computer's over the link. */
export interface Holder {
  /** `noFollow`: no link on the way is followed, anywhere (a link at any part is refused). */
  stat(path: string, call: HolderCall & { noFollow?: boolean }): Promise<FileStat | null>;
  /** `noFollow`: as `stat`, and the opened file must be the path walked; one call, so nothing comes between. */
  read(path: string, call: HolderCall & { encoding?: "utf8" | "base64"; offset?: number; length?: number; noFollow?: boolean }): Promise<TreeData>;
  write(path: string, data: TreeData, call: HolderCall & { executable?: boolean }): Promise<void>;
  mkdir(path: string, call: HolderCall): Promise<void>;
  list(path: string, call: HolderCall): Promise<FileStat[]>;
  remove(path: string, call: HolderCall & { recursive?: boolean }): Promise<void>;
  /** Both paths on this holder. */
  move(from: string, to: string, call: HolderCall): Promise<void>;
  readlink(path: string, call: HolderCall): Promise<string>;
  symlink(path: string, target: string, call: HolderCall): Promise<void>;
  glob(pattern: string, call: HolderCall & { cwd: string; limit?: number }): Promise<{ paths: string[]; truncated: boolean }>;
  grep(pattern: string, call: HolderCall & { cwd: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
  /** Change events under a folder, for a code session's Files panel. */
  watch(path: string, call: HolderCall, fn: (e: TreeWatchEvent) => void): Promise<Unsubscribe>;
}

export interface LocalHolderOptions {
  clock: Pick<Clock, "now">;
  /** This computer's name in the tree, and its old names, read at each call (a rename takes effect at once). */
  name: () => string;
  aliases?: () => readonly string[];
  /** The home folder: `home/<name>/` is it. */
  home: string;
  /** Where the bots this computer runs keep their folders (`<Clover home>/bots`). */
  botsRoot?: string;
  /** Whether this computer runs `bot` (its `bots/<bot>/` lives here). */
  runsBot?: (bot: string) => boolean;
  os?: Os;
  /** This computer's fence. Calls for the user and the core never ask it. */
  fence?: Pick<Fence, "check" | "fencedSet">;
  /** The Clover home, where a fenced caller may make no name that isn't ASCII (B-M1's contract review): a name the
   *  disk folds where no fold here does can't reach a fenced item. */
  cloverHome?: string;
  /** This computer's level, which a peer's change is judged at. */
  level?: () => Level;
  /** What checks a peer's signed answer: the paired devices, this computer's ledger of used card ids, and its own
   *  card for a call. Without them no signed answer counts. */
  answers?: { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer };
  /** This computer's folder watches (one set per computer). */
  watches?: FolderWatches;
  /** This computer's reviewer for a peer's change at `ask-risky` (R1; lane C's): B-M1's `TreeReviewer`. */
  reviewer?: TreeReviewer;
  /** The real path of an open file from its handle (`nofollow.ts`); tests fake it. */
  fdRealPath?: (fd: number, path: string) => string | null;
  /** Tests only: called after each part a `noFollow` walk looks at, to swap something mid-walk. */
  afterLstat?: (real: string) => void | Promise<void>;
  /** Told of every change in a bot's memory here, once it is on disk: lane H's sync, which copies it to the other
   *  computers that run the core, now or when they are back. `rel` is the changed entry's path in the memory folder,
   *  with `/` between names (`""` for the folder itself). */
  memoryChanged?: (bot: string, rel: string) => void;
}

/** The tree's name for a bot's memory, beside the computers in `home/` (the owner's ruling for J-M3); also the folder's
 *  name in the bot's own folder. No computer can be called this. */
export const MEMORY_FOLDER = "memory";

/** The bot whose memory a caller reaches as `home/memory`: a bot's own session (or its side thread). Coding sessions,
 *  agents (ACP or delegated), plugins, peers, the user and the core have none. */
export function memoryBotOf(as: Caller): string | undefined {
  return as.kind === "session" && as.bot !== undefined && (as.sessionKind === "bot" || as.sessionKind === "side-thread") ? as.bot : undefined;
}

/** The name in `home/<this computer>/` that is this computer's Clover home, wherever it is on disk. */
export const CLOVER_HOME_NAME = ".clover";

interface Located {
  area: "home" | "bot" | "clover" | "memory";
  /** The area's real root. */
  root: string;
  segments: string[];
  /** The tree path as given, without a trailing slash. */
  treePath: string;
}

interface Resolved {
  /** Where the call acts: the canonical path of the last name, or, when the call follows links, the real target. */
  real: string;
  /** The area's real root. */
  root: string;
  exists: boolean;
  /** lstat of `real` when it exists. */
  st?: Stats;
}

const NO_DEVICES: AnswerDevices = { get: () => undefined, verifyAnswer: async () => false };
const NEVER: AnswerLedger = { claim: () => false };

/** A Node error as the contract's typed failure. */
export function diskError(err: unknown, what: string): ContractError {
  if (err instanceof ContractError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT": return new ContractError("not_found", `${what} doesn't exist`);
    case "EEXIST": return new ContractError("conflict", `${what} already exists`);
    case "ENOTEMPTY": return new ContractError("invalid", `${what} isn't empty`);
    case "ENOTDIR": return new ContractError("invalid", `a part of ${what} isn't a folder`);
    case "EISDIR": return new ContractError("invalid", `${what} is a folder`);
    case "ELOOP": return new ContractError("refused", `${what} goes through a link that can't be followed`);
    case "EACCES": case "EPERM": return new ContractError("refused", `this computer refused ${what}`);
    case "ENAMETOOLONG": return new ContractError("invalid", `${what} is too long a path`);
    default: return new ContractError("failed", `${what}: ${code ?? (err as Error)?.message ?? "failed"}`);
  }
}

/** A path's real path, when it exists (`exact`); otherwise its nearest existing folder's real path with the rest
 *  joined on, which is what it will be once made. */
function realOrNearest(path: string): { real: string; exact: boolean } {
  const rest: string[] = [];
  for (let p = path; ; ) {
    try {
      return { real: join(realpathSync.native(p), ...rest.reverse()), exact: rest.length === 0 };
    } catch {
      const up = dirname(p);
      if (up === p) return { real: path, exact: false };
      rest.push(basename(p));
      p = up;
    }
  }
}

export class LocalHolder implements Holder {
  readonly os: Os;
  readonly #o: LocalHolderOptions;
  #cloverHomeReal: string | undefined;
  #botsRootReal: string | undefined;
  readonly #answers: { devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer };
  readonly watches: FolderWatches;

  constructor(opts: LocalHolderOptions) {
    this.#o = opts;
    this.os = opts.os ?? hostOs();
    this.#answers = opts.answers ?? { devices: NO_DEVICES, ledger: NEVER, render: () => undefined };
    this.watches = opts.watches ?? new FolderWatches();
  }

  /** This computer's name in the tree. */
  get name(): string {
    return this.#o.name();
  }

  /** A folder's real path, for a command run there: it must exist, be a folder, and pass the fence for a listing. */
  async realFolder(path: string, call: HolderCall): Promise<string> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: true });
    this.#fenced({ op: "list", path: r.real }, call);
    if (!r.exists) throw new ContractError("not_found", `${path} doesn't exist`);
    if (!r.st?.isDirectory()) throw new ContractError("invalid", `${path} isn't a folder`);
    return r.real;
  }

  async watch(path: string, call: HolderCall, fn: (e: TreeWatchEvent) => void): Promise<Unsubscribe> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: true });
    // A project's folder, never a whole home or a bot's whole folder (review minor 2): a recursive watch of those
    // costs the disk everything.
    if (r.real === r.root) throw new ContractError("invalid", `${path} is a whole area of the tree; watch a folder in it`);
    const real = await this.realFolder(path, call);
    const watcher = call.as.kind === "peer" ? `peer:${call.as.device}` : "local";
    return this.watches.subscribe(real, this.#treePath(path), (child) => this.#mayRead(child, call), fn, watcher);
  }

  /** An entry's real path for the direct path (`transfer.ts`): resolved, inside its area and through the fence for
   *  `op`, as a write, a read or a delete would be. */
  async realEntry(path: string, call: HolderCall, op: "read" | "write" | "delete"): Promise<{ real: string; root: string; exists: boolean; dir: boolean }> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: false, create: op === "write" });
    if (r.real === r.root && op !== "read") throw new ContractError("invalid", `${path} is a whole area of the tree`);
    this.#fenced({ op, path: r.real }, call);
    return { real: r.real, root: r.root, exists: r.exists, dir: r.st?.isDirectory() ?? false };
  }

  /** Makes the folders above an entry `realEntry` gave for a write, safely (inside its area, never through a link). */
  async makeParents(entry: { real: string; root: string }, path: string): Promise<void> {
    await this.#mkdirs(entry.root, dirname(entry.real), path);
  }

  /** Whether `call` may see (and so take) a real path here: the fence's read-denied items are hidden. */
  visible(real: string, call: HolderCall): boolean {
    return this.#mayRead(real, call);
  }

  /** Whether `call` may change a real path here (a move's source, entry by entry). */
  changeable(real: string, call: HolderCall): boolean {
    if (call.as.kind === "user" || call.as.kind === "core") return this.#readDenied(real) === undefined;
    return this.#memoryOk(real, call.as, true) && this.#check({ op: "delete", path: real }, call.as).allowed;
  }

  /** Judges a whole operation once, with one binding (the direct path's move or copy; review S1). */
  async judge(call: HolderCall, change: TreeChange, effect: "edit" | "delete" | "move"): Promise<void> {
    await this.#judge(call, change, effect);
  }

  /** The real path a tree path names here, without touching the disk (for bookkeeping and `Tree.resolve`). `as`: who
   *  asks, for `home/memory/` (that bot's memory). */
  realPathOf(path: string, as?: Caller): string {
    const loc = this.#locate(path, as);
    return loc.segments.length === 0 ? loc.root : join(loc.root, ...loc.segments);
  }

  async stat(path: string, call: HolderCall & { noFollow?: boolean }): Promise<FileStat | null> {
    this.#caller(call);
    if (call.noFollow) {
      const w = await this.#walkNoFollow(path, call, "stat");
      return w.st ? this.#statOf(this.#treePath(path), w.real, w.st) : null;
    }
    const r = await this.#resolve(path, call, { follow: false });
    this.#fenced({ op: "stat", path: r.real }, call);
    if (!r.exists || !r.st) return null;
    return this.#statOf(this.#treePath(path), r.real, r.st);
  }

  async read(path: string, call: HolderCall & { encoding?: "utf8" | "base64"; offset?: number; length?: number; noFollow?: boolean }): Promise<TreeData> {
    this.#caller(call);
    let fh: fsp.FileHandle;
    if (call.noFollow) {
      fh = await this.#openNoFollow(path, call);
    } else {
      const r = await this.#resolve(path, call, { follow: true });
      this.#fenced({ op: "read", path: r.real }, call);
      if (!r.exists) throw new ContractError("not_found", `${path} doesn't exist`);
      fh = await this.#openChecked(r, FS.O_RDONLY, call, "read", path);
    }
    try {
      const st = await fh.stat();
      if (st.isDirectory()) throw new ContractError("invalid", `${path} is a folder`);
      if (!st.isFile()) throw new ContractError("invalid", `${path} isn't a file`);
      const offset = call.offset ?? 0;
      const want = Math.min(call.length ?? st.size - offset, Math.max(0, st.size - offset));
      if (want > TREE_IO_MAX) throw new ContractError("invalid", `${path} is ${st.size} bytes; read it in parts of at most ${TREE_IO_MAX}`);
      const buf = new Uint8Array(Math.max(0, want));
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const bytes = buf.subarray(0, got);
      return call.encoding === "base64" ? { encoding: "base64", data: Buffer.from(bytes).toString("base64") } : { encoding: "utf8", text: new TextDecoder().decode(bytes) };
    } finally {
      await fh.close();
    }
  }

  async write(path: string, data: TreeData, call: HolderCall & { executable?: boolean }): Promise<void> {
    this.#caller(call);
    const bytes = data.encoding === "utf8" ? new TextEncoder().encode(data.text) : Buffer.from(data.data, "base64");
    if (bytes.length > TREE_IO_MAX) throw new ContractError("invalid", `${path}: a write carries at most ${TREE_IO_MAX} bytes`);
    const r = await this.#resolve(path, call, { follow: true, create: true });
    this.#fenced({ op: "write", path: r.real }, call);
    if (!call.approved) await this.#judge(call, treeCallBinding("tree.write", { path, data }), "edit");
    if (r.st?.isDirectory()) throw new ContractError("invalid", `${path} is a folder`);
    await this.#mkdirs(r.root, dirname(r.real), path);
    // Truncated only once the open file is checked (a hard link to a fenced item is refused untouched).
    const fh = await this.#openChecked(r, FS.O_WRONLY | FS.O_CREAT, call, "write", path);
    try {
      await fh.truncate(0);
      let off = 0;
      while (off < bytes.length) off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten;
      // On the holder's disk before the call answers (S6 review S5: a write that returned wasn't always there).
      await fh.datasync();
      // A file keeps its mode unless the call says whether it is executable: then x follows each r bit.
      if (this.os !== "windows" && call.executable !== undefined) {
        const mode = (await fh.stat()).mode & 0o7777;
        const next = call.executable ? mode | ((mode & 0o444) >> 2) | 0o100 : mode & ~0o111;
        if (next !== mode) await fh.chmod(next);
      }
    } finally {
      await fh.close();
    }
    this.changedAt(r.real);
  }

  async mkdir(path: string, call: HolderCall): Promise<void> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: false, create: true });
    this.#fenced({ op: "write", path: r.real }, call);
    await this.#judge(call, { method: "tree.mkdir", params: { path } } as unknown as TreeChange, "edit");
    if (r.exists) {
      if (r.st?.isDirectory()) return;
      throw new ContractError("conflict", `${path} is a file`);
    }
    await this.#mkdirs(r.root, r.real, path);
    this.changedAt(r.real);
  }

  async list(path: string, call: HolderCall): Promise<FileStat[]> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: true });
    this.#fenced({ op: "list", path: r.real }, call);
    if (!r.exists) throw new ContractError("not_found", `${path} doesn't exist`);
    if (!r.st?.isDirectory()) throw new ContractError("invalid", `${path} isn't a folder`);
    let ents: Dirent[];
    try {
      ents = await fsp.readdir(r.real, { withFileTypes: true });
    } catch (e) {
      throw diskError(e, path);
    }
    const base = this.#treePath(path);
    const out: FileStat[] = [];
    for (let i = 0; i < ents.length; i += 128) {
      const batch = ents.slice(i, i + 128);
      const stats = await Promise.all(batch.map(async (d) => {
        const real = join(r.real, d.name);
        // A read-denied item (the run folder, the secrets file) doesn't show to anyone the fence judges.
        if (!this.#mayRead(real, call)) return null;
        const st = await fsp.lstat(real).catch(() => null);
        return st ? this.#statOf(`${base}/${d.name}`, real, st) : null; // gone meanwhile: skipped
      }));
      for (const s of stats) if (s) out.push(s);
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async remove(path: string, call: HolderCall & { recursive?: boolean }): Promise<void> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: false });
    this.#fenced({ op: "delete", path: r.real }, call);
    if (r.real === r.root) throw new ContractError("invalid", `${path} is a whole area of the tree; it can't be removed`);
    await this.#judge(call, treeCallBinding("tree.remove", call.recursive === undefined ? { path } : { path, recursive: call.recursive }), "delete");
    if (!r.exists) throw new ContractError("not_found", `${path} doesn't exist`);
    // Anchored to each folder on the way where libc allows (`at.ts`, review minor 6).
    const at = this.#at();
    if (at) {
      at.remove(r.root, this.#rel(r.root, r.real), { dir: r.st?.isDirectory() === true, recursive: call.recursive === true }, path);
      this.changedAt(r.real);
      return;
    }
    try {
      if (r.st?.isDirectory()) {
        if (call.recursive) await fsp.rm(r.real, { recursive: true, force: false });
        else await fsp.rmdir(r.real);
      } else {
        await fsp.unlink(r.real);
      }
    } catch (e) {
      throw diskError(e, path);
    }
    this.changedAt(r.real);
  }

  async move(from: string, to: string, call: HolderCall): Promise<void> {
    this.#caller(call);
    const src = await this.#resolve(from, call, { follow: false });
    const dst = await this.#resolve(to, call, { follow: false, create: true });
    this.#fenced({ op: "move", path: src.real, to: dst.real }, call);
    if (src.real === src.root) throw new ContractError("invalid", `${from} is a whole area of the tree; it can't be moved`);
    await this.#judge(call, treeCallBinding("tree.move", { from, to }), "move");
    if (!src.exists) throw new ContractError("not_found", `${from} doesn't exist`);
    if (dst.exists && !(this.os !== "linux" && foldName(src.real, this.os) === foldName(dst.real, this.os))) {
      throw new ContractError("conflict", `${to} already exists`);
    }
    if (src.st?.isDirectory() && (dst.real === src.real || dst.real.startsWith(src.real + sep))) {
      throw new ContractError("invalid", `${to} is inside ${from}`);
    }
    await this.#mkdirs(dst.root, dirname(dst.real), to);
    try {
      await this.#rename(src, dst, from);
    } finally {
      this.changedAt(src.real);
      this.changedAt(dst.real);
    }
  }

  async #rename(src: Resolved, dst: Resolved, from: string): Promise<void> {
    const at = this.#at();
    try {
      if (at) at.rename(src.root, this.#rel(src.root, src.real), dst.root, this.#rel(dst.root, dst.real), from);
      else await fsp.rename(src.real, dst.real);
    } catch (e) {
      if ((e as { code?: string }).code === "invalid" && at) {
        // Another disk: copied, then removed, as below.
        await fsp.cp(src.real, dst.real, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        at.remove(src.root, this.#rel(src.root, src.real), { dir: src.st?.isDirectory() === true, recursive: true }, from);
        return;
      }
      if (at) throw e;
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw diskError(e, from);
      await fsp.cp(src.real, dst.real, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await fsp.rm(src.real, { recursive: true, force: false });
    }
  }

  async readlink(path: string, call: HolderCall): Promise<string> {
    this.#caller(call);
    const r = await this.#resolve(path, call, { follow: false });
    this.#fenced({ op: "read", path: r.real }, call);
    if (!r.exists || !r.st?.isSymbolicLink()) throw new ContractError("invalid", `${path} isn't a link`);
    const raw = await fsp.readlink(r.real).catch((e) => { throw diskError(e, path); });
    return this.#linkTarget(r.root, r.real, raw, path);
  }

  async symlink(path: string, target: string, call: HolderCall): Promise<void> {
    this.#caller(call);
    if (target === "" || target.includes("\0") || isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.includes("\\")) {
      throw new ContractError("invalid", "a link's target is a relative path inside the tree");
    }
    const r = await this.#resolve(path, call, { follow: false, create: true });
    if (r.exists) throw new ContractError("conflict", `${path} already exists`);
    const lands = resolvePath(dirname(r.real), target);
    if (!this.#inside(lands, r.root)) throw new ContractError("refused", `a link at ${path} would lead out of its folder`);
    this.#fenced({ op: "write", path: r.real }, call);
    await this.#judge(call, treeCallBinding("tree.write", { path, data: { encoding: "utf8", text: target } }), "edit");
    await this.#mkdirs(r.root, dirname(r.real), path);
    try {
      await fsp.symlink(this.os === "windows" ? target.split("/").join("\\") : target, r.real);
    } catch (e) {
      throw diskError(e, path);
    }
    this.changedAt(r.real);
  }

  async glob(pattern: string, call: HolderCall & { cwd: string; limit?: number }): Promise<{ paths: string[]; truncated: boolean }> {
    this.#caller(call);
    if (pattern.includes("\0") || pattern.split("/").includes("..") || isAbsolute(pattern)) throw new ContractError("invalid", "a glob stays inside its folder");
    const r = await this.#resolve(call.cwd, call, { follow: true });
    this.#fenced({ op: "list", path: r.real }, call);
    if (!r.exists) throw new ContractError("not_found", `${call.cwd} doesn't exist`);
    if (!r.st?.isDirectory()) throw new ContractError("invalid", `${call.cwd} isn't a folder`);
    const base = this.#treePath(call.cwd);
    const limit = call.limit ?? 100_000;
    const out: string[] = [];
    let walked = 0;
    let truncated = false;
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: r.real, onlyFiles: true, dot: true, followSymlinks: false })) {
      if (++walked > WALK_MAX) { truncated = true; break; }
      const posix = rel.split(sep).join("/");
      if (!this.#mayRead(join(r.real, rel), call)) continue;
      out.push(`${base}/${posix}`);
    }
    out.sort();
    if (out.length > limit) { out.length = limit; truncated = true; }
    return { paths: out, truncated };
  }

  async grep(pattern: string, call: HolderCall & { cwd: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    this.#caller(call);
    let re: RegExp;
    try {
      re = new RegExp(pattern, call.ignoreCase ? "i" : "");
    } catch {
      throw new ContractError("invalid", "the pattern isn't a regular expression");
    }
    const r = await this.#resolve(call.cwd, call, { follow: true });
    this.#fenced({ op: "read", path: r.real }, call);
    if (!r.exists) throw new ContractError("not_found", `${call.cwd} doesn't exist`);
    const base = this.#treePath(call.cwd);
    const limit = call.limit ?? 100_000;
    let files: string[];
    if (r.st?.isDirectory()) {
      files = [];
      let walked = 0;
      for await (const rel of new Bun.Glob(call.glob ?? "**/*").scan({ cwd: r.real, onlyFiles: true, dot: true, followSymlinks: false })) {
        if (++walked > WALK_MAX) break;
        files.push(rel);
      }
      files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } else {
      if (call.glob && !new Bun.Glob(call.glob).match(basename(r.real))) return { matches: [], truncated: false };
      files = [""];
    }
    const matches: { path: string; line: number; text: string }[] = [];
    for (const rel of files) {
      const real = rel === "" ? r.real : join(r.real, rel);
      if (!this.#mayRead(real, call)) continue;
      // The same checked open as `read` (check 2's N1): no link followed, the opened file's identity compared, and a
      // file with other names (hard links) skipped for anyone the fence judges.
      const bytes = await this.#contents(real, r.root, call, GREP_FILE_MAX);
      if (!bytes || bytes.subarray(0, 8192).includes(0)) continue;
      const lines = bytes.toString("utf8").split("\n");
      const path = rel === "" ? base : `${base}/${rel.split(sep).join("/")}`;
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!.replace(/\r$/, "");
        if (!re.test(text)) continue;
        if (matches.length >= limit) return { matches, truncated: true };
        matches.push({ path, line: i + 1, text: text.length > 4000 ? text.slice(0, 4000) : text });
      }
    }
    return { matches, truncated: false };
  }

  // ---- resolution ------------------------------------------------------------------------------------------------

  /** Which area a tree path names here, and its segments, each a plain name on this OS. `home/memory/…` is the
   *  calling bot's memory, for that bot's own sessions alone; for anyone else it names no computer. */
  #locate(path: string, as?: Caller): Located {
    const parts = splitTreePath(path);
    if (!parts) throw new ContractError("invalid", `${path} isn't in the folder tree (home/<Computer>/… or bots/<bot>/…)`);
    const segments = parts.rest === "" ? [] : parts.rest.split("/");
    for (const s of segments) checkSegment(s, this.os);
    // Lane B's alias rule (#187): on Windows a stream (`a.json::$DATA`) or a short 8.3 name (`CLOVER~1`) is another
    // file's name, refused wherever it is, for every caller. `checkSegment` and the listed-name check stay as walls.
    if (this.os === "windows") {
      const alias = windowsAlias(segments.join("/"));
      if (alias !== undefined) throw new ContractError("refused", `${path}: "${alias}" may be another file's name on Windows (a stream or a short name)`);
    }
    const treePath = path.replace(/\/+$/, "");
    if (parts.area === "home" && parts.name === MEMORY_FOLDER) {
      const bot = as ? memoryBotOf(as) : undefined;
      if (bot === undefined || !this.#o.botsRoot) throw new ContractError("not_found", `no computer ${MEMORY_FOLDER}`);
      return { area: "memory", root: join(this.#o.botsRoot, pluginIdToSegment(bot), MEMORY_FOLDER), segments, treePath };
    }
    if (parts.area === "home") {
      const names = [this.#o.name(), ...(this.#o.aliases?.() ?? [])];
      if (!names.includes(parts.name)) throw new ContractError("not_found", `${parts.name} isn't this computer`);
      // `.clover` is this computer's Clover home, wherever it is on disk.
      if (this.#o.cloverHome !== undefined && segments.length > 0 && foldName(segments[0]!, this.os) === CLOVER_HOME_NAME) {
        return { area: "clover", root: this.#o.cloverHome, segments: segments.slice(1), treePath };
      }
      return { area: "home", root: this.#o.home, segments, treePath };
    }
    const bot = pluginIdFromSegment(parts.name);
    if (!this.#o.botsRoot || !this.#o.runsBot?.(bot)) throw new ContractError("not_found", `this computer doesn't run ${bot}`);
    return { area: "bot", root: join(this.#o.botsRoot, pluginIdToSegment(bot)), segments, treePath };
  }

  /** Resolves a tree path on this disk and checks where it lands. `follow` follows a link at the last name (the call
   *  acts on what it points to). A missing last name, or missing folders above it, resolve to where they would be
   *  (`exists: false`), so the fence is asked before anything says "doesn't exist"; `create` also makes a bot's folder
   *  that doesn't exist yet. */
  async #resolve(path: string, call: HolderCall, opts: { follow: boolean; create?: boolean }): Promise<Resolved> {
    const loc = this.#locate(path, call.as);
    const root = await this.#rootReal(loc, opts.create === true);
    if (loc.segments.length === 0) {
      const st = await fsp.lstat(root).catch(() => undefined);
      return { real: root, root, exists: st !== undefined, ...(st ? { st } : {}) };
    }
    // The folders above the last name: real paths, inside the area. A missing one is fine only for a create, and only
    // below the deepest folder that exists, which is real and inside.
    let parent = root;
    const above = loc.segments.slice(0, -1);
    for (let i = 0; i < above.length; i++) {
      const next = join(parent, above[i]!);
      let real: string;
      try {
        real = await fsp.realpath(next);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          const st = await fsp.lstat(next).catch(() => null);
          if (st?.isSymbolicLink()) throw new ContractError(opts.create ? "refused" : "not_found", `${path} goes through a link to nothing`);
          const lexical = join(next, ...above.slice(i + 1), loc.segments.at(-1)!);
          this.#landsInside(lexical, root, path);
          return { real: lexical, root, exists: false };
        }
        throw diskError(e, path);
      }
      this.#landsInside(real, root, path);
      parent = real;
    }
    return this.#last(path, root, parent, loc.segments.at(-1)!, opts);
  }

  async #last(path: string, root: string, parent: string, name: string, opts: { follow: boolean; create?: boolean }): Promise<Resolved> {
    const lexical = join(parent, name);
    const st = await fsp.lstat(lexical).catch(() => undefined);
    if (!st) {
      this.#landsInside(lexical, root, path);
      return { real: lexical, root, exists: false };
    }
    let canonical: string;
    if (st.isSymbolicLink() || mayBeShortName(name, this.os)) {
      // A link's own name, or a name Windows may answer to as an alias: its canonical spelling is the one the folder
      // lists. A name the disk answers to but doesn't list is an 8.3 alias, refused.
      const listed = await this.#listedName(parent, name);
      if (listed === null) throw new ContractError("refused", `${path} names an entry by a short (8.3) name`);
      canonical = join(parent, listed);
      if (!st.isSymbolicLink()) canonical = await fsp.realpath(canonical).catch(() => canonical);
    } else {
      canonical = await fsp.realpath(lexical).catch(() => lexical);
    }
    this.#landsInside(canonical, root, path);
    if (opts.follow && st.isSymbolicLink()) {
      let target: string;
      try {
        target = await fsp.realpath(canonical);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          if (opts.create) throw new ContractError("refused", `${path} is a link to nothing; nothing is made through it`);
          return { real: canonical, root, exists: false };
        }
        throw diskError(e, path);
      }
      this.#landsInside(target, root, path);
      const tst = await fsp.lstat(target).catch(() => undefined);
      return { real: target, root, exists: tst !== undefined, ...(tst ? { st: tst } : {}) };
    }
    return { real: canonical, root, exists: true, st };
  }

  /** The area's root, real. A bot's folder that doesn't exist yet is made for a create. */
  async #rootReal(loc: Located, create: boolean): Promise<string> {
    try {
      return await fsp.realpath(loc.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw diskError(e, loc.treePath);
      if (!create || loc.area === "home") {
        if (loc.area !== "home") return loc.root; // nothing there yet; every name under it is missing
        throw new ContractError("not_found", `${loc.treePath} doesn't exist`);
      }
      await fsp.mkdir(loc.root, { recursive: true, mode: 0o700 });
      return fsp.realpath(loc.root);
    }
  }

  /** The name a folder lists for `name`: the same spelling first, then the same name folded; null if none. */
  async #listedName(parent: string, name: string): Promise<string | null> {
    const names = await fsp.readdir(parent).catch(() => [] as string[]);
    if (names.includes(name)) return name;
    const want = foldName(name, this.os);
    return names.find((n) => foldName(n, this.os) === want) ?? null;
  }

  #inside(real: string, root: string): boolean {
    const rel = relative(root, real);
    return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  }

  #landsInside(real: string, root: string, path: string): void {
    if (!this.#inside(real, root)) throw new ContractError("refused", `${path} leads out of its folder`);
  }

  /** Opens `r.real` without following a link there, then checks what was opened is still what the path names, inside
   *  the area and outside the fence (S6's `checkOpened`, with the inode compared too). */
  /** The path walked from its area's root down with no link followed (`noFollow`): every part is looked at with lstat
   *  and refused when it is a link, on Windows a reparse point, or a short (8.3) name; the fence judges the path. `st`
   *  is the last part's, undefined when it doesn't exist. */
  async #walkNoFollow(path: string, call: HolderCall, op: "stat" | "read"): Promise<{ real: string; st?: Stats }> {
    const loc = this.#locate(path, call.as);
    const root = await this.#rootReal(loc, false);
    const real = loc.segments.length === 0 ? root : join(root, ...loc.segments);
    this.#fenced({ op, path: real }, call);
    let at = root;
    let st: Stats | undefined;
    // Each part's identity as the walk saw it, looked at again once the walk is done: a folder swapped for a link
    // mid-walk (whose lstat of the next part went through it) no longer is what the walk saw.
    // A swap undone before this second look isn't caught here (it takes exact timing); `read` is covered by its handle.
    const seen: { path: string; dev: number; ino: number }[] = [];
    const again = async () => {
      for (const s of seen) {
        const now = await fsp.lstat(s.path).catch(() => undefined);
        if (!now || now.isSymbolicLink() || now.dev !== s.dev || now.ino !== s.ino) {
          throw new ContractError("refused", `${path} changed while it was being looked at (a link on the way); a link isn't followed here`);
        }
      }
    };
    for (let i = 0; i < loc.segments.length; i++) {
      const name = loc.segments[i]!;
      const next = join(at, name);
      st = await fsp.lstat(next).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") return undefined;
        throw diskError(e, path);
      });
      await this.#o.afterLstat?.(next);
      if (!st) {
        await again();
        if (i < loc.segments.length - 1) throw new ContractError("not_found", `${path} doesn't exist`);
        return { real };
      }
      seen.push({ path: next, dev: st.dev, ino: st.ino });
      const shown = loc.segments.slice(0, i + 1).join("/");
      if (st.isSymbolicLink() || isReparsePoint(next)) {
        throw new ContractError("refused", `${path} goes through a link at ${shown}; a link isn't followed here`);
      }
      if (mayBeShortName(name, this.os) && (await this.#listedName(at, name)) !== name) {
        throw new ContractError("refused", `${path} names an entry by a short (8.3) name`);
      }
      if (i < loc.segments.length - 1 && !st.isDirectory()) throw new ContractError("not_found", `${path} doesn't exist`);
      at = next;
    }
    if (loc.segments.length === 0) st = await fsp.lstat(root).catch(() => undefined);
    await again();
    return { real, ...(st ? { st } : {}) };
  }

  /** Opens a file for a `noFollow` read: walked as `#walkNoFollow`, opened without following a link at the last part,
   *  and believed only when the handle's real path is the path walked (a folder swapped for a link between the walk
   *  and the open is refused) and it is a plain file. */
  async #openNoFollow(path: string, call: HolderCall): Promise<fsp.FileHandle> {
    const w = await this.#walkNoFollow(path, call, "read");
    if (!w.st) throw new ContractError("not_found", `${path} doesn't exist`);
    if (w.st.isDirectory()) throw new ContractError("invalid", `${path} is a folder`);
    if (!w.st.isFile()) throw new ContractError("invalid", `${path} isn't a file`);
    const nofollow = this.os === "windows" ? 0 : FS.O_NOFOLLOW ?? 0;
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(w.real, FS.O_RDONLY | nofollow);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new ContractError("refused", `${path} is a link; a link isn't followed here`);
      throw diskError(e, path);
    }
    try {
      const opened = await fh.stat({ bigint: true });
      if (!opened.isFile()) throw new ContractError("invalid", `${path} isn't a file`);
      if (opened.nlink > 1n && call.as.kind !== "user" && call.as.kind !== "core") {
        throw new ContractError("refused", `${path} has other names (hard links); open it by its own name outside the tree`);
      }
      const real = (this.#o.fdRealPath ?? fdRealPath)(fh.fd, w.real);
      // Exact on Linux, where names differ by case; folded where the disk folds them (macOS, Windows).
      const same = real !== null && (this.os === "linux" ? real === w.real : foldPath(real, this.os) === foldPath(w.real, this.os));
      if (!same) {
        throw new ContractError("refused", `${path} isn't the file that was opened (a link on the way changed); a link isn't followed here`);
      }
      return fh;
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
  }

  async #openChecked(r: Resolved, flags: number, call: HolderCall, op: "read" | "write", path: string): Promise<fsp.FileHandle> {
    const nofollow = this.os === "windows" ? 0 : FS.O_NOFOLLOW ?? 0;
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(r.real, flags | nofollow, 0o644);
    } catch (e) {
      throw diskError(e, path);
    }
    try {
      const opened = await fh.stat({ bigint: true });
      // A file with another name (a hard link) may be a fenced item under that name, and no path tells which: anyone
      // the fence judges is refused it (review S4).
      if (opened.isFile() && opened.nlink > 1n && call.as.kind !== "user" && call.as.kind !== "core") {
        throw new ContractError("refused", `${path} has other names (hard links); open it by its own name outside the tree`);
      }
      const real = await fsp.realpath(r.real);
      this.#landsInside(real, r.root, path);
      this.#fenced({ op, path: real }, call);
      const now = await fsp.stat(real, { bigint: true });
      if (now.dev !== opened.dev || now.ino !== opened.ino) throw new ContractError("refused", `${path} changed while it was being opened`);
      return fh;
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
  }

  /** Makes the folders from the deepest one that exists down to `dir`, each made inside the area. */
  /** A file's bytes for a content search, read the way `read` opens a file (`#openChecked`), or null to skip it: not
   *  a regular file, larger than `max`, another name of a file (hard links) for a fenced caller, or not what the
   *  path named by the time it was opened. */
  async #contents(real: string, root: string, call: HolderCall, max: number): Promise<Buffer | null> {
    const nofollow = this.os === "windows" ? 0 : FS.O_NOFOLLOW ?? 0;
    const fh = await fsp.open(real, FS.O_RDONLY | nofollow).catch(() => null);
    if (!fh) return null;
    try {
      const opened = await fh.stat({ bigint: true });
      if (!opened.isFile() || opened.size > BigInt(max)) return null;
      if (opened.nlink > 1n && call.as.kind !== "user" && call.as.kind !== "core") return null;
      const now = await fsp.realpath(real).catch(() => null);
      if (!now) return null;
      try {
        this.#landsInside(now, root, real);
      } catch {
        return null;
      }
      if (!this.#mayRead(now, call)) return null;
      const again = await fsp.stat(now, { bigint: true }).catch(() => null);
      if (!again || again.dev !== opened.dev || again.ino !== opened.ino) return null;
      const buf = Buffer.alloc(Number(opened.size));
      let off = 0;
      while (off < buf.length) {
        const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return buf.subarray(0, off);
    } finally {
      await fh.close();
    }
  }

  /** The anchored changes, on macOS and Linux. */
  #at(): AtOps | null {
    return this.os === "windows" ? null : atOps();
  }

  /** `real`'s names below `root`. */
  #rel(root: string, real: string): string[] {
    const r = relative(root, real);
    return r === "" ? [] : r.split(sep);
  }

  async #mkdirs(root: string, dir: string, path: string): Promise<void> {
    this.#landsInside(dir, root, path);
    const at = this.#at();
    if (at) {
      at.mkdirs(root, this.#rel(root, dir), path);
      return;
    }
    const missing: string[] = [];
    let p = dir;
    for (;;) {
      const st = await fsp.lstat(p).catch(() => undefined);
      if (st) {
        if (st.isSymbolicLink()) {
          const real = await fsp.realpath(p).catch(() => { throw new ContractError("refused", `${path} goes through a link to nothing`); });
          this.#landsInside(real, root, path);
          if (!(await fsp.stat(real)).isDirectory()) throw new ContractError("invalid", `a part of ${path} is a file`);
        } else if (!st.isDirectory()) {
          throw new ContractError("invalid", `a part of ${path} is a file`);
        }
        break;
      }
      missing.push(p);
      if (p === root || dirname(p) === p) break;
      p = dirname(p);
    }
    for (const m of missing.reverse()) {
      try {
        await fsp.mkdir(m);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw diskError(e, path);
      }
      const real = await fsp.realpath(m);
      this.#landsInside(real, root, path);
    }
  }

  /** A link's target as another computer may see it: relative, and inside the area. An absolute target inside the
   *  area becomes relative; one that leaves it answers `refused` (S6 edit 6). */
  #linkTarget(root: string, at: string, raw: string, path: string): string {
    let t = raw.startsWith("\\\\?\\") ? raw.slice(4) : raw;
    const lands = isAbsolute(t) ? t : resolvePath(dirname(at), t);
    if (!this.#inside(lands, root)) throw new ContractError("refused", `${path} points out of its folder`);
    if (isAbsolute(t)) t = relative(dirname(at), t) || ".";
    return t.split(sep).join("/");
  }

  // ---- callers, the fence and the level ----------------------------------------------------------------------------

  #caller(call: HolderCall | undefined): void {
    if (!call || typeof call.as !== "object" || call.as === null) throw new ContractError("invalid", "a tree call says whom it is for (`as`)");
  }

  /** Every caller but the user on this computer and the core meets the fence; a peer always (review N2). */
  #fenced(op: FenceOp, call: HolderCall): void {
    const as = call.as;
    if (as.kind === "user" || as.kind === "core") {
      // The read-denied items (the run folder, the secrets file, key files…) are no one's through the tree, the user's
      // surfaces included: a paired phone or the web companion never reads them; the core reads them directly.
      for (const p of op.op === "move" ? [op.path, op.to] : [op.path]) {
        const item = this.#readDenied(p);
        if (item) throw new ContractError("fenced", `${item} is never read through the folder tree`, { computer: this.#o.name(), reason: "read-denied" });
      }
      return;
    }
    for (const p of op.op === "move" ? [op.path, op.to] : [op.path]) {
      // The same refusal as the fence's own `bot-memory` rule (lane B's #197), which says it at the OS's level too.
      if (!this.#memoryOk(p, as, op.op !== "read" && op.op !== "stat" && op.op !== "list")) {
        throw new ContractError("fenced", "a bot's memory is the bots' alone", { computer: this.#o.name(), reason: "bot-memory" });
      }
    }
    if (op.op === "write" || op.op === "delete" || op.op === "move") {
      for (const p of op.op === "move" ? [op.path, op.to] : [op.path]) this.#asciiUnderCloverHome(p);
    }
    const verdict = this.#check(op, as);
    if (!verdict.allowed) {
      throw new ContractError("fenced", `the fence keeps bots out of ${verdict.path}`, { computer: this.#o.name(), reason: verdict.reason });
    }
  }

  /** The read-denied fenced item `real` is in, if any (`deny: "read-write"`), folded as the disk may. */
  #readDenied(real: string): string | undefined {
    const fence = this.#o.fence;
    if (!fence) return undefined;
    const p = foldPath(real, this.os);
    return fence.fencedSet().find((i) => i.deny === "read-write" && isInside(p, foldPath(i.path, this.os)))?.path;
  }

  #mayRead(real: string, call: HolderCall): boolean {
    if (call.as.kind === "user" || call.as.kind === "core") return this.#readDenied(real) === undefined;
    return this.#memoryOk(real, call.as, false) && this.#check({ op: "read", path: real }, call.as).allowed;
  }

  /** Tells lane H's sync that a real path changed, when it is in a bot's memory (the direct path calls this for what
   *  it places and lets go of). */
  changedAt(real: string): void {
    const at = this.#memoryAt(real);
    if (at) this.#o.memoryChanged?.(at.bot, at.rel);
  }

  /** The bot whose memory holds a real path, and the path in it. */
  #memoryAt(real: string): { bot: string; rel: string } | undefined {
    if (!this.#o.botsRoot || !this.#o.memoryChanged) return undefined;
    const root = this.#botsRoot();
    const rel = relative(root, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    const [seg, folder, ...rest] = rel.split(sep);
    if (seg === undefined || folder === undefined || foldName(folder, this.os) !== MEMORY_FOLDER) return undefined;
    return { bot: pluginIdFromSegment(seg), rel: rest.join("/") };
  }

  /** The bots' folder's real path. Kept only once the folder exists: before that, its nearest folder that does is
   *  resolved and the rest joined on, every time, so a Clover home behind a symlink compares right both before and
   *  after `bots/` is made (#254's review, should-fix 7). */
  #botsRoot(): string {
    if (this.#botsRootReal !== undefined) return this.#botsRootReal;
    const r = realOrNearest(this.#o.botsRoot!);
    if (r.exact) this.#botsRootReal = r.real;
    return r.real;
  }

  /** Whether `as` may reach a real path as far as bots' memories go. A bot's session or side thread: always here, its
   *  reach is the fence's alone (the owner's ruling of November 9 and its amendment: every bot reads and writes every
   *  bot's memory; lane C's `homeAllows` and the fence's own `bot-memory` rule judge it), so the tree adds no deny that
   *  would still block it. Anyone else: nothing inside `<bots>/<bot>/memory/`, and for a change (`change`) not the
   *  bots' folder itself or a bot's whole folder, which hold memories. Names compare folded, as the disk may. Anything
   *  else is fine here. */
  #memoryOk(real: string, as: Caller, change: boolean): boolean {
    if (!this.#o.botsRoot) return true;
    if (memoryBotOf(as) !== undefined) return true;
    const fold = (p: string) => foldPath(p, this.os).replace(/\/+$/, "");
    const root = fold(this.#botsRoot());
    const p = fold(real);
    if (p !== root && !p.startsWith(`${root}/`)) return true;
    const names = p.slice(root.length).split("/").filter((n) => n !== "");
    if (names.length <= 1) return !change;
    return names[1] !== foldName(MEMORY_FOLDER, this.os);
  }

  /** Lane B's second wall (`nonAsciiAlias`): a name that isn't ASCII where Clover names things under its home (its top
   *  level, and any folder there that holds a fenced item) is refused, whatever a disk might fold it to. A bot's memory
   *  notes and a plugin's assets may have any name. */
  #asciiUnderCloverHome(real: string): void {
    if (!this.#o.cloverHome) return;
    // The home's real path, as the paths it is compared with are (`/var` is `/private/var` on a Mac).
    let home = this.#cloverHomeReal;
    if (home === undefined) {
      const r = realOrNearest(this.#o.cloverHome);
      if (r.exact) this.#cloverHomeReal = r.real;
      home = r.real;
    }
    if (nonAsciiAlias(real, this.#o.fence?.fencedSet() ?? [], home, this.os)) {
      throw new ContractError("fenced", `names Clover keeps under its home are ASCII; ${basename(real)} isn't`, { computer: this.#o.name(), reason: "clover-home" });
    }
  }

  /** The fence's verdict, as is and folded (review B1): refused when either refuses. */
  #check(op: FenceOp, as: Caller): FenceVerdict {
    const fence = this.#o.fence;
    if (!fence) return { allowed: true };
    // The caller's reach for the pattern items (`bot-memory`, `sessions-runtime`), as `Fence.forCaller` binds it.
    const plain = fence.check(op, fenceContextFor(as));
    if (!plain.allowed) return plain;
    const fold = (p: string) => foldPath(p, this.os);
    const set = fence.fencedSet().map((item) => ({ ...item, path: fold(item.path) }));
    const folded = fenceJudge(set, op.op === "move" ? { ...op, path: fold(op.path), to: fold(op.to) } : { ...op, path: fold(op.path) }, { os: this.os });
    if (folded.allowed) return folded;
    // Name the item as the fence does, not folded.
    const item = fence.fencedSet().find((i) => fold(i.path) === folded.path);
    return { ...folded, path: item?.path ?? folded.path };
  }

  /** A peer's change, at the stricter of this computer's level and the call's (`judge.ts`, R1): the reviewer passes
   *  what isn't risky at `ask-risky`; the rest needs the user's signed answer bound to exactly it (N2). */
  async #judge(call: HolderCall, change: TreeChange, effect: "edit" | "delete" | "move"): Promise<void> {
    if (call.as.kind !== "peer") return;
    if (call.level === undefined) throw new ContractError("invalid", "a peer's change says its level");
    await judgePeer({
      computer: this.#o.name(), ownLevel: this.#o.level?.(), callLevel: call.level, effect,
      method: change.method, params: change.params, as: call.as, now: this.#o.clock.now(), answers: this.#answers,
      ...(call.answer ? { answer: call.answer } : {}),
      ...(this.#o.reviewer ? { reviewer: (c: { computer: string; as: Caller }) => this.#o.reviewer!({ ...change, computer: c.computer, as: c.as }) } : {}),
    });
  }

  #treePath(path: string): string {
    return path.replace(/\/+$/, "");
  }

  async #statOf(treePath: string, real: string, st: Stats): Promise<FileStat> {
    const type = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
    let executable = false;
    if (type === "file") executable = this.os === "windows" ? await windowsExecutable(real, st.nlink > 1) : (st.mode & 0o111) !== 0;
    return { path: treePath, type, size: type === "file" ? st.size : 0, modifiedAt: Math.max(0, Math.floor(st.mtimeMs)), executable };
  }
}

const WINDOWS_EXEC = /\.(exe|com|bat|cmd|ps1)$/i;

/** Windows keeps no x bit. A file counts as executable by its extension, or by a `#!` line, as Git for Windows reads
 *  a script. A file with other names (hard links) is judged by its extension alone, so not even two of its bytes are
 *  read through this name (check 2's N1). */
async function windowsExecutable(real: string, linked = false): Promise<boolean> {
  if (WINDOWS_EXEC.test(real)) return true;
  if (linked) return false;
  const fh = await fsp.open(real, FS.O_RDONLY).catch(() => null);
  if (!fh) return false;
  try {
    const b = new Uint8Array(2);
    const { bytesRead } = await fh.read(b, 0, 2, 0);
    return bytesRead === 2 && b[0] === 0x23 && b[1] === 0x21;
  } finally {
    await fh.close();
  }
}
