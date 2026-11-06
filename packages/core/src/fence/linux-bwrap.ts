// Linux: the fence as a bubblewrap sandbox, for a command run under it (spec §9.1). Built from the fence's
// `SandboxPolicy` at each run. A mount can't deny a path that isn't there yet, so the shape differs from macOS's:
//   * the whole tree read-only, then the writable roots (the home, temp) writable;
//   * the Clover home, every folder that holds a fenced item inside it, and the nearest present folder of a fenced
//     item that isn't there yet (a `.zshrc` never made: the home itself, then), bound read-only again, and only their
//     children that are neither fenced nor such a folder bound back writable: a fenced file that doesn't exist yet
//     can't be made, and nothing new appears where Clover names things;
//   * every folder between a writable root and a fenced item outside those is bound onto itself, so it's a mount
//     point: renaming or removing it fails (EBUSY), and the item can't be moved out;
//   * a hard link across mounts fails (EXDEV), so none can be made from a fenced file;
//   * read-denied items hidden (an empty tmpfs, or /dev/null for a file);
//   * no network (`--unshare-net`, abstract sockets included), and no Unix socket on the disk either (a network
//     namespace doesn't cover them: a seccomp filter, `unixSocketFilter`, makes `socket(AF_UNIX)` and io_uring fail;
//     `socketpair` stays, for pipes between its own processes), its own pid namespace (no other process's /proc), a new
//     session (no TIOCSTI), and the user's D-Bus hidden (`systemd-run --user` and the rest of the closed doors).
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SandboxPolicy } from "../contracts/fence";
import { foldName } from "./fold";
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
  /** The runner's caller (`callerPlaces`): bots' memory and the bot driver's state, after the denies. */
  readonly caller?: CallerPlaces;
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
  const fs = input.fs ?? realFs;
  const { policy, cloverHome } = input;
  const writable = policy.allowWrite.filter((w) => fs.kind(w) === "dir");
  const fenced = new Set(policy.denyWrite);
  const a: string[] = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const w of writable) a.push("--bind", w, w);

  // Where Clover names things: the Clover home and each folder holding a fenced item inside it, top-down.
  const naming = new Set<string>();
  if (fs.kind(cloverHome) === "dir") naming.add(cloverHome);
  for (const d of fenced) {
    if (!inside(d, cloverHome) || d === cloverHome) continue;
    for (let p = dirname(d); inside(p, cloverHome); p = dirname(p)) { naming.add(p); if (p === cloverHome) break; }
  }
  // A fenced item that isn't there yet (a `.zshrc` a bash user never made, `~/.config/autostart`) can't be kept from
  // being made by a mount on itself, so the nearest folder that is there takes the naming folders' shape: read-only,
  // its present children writable, nothing new in it (fails closed: no new top-level names there for the command).
  for (const d of fenced) {
    if (fs.kind(d) !== null) continue;
    let p = dirname(d);
    while (fs.kind(p) === null && p !== dirname(p)) p = dirname(p);
    if (writable.some((w) => inside(p, w))) naming.add(p);
  }
  // Folders between a writable root and a fenced item (or the Clover home), outside the naming set: mount points.
  const holders = new Set<string>();
  for (const d of [...fenced, cloverHome]) {
    for (let p = dirname(d); p !== dirname(p); p = dirname(p)) {
      if (naming.has(p)) continue;
      if (!writable.some((w) => inside(p, w))) break;
      holders.add(p);
    }
  }
  for (const h of [...holders].sort((x, y) => x.length - y.length)) if (fs.kind(h) === "dir") a.push("--bind", h, h);
  for (const n of [...naming].sort((x, y) => x.length - y.length)) {
    if (fs.kind(n) !== "dir") continue;
    a.push("--ro-bind", n, n);
    for (const name of fs.list(n).sort()) {
      const c = join(n, name);
      if (fenced.has(c) || naming.has(c) || [...fenced].some((d) => inside(d, c))) continue;
      const k = fs.kind(c);
      if (k === "dir" || k === "file") a.push("--bind", c, c);
    }
  }
  // Fenced items elsewhere (development folders): read-only where they are.
  for (const d of [...fenced].sort()) if (!inside(d, cloverHome) && fs.kind(d) !== null) a.push("--ro-bind", d, d);
  // Read-denied items, hidden.
  for (const r of [...policy.denyRead].sort()) {
    const k = fs.kind(r);
    if (k === "dir") a.push("--tmpfs", r, "--remount-ro", r);
    else if (k !== null) a.push("--ro-bind", "/dev/null", r);
  }
  // The caller's rules (`per-caller.ts`): `bots/` becomes an empty read-only tmpfs holding only what this caller may
  // see, each bot folder's entries but `memory` read-only, and the owner's own memory writable (a mount point, so
  // it can't be removed or moved); a bot made while the command runs isn't in it at all. The bot driver's state
  // likewise: hidden, but the caller's own state file, read-only.
  const c = input.caller;
  if (c) {
    if (fs.kind(c.bots) === "dir") {
      a.push("--tmpfs", c.bots);
      for (const x of fs.list(c.bots).sort()) {
        const folder = join(c.bots, x);
        if (fs.kind(folder) !== "dir") continue;
        for (const e of fs.list(folder).sort()) {
          const entry = join(folder, e);
          if (foldName(e) === "memory") { if (c.ownMemory !== null && entry === c.ownMemory && fs.kind(entry) === "dir") a.push("--bind", entry, entry); continue; }
          const k = fs.kind(entry);
          if (k === "dir" || k === "file") a.push("--ro-bind", entry, entry);
        }
      }
      a.push("--remount-ro", c.bots);
    }
    if (fs.kind(c.runtime) === "dir") {
      a.push("--tmpfs", c.runtime);
      if (c.ownRuntime !== null && fs.kind(c.ownRuntime) === "file") a.push("--ro-bind", c.ownRuntime, c.ownRuntime);
      a.push("--remount-ro", c.runtime);
    }
  }
  // The closed doors: the user's session bus and systemd (systemd-run --user), and the system bus.
  if (policy.closedDoors.length > 0) {
    const run = `/run/user/${input.uid}`;
    if (fs.kind(run) === "dir") a.push("--tmpfs", run);
    if (fs.kind("/run/dbus/system_bus_socket") !== null) a.push("--ro-bind", "/dev/null", "/run/dbus/system_bus_socket");
  }
  if (input.seccompFd !== undefined) a.push("--seccomp", String(input.seccompFd));
  a.push("--chdir", input.cwd);
  return a;
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
