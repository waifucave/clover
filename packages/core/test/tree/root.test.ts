// The tree on each computer's own disk: this computer's own entry is a link to its home folder, `bots/` to its bots'
// folder, nothing else is there, and `home/` is read-only (spec §9.1 "Same-computer paths are native").
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { defaultTreeRoot, ensureTreeRoot, treeHomeWritable } from "../../src/tree/root";

describe("the tree folder", () => {
  test("home/<this computer> is the home folder; other computers aren't on disk; home/ is read-only", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lane-j-root-")));
    const home = join(base, "home");
    mkdirSync(join(home, "project"), { recursive: true });
    writeFileSync(join(home, "project", "a.txt"), "native");
    const root = join(base, "tree");
    const botsRoot = join(home, ".clover", "bots");
    await ensureTreeRoot({ root, self: "Studio", home, botsRoot });
    expect(readFileSync(join(root, "home", "Studio", "project", "a.txt"), "utf8")).toBe("native");
    expect(readdirSync(join(root, "home"))).toEqual(["Studio"]);
    expect(existsSync(join(root, "home", "Laptop1"))).toBe(false);
    expect(realpathSync(join(root, "bots"))).toBe(realpathSync(botsRoot));
    if (process.platform !== "win32") {
      expect(await treeHomeWritable(root)).toBe(false);
      expect(() => writeFileSync(join(root, "home", "Laptop1"), "x")).toThrow();
    }
    // A rename moves the link, and leaves no other.
    await ensureTreeRoot({ root, self: "Studio-2", home, botsRoot });
    expect(readdirSync(join(root, "home"))).toEqual(["Studio-2"]);
    expect(readFileSync(join(root, "home", "Studio-2", "project", "a.txt"), "utf8")).toBe("native");
  });

  test("where it lives on each OS, outside every home folder", () => {
    expect(defaultTreeRoot({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe("/run/user/1000/clover");
    expect(isContractError((() => { try { defaultTreeRoot({}, "linux"); } catch (e) { return e; } })(), "invalid")).toBe(true);
    expect(defaultTreeRoot({}, "macos")).toMatch(/^\/Users\/Shared\/clover-\d+$/);
    expect(defaultTreeRoot({ ProgramData: "C:\\ProgramData", USERNAME: "me" }, "windows")).toBe("C:\\ProgramData\\Clover\\tree-me");
  });
});
