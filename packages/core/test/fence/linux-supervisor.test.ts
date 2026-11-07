import { describe, expect, test } from "bun:test";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUserNotifFilter, foldName, lstatFinal, matchSupervised, openParentDir, openSupervisorLib, openWrites, parentIdentity, readCString, readPathOnce, resolveBase, splitParent, supervisorArch, trapTable, type SupervisorLib } from "../../src/fence/linux-supervisor";
import { parseGitConfigWatched, parseGitConfigWithGit, revertWatchedGitChanges, watchedGitChanges } from "../../src/fence/git-config";

describe("the supervisor's filter and decisions", () => {
  test("no supervisor off x86-64 and arm64; the filter traps the path syscalls and allows the rest", () => {
    expect(supervisorArch("ia32")).toBeNull();
    expect(supervisorArch("x64")).toBe("x64");
    expect(supervisorArch("arm64")).toBe("arm64");
    expect(buildUserNotifFilter("ia32")).toBeNull();
    const f = buildUserNotifFilter("x64")!;
    expect(f.length % 8).toBe(0);
    const insns = f.length / 8;
    expect(insns).toBe(4 + 15 + 3); // arch check, call number, x32 refuse, one jump per trapped call, allow, trap, EPERM
    expect([f.readUInt16LE(0), f.readUInt32LE(4)]).toEqual([0x20, 4]); // LD arch
    expect([f.readUInt16LE((insns - 3) * 8), f.readUInt32LE((insns - 3) * 8 + 4)]).toEqual([0x06, 0x7fff0000]); // allow
    expect([f.readUInt16LE((insns - 2) * 8), f.readUInt32LE((insns - 2) * 8 + 4)]).toEqual([0x06, 0x7fc00000]); // trap: USER_NOTIF
    expect([f.readUInt16LE((insns - 1) * 8), f.readUInt32LE((insns - 1) * 8 + 4)]).toEqual([0x06, 0x00050001]); // x32 and foreign arch: EPERM
    // The openat jump lands on the trap.
    const openat = 4 + 0; // first trapped call
    expect([f.readUInt8(openat * 8 + 2), f.readUInt32LE(openat * 8 + 4)]).toEqual([15 - 0, 257]);
    // Wrong arch and x32 numbers both land on EPERM.
    expect(f.readUInt8(1 * 8 + 2)).toBe(0); // JEQ arch: equal falls through
    expect(f.readUInt32LE(1 * 8 + 4)).toBe(0xc000003e); // x86-64
    expect([f.readUInt16LE(3 * 8), f.readUInt8(3 * 8 + 2), f.readUInt32LE(3 * 8 + 4)]).toEqual([0x35, 15 + 2, 0x40000000]); // JGE x32
  });

  test("the arm64 filter traps arm64's *at-only table (no legacy numbers)", () => {
    const f = buildUserNotifFilter("arm64")!;
    expect(f.length / 8).toBe(4 + 8 + 3);
    expect(f.readUInt32LE(1 * 8 + 4)).toBe(0xc00000b7); // AUDIT_ARCH_AARCH64
    const nrs = trapTable("arm64")!.map((t) => t.nr);
    expect(nrs).toEqual([56, 437, 34, 33, 382, 38, 37, 36]);
    expect(nrs).not.toContain(2); // no legacy open
    expect(nrs).not.toContain(257); // no x64 openat
    // symlinkat's linkpath is its third argument, under its second (the new dirfd).
    expect(trapTable("x64")!.find((t) => t.nr === 266)).toMatchObject({ dirfd: 1, paths: [2] });
    expect(trapTable("arm64")!.find((t) => t.nr === 36)).toMatchObject({ dirfd: 1, paths: [2] });
    expect(trapTable("ia32")).toBeNull();
  });

  test("openWrites reads the access and creation flags", () => {
    expect(openWrites(0n)).toBe(false); // O_RDONLY
    expect(openWrites(0o1n)).toBe(true); // O_WRONLY
    expect(openWrites(0o2n)).toBe(true); // O_RDWR
    expect(openWrites(0o100n)).toBe(true); // O_CREAT
    expect(openWrites(0o1000n)).toBe(true); // O_TRUNC
    expect(openWrites(0o2000n)).toBe(true); // O_APPEND
    expect(openWrites(0o10000000n)).toBe(false); // O_PATH
    expect(openWrites(0o2000000n)).toBe(false); // O_NOFOLLOW alone reads
  });

  test("foldName matches the way the disks fold", () => {
    expect(foldName("/h/.bash_profile")).toBe(foldName("/h/.BASH_PROFILE"));
    expect(foldName("a")).not.toBe(foldName("b"));
  });

  test("splitParent separates the final name; trailing slashes don't make empty names", () => {
    expect(splitParent("/a/b/c")).toEqual({ dir: "/a/b", name: "c" });
    expect(splitParent("a/b")).toEqual({ dir: "a", name: "b" });
    expect(splitParent("x")).toEqual({ dir: "", name: "x" });
    expect(splitParent("/x")).toEqual({ dir: "/", name: "x" });
    expect(splitParent("a/b/")).toEqual({ dir: "a", name: "b" });
    expect(splitParent("/")).toEqual({ dir: "/", name: "" });
  });

  test("trap tables cover every mutating path syscall once", () => {
    const x64 = trapTable("x64")!.map((t) => t.nr);
    for (const nr of [257, 437, 2, 85, 258, 83, 259, 133, 316, 264, 38, 265, 86, 266, 88]) expect(x64).toContain(nr);
    expect(new Set(x64).size).toBe(x64.length); // no duplicates
  });
});

