// Linux: the fence as a bubblewrap sandbox, for a command run under it (spec §9.1). Built from the fence's
// `SandboxPolicy` at each run. A mount can't deny a path that isn't there yet, so the shape differs from macOS's:
//   * the whole tree read-only, then the writable roots (the home, temp) writable;
//   * the Clover home itself is a tmpfs view holding only the runner's own folders (`outputs/<session>`,
//     `scratch/<bot>`, `routines/<bot>`, its bot's folder read-only with its `memory` read-write, and a plugin's own
//     `plugin-data/<id>`), each bound over it with its access: Landlock can't nest an allow inside a deny, and neither
//     can a mount, so the home deny is the absence of everything else (B's contract, `policyAllows`'s order);
//   * every fenced item outside the Clover home (the login-start places, development folders, OK'd agent installs, the
//     browser's partitions), and every folder that holds one inside a writable root, bound read-only again, and only
//     their children that are neither fenced nor such a folder bound back writable: a fenced file that doesn't exist
//     yet can't be made, and nothing new appears where Clover names things;
//   * every folder between a writable root and an outside fenced item is bound onto itself, so it's a mount point:
//     renaming or removing it fails (EBUSY), and the item can't be moved out;
//   * a hard link across mounts fails (EXDEV), so none can be made from a fenced file;
//   * no network (`--unshare-net`, abstract sockets included), and no Unix socket on the disk either (a network
//     namespace doesn't cover them: a seccomp filter, `unixSocketFilter`, makes `socket(AF_UNIX)` and io_uring fail;
//     `socketpair` stays, for pipes between its own processes), its own pid namespace (no other process's /proc), a new
//     session (no TIOCSTI), and the user's D-Bus hidden (`systemd-run --user` and the rest of the closed doors).
//
// Notes for the runner (a bot's Bash under here): a denied part of the home looks absent, not "permission denied"
// (the tmpfs view holds nothing there: no listing, no stat), a write into the view fails as a read-only file
// system (the view is remounted read-only around the bound-back own folders), `pip install --user` is refused (the
// user site folders are fenced: bots use virtual environments), and `git init` and `git clone` use Clover's empty
// template (`GIT_TEMPLATE_DIR`): no hooks are installed, plant none anyway, and the fence judges every tool call
// that reaches another repo's).
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SandboxPolicy } from "../contracts/fence";
import { gitTemplateDir } from "./layout";
import type { CallerPlaces } from "./per-caller";

export interface BwrapInput {
  readonly policy: SandboxPolicy;
  readonly cloverHome: string;
  readonly cwd: string;
  /** The user's id, for `/run/user/<uid>`. */
  readonly uid: number;
  /** The disk, for tests. */
  readonly fs?: { kind(path: string): "dir" | "file" | "other" | null; list(dir: string): string[] };
  /** The fd (in the child) bwrap reads the seccomp filter from. */
  readonly seccompFd?: number;
  /** The runner's caller: its own folders are the only ways back into the Clover home's view. */
  readonly caller?: CallerPlaces;
  /** The session's own repo's `.git/hooks`, when it is there: bound read-only. Other repos under the home are a
   *  known limit on Linux (bwrap can't match patterns): the fence still judges every tool call that reaches them. */
  readonly repoHooks?: string | null;
}

const realFs = {
  kind(path: string): "dir" | "file" | "other" | null {
    try { const s = lstatSync(path); return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other"; } catch { return null; }
  },
  list(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } },
};

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** bwrap's arguments, the command's own after them. */
export function bwrapArgs(input: BwrapInput): string[] {
  return bwrapPlan(input).args;
}

/** A folder held read-only for new names because a fenced item in it isn't there yet. */
export interface HeldFolder { readonly folder: string; readonly because: string }

