// FakeTree: one in-memory file system per computer, joined into the folder tree, with each computer's fence and an
// on/off switch. It never touches the real disk.
import { pluginIdFromSegment, pluginIdToSegment, type Caller, type FileStat } from "@waifucave/clover-protocol";
import type { Clock } from "../clock";
import { ContractError, isInside, normalizePosix } from "../common";
import type { Fence, FenceOp } from "../fence";
import { splitTreePath, type Tree, type TreeCallOptions, type TreeData, type TreeLocation } from "../tree";

interface Node {
  type: "file" | "dir";
  data?: Uint8Array;
  executable: boolean;
  modifiedAt: number;
}

export interface FakeTreeComputer {
  /** The computer's home folder, a real POSIX path: `home/<Computer>/` is it. */
  home: string;
  /** Where `bots/<bot>/` lives on this computer when it runs that bot (`<Clover home>/bots`). */
  botsRoot?: string;
  online?: boolean;
  aliases?: string[];
  fence?: Pick<Fence, "check">;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const parentPath = (p: string) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));

export class FakeTree implements Tree {
  readonly #clock: Pick<Clock, "now">;
  readonly #computers = new Map<string, FakeTreeComputer>();
  readonly #fs = new Map<string, Map<string, Node>>();
  readonly #botComputer: (bot: string) => string | undefined;

  constructor(opts: { clock: Pick<Clock, "now">; computers: Record<string, FakeTreeComputer>; botComputer: (bot: string) => string | undefined }) {
    this.#clock = opts.clock;
    this.#botComputer = opts.botComputer;
    for (const [name, c] of Object.entries(opts.computers)) this.addComputer(name, c);
  }

  addComputer(name: string, c: FakeTreeComputer): void {
    this.#computers.set(name, { online: true, ...c, home: normalizePosix(c.home) });
    const fs = new Map<string, Node>();
    const now = this.#clock.now();
    for (let p = normalizePosix(c.home); ; p = parentPath(p)) {
      fs.set(p, { type: "dir", executable: false, modifiedAt: now });
      if (p === "/") break;
    }
    this.#fs.set(name, fs);
  }

  setOnline(name: string, online: boolean): void {
    const c = this.#computers.get(name);
    if (c) c.online = online;
  }