const linuxOnly = process.platform === "linux" ? describe : describe.skip;

linuxOnly("the supervisor's walk and identity (Linux: real fds)", () => {
  const lib = (): SupervisorLib => {
    const l = openSupervisorLib();
    if (l === null) throw new Error("no supervisor lib on this machine");
    return l;
  };
  test("resolveBase opens the cwd, a dir fd, and the root; refuse the rest", () => {
    const l = lib();
    const me = process.pid;
    const cwd = resolveBase(l, me, false, -100);
    expect(cwd.err).toBe(0);
    expect(cwd.fd).toBeGreaterThanOrEqual(0);
    closeSync(cwd.fd);
    const root = resolveBase(l, me, true, -100);
    expect(root.err).toBe(0);
    closeSync(root.fd);
    expect(resolveBase(l, me, false, 999999).fd).toBe(-1); // no such fd
    expect(resolveBase(l, 1 << 30, false, -100).fd).toBe(-1); // no such pid
    // A non-directory fd is ENOTDIR, not a base.
    const f = openSync(__filename, "r");
    try {
      const bad = resolveBase(l, me, false, f);
      expect(bad.fd).toBe(-1);
      expect(bad.err).toBe(20);
    } finally { closeSync(f); }
  });

  test("openParentDir resolves with the kernel: links refused, escapes pinned, identity stable", () => {
    const l = lib();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "walk-")));
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      writeFileSync(join(root, "a", "f.txt"), "x");
      symlinkSync(join(root, "a"), join(root, "slink"));
      const freshBase = () => openSync(root, 0o200000); // O_RDONLY|O_DIRECTORY; each open consumes its base
      // A plain subdir opens; its identity matches lstat.
      const w = openParentDir(l, freshBase(), "a/b");
      if (!("parentFd" in w)) throw new Error(`open failed: ${JSON.stringify(w)}`);
      const id = parentIdentity(w.parentFd);
      if (id === null) throw new Error("no identity for a kernel-opened dir");
      const st = lstatSync(join(root, "a", "b"));
      expect({ dev: BigInt(st.dev), ino: BigInt(st.ino) }).toEqual(id);
      try { closeSync(w.parentFd); } catch { /* pinned */ }
      // Through a link: refused with ELOOP, never followed.
      // Through a link: refused, never followed (O_NOFOLLOW|O_DIRECTORY on a link reports ENOTDIR).
      expect(openParentDir(l, freshBase(), "slink/b")).toEqual({ errno: 20 });
      // Dot-dot resolves normally (.. cannot leave the mount namespace; links stay refused).
      const wd = openParentDir(l, freshBase(), "a/../..");
      if (!("parentFd" in wd)) throw new Error(`dot-dot failed: ${JSON.stringify(wd)}`);
      const up = lstatSync(join(root, ".."));
      expect(parentIdentity(wd.parentFd)).toEqual({ dev: BigInt(up.dev), ino: BigInt(up.ino) });
      try { closeSync(wd.parentFd); } catch { /* pinned */ }
      // An absolute path stays under the host root (IN_ROOT).
      const hostRoot = openSync("/", 0o200000);
      const wa = openParentDir(l, hostRoot, root.slice(1) + "/a");
      if (!("parentFd" in wa)) throw new Error("absolute open failed");
      const ast = lstatSync(join(root, "a"));
      expect(parentIdentity(wa.parentFd)).toEqual({ dev: BigInt(ast.dev), ino: BigInt(ast.ino) });
      try { closeSync(wa.parentFd); } catch { /* pinned */ }
      // Identity matching against a supervised list.
      const wb = openParentDir(l, freshBase(), "a");
      if (!("parentFd" in wb)) throw new Error("open failed");
      expect(matchSupervised(wb.parentFd, "f.txt", [join(root, "a", "f.txt")])).toBe(true);
      expect(matchSupervised(wb.parentFd, "f.txt", [join(root, "a", "other")])).toBe(false);
      expect(matchSupervised(wb.parentFd, "f.txt", [join(root, "nope", "f.txt")])).toBe(false);
      try { closeSync(wb.parentFd); } catch { /* pinned */ }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("lstatFinal tells missing, link, dir and file apart without following", () => {
    const l = lib();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fin-")));
    try {
      mkdirSync(join(root, "d"));
      writeFileSync(join(root, "f"), "x");
      symlinkSync(join(root, "f"), join(root, "s"));
      const base = openSync(root, 0o200000);
      try {
        expect(lstatFinal(l, base, "missing")).toEqual({ kind: "missing" });
        expect(lstatFinal(l, base, "s")).toMatchObject({ kind: "link" }); // not followed to f
        expect(lstatFinal(l, base, "d")).toMatchObject({ kind: "dir" });
        expect(lstatFinal(l, base, "f")).toMatchObject({ kind: "other" });
      } finally { try { closeSync(base); } catch { /* pinned */ } }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("readCString reads the target's bytes once (self-read)", () => {
    const l = lib();
    const { ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const buf = Buffer.from("hello-self\0TRAILING", "utf8");
    const addr = BigInt(ptr(buf) as unknown as number);
    expect(readCString(l, process.pid, addr)).toBe("hello-self");
    expect(readPathOnce(l, process.pid, addr, 5)).toEqual(Buffer.from("hello", "utf8"));
    expect(readCString(l, process.pid, 0n)).toBeNull();
  });
});

describe("the git-config guard", () => {
  test("parsing: sections, subsections, comments, continuations and quotes", () => {
    const keys = parseGitConfigWatched([
      "# a comment",
      "; another",
      "[core]",
      "  hooksPath = /tmp/evil",
      "  pager = less",
      '[filter "lfs"]',
      "  clean = git-lfs clean -- %f",
      "  smudge = git-lfs smudge -- %f",
      '[alias]',
      "  ll = log --oneline",
      '  fire = "!f() { rm -rf /; }; f"',
      "[remote \"origin\"]",
      "  url = https://example.com/r.git",
      "[includeIf \"gitdir:~/work/\"]",
      "  path = ~/extra.inc",
      "  [bad",
      "orphan = 1",
      "[core]",
      "  editor = vim \\",
      "    -u NONE",
    ].join("\n"));
    const byDotted = new Map(keys.map((k) => [k.dotted, k.value]));
    expect(byDotted.get("core.hooksPath")).toBe("/tmp/evil");
    expect(byDotted.get('filter.lfs.clean')).toBe("git-lfs clean -- %f");
    expect(byDotted.get("alias.fire")).toBe("!f() { rm -rf /; }; f");
    expect(byDotted.get("remote.origin.url")).toBe("https://example.com/r.git");
    expect(byDotted.get("includeif.gitdir:~/work/.path")).toBe("~/extra.inc");
    expect(byDotted.get("core.editor")).toBe("vim     -u NONE");
    expect(keys.some((k) => k.dotted.startsWith("orphan"))).toBe(false);
  });

  test("watched changes: added, changed and removed risky keys; the rest is left alone", () => {
    const before = ["[user]", "  name = Luna", "[core]", "  editor = vim", "  pager = less", '[alias]', '  ll = log --oneline'].join("\n");
    const added = `${before}\n[core]\n  hooksPath = /tmp/evil\n`;
    expect(watchedGitChanges(before, added).map((c) => c.dotted)).toEqual(["core.hookspath"]);
    expect(watchedGitChanges(before, before)).toEqual([]);
    expect(watchedGitChanges(before, `${before}\n[user]\n  email = l@x.io`)).toEqual([]);
    expect(watchedGitChanges(before, `[user]\n  name = Luna`).map((c) => c.dotted)).toEqual(["core.editor", "core.pager"]);
    const bang = `${before}\n[alias]\n  zap = "!rm -rf ~"`;
    expect(watchedGitChanges(before, bang).map((c) => c.dotted)).toEqual(["alias.zap"]);
    const plain = `${before}\n[alias]\n  zap = "status --short"`;
    expect(watchedGitChanges(before, plain)).toEqual([]);
    expect(watchedGitChanges(null, `[core]\n  fsmonitor = true`).map((c) => c.dotted)).toEqual(["core.fsmonitor"]);
    expect(watchedGitChanges(`[core]\n  fsmonitor = true`, null).map((c) => c.dotted)).toEqual(["core.fsmonitor"]);
  });

  test("revertWatchedGitChanges drops planted lines and restores the snapshot's values", () => {
    const before = ["[user]", "\tname = Luna", "[core]", "\teditor = vim", '[alias]', '\tll = log --oneline'].join("\n");
    const after = ["[user]", "\tname = Luna", "[core]", "\teditor = vim", "\thooksPath = /tmp/evil",
      '[alias]', '\tll = log --oneline', '\tzap = "!rm -rf ~"'].join("\n");
    const changes = watchedGitChanges(before, after);
    expect(changes.map((c) => c.dotted).sort()).toEqual(["alias.zap", "core.hookspath"]);
    const fixed = revertWatchedGitChanges(after, changes);
    expect(fixed).toContain("name = Luna");
    expect(fixed).toContain("ll = log --oneline");
    expect(fixed).not.toContain("hooksPath");
    expect(fixed).not.toContain("zap");
    expect(fixed).not.toContain("rm -rf");
    // Unwatched keys stay exactly as they were, formatting included.
    const plain = `${before}\n[user]\n  email = l@x.io\n`;
    expect(revertWatchedGitChanges(plain, watchedGitChanges(before, plain))).toBe(plain);
    // Nothing watched: byte-identical.
    expect(revertWatchedGitChanges(before, [])).toBe(before);
  });

  test("git itself parses the configs: case, quotes and subsections canonicalize the same way", () => {
    const parsed = parseGitConfigWithGit(["[CORE]", "\tHooksPath = /tmp/evil", '[filter "lfs"]', "\tclean = x"].join("\n"));
    expect(parsed?.get("core.hookspath")).toEqual(["/tmp/evil"]);
    expect(parsed?.get("filter.lfs.clean")).toEqual(["x"]);
    // Malformed files fall back to the built-in parser (null here).
    expect(parseGitConfigWithGit("[core]\n\tok = 1\n[bad\n")).toBeNull();
    // Detection through git: an uppercase section and a quoted !-alias both count.
    const changes = watchedGitChanges("[CORE]\n\tpager = less\n", "[CORE]\n\tpager = less\n[core]\n\thooksPath = /tmp/evil\n[alias]\n\tzap = \"!rm -rf ~\"\n");
    expect(changes.map((c) => c.dotted).sort()).toEqual(["alias.zap", "core.hookspath"]);
  });
});
