// The folder tree, as one computer's core sees it (spec §9.1, the contract in `contracts/tree.ts`; the owner's items
// 88 and 89). `home/<Computer>/` for each connected computer and `bots/<bot>/` for each bot, every call run by the
// computer that holds the files: this computer's own part through its `LocalHolder`, every other computer's over the
// link through a `RemoteHolder`. Nothing is mounted and nothing is synced.
//
// * A computer that is off answers `computer_offline` at once, before anything is sent.
// * A call for another computer carries the calling computer's level for it, the stricter of the computers it touches
//   (§9.1 "Approvals follow the files"), and the holder judges it at the stricter of that and its own (review N2).
// * A move or copy between two computers takes the direct path (edit J8, `transfer.ts`): the destination's holder
//   takes the files straight from the source's over the link between them, and a move removes the source only once
//   they're in place. Without it (the tree alone, in tests) a move copies through this computer.
import type { FileStat, Level, Os } from "@waifucave/clover-protocol";
import { DEFAULT_LEVEL, pluginIdFromSegment, pluginIdToSegment } from "@waifucave/clover-protocol";
import { strictestLevel } from "../contracts/approval-broker";
import { ContractError, type Unsubscribe } from "../contracts/common";
import { splitTreePath, type Tree, type TreeCallOptions, type TreeData, type TreeLocation } from "../contracts/tree";
import { TREE_IO_MAX, type Holder, type HolderCall } from "./holder";
import { foldName } from "./names";
import type { TreeWatchEvent } from "./watch";

/** One computer, as the tree needs it. */
export interface TreeComputer {
  name: string;
  aliases: readonly string[];
  online: boolean;
  level: Level;
  /** Its home folder's real path and its OS; unknown until its first hello over the link. */
  home?: string;
  os?: Os;
  /** Where the bots it runs keep their folders (`<Clover home>/bots`). */
  botsRoot?: string;
}

export interface TreeDirectory {
  /** This computer's name. */
  self(): string;
  /** By name or an old name. */
  get(nameOrAlias: string): TreeComputer | undefined;
}

export interface CoreTreeOptions {
  directory: TreeDirectory;
  /** The holder for a computer: this one's `LocalHolder`, another's `RemoteHolder`. */
  holder(computer: string): Holder;
  /** Which computer runs `bot` (its `bots/<bot>/` lives there). */
  botComputer(bot: string): string | undefined;
  /** The direct path between holders (`transfer.ts`): a move between computers, or any copy. */
  transfer?: (o: { from: string; to: string; move: boolean; source: string; destination: string; call: HolderCall }) => Promise<void>;
}

/** The most a move through this computer copies of one file (no direct path); the direct path streams any size. */
export const CROSS_MOVE_FILE_MAX = TREE_IO_MAX * 4;

/** A real path inside `home`, joined the way that computer's OS writes paths. */
function joinReal(os: Os | undefined, root: string, rest: string): string {
  if (rest === "") return root;
  if (os === "windows") return `${root.replace(/[\\/]+$/, "")}\\${rest.split("/").join("\\")}`;
  return `${root.replace(/\/+$/, "")}/${rest}`;
}

export class CoreTree implements Tree {
  readonly #o: CoreTreeOptions;

  constructor(opts: CoreTreeOptions) {
    this.#o = opts;
  }

  resolve(path: string): TreeLocation {
    const parts = splitTreePath(path);
    if (!parts) throw new ContractError("invalid", `${path} isn't in the folder tree (home/<Computer>/… or bots/<bot>/…)`);
    if (parts.area === "home") {
      const c = this.#o.directory.get(parts.name);
      if (!c) throw new ContractError("not_found", `no computer ${parts.name}`);
      if (c.home === undefined) throw new ContractError("computer_offline", `${c.name} hasn't said where its home folder is yet`, { computer: c.name });
      return { computer: c.name, path: joinReal(c.os, c.home, parts.rest), area: "home" };
    }
    const bot = pluginIdFromSegment(parts.name);
    const name = this.#o.botComputer(bot);
    const c = name === undefined ? undefined : this.#o.directory.get(name);
    if (!c) throw new ContractError("not_found", `no computer runs ${bot}`);
    if (c.home === undefined) throw new ContractError("computer_offline", `${c.name} hasn't said where its home folder is yet`, { computer: c.name });
    const root = c.botsRoot ?? joinReal(c.os, c.home, ".clover/bots");
    return { computer: c.name, path: joinReal(c.os, root, parts.rest === "" ? pluginIdToSegment(bot) : `${pluginIdToSegment(bot)}/${parts.rest}`), area: "bot", bot };
  }

