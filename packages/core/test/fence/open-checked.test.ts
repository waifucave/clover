import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverFence } from "../../src/fence/fence";
import { fdRealPath, FenceRefused, openChecked, readChecked, writeChecked } from "../../src/fence/open-checked";

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-oc-")));
  const home = join(root, "home"), clover = join(home, ".clover");
  mkdirSync(join(clover, "levels"), { recursive: true });
  mkdirSync(join(home, "project"), { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  return { root, home, clover, fence: new CloverFence({ home, cloverHome: clover, temp: join(root, "tmp") }) };
}

describe("openChecked (#205's S7): judged, opened without the link, judged again at its real path", () => {
  test("an ordinary file reads and writes; its real path comes back from the handle", () => {
    const w = world();
    const f = join(w.home, "project", "notes.md");
    writeChecked(w.fence, f, "hello");
    expect(readChecked(w.fence, f).toString()).toBe("hello");
    const fd = openChecked(w.fence, f);
    try { expect(fdRealPath(fd, process.platform, f)?.toLowerCase()).toBe(realpathSync.native(f).toLowerCase()); } finally { closeSync(fd); }
  });

  test.skipIf(process.platform === "win32")("a link swapped in at the last component is refused, and nothing behind it is touched", () => {
    const w = world();
    const f = join(w.home, "project", "innocent.json");
    symlinkSync(join(w.clover, "settings.json"), f); // the swap, after a check would have passed on a plain file
    expect(() => writeChecked(w.fence, f, "{}")).toThrow();
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
  });

  test("a folder link on the way into a fenced folder: the real path is judged, and a file it made is removed", () => {
    const w = world();
    symlinkSync(join(w.clover, "levels"), join(w.home, "project", "lv"));
    const target = join(w.home, "project", "lv", "computer.json");
    // Through the real fence the first check already refuses (canonicalPath follows the link) …
    expect(() => writeChecked(w.fence, target, "x")).toThrow(FenceRefused);
    // … and when only the open sees the link (a judge that passed the path before it was swapped), the second does.
    const once = { n: 0, check: (op: { op: string; path: string }) => (once.n++ === 0 ? { allowed: true as const } : w.fence.check(op as never)) };
    expect(() => writeChecked(once, join(w.home, "project", "lv", "new.json"), "x")).toThrow(FenceRefused);
    expect(existsSync(join(w.clover, "levels", "new.json"))).toBe(false);
  });

  test("a FIFO never blocks the read: opened without waiting, then refused as not a file", () => {
    const w = world();
    const fifo = join(w.home, "project", "pipe");
    execFileSync("mkfifo", [fifo]);
    // Without O_NONBLOCK this open would wait for a writer forever; with it the fstat refuses instead.
    expect(() => openChecked(w.fence, fifo)).toThrow(FenceRefused);
    expect(() => readChecked(w.fence, fifo)).toThrow(FenceRefused);
    expect(() => writeChecked(w.fence, fifo, "x")).toThrow();
  });

  test("a socket is never read through: the open itself fails instead of hanging", () => {
    const w = world();
    const sock = join(w.home, "project", "sock");
    const server = Bun.listen({ unix: sock, socket: { data() {} } });
    try {
      expect(() => openChecked(w.fence, sock)).toThrow();
      expect(() => readChecked(w.fence, sock)).toThrow();
    } finally { server.stop(true); }
  });

  test("a file with a second name is refused: st_nlink > 1", () => {
    const w = world();
    const f = join(w.home, "project", "shared.md");
    writeChecked(w.fence, f, "hello");
    linkSync(f, join(w.home, "project", "alias.md")); // a second name: either could be swapped next
    expect(() => readChecked(w.fence, f)).toThrow(FenceRefused);
    expect(() => openChecked(w.fence, f)).toThrow(FenceRefused);
  });

  test("a file larger than the cap is refused, not taken into memory", () => {
    const w = world();
    const f = join(w.home, "project", "big.bin");
    writeFileSync(f, Buffer.alloc(1024 * 1024 + 1, 7));
    expect(() => readChecked(w.fence, f)).toThrow(FenceRefused);
  });
});