/** The arguments, and the folders held for missing fenced items (for the refusal's explanation). */
export function bwrapPlan(input: BwrapInput): { args: string[]; held: HeldFolder[] } {
  const held: HeldFolder[] = [];
  const fs = input.fs ?? realFs;
  const { policy, cloverHome } = input;
  const writable = policy.allowWrite.filter((w) => fs.kind(w) === "dir");
  // Only the fenced items outside the Clover home take the read-only shape: everything under the home is hidden by
  // its tmpfs view below. The home itself is in the deny lists (the default-deny); it is the view, not an item.
  const fenced = new Set([...policy.denyWrite].filter((d) => !inside(d, cloverHome)));
  const a: string[] = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const w of writable) a.push("--bind", w, w);

  // Where Clover names things outside its home: the nearest folder that is there takes the naming folders' shape
  // when a fenced item isn't there yet (a `.zshrc` a bash user never made, the login unit on a fresh home):
  // read-only, its present children writable, nothing new in it (fails closed: no new top-level names there for the
  // command). `held` names each such folder for the refusal's explanation.
  const naming = new Set<string>();
  for (const d of fenced) {
    if (inside(d, cloverHome) || fs.kind(d) !== null) continue;
    let p = dirname(d);
    while (fs.kind(p) === null && p !== dirname(p)) p = dirname(p);
    if (writable.some((w) => inside(p, w))) {
      if (!naming.has(p)) held.push({ folder: p, because: d });
      naming.add(p);
    }
  }
  // Folders between a writable root and an outside fenced item: mount points, so it can't be renamed out.
  const holders = new Set<string>();
  for (const d of fenced) {
    for (let p = dirname(d); p !== dirname(p); p = dirname(p)) {
      if (naming.has(p) || inside(p, cloverHome)) continue;
      if (!writable.some((w) => inside(p, w))) break;
      holders.add(p);
    }
  }
  for (const h of [...holders].sort((x, y) => x.length - y.length)) if (fs.kind(h) === "dir") a.push("--bind", h, h);
  for (const n of [...naming].sort((x, y) => x.length - y.length)) {
    if (fs.kind(n) !== "dir") continue;
    a.push("--ro-bind", n, n);
    for (const name of fs.list(n).sort()) {
      const c2 = join(n, name);
      if (fenced.has(c2) || naming.has(c2) || [...fenced].some((d) => inside(d, c2))) continue;
      const k = fs.kind(c2);
      if (k === "dir" || k === "file") a.push("--bind", c2, c2);
    }
  }
  // Fenced items elsewhere (development folders): read-only where they are.
  for (const d of [...fenced].sort()) if (fs.kind(d) !== null) a.push("--ro-bind", d, d);
  // Read-denied items outside the home, hidden (an empty tmpfs, or /dev/null for a file).
  for (const r of [...policy.denyRead].sort()) {
    if (inside(r, cloverHome)) continue;
    const k = fs.kind(r);
    if (k === "dir") a.push("--tmpfs", r, "--remount-ro", r);
    else if (k !== null) a.push("--ro-bind", "/dev/null", r);
  }

  // A hook planted in any repo under the home runs later, outside the sandbox (spec item 1116): the session's own
  // repo's hooks are bound read-only (other repos under the home are the known limit, above).
  if (input.repoHooks !== null && input.repoHooks !== undefined && fs.kind(input.repoHooks) === "dir") {
    a.push("--ro-bind", input.repoHooks, input.repoHooks);
  }
  // The Clover home as a tmpfs view holding only the caller's own folders (the home default-deny, for runners).
  // Without a caller every own folder is absent: the view holds nothing.
  if (fs.kind(cloverHome) === "dir") {
    const c = input.caller;
    a.push("--tmpfs", cloverHome);
    // Shallow first: the top folders exist so a runner can list its own view, and each folder on the way to a
    // bind is made, so no bind needs its destination to exist.
    const ro: [string | null | undefined] = [c?.ownBot];
    const rw = [c?.ownOutputs, c?.ownScratch, c?.ownRoutines, c?.ownPluginData, c?.ownMemory];
    const dirs = new Set(["bots", "outputs", "scratch", "routines", "plugin-data"].map((t) => `${cloverHome}/${t}`));
    for (const p of [...ro, ...rw].filter((p): p is string => typeof p === "string")) {
      for (let d = dirname(p); d !== cloverHome && inside(d, cloverHome); d = dirname(d)) dirs.add(d);
    }
    for (const d of [...dirs].sort((x, y) => x.length - y.length)) a.push("--dir", d);
    if (c?.ownBot !== null && c?.ownBot !== undefined && fs.kind(c.ownBot) === "dir") a.push("--ro-bind", c.ownBot, c.ownBot);
    for (const p of rw) {
      if (p === null || p === undefined) continue;
      const k = fs.kind(p);
      if (k === "dir" || k === "file") a.push("--bind", p, p);
    }
    // Clover's empty git template, read-only: `git init` and `git clone` install no hooks from it. Bound after
    // the tmpfs, which would otherwise hide it.
    const template = gitTemplateDir(cloverHome);
    if (fs.kind(template) === "dir") a.push("--ro-bind", template, template);
    a.push("--remount-ro", cloverHome);
  }
  // The closed doors: the user's session bus and systemd (systemd-run --user), and the system bus.
  if (policy.closedDoors.length > 0) {
    const run = `/run/user/${input.uid}`;
    if (fs.kind(run) === "dir") a.push("--tmpfs", run);
    if (fs.kind("/run/dbus/system_bus_socket") !== null) a.push("--ro-bind", "/dev/null", "/run/dbus/system_bus_socket");
  }
  if (input.seccompFd !== undefined) a.push("--seccomp", String(input.seccompFd));
  a.push("--chdir", input.cwd);
  return { args: a, held };
}