  toTreePath(computer: string, realPath: string): string | null {
    const c = this.#o.directory.get(computer);
    if (!c?.home) return null;
    const win = c.os === "windows";
    const norm = (p: string) => (win ? p.replace(/\//g, "\\").replace(/\\+$/, "") : p.replace(/\/+$/, "") || "/");
    const home = norm(c.home);
    const real = norm(realPath);
    const same = (a: string, b: string) => (c.os === "linux" ? a === b : foldName(a, c.os ?? "macos") === foldName(b, c.os ?? "macos"));
    const s = win ? "\\" : "/";
    if (same(real, home)) return `home/${c.name}`;
    if (real.length <= home.length + 1 || !same(real.slice(0, home.length + 1), home + s)) return null;
    const rest = real.slice(home.length + 1).split(s);
    if (rest.some((x) => x === "" || x === "." || x === "..")) return null;
    return `home/${c.name}/${rest.join("/")}`;
  }

  async stat(path: string, opts: TreeCallOptions): Promise<FileStat | null> {
    const { holder, call } = this.#reach([path], opts);
    return holder.stat(path, call);
  }

  async read(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64" }): Promise<TreeData> {
    const { holder, call } = this.#reach([path], opts);
    return holder.read(path, { ...call, ...(opts.encoding === undefined ? {} : { encoding: opts.encoding }) });
  }

  async write(path: string, data: TreeData, opts: TreeCallOptions & { executable?: boolean }): Promise<void> {
    const { holder, call } = this.#reach([path], opts);
    await holder.write(path, data, { ...call, ...(opts.executable === undefined ? {} : { executable: opts.executable }) });
  }

  async list(path: string, opts: TreeCallOptions): Promise<FileStat[]> {
    const { holder, call } = this.#reach([path], opts);
    return holder.list(path, call);
  }

  async remove(path: string, opts: TreeCallOptions & { recursive?: boolean }): Promise<void> {
    const { holder, call } = this.#reach([path], opts);
    await holder.remove(path, { ...call, ...(opts.recursive === undefined ? {} : { recursive: opts.recursive }) });
  }

  async move(from: string, to: string, opts: TreeCallOptions): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    if (src.computer === dst.computer) {
      const { holder, call } = this.#reach([from, to], opts);
      await holder.move(from, to, call);
      return;
    }
    const { call } = this.#reach([from, to], opts);
    if (this.#o.transfer) {
      await this.#o.transfer({ from, to, move: true, source: src.computer, destination: dst.computer, call });
      return;
    }
    const a = this.#o.holder(src.computer);
    const b = this.#o.holder(dst.computer);
    const top = await a.stat(from, call);
    if (!top) throw new ContractError("not_found", `${from} doesn't exist`);
    if (await b.stat(to, call)) throw new ContractError("conflict", `${to} already exists`);
    try {
      await this.#copy(a, b, from, to, top, call);
    } catch (e) {
      // Nothing of the source was touched; take back what was copied, if the holder lets the same caller.
      await b.remove(to, { ...call, recursive: true }).catch(() => {});
      throw e;
    }
    await a.remove(from, { ...call, recursive: true });
  }

  /** Copies a file or a folder, on one computer or between two, by the direct path: the files never pass through
   *  this computer unless it holds one end. */
  async copy(from: string, to: string, opts: TreeCallOptions): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    const { call } = this.#reach([from, to], opts);
    if (this.#o.transfer) {
      await this.#o.transfer({ from, to, move: false, source: src.computer, destination: dst.computer, call });
      return;
    }
    const a = this.#o.holder(src.computer);
    const b = this.#o.holder(dst.computer);
    const top = await a.stat(from, call);
    if (!top) throw new ContractError("not_found", `${from} doesn't exist`);
    if (await b.stat(to, call)) throw new ContractError("conflict", `${to} already exists`);
    try {
      await this.#copy(a, b, from, to, top, call);
    } catch (e) {
      await b.remove(to, { ...call, recursive: true }).catch(() => {});
      throw e;
    }
  }

  async glob(pattern: string, opts: TreeCallOptions & { cwd: string }): Promise<string[]> {
    const { holder, call } = this.#reach([opts.cwd], opts);
    return (await holder.glob(pattern, { ...call, cwd: opts.cwd })).paths;
  }

