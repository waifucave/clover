import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runFenceConformance } from "../../src/contracts/conformance/fence";
import { CloverFence } from "../../src/fence/fence";
import { canonicalPath } from "../../src/fence/canonical";
import { diskName, foldName, foldPath, nonAsciiUnderHome } from "../../src/fence/fold";

// C-M2: the real fence. B's conformance suite runs against it with the suite's own fictional paths (no disk), then
// the folding and the disk's links are checked on real folders.

runFenceConformance((opts) => new CloverFence({ ...opts, canonical: (p) => posix.normalize(p) }));

describe("the fence's fold (B-M1's review, J-M1's B1)", () => {
  test("long s, sharp s and the Kelvin sign fold as the disks take them; NFC and NFD are one name", () => {
    expect(foldName("ſettings.json")).toBe("settings.json");
    expect(foldName("ſettings.json")).toBe(foldName("SETTINGS.JSON"));
    expect(foldName("Straße")).toBe(foldName("STRASSE"));
    expect(foldName("\u212Aey")).toBe("key"); // the Kelvin sign
    expect(foldName("Cafe\u0301")).toBe(foldName("Café"));
  });

  test("Windows: trailing dots and spaces, and a stream suffix, name the same file; the drive folds", () => {
    expect(diskName("settings.json. . ", "windows")).toBe("settings.json");
    expect(diskName("settings.json::$DATA", "windows")).toBe("settings.json");
    expect(diskName("settings.json:hidden", "windows")).toBe("settings.json");
    expect(diskName("settings.json.", "macos")).toBe("settings.json.");
    expect(foldPath("C:\\Users\\Me\\.clover\\Settings.json::$DATA", "windows")).toBe("c:/users/me/.clover/settings.json");
  });

  test("a component under the Clover home that isn't plain ASCII is named", () => {
    expect(nonAsciiUnderHome("/Users/José/.clover/levels/x.json", "/Users/José/.clover", "macos")).toBeNull();
    expect(nonAsciiUnderHome("/Users/me/.clover/ſettings.json", "/Users/me/.clover", "macos")).toBe("ſettings.json");
    expect(nonAsciiUnderHome("/Users/me/project/ſ.txt", "/Users/me/.clover", "macos")).toBeNull();
  });
});

describe("the real fence on a real disk", () => {
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
  const make = (os?: "macos" | "linux" | "windows") => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "fence-")));
    const home = join(root, "home");
    const clover = join(home, ".clover");
    mkdirSync(join(clover, "levels"), { recursive: true });
    mkdirSync(join(home, "project"), { recursive: true });
    return { home, clover, fence: new CloverFence({ home, cloverHome: clover, temp: join(root, "tmp"), ...(os ? { os } : {}) }) };
  };

  test("a fenced name in another case or Unicode form, existing or not, on every OS (Linux included)", () => {
    // Each OS's rules on a disk of its own kind: Windows paths on Windows, macOS's and Linux's on POSIX.
    for (const os of process.platform === "win32" ? (["windows"] as const) : (["macos", "linux"] as const)) {
      const { clover, fence } = make(os);
      expect(fence.check({ op: "write", path: join(clover, "LEVELS", "computer.json") })).toMatchObject({ allowed: false, reason: "levels" });
      expect(fence.check({ op: "write", path: join(clover, "Settings.JSON") })).toMatchObject({ allowed: false, reason: "settings" });
      expect(fence.check({ op: "write", path: join(clover, "rules", "allow.json") })).toMatchObject({ allowed: false, reason: "saved-rules" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ſettings, and any other non-ASCII name under the home, is refused outright", () => {
    const { clover, home, fence } = make();
    expect(fence.check({ op: "write", path: join(clover, "ſettings.json") })).toEqual({ allowed: false, reason: "clover-home", path: clover });
    expect(fence.check({ op: "write", path: join(clover, "plugins", "lüna", "clover.json") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.check({ op: "write", path: join(home, "project", "lüna.txt") })).toEqual({ allowed: true });
  });

  test("links: through a link, a `..` after a link, and a dangling link whose target would be fenced", () => {
    const { home, clover, fence } = make();
    symlinkSync(join(clover, "levels"), join(home, "project", "lv"));
    expect(fence.check({ op: "write", path: join(home, "project", "lv", "computer.json") })).toMatchObject({ allowed: false, reason: "levels" });
    // `lv/..` is `.clover`, not `project`: lexically it would be project/settings.json, which isn't fenced.
    expect(fence.check({ op: "write", path: `${join(home, "project", "lv")}/../settings.json` })).toMatchObject({ allowed: false, reason: "settings" });
    symlinkSync(join(clover, "trust", "agent-oks.json"), join(home, "project", "notes.json")); // dangling: trust/ isn't there
    expect(fence.check({ op: "write", path: join(home, "project", "notes.json") })).toMatchObject({ allowed: false, reason: "trust" });
    symlinkSync(clover, join(home, "c"));
    expect(fence.check({ op: "read", path: join(home, "c", "run", "core.sock") })).toMatchObject({ allowed: false, reason: "run-folder" });
    expect(fence.checkAgentRoot(join(home, "project"))).toEqual({ allowed: true });
  });

  test("a home that is itself reached through a link is fenced at its real path", () => {
    const { home, clover } = make();
    symlinkSync(clover, join(root, "alias"));
    const f = new CloverFence({ home, cloverHome: join(root, "alias") });
    expect(f.check({ op: "write", path: join(clover, "levels", "x.json") })).toMatchObject({ allowed: false, reason: "levels" });
    expect(f.fencedSet().find((i) => i.kind === "levels")!.path).toBe(join(clover, "levels"));
    writeFileSync(join(home, "project", "a.txt"), "x");
    expect(canonicalPath(join(root, "alias", "..", "home", "project", "a.txt"))).toBe(join(home, "project", "a.txt"));
  });
});
