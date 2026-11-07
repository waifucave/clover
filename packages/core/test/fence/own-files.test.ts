import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { CloverFence } from "../../src/fence/fence";
import { readOwnFile, refuseLinksIn, sweepOwnTempFiles, writeOwnFile } from "../../src/fence/own-files";
import { FenceRefused } from "../../src/fence/open-checked";

const bot = (b: string | undefined, sessionId: string, sessionKind: "bot" | "side-thread" | "agent" | "coding" = "bot"): Caller =>
  ({ kind: "session", sessionId, sessionKind, ...(b ? { bot: b } : {}) }) as Caller;

// The core's own file access in a bot's folders: no link on the way in, and never outside its own folders, so a
// symlink a runner leaves behind can't lead the core to another bot's data.
describe("the core's own files in a caller's own folders", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-own-")));
  const home = join(root, "home"), clover = join(home, ".clover");
  const fence = new CloverFence({ home, cloverHome: clover, temp: join(root, "tmp") });
  const b = (...parts: string[]) => join(clover, "bots", ...parts);
  for (const d of [b("luna", "memory"), b("luna", "agents"), b("sol", "memory")]) mkdirSync(d, { recursive: true });
  writeFileSync(b("luna", "memory", "MEMORY.md"), "luna's");
  writeFileSync(b("luna", "agents", "t.json"), "{}");
  writeFileSync(b("sol", "memory", "MEMORY.md"), "sol's");
  const luna = fence.forCaller(bot("luna", "s1"));
  const coding = fence.forCaller(bot(undefined, "c1", "coding"));

  test("its own memory reads and writes; another bot's neither", () => {
    expect(readOwnFile(luna, b("luna", "memory", "MEMORY.md")).toString()).toBe("luna's");
    writeOwnFile(luna, b("luna", "memory", "new.md"), "new");
    expect(readOwnFile(luna, b("luna", "memory", "new.md")).toString()).toBe("new");
    expect(() => readOwnFile(luna, b("sol", "memory", "MEMORY.md"))).toThrow(FenceRefused);
    expect(() => writeOwnFile(luna, b("sol", "memory", "new.md"), "x")).toThrow(FenceRefused);
    expect(readOwnFile(luna, b("luna", "agents", "t.json")).toString()).toBe("{}"); // its own folder reads
    expect(() => writeOwnFile(luna, b("luna", "agents", "x.json"), "x")).toThrow(FenceRefused); // but never writes
    const outs = join(clover, "outputs", "c1");
    mkdirSync(outs, { recursive: true });
    writeOwnFile(coding, join(outs, "r.md"), "r");
    expect(readOwnFile(coding, join(outs, "r.md")).toString()).toBe("r");
    expect(() => readOwnFile(coding, b("luna", "memory", "MEMORY.md"))).toThrow(FenceRefused);
  });

  test("a planted link to another bot's memory is refused, read and write", () => {
    symlinkSync(b("sol", "memory", "MEMORY.md"), b("luna", "memory", "peek.md"));
    try {
      expect(() => readOwnFile(luna, b("luna", "memory", "peek.md"))).toThrow(FenceRefused);
      expect(() => writeOwnFile(luna, b("luna", "memory", "peek.md"), "x")).toThrow(FenceRefused);
    } finally { rmSync(b("luna", "memory", "peek.md")); }
    symlinkSync(b("sol", "memory"), b("luna", "peek"));
    try {
      expect(() => readOwnFile(luna, b("luna", "peek", "MEMORY.md"))).toThrow(FenceRefused);
    } finally { rmSync(b("luna", "peek")); }
  });

  test("the handle's real path decides, faked for Windows", () => {
    // Without the path Windows can't answer, so every call would refuse; the fake stands in for its answer.
    expect(() => readOwnFile(luna, b("luna", "memory", "MEMORY.md"), { realPath: () => null })).toThrow(FenceRefused);
    // A real path outside the caller's own folders refuses, even with no link on disk.
    expect(() => readOwnFile(luna, b("luna", "memory", "MEMORY.md"), { realPath: () => b("sol", "memory", "MEMORY.md") })).toThrow(FenceRefused);
    // A matching answer reads through.
    expect(readOwnFile(luna, b("luna", "memory", "MEMORY.md"), { realPath: () => b("luna", "memory", "MEMORY.md") }).toString()).toBe("luna's");
  });

  test("a FIFO, a socket, a second name and an over-cap file are all refused reads", () => {
    const mem = b("luna", "memory");
    const fifo = join(mem, "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(() => readOwnFile(luna, fifo)).toThrow(FenceRefused); // never blocks: O_NONBLOCK, then not a file
    const sock = join(mem, "sock");
    const server = Bun.listen({ unix: sock, socket: { data() {} } });
    try {
      expect(() => readOwnFile(luna, sock)).toThrow(); // the open itself fails: never read through
    } finally { server.stop(true); }
    const shared = join(mem, "shared.md");
    writeOwnFile(luna, shared, "hello");
    linkSync(shared, join(mem, "shared-alias.md"));
    expect(() => readOwnFile(luna, shared)).toThrow(FenceRefused); // st_nlink > 1
    const big = join(mem, "big.bin");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 7));
    expect(() => readOwnFile(luna, big)).toThrow(FenceRefused); // past the cap, not into memory
    // Ordinary files still read.
    expect(readOwnFile(luna, b("luna", "memory", "MEMORY.md")).toString()).toBe("luna's");
  });

  test("a home under a symlinked folder works when callers pass the real path", () => {
    // /var and /tmp themselves are links on macOS: the fence canonicalizes to the real path, and the link
    // walk above a real path meets only real folders. A caller passing the unresolved path fails closed.
    const realRoot = realpathSync(mkdtempSync(join(tmpdir(), "clover-real-")));
    const link = join(tmpdir(), `clover-link-${process.pid}`);
    symlinkSync(realRoot, link);
    try {
      const home = join(link, "home"), clover = join(home, ".clover");
      mkdirSync(join(clover, "bots", "luna", "memory"), { recursive: true });
      writeFileSync(join(clover, "bots", "luna", "memory", "MEMORY.md"), "luna's");
      const fence = new CloverFence({ home, cloverHome: clover, temp: join(link, "tmp") });
      expect(fence.home).toBe(join(realRoot, "home")); // canonicalized past the link
      const l = fence.forCaller(bot("luna", "s1"));
      const mem = join(realRoot, "home", ".clover", "bots", "luna", "memory");
      expect(readOwnFile(l, join(mem, "MEMORY.md")).toString()).toBe("luna's");
      writeOwnFile(l, join(mem, "n.md"), "n");
      expect(readOwnFile(l, join(mem, "n.md")).toString()).toBe("n");
      expect(refuseLinksIn(mem)).toBeUndefined();
      // The unresolved spelling fails closed (a prefix is a link), never misread.
      expect(() => readOwnFile(l, join(link, "home", ".clover", "bots", "luna", "memory", "MEMORY.md"))).toThrow(FenceRefused);
    } finally {
      rmSync(link, { force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  test("refuseLinksIn guards a walked folder", () => {
    expect(refuseLinksIn(b("luna", "memory"))).toBeUndefined();
    symlinkSync(b("sol", "memory", "MEMORY.md"), b("luna", "memory", "peek.md"));
    try {
      expect(() => refuseLinksIn(b("luna", "memory"))).toThrow(FenceRefused);
    } finally { rmSync(b("luna", "memory", "peek.md")); }
    expect(refuseLinksIn(b("luna", "memory"))).toBeUndefined();
  });

  test("sweepOwnTempFiles removes only leftover temp files, never following links", () => {
    const mem = b("luna", "memory");
    mkdirSync(join(mem, "sub"), { recursive: true });
    writeFileSync(join(mem, "leave.tmp-0123456789abcdef"), "half-written");
    writeFileSync(join(mem, "sub", "leave.tmp-fedcba9876543210"), "half-written");
    writeFileSync(join(mem, "MEMORY.md"), "luna's");
    writeFileSync(join(mem, "note.tmp-xyz"), "not a temp file");
    writeFileSync(join(mem, "note.tmp-0123456789abcde"), "too short");
    symlinkSync(join(mem, "MEMORY.md"), join(mem, "skip.tmp-aaaaaaaaaaaaaaaa"));
    writeFileSync(b("sol", "memory", "leave.tmp-bbbbbbbbbbbbbbbb"), "another bot's");
    sweepOwnTempFiles([mem]);
    expect(existsSync(join(mem, "leave.tmp-0123456789abcdef"))).toBe(false);
    expect(existsSync(join(mem, "sub", "leave.tmp-fedcba9876543210"))).toBe(false);
    expect(readFileSync(join(mem, "MEMORY.md"), "utf8")).toBe("luna's");
    expect(existsSync(join(mem, "note.tmp-xyz"))).toBe(true);
    expect(existsSync(join(mem, "note.tmp-0123456789abcde"))).toBe(true);
    expect(existsSync(join(mem, "skip.tmp-aaaaaaaaaaaaaaaa"))).toBe(true); // the link stays, and its target
    expect(existsSync(b("sol", "memory", "leave.tmp-bbbbbbbbbbbbbbbb"))).toBe(true); // other folders aren't swept
  });
});
