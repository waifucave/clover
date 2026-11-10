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
//     namespace doesn't cover them: a seccomp filter, `unixSocketFilter` (seccomp.ts), makes `socket(AF_UNIX)` and io_uring fail;
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
  /** Fenced files the supervisor refuses instead of the mounts (spec item 1116): never held for these, so `~` and
   *  `~/.config` stay writable for ordinary new names. */
  readonly supervised?: readonly string[];
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

/** How many files a bot's glob read-denies (the provider-state sidecars) are masked one by one; past it, the folders
 *  holding them are hidden whole. */
export const GLOB_MASK_CAP = 1000;

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
  // command). `held` names each such folder for the refusal's explanation. Supervised files never hold: the
  // supervisor refuses them, so `~` and `~/.config` stay writable for ordinary new names.
  const naming = new Set<string>();
  const supervised = new Set(input.supervised ?? []);
  for (const d of fenced) {
    if (inside(d, cloverHome) || fs.kind(d) !== null || supervised.has(d)) continue;
    let p = dirname(d);
    while (fs.kind(p) === null && p !== dirname(p)) p = dirname(p);
    if (writable.some((w) => inside(p, w))) {
      if (!naming.has(p)) held.push({ folder: p, because: d });
      naming.add(p);
    }
  }
  // The links on the way to a fenced item (#392's review): a link can't be a mount point, so its folder takes the
  // naming folders' shape (read-only, its present folders and files bound back writable, the link not among them),
  // and the link can't be removed, replaced or made there.
  for (const l of policy.holdLinks ?? []) {
    const p = dirname(l);
    if (inside(p, cloverHome) || fs.kind(p) !== "dir" || !writable.some((w) => inside(p, w))) continue;
    if (!naming.has(p)) held.push({ folder: p, because: l });
    naming.add(p);
  }
  // Folders between a writable root and an outside fenced item: mount points, so it can't be renamed out.
  const holders = new Set<string>();
  // A held link's folders too (#392's review): its own folder is a naming folder (a mount already), and each above it
  // up to the writable root a mount point, so none is renamed away and replaced.
  for (const d of [...fenced, ...(policy.holdLinks ?? [])]) {
    for (let p = dirname(d); p !== dirname(p); p = dirname(p)) {
      if (naming.has(p) || inside(p, cloverHome)) continue;
      if (!writable.some((w) => inside(p, w))) break;
      holders.add(p);
    }
  }
  // The mounts, shallowest first (#392's review, run live): a later mount covers what an earlier one put below it, so
  // a naming folder's read-only bind and its bound-back entries come before any holder or naming folder inside it,
  // and a held link's own folder, deepest, last. (Holders first and naming folders after left `~/a/b` a plain folder
  // under `~` read-only and `~/a` bound back: renamed.)
  const mounts = new Map<string, { ro: boolean }>();
  for (const h of holders) if (fs.kind(h) === "dir") mounts.set(h, { ro: false });
  for (const n of naming) {
    if (fs.kind(n) !== "dir") continue;
    mounts.set(n, { ro: true });
    for (const name of fs.list(n)) {
      const c2 = join(n, name);
      if (fenced.has(c2) || naming.has(c2) || [...fenced].some((d) => inside(d, c2))) continue;
      const k = fs.kind(c2);
      if ((k === "dir" || k === "file") && !mounts.has(c2)) mounts.set(c2, { ro: false });
    }
  }
  const depth = (x: string) => x.split("/").length;
  for (const [m, { ro }] of [...mounts].sort(([x], [y]) => depth(x) - depth(y) || (x < y ? -1 : x > y ? 1 : 0))) {
    a.push(ro ? "--ro-bind" : "--bind", m, m);
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
    // A bot's open access (the owner's ruling of November 9): the view holds the home's entries read-only, but every
    // one the policy read-denies by name, which never appears in it, there or not when the run starts (a secrets file
    // made mid-run stays out: #355's review); its own folders and every bot's scratch and memory bound read-write over
    // it, and what a glob denies masked below.
    const open = c?.botAccess ?? null;
    a.push("--tmpfs", cloverHome);
    const listed = (dir: string) => (fs.kind(dir) === "dir" ? fs.list(dir).sort() : []);
    const named = open === null ? [] : policy.denyRead.filter((d) => d !== cloverHome && inside(d, cloverHome) && !d.includes("*"));
    const view = (dir: string): void => {
      for (const name of listed(dir)) {
        const e = `${dir}/${name}`;
        if (named.includes(e)) continue;
        if (named.some((d) => d !== e && inside(d, e))) { a.push("--dir", e); view(e); continue; }
        const k = fs.kind(e);
        if (k === "dir" || k === "file") a.push("--ro-bind", e, e);
      }
    };
    if (open !== null) view(cloverHome);
    // Shallow first: the top folders exist so a runner can list its own view, and each folder on the way to a
    // bind is made, so no bind needs its destination to exist.
    const ro: [string | null | undefined] = [c?.ownBot];
    // Every bot's scratch folder and every bot's memory there when the run starts, read-write (the owner's ruling and
    // its amendment).
    const scratchAll = open !== null ? listed(open.scratch).map((x) => `${open.scratch}/${x}`) : [];
    const memoryAll = open !== null ? listed(open.bots).map((x) => `${open.bots}/${x}/memory`) : [];
    const rw = [...new Set([c?.ownOutputs, c?.ownScratch, c?.ownRoutines, c?.ownPluginData, c?.ownMemory, ...scratchAll, ...memoryAll])];
    const dirs = new Set(["bots", "outputs", "scratch", "routines", "plugin-data"].map((t) => `${cloverHome}/${t}`));
    for (const p of [...ro, ...rw].filter((p): p is string => typeof p === "string")) {
      for (let d = dirname(p); d !== cloverHome && inside(d, cloverHome); d = dirname(d)) dirs.add(d);
    }
    if (open === null) for (const d of [...dirs].sort((x, y) => x.length - y.length)) a.push("--dir", d);
    if (c?.ownBot !== null && c?.ownBot !== undefined && fs.kind(c.ownBot) === "dir") a.push("--ro-bind", c.ownBot, c.ownBot);
    for (const p of rw) {
      if (p === null || p === undefined) continue;
      const k = fs.kind(p);
      if (k === "dir" || k === "file") a.push("--bind", p, p);
    }
    // A deny always wins over an allow (the controller's ruling): a fenced item strictly inside a bound own folder is
    // masked again after the binds, read-only, or hidden when it is read-denied.
    const own = [...ro, ...rw].filter((p): p is string => typeof p === "string");
    const strictlyIn = (list: readonly string[]) => (d: string) => list.some((o) => d !== o && inside(d, o));
    // (A bot's named read denies never entered its view; what sits in a read-write folder is masked here.)
    const hidden = new Set(policy.denyRead.filter((d) => !d.includes("*")).filter(strictlyIn(own)));
    for (const d of [...new Set([...policy.denyWrite.filter(strictlyIn(own)), ...hidden])].sort((x, y) => x.length - y.length)) {
      const k = fs.kind(d);
      if (k === null) continue;
      if (hidden.has(d)) {
        if (k === "dir") a.push("--tmpfs", d, "--remount-ro", d);
        else a.push("--ro-bind", "/dev/null", d);
      } else {
        a.push("--ro-bind", d, d);
      }
    }
    // What a glob read-denies for a bot (the runtimes' provider-state sidecars, `projects/*/*.provider-state.jsonl`),
    // as it is when the run starts: each match masked. One made mid-run in a bound folder is the known gap the fence's
    // own check still covers.
    if (open !== null) {
      const matches: { path: string; kind: "dir" | "file" | "other" }[] = [];
      for (const g of policy.denyRead.filter((d) => d.includes("*") && inside(d, cloverHome))) {
        let at = [cloverHome];
        for (const seg of g.slice(cloverHome.length + 1).split("/")) {
          const next: string[] = [];
          for (const dir of at) {
            if (!seg.includes("*")) { next.push(`${dir}/${seg}`); continue; }
            const suffix = seg === "*" ? "" : seg.slice(1);
            for (const n of listed(dir)) if (n.endsWith(suffix)) next.push(`${dir}/${n}`);
          }
          at = next;
        }
        for (const m of at) { const k = fs.kind(m); if (k !== null) matches.push({ path: m, kind: k }); }
      }
      // One mount per sidecar is one per session: past `GLOB_MASK_CAP` the folders holding them are hidden instead
      // (their transcripts with them, failing closed), so the arguments and the mounts stay bounded.
      if (matches.length > GLOB_MASK_CAP) {
        for (const d of [...new Set(matches.map((m) => dirname(m.path)))].sort()) a.push("--tmpfs", d, "--remount-ro", d);
      } else {
        for (const m of matches) {
          if (m.kind === "dir") a.push("--tmpfs", m.path, "--remount-ro", m.path);
          else a.push("--ro-bind", "/dev/null", m.path);
        }
      }
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