/** What a refused write in a held folder means, for the command's stderr (the controller's ruling: say which fenced
 *  file holds the folder, and offer a subfolder or asking the user). Null when nothing in `stderr` looks like it. */
export function heldFolderNote(stderr: string, held: readonly HeldFolder[]): string | null {
  if (held.length === 0 || !/Read-only file system|EROFS/.test(stderr)) return null;
  const lines = held.map((h) => `clover: ${h.folder} takes no new names under the fence, because ${h.because} is fenced and isn't there yet; write in a subfolder of it, or ask the user`);
  return `${lines.join("\n")}\n`;
}

/** The seccomp filter (classic BPF, `struct sock_filter[]`): `socket(AF_UNIX, …)` and `io_uring_setup` fail with EPERM,
 *  and so does every call of another architecture (a 32-bit binary's), so no Unix socket on the disk can be reached.
 *  Null where the architecture isn't one Clover ships for. */
export function unixSocketFilter(arch: string = process.arch): Buffer | null {
  const t = arch === "x64" ? { audit: 0xc000003e, socket: 41 } : arch === "arm64" ? { audit: 0xc00000b7, socket: 198 } : null;
  if (t === null) return null;
  const LD = 0x20, JEQ = 0x15, RET = 0x06, ALLOW = 0x7fff0000, EPERM = 0x00050001, IO_URING_SETUP = 425, AF_UNIX = 1;
  const prog: [number, number, number, number][] = [
    [LD, 0, 0, 4], //            0: the architecture
    [JEQ, 0, 6, t.audit], //     1: another one: EPERM (8)
    [LD, 0, 0, 0], //            2: the call
    [JEQ, 4, 0, IO_URING_SETUP], // 3: EPERM (8)
    [JEQ, 0, 2, t.socket], //    4: not socket(): allow (7)
    [LD, 0, 0, 16], //           5: its first argument, the domain (low 32 bits)
    [JEQ, 1, 0, AF_UNIX], //     6: AF_UNIX: EPERM (8), else allow (7)
    [RET, 0, 0, ALLOW], //       7
    [RET, 0, 0, EPERM], //       8
  ];
  const b = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, k], i) => { b.writeUInt16LE(code, i * 8); b.writeUInt8(jt, i * 8 + 2); b.writeUInt8(jf, i * 8 + 3); b.writeUInt32LE(k >>> 0, i * 8 + 4); });
  return b;
}