  resolve(path: string): TreeLocation {
    const parts = splitTreePath(path);
    if (!parts) throw new ContractError("invalid", `${path} isn't in the folder tree (home/<Computer>/… or bots/<bot>/…)`);
    if (parts.area === "home") {
      const name = this.#computerName(parts.name);
      if (!name) throw new ContractError("not_found", `no computer ${parts.name}`);
      const c = this.#computers.get(name)!;
      return { computer: name, path: normalizePosix(parts.rest ? `${c.home}/${parts.rest}` : c.home), area: "home" };
    }
    const bot = pluginIdFromSegment(parts.name);
    const name = this.#botComputer(bot);
    if (!name || !this.#computers.has(name)) throw new ContractError("not_found", `no computer runs ${bot}`);
    const c = this.#computers.get(name)!;
    const root = c.botsRoot ?? `${c.home}/.clover/bots`;
    return { computer: name, path: normalizePosix(`${root}/${pluginIdToSegment(bot)}${parts.rest ? `/${parts.rest}` : ""}`), area: "bot", bot };
  }

  toTreePath(computer: string, realPath: string): string | null {
    const name = this.#computerName(computer);
    const c = name ? this.#computers.get(name) : undefined;
    if (!name || !c) return null;
    const p = normalizePosix(realPath);
    if (!isInside(p, c.home)) return null;
    return p === c.home ? `home/${name}` : `home/${name}/${p.slice(c.home.length + 1)}`;
  }

  async stat(path: string, opts: TreeCallOptions = {}): Promise<FileStat | null> {
    const loc = this.#reach(path, { op: "stat", path: "" }, opts);
    const node = this.#fs.get(loc.computer)!.get(loc.path);
    return node ? this.#statOf(path, node) : null;
  }

  async read(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64" } = {}): Promise<TreeData> {
    const loc = this.#reach(path, { op: "read", path: "" }, opts);
    const node = this.#fs.get(loc.computer)!.get(loc.path);
    if (!node) throw new ContractError("not_found", `${path} doesn't exist`);
    if (node.type !== "file") throw new ContractError("invalid", `${path} is a folder`);
    const bytes = node.data ?? new Uint8Array();
    return opts.encoding === "base64" ? { encoding: "base64", data: b64(bytes) } : { encoding: "utf8", text: dec.decode(bytes) };
  }

  async write(path: string, data: TreeData, opts: TreeCallOptions & { executable?: boolean } = {}): Promise<void> {
    const loc = this.#reach(path, { op: "write", path: "" }, opts);
    const fs = this.#fs.get(loc.computer)!;
    const existing = fs.get(loc.path);
    if (existing?.type === "dir") throw new ContractError("invalid", `${path} is a folder`);
    this.#mkdirs(fs, parentPath(loc.path));
    const bytes = data.encoding === "utf8" ? enc.encode(data.text) : unb64(data.data);
    fs.set(loc.path, { type: "file", data: bytes, executable: opts.executable ?? existing?.executable ?? false, modifiedAt: this.#clock.now() });
  }

  async list(path: string, opts: TreeCallOptions = {}): Promise<FileStat[]> {
    const loc = this.#reach(path, { op: "list", path: "" }, opts);
    const fs = this.#fs.get(loc.computer)!;
    const node = fs.get(loc.path);
    if (!node) throw new ContractError("not_found", `${path} doesn't exist`);
    if (node.type !== "dir") throw new ContractError("invalid", `${path} isn't a folder`);
    const out: FileStat[] = [];
    for (const [p, n] of fs) {
      if (p !== loc.path && parentPath(p) === loc.path) out.push(this.#statOf(`${path.replace(/\/+$/, "")}/${p.slice(p.lastIndexOf("/") + 1)}`, n));
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async remove(path: string, opts: TreeCallOptions & { recursive?: boolean } = {}): Promise<void> {
    const loc = this.#reach(path, { op: "delete", path: "" }, opts);
    const fs = this.#fs.get(loc.computer)!;
    const node = fs.get(loc.path);
    if (!node) throw new ContractError("not_found", `${path} doesn't exist`);
    const inside = [...fs.keys()].filter((p) => p !== loc.path && isInside(p, loc.path));
    if (node.type === "dir" && inside.length > 0 && !opts.recursive) throw new ContractError("invalid", `${path} isn't empty`);
    for (const p of [...inside, loc.path]) fs.delete(p);
  }

  async move(from: string, to: string, opts: TreeCallOptions = {}): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    this.#online(src.computer);
    this.#online(dst.computer);
    if (src.computer === dst.computer) this.#fenced(src.computer, { op: "move", path: src.path, to: dst.path }, opts.as);
    else {
      this.#fenced(src.computer, { op: "delete", path: src.path }, opts.as);
      this.#fenced(dst.computer, { op: "write", path: dst.path }, opts.as);
    }
    const sfs = this.#fs.get(src.computer)!;
    const dfs = this.#fs.get(dst.computer)!;
    if (!sfs.get(src.path)) throw new ContractError("not_found", `${from} doesn't exist`);
    if (dfs.has(dst.path)) throw new ContractError("conflict", `${to} already exists`);
    const moving = [...sfs.entries()].filter(([p]) => isInside(p, src.path));
    this.#mkdirs(dfs, parentPath(dst.path));
    for (const [p, n] of moving) {
      sfs.delete(p);
      dfs.set(normalizePosix(dst.path + p.slice(src.path.length)), { ...n, ...(n.data ? { data: n.data.slice() } : {}) });
    }
  }

  async glob(pattern: string, opts: TreeCallOptions & { cwd: string }): Promise<string[]> {
    const loc = this.#reach(opts.cwd, { op: "list", path: "" }, opts);
    const g = new Bun.Glob(pattern);
    const out: string[] = [];
    for (const [p, n] of this.#fs.get(loc.computer)!) {
      if (n.type !== "file" || !isInside(p, loc.path) || p === loc.path) continue;
      const rel = p.slice(loc.path === "/" ? 1 : loc.path.length + 1);
      if (g.match(rel)) out.push(`${opts.cwd.replace(/\/+$/, "")}/${rel}`);
    }
    return out.sort();
  }

  async grep(pattern: string, opts: TreeCallOptions & { path: string; glob?: string; ignoreCase?: boolean; limit?: number }): Promise<{ path: string; line: number; text: string }[]> {
    const loc = this.#reach(opts.path, { op: "read", path: "" }, opts);
    const re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
    const g = opts.glob ? new Bun.Glob(opts.glob) : undefined;
    const out: { path: string; line: number; text: string }[] = [];
    const base = opts.path.replace(/\/+$/, "");
    for (const [p, n] of [...this.#fs.get(loc.computer)!].sort(([a], [b]) => a.localeCompare(b))) {
      if (n.type !== "file" || !isInside(p, loc.path)) continue;
      const rel = p === loc.path ? "" : p.slice(loc.path.length + 1);
      if (g && !g.match(rel || p.slice(p.lastIndexOf("/") + 1))) continue;
      const lines = dec.decode(n.data ?? new Uint8Array()).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!)) continue;
        out.push({ path: rel ? `${base}/${rel}` : base, line: i + 1, text: lines[i]! });
        if (opts.limit !== undefined && out.length >= opts.limit) return out;
      }
    }
    return out;
  }

  computersFor(paths: readonly string[]): string[] {
    return [...new Set(paths.map((p) => this.resolve(p).computer))];
  }

  /** Resolves, checks the computer is on, and asks its fence. */
  #reach(path: string, op: FenceOp, opts: TreeCallOptions): TreeLocation {
    const loc = this.resolve(path);
    this.#online(loc.computer);
    this.#fenced(loc.computer, { ...op, path: loc.path } as FenceOp, opts.as);
    return loc;
  }

  #online(computer: string): void {
    if (!this.#computers.get(computer)?.online) throw new ContractError("computer_offline", `${computer} is offline`, { computer });
  }

  #fenced(computer: string, op: FenceOp, as: Caller | undefined): void {
    if (as === undefined || as.kind === "user" || as.kind === "core") return;
    const verdict = this.#computers.get(computer)?.fence?.check(op);
    if (verdict && !verdict.allowed) throw new ContractError("fenced", `the fence keeps bots out of ${verdict.path}`, { computer, reason: verdict.reason });
  }

  #computerName(nameOrAlias: string): string | undefined {
    if (this.#computers.has(nameOrAlias)) return nameOrAlias;
    for (const [name, c] of this.#computers) if (c.aliases?.includes(nameOrAlias)) return name;
    return undefined;
  }

  #mkdirs(fs: Map<string, Node>, dir: string): void {
    const now = this.#clock.now();
    for (let p = normalizePosix(dir); ; p = parentPath(p)) {
      const n = fs.get(p);
      if (n?.type === "file") throw new ContractError("invalid", `${p} is a file`);
      if (!n) fs.set(p, { type: "dir", executable: false, modifiedAt: now });
      if (p === "/") break;
    }
  }

  #statOf(treePath: string, n: Node): FileStat {
    return { path: treePath, type: n.type, size: n.data?.length ?? 0, modifiedAt: n.modifiedAt, executable: n.executable };
  }
}
