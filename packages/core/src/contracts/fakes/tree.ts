// FakeTree: one in-memory file system per computer, joined into the folder tree, with each computer's fence, level
// and an on/off switch. It never touches the real disk. A peer's change is judged as the computer holding the files
// would judge it (review N2), with signed answers checked by `verifySignedAnswer`.
import { createHash } from "node:crypto";
import { DEFAULT_LEVEL, pluginIdFromSegment, pluginIdToSegment, type Caller, type FileStat, type Level } from "@waifucave/clover-protocol";
import { type AnswerDevices, type AnswerLedger, type CallCardRenderer, verifySignedAnswer } from "../approval-broker";
import type { Clock } from "../clock";
import { ContractError, isInside, normalizePosix, type Unsubscribe } from "../common";
import type { Fence, FenceOp } from "../fence";
import { MemoryAnswerLedger } from "./approval-broker";
import {
  peerTreeDecision, splitTreePath, transferChange, treeCallBinding,
  type Tree, type TreeCallOptions, type TreeChange, type TreeData, type TreeLocation, type TreeReviewer, type TreeWatchEvent,
} from "../tree";

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
  /** The computer's fence: its verdicts, and the fenced set a harness reads (lane J's ask). */
  fence?: Pick<Fence, "check" | "fencedSet">;
  /** The computer's approval level, which a peer's change is judged at (`DEFAULT_LEVEL` when unset). */
  level?: Level;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const NO_DEVICES: AnswerDevices = { get: () => undefined, verifyAnswer: async () => false };

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
  readonly #devices: AnswerDevices;
  readonly #ledgers = new Map<string, AnswerLedger>();
  readonly #ledgerOf: (computer: string) => AnswerLedger;
  readonly #render: CallCardRenderer;
  readonly #reviewer: TreeReviewer;
  readonly #watches = new Set<{ computer: string; path: string; treeBase: string; fn: (e: TreeWatchEvent) => void }>();

  /** `devices`, `ledgers` and `render` check a peer's signed answers (none counts by default; each computer keeps its
   *  own ledger, as each holder does, unless `ledgers` names one); `reviewer` is the
   *  holder's safety reviewer for a peer's change at "ask for risky actions" (unavailable by default, so it asks). */
  constructor(opts: {
    clock: Pick<Clock, "now">;
    computers: Record<string, FakeTreeComputer>;
    botComputer: (bot: string) => string | undefined;
    devices?: AnswerDevices;
    ledgers?: Record<string, AnswerLedger>;
    render?: CallCardRenderer;
    reviewer?: TreeReviewer;
  }) {
    this.#clock = opts.clock;
    this.#botComputer = opts.botComputer;
    this.#devices = opts.devices ?? NO_DEVICES;
    this.#ledgerOf = (computer) => {
      let l = opts.ledgers?.[computer] ?? this.#ledgers.get(computer);
      if (!l) this.#ledgers.set(computer, (l = new MemoryAnswerLedger()));
      return l;
    };
    this.#render = opts.render ?? (() => undefined);
    this.#reviewer = opts.reviewer ?? (async () => "unavailable");
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

  /** Sets a computer's level (the ComputerRegistry's job in the real core). */
  setLevel(name: string, level: Level): void {
    const c = this.#computers.get(name);
    if (c) c.level = level;
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

  async stat(path: string, opts: TreeCallOptions): Promise<FileStat | null> {
    const loc = this.#reach(path, { op: "stat", path: "" }, opts);
    const node = this.#fs.get(loc.computer)!.get(loc.path);
    return node ? this.#statOf(path, node) : null;
  }

  async read(path: string, opts: TreeCallOptions & { encoding?: "utf8" | "base64" }): Promise<TreeData> {
    const loc = this.#reach(path, { op: "read", path: "" }, opts);
    const node = this.#fs.get(loc.computer)!.get(loc.path);
    if (!node) throw new ContractError("not_found", `${path} doesn't exist`);
    if (node.type !== "file") throw new ContractError("invalid", `${path} is a folder`);
    const bytes = node.data ?? new Uint8Array();
    return opts.encoding === "base64" ? { encoding: "base64", data: b64(bytes) } : { encoding: "utf8", text: dec.decode(bytes) };
  }

  async write(path: string, data: TreeData, opts: TreeCallOptions & { executable?: boolean }): Promise<void> {
    const loc = this.#reach(path, { op: "write", path: "" }, opts);
    await this.#peerJudged([loc.computer], treeCallBinding("tree.write", { path, data }), "edit", opts);
    const fs = this.#fs.get(loc.computer)!;
    const existing = fs.get(loc.path);
    if (existing?.type === "dir") throw new ContractError("invalid", `${path} is a folder`);
    this.#mkdirs(fs, parentPath(loc.path));
    const bytes = data.encoding === "utf8" ? enc.encode(data.text) : unb64(data.data);
    fs.set(loc.path, { type: "file", data: bytes, executable: opts.executable ?? existing?.executable ?? false, modifiedAt: this.#clock.now() });
    this.#changed(loc.computer, [loc.path]);
  }

  async list(path: string, opts: TreeCallOptions): Promise<FileStat[]> {
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

  async remove(path: string, opts: TreeCallOptions & { recursive?: boolean }): Promise<void> {
    const loc = this.#reach(path, { op: "delete", path: "" }, opts);
    await this.#peerJudged([loc.computer], treeCallBinding("tree.remove", opts.recursive === undefined ? { path } : { path, recursive: opts.recursive }), "delete", opts);
    const fs = this.#fs.get(loc.computer)!;
    const node = fs.get(loc.path);
    if (!node) throw new ContractError("not_found", `${path} doesn't exist`);
    const inside = [...fs.keys()].filter((p) => p !== loc.path && isInside(p, loc.path));
    if (node.type === "dir" && inside.length > 0 && !opts.recursive) throw new ContractError("invalid", `${path} isn't empty`);
    for (const p of [...inside, loc.path]) fs.delete(p);
    this.#changed(loc.computer, [loc.path]);
  }

  async move(from: string, to: string, opts: TreeCallOptions): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    this.#online(src.computer);
    this.#online(dst.computer);
    if (src.computer === dst.computer) this.#fenced(src.computer, { op: "move", path: src.path, to: dst.path }, opts.as);
    else {
      this.#fenced(src.computer, { op: "delete", path: src.path }, opts.as);
      this.#fenced(dst.computer, { op: "write", path: dst.path }, opts.as);
    }
    // Between two computers it is R15's one call, which each holder judges and checks the one answer against.
    const change = src.computer === dst.computer ? treeCallBinding("tree.move", { from, to }) : transferChange(true, from, to, src.computer, dst.computer);
    await this.#peerJudged([...new Set([src.computer, dst.computer])], change, "move", opts);
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
    this.#changed(src.computer, [src.path]);
    this.#changed(dst.computer, [dst.path]);
  }

  async watch(path: string, opts: TreeCallOptions, fn: (event: TreeWatchEvent) => void): Promise<Unsubscribe> {
    const loc = this.#reach(path, { op: "list", path: "" }, opts);
    const home = this.#computers.get(loc.computer)?.home;
    if (loc.area === "home" && home !== undefined && normalizePosix(loc.path) === normalizePosix(home)) {
      throw new ContractError("invalid", `${path} is a whole home; a watch follows one folder in it, a session's own`);
    }
    const node = this.#fs.get(loc.computer)!.get(loc.path);
    if (!node) throw new ContractError("not_found", `${path} doesn't exist`);
    if (node.type !== "dir") throw new ContractError("invalid", `${path} isn't a folder`);
    const w = { computer: loc.computer, path: loc.path, treeBase: path.replace(/\/+$/, ""), fn };
    this.#watches.add(w);
    return () => void this.#watches.delete(w);
  }

  /** The watch's news for real paths that changed on a computer, as tree paths under each watched folder. */
  #changed(computer: string, paths: string[]): void {
    for (const w of this.#watches) {
      if (w.computer !== computer) continue;
      const hits = paths.filter((p) => p !== w.path && isInside(p, w.path)).map((p) => `${w.treeBase}/${p.slice(w.path.length + 1)}`);
      if (hits.length > 0) w.fn({ type: "changed", paths: hits });
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

  /** A peer's change, judged at the strictest of the holders' levels and the call's (review N2). One computer's change
   *  binds that computer; a transfer between two binds both, and each holder checks the answer with its own ledger. */
  async #peerJudged(computers: string[], change: TreeChange, effect: "edit" | "delete" | "move", opts: TreeCallOptions): Promise<void> {
    if (opts.as.kind !== "peer") return;
    if (opts.level === undefined) throw new ContractError("invalid", "a peer's change says its level");
    const levels = computers.map((c) => this.#computers.get(c)?.level ?? DEFAULT_LEVEL);
    const decision = peerTreeDecision(levels, opts.level, effect);
    if (decision === "allow") return;
    if (decision === "refuse") throw new ContractError("refused", `${computers.join(" and ")} doesn't let another computer change files at its level`);
    // At "ask for risky actions" the holder's own reviewer judges it first (ruling R1): safe runs.
    if (decision === "review" && (await this.#reviewer({ ...change, computer: computers[0]!, as: opts.as })) === "safe") return;
    if (!opts.answer) throw new ContractError("refused", "this change needs the user's answer, signed and bound to it");
    for (const self of computers) {
      const verdict = await verifySignedAnswer(opts.answer, {
        self, method: change.method, params: change.params, now: this.#clock.now(), sha256,
        devices: this.#devices, ledger: this.#ledgerOf(self), render: this.#render,
      });
      if (verdict !== "ok") throw new ContractError("refused", `the answer doesn't hold for this change at ${self} (${verdict})`);
    }
  }

  /** Every caller but the user on this computer and the core is fenced: a peer always (review N2). */
  #fenced(computer: string, op: FenceOp, as: Caller | undefined): void {
    if (as === undefined) throw new ContractError("invalid", "a tree call says whom it is for (`as`)");
    if (as.kind === "user" || as.kind === "core") return;
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
