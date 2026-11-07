// The folder tree, as one computer's core sees it (spec §9.1, the contract in `contracts/tree.ts`; the owner's items
// 88 and 89). `home/<Computer>/` for each connected computer and `bots/<bot>/` for each bot, every call run by the
// computer that holds the files: this computer's own part through its `LocalHolder`, every other computer's over the
// link through a `RemoteHolder`. Nothing is mounted and nothing is synced.
//
// * A computer that is off answers `computer_offline` at once, before anything is sent.
// * A call for another computer carries the calling computer's level for it, the stricter of the computers it touches
//   (§9.1 "Approvals follow the files"), and the holder judges it at the stricter of that and its own (review N2).
// * A move between two computers, and any copy, takes the direct path (`transfer.ts`; edit J8, review S1): the
//   destination's holder takes the files straight from the source's, each judging the whole operation once, and for a
//   move the source lets go of what it sent only once the files are in place.
import type { FileStat, Level, Os } from "@waifucave/clover-protocol";
import { DEFAULT_LEVEL, pluginIdFromSegment, pluginIdToSegment } from "@waifucave/clover-protocol";
import { strictestLevel } from "../contracts/approval-broker";
import { ContractError, type Unsubscribe } from "../contracts/common";
import { splitTreePath, type Tree, type TreeCallOptions, type TreeData, type TreeLocation } from "../contracts/tree";
import { CLOVER_HOME_NAME, type Holder, type HolderCall } from "./holder";
import type { TransferResult } from "./transfer";
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
  /** The direct path between holders (`transfer.ts`), for a move between computers or any copy, with the one signed
   *  answer for the whole operation that both holders check (ruling R15). */
  transfer?: (o: { from: string; to: string; move: boolean; source: string; destination: string; call: HolderCall }) => Promise<TransferResult>;
}

/** A computer's Clover home: where its bots' folders are, less `bots`, or `<home>/.clover` until it says. */
function cloverHomeOf(c: TreeComputer): string | undefined {
  if (c.botsRoot !== undefined) return c.botsRoot.replace(/[\\/]+bots[\\/]*$/, "");
  return c.home === undefined ? undefined : joinReal(c.os, c.home, CLOVER_HOME_NAME);
}

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
      // `home/<Computer>/.clover/` is that computer's Clover home, wherever it is on its disk.
      const [first, ...below] = parts.rest.split("/");
      const cloverHome = cloverHomeOf(c);
      if (first !== undefined && cloverHome !== undefined && foldName(first, c.os ?? "macos") === CLOVER_HOME_NAME) {
        return { computer: c.name, path: joinReal(c.os, cloverHome, below.join("/")), area: "home" };
      }
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
    // The Clover home first: it is `home/<Computer>/.clover/` wherever it is.
    const ch = cloverHomeOf(c);
    if (ch !== undefined) {
      const clover = norm(ch);
      if (same(real, clover)) return `home/${c.name}/${CLOVER_HOME_NAME}`;
      if (real.length > clover.length + 1 && same(real.slice(0, clover.length + 1), clover + s)) {
        const rest = real.slice(clover.length + 1).split(s);
        if (!rest.some((x) => x === "" || x === "." || x === "..")) return `home/${c.name}/${CLOVER_HOME_NAME}/${rest.join("/")}`;
      }
    }
    if (same(real, home)) return `home/${c.name}`;
    if (real.length <= home.length + 1 || !same(real.slice(0, home.length + 1), home + s)) return null;
    const rest = real.slice(home.length + 1).split(s);
    if (rest.some((x) => x === "" || x === "." || x === "..")) return null;
    return `home/${c.name}/${rest.join("/")}`;
  }

  /** `noFollow`: no link anywhere on the way is followed (one is refused), for the user's own file viewers. */
  async stat(path: string, opts: TreeCallOptions & { noFollow?: boolean }): Promise<FileStat | null> {
    const { holder, call } = this.#reach([path], opts);
    return holder.stat(path, { ...call, ...(opts.noFollow ? { noFollow: true } : {}) });
  }

  /** `noFollow`: as `stat`, in the same call: only a plain file reached without a link is read. */
  async read(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64"; noFollow?: boolean }): Promise<TreeData> {
    const { holder, call } = this.#reach([path], opts);
    return holder.read(path, { ...call, ...(opts.encoding === undefined ? {} : { encoding: opts.encoding }), ...(opts.noFollow ? { noFollow: true } : {}) });
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

  /** A move between computers is judged by both holders, each at the stricter of its level and the call's, so it may
   *  need the user's answer at each: `answer` and `answers` go to the holder whose card each binds. */
  async move(from: string, to: string, opts: TreeCallOptions): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    if (src.computer === dst.computer) {
      const { holder, call } = this.#reach([from, to], opts);
      await holder.move(from, to, call);
      return;
    }
    await this.#direct(true, from, to, opts);
  }

  /** Copies a file or a folder, on one computer or between two, by the direct path: the files never pass through
   *  this computer unless it holds one end. */
  async copy(from: string, to: string, opts: TreeCallOptions): Promise<void> {
    await this.#direct(false, from, to, opts);
  }

  async #direct(move: boolean, from: string, to: string, opts: TreeCallOptions): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    const { call } = this.#reach([from, to], opts);
    if (!this.#o.transfer) throw new ContractError("invalid", "this tree has no direct path between computers");
    const r = await this.#o.transfer({ from, to, move, source: src.computer, destination: dst.computer, call });
    if (r.kept > 0) {
      throw new ContractError("conflict", `${to} has the files; ${r.kept} of them changed at ${from} while they moved, so they stay there too`, { kept: r.kept });
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
  async readPart(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64"; offset?: number; length?: number; noFollow?: boolean }): Promise<TreeData> {
    const { holder, call } = this.#reach([path], opts);
    return holder.read(path, {
      ...call, ...(opts.noFollow ? { noFollow: true } : {}),
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
}