  async grep(pattern: string, opts: TreeCallOptions & { path: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ path: string; line: number; text: string }[]> {
    const { holder, call } = this.#reach([opts.path], opts);
    const res = await holder.grep(pattern, {
      ...call, cwd: opts.path,
      ...(opts.glob === undefined ? {} : { glob: opts.glob }),
      ...(opts.ignoreCase === undefined ? {} : { ignoreCase: opts.ignoreCase }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    return res.matches;
  }

  computersFor(paths: readonly string[]): string[] {
    return [...new Set(paths.map((p) => this.resolve(p).computer))];
  }

  /** Glob with the truncation flag, for the tool layer and the `tree.glob` method. */
  async globAll(pattern: string, opts: TreeCallOptions & { cwd: string; limit?: number }): Promise<{ paths: string[]; truncated: boolean }> {
    const { holder, call } = this.#reach([opts.cwd], opts);
    return holder.glob(pattern, { ...call, cwd: opts.cwd, ...(opts.limit === undefined ? {} : { limit: opts.limit }) });
  }

  /** Grep with the truncation flag. */
  async grepAll(pattern: string, opts: TreeCallOptions & { cwd: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    const { holder, call } = this.#reach([opts.cwd], opts);
    return holder.grep(pattern, {
      ...call, cwd: opts.cwd,
      ...(opts.glob === undefined ? {} : { glob: opts.glob }),
      ...(opts.ignoreCase === undefined ? {} : { ignoreCase: opts.ignoreCase }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
  }

  /** Change events under a folder, from the computer that holds it: what a code session's Files panel shows fresh
   *  (the owner's item 88). The folder's holder fences them as it fences a listing. */
  async watch(path: string, opts: TreeCallOptions, fn: (e: TreeWatchEvent) => void): Promise<Unsubscribe> {
    const { holder, call } = this.#reach([path], opts);
    return holder.watch(path, call, fn);
  }

  /** A file's bytes in parts, for the tool layer: `offset` and `length` reach the holder. */
  async readPart(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64"; offset?: number; length?: number }): Promise<TreeData> {
    const { holder, call } = this.#reach([path], opts);
    return holder.read(path, {
      ...call,
      ...(opts.encoding === undefined ? {} : { encoding: opts.encoding }),
      ...(opts.offset === undefined ? {} : { offset: opts.offset }),
      ...(opts.length === undefined ? {} : { length: opts.length }),
    });
  }

  /** Where every path lives, each computer online, and what a call to them carries. The holder of the first path
   *  serves the call. */
  #reach(paths: readonly string[], opts: TreeCallOptions): { holder: Holder; call: HolderCall } {
    if (!opts || typeof opts.as !== "object" || opts.as === null) throw new ContractError("invalid", "a tree call says whom it is for (`as`)");
    const computers = [...new Set(paths.map((p) => this.resolve(p).computer))];
    const levels: Level[] = [];
    for (const name of computers) {
      const c = this.#o.directory.get(name)!;
      if (!c.online) throw new ContractError("computer_offline", `${c.name} is offline`, { computer: c.name });
      levels.push(c.level ?? DEFAULT_LEVEL);
    }
    const self = this.#o.directory.self();
    const remote = computers.some((c) => c !== self);
    // A call for another computer says its level (the stricter of those it touches); the holder judges at the stricter
    // of that and its own. A peer's own call, relayed, keeps the level it came with.
    const level = opts.level ?? (remote && opts.as.kind !== "peer" ? strictestLevel(levels) : undefined);
    const call: HolderCall = {
      as: opts.as,
      ...(level === undefined ? {} : { level }),
      ...(opts.answer === undefined ? {} : { answer: opts.answer }),
    };
    return { holder: this.#o.holder(computers[0]!), call };
  }

  /** Copies `from` (on `a`) to `to` (on `b`): files in parts, folders, and links whose target stays in the tree. */
  async #copy(a: Holder, b: Holder, from: string, to: string, st: FileStat, call: HolderCall): Promise<void> {
    if (st.type === "dir") {
      await b.mkdir(to, call);
      for (const e of await a.list(from, call)) {
        const name = e.path.slice(e.path.lastIndexOf("/") + 1);
        await this.#copy(a, b, `${from.replace(/\/+$/, "")}/${name}`, `${to.replace(/\/+$/, "")}/${name}`, e, call);
      }
      return;
    }
    if (st.type === "symlink") {
      await b.symlink(to, await a.readlink(from, call), call);
      return;
    }
    if (st.type !== "file") throw new ContractError("invalid", `${from} isn't a file, folder or link; it can't move to another computer`);
    if (st.size > CROSS_MOVE_FILE_MAX) throw new ContractError("invalid", `${from} is ${st.size} bytes; moving a file this large needs the direct path`);
    const parts: Uint8Array[] = [];
    for (let off = 0; off < st.size || off === 0; off += TREE_IO_MAX) {
      const d = await a.read(from, { ...call, encoding: "base64", offset: off, length: Math.min(TREE_IO_MAX, Math.max(1, st.size - off)) });
      parts.push(Buffer.from(d.encoding === "base64" ? d.data : d.text, d.encoding === "base64" ? "base64" : "utf8"));
      if (st.size === 0) break;
    }
    const bytes = Buffer.concat(parts);
    await b.write(to, { encoding: "base64", data: bytes.toString("base64") }, { ...call, executable: st.executable });
  }
}
