import { describe, expect, test } from "bun:test";
import { buildUserNotifFilter, decideCall, matchUnsafe, openWrites, supervisorArch, type ProcIo } from "../../src/fence/linux-supervisor";
import { parseGitConfigWatched, revertWatchedGitChanges, watchedGitChanges } from "../../src/fence/git-config";

describe("the supervisor's filter and decisions", () => {
  test("no supervisor off x86-64; the filter traps the path syscalls and allows the rest", () => {
    expect(supervisorArch("arm64")).toBeNull();
    expect(supervisorArch("x64")).toBe("x64");
    expect(buildUserNotifFilter("arm64")).toBeNull();
    const f = buildUserNotifFilter("x64")!;
    expect(f.length % 8).toBe(0);
    const insns = f.length / 8;
    expect(insns).toBe(3 + 15 + 2); // arch check, call number, one jump per trapped call, allow, trap
    expect([f.readUInt16LE(0), f.readUInt32LE(4)]).toEqual([0x20, 4]); // LD arch
    expect([f.readUInt16LE((insns - 2) * 8), f.readUInt32LE((insns - 2) * 8 + 4)]).toEqual([0x06, 0x7fff0000]); // allow
    expect([f.readUInt16LE((insns - 1) * 8), f.readUInt32LE((insns - 1) * 8 + 4)]).toEqual([0x06, 0x7fc00000]); // trap: USER_NOTIF
    // The openat jump lands on the trap.
    const openat = 3 + 0; // first trapped call
    expect([f.readUInt8(openat * 8 + 2), f.readUInt32LE(openat * 8 + 4)]).toEqual([15 - 0, 257]);
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

  test("matchUnsafe is exact, or folded as the disk would", () => {
    expect(matchUnsafe("/h/.bash_profile", ["/h/.bash_profile"])).toBe(true);
    expect(matchUnsafe("/h/.bashrc", ["/h/.bash_profile"])).toBe(false);
    expect(matchUnsafe("/h/.BASH_PROFILE", ["/h/.bash_profile"])).toBe(true); // folding disk
  });

  const ioFor = (files: Record<string, string>, cwd = "/h/work"): ProcIo => ({
    readlink: (p) => {
      if (p === `/proc/4242/cwd`) return cwd;
      const m = /^\/proc\/4242\/fd\/(\d+)$/.exec(p);
      if (m !== null) return { 3: "/h/work", 4: "/h" }[m[1]!] ?? null;
      return null;
    },
    readMem: (_pid, addr, _len) => {
      const text = files[Number(addr)] ?? null;
      return text === null ? null : Buffer.from(`${text}\0`, "utf8");
    },
  });
  const call = (nr: number, args: (bigint | number)[], extra: Record<string, string> = {}, cwd = "/h/work") =>
    decideCall({ nr, args: args.map(BigInt), pid: 4242 }, ["/h/.bash_profile", "/h/.git/hooks", "/h/other"], ioFor(extra, cwd));

  test("reads pass, writes to supervised folders don't", () => {
    // openat read of an ordinary file.
    expect(call(257, [3, 0x1000], { 0x1000: "/h/work/a.txt" })).toBe("allow");
    // openat write: an absolute supervised path is denied whatever the dirfd.
    expect(call(257, [3, 0x1000, 0o1], { 0x1000: "/h/.bash_profile" })).toBe("deny");
    expect(call(257, [4, 0x1000, 0o1], { 0x1000: ".bash_profile" })).toBe("deny"); // dirfd 4 = /h
    expect(call(2, [0x1000, 0o0], { 0x1000: "/h/.bash_profile" })).toBe("allow"); // O_RDONLY reads pass
    expect(call(2, [0x1000, 0o1], { 0x1000: "/h/.bash_profile" })).toBe("deny");
    // creat always writes.
    expect(call(85, [0x1000, 0o644], { 0x1000: "/h/.bash_profile" })).toBe("deny");
    expect(call(85, [0x1000, 0o644], { 0x1000: "/h/work/new.txt" })).toBe("allow");
    // mkdir, symlink, link and rename on supervised paths.
    expect(call(258, [3, 0x1000], { 0x1000: "/h/.ssh" })).toBe("allow"); // not supervised in this list
    expect(call(88, [0x1000, 0x2000], { 0x1000: "/bin/true", 0x2000: "/h/.bash_profile" })).toBe("deny");
    expect(call(264, [3, 0x1000, 4, 0x2000], { 0x1000: "a", 0x2000: ".bash_profile" })).toBe("deny");
    expect(call(264, [3, 0x1000, 4, 0x2000], { 0x1000: "a", 0x2000: "b" })).toBe("allow");
    // An untrappable call and an unreadable target.
    expect(call(0, [1, 2, 3])).toBe("allow"); // read: not trapped
    expect(call(257, [3, 0x1000, 0o1], {})).toBe("deny"); // fail closed
    // AT_FDCWD arrives as an unsigned word (2^64-100): relative paths still resolve against the cwd.
    const AT_FDCWD_U = 2n ** 64n - 100n;
    expect(decideCall({ nr: 257, args: [AT_FDCWD_U, 0x1000n, 0o1n], pid: 4242 }, ["/h/.bash_profile"], ioFor({ 0x1000: ".bash_profile" }, "/h"))).toBe("deny");
    expect(decideCall({ nr: 257, args: [AT_FDCWD_U, 0x1000n, 0o1n], pid: 4242 }, ["/h/.bash_profile"], ioFor({ 0x1000: "notes.txt" }, "/h"))).toBe("allow");
  });

  test("openat2 reads its write intent from open_how", () => {
    const how = (flags: bigint) => {
      const b = Buffer.alloc(24);
      b.writeBigUInt64LE(flags, 0);
      return b;
    };
    const io: ProcIo = {
      readlink: (p) => (p === "/proc/4242/cwd" ? "/h" : p === "/proc/4242/fd/3" ? "/h" : null),
      readMem: (_pid, addr, _len) => (addr === 0x3000n ? how(0n) : addr === 0x3001n ? how(0o1n) : addr === 0x1000n ? Buffer.from(".bash_profile\0") : null),
    };
    expect(decideCall({ nr: 437, args: [3n, 0x1000n, 0x3000n], pid: 4242 }, ["/h/.bash_profile"], io)).toBe("allow");
    expect(decideCall({ nr: 437, args: [3n, 0x1000n, 0x3001n], pid: 4242 }, ["/h/.bash_profile"], io)).toBe("deny");
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
});
