import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { CloverFence } from "../../src/fence/fence";
import { readOwnFile, refuseLinksIn, writeOwnFile } from "../../src/fence/own-files";
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

  test("refuseLinksIn guards a walked folder", () => {
    expect(refuseLinksIn(b("luna", "memory"))).toBeUndefined();
    symlinkSync(b("sol", "memory", "MEMORY.md"), b("luna", "memory", "peek.md"));
    try {
      expect(() => refuseLinksIn(b("luna", "memory"))).toThrow(FenceRefused);
    } finally { rmSync(b("luna", "memory", "peek.md")); }
    expect(refuseLinksIn(b("luna", "memory"))).toBeUndefined();
  });
});
