import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runFenceConformance } from "../../src/contracts/conformance/fence";
import { CloverFence } from "../../src/fence/fence";
import { canonicalPath } from "../../src/fence/canonical";
import { diskName, foldName, foldPath, nonAsciiAlias } from "../../src/fence/fold";

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

  test("a non-ASCII name is named only where Clover names things: the home's top level and folders holding a fenced item", () => {
    const H = "/Users/José/.clover";
    const fenced = [`${H}/levels`, `${H}/plugins-state/oks`];
    expect(nonAsciiAlias(`${H}/ſettings.json`, fenced, H, "macos")).toBe("ſettings.json");
    expect(nonAsciiAlias(`${H}/plugins-state/ökay.json`, fenced, H, "macos")).toBe("ökay.json");
    expect(nonAsciiAlias(`${H}/levels/x.json`, fenced, H, "macos")).toBeNull(); // the home's own name may be anything
    expect(nonAsciiAlias(`${H}/bots/alpha/memory/café.md`, fenced, H, "macos")).toBeNull(); // a bot's note
    expect(nonAsciiAlias(`${H}/plugins/lüna/clover.json`, fenced, H, "macos")).toBeNull(); // a plugin's files
    expect(nonAsciiAlias("/Users/me/project/ſ.txt", fenced, H, "macos")).toBeNull();
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

  test("ſettings, and a non-ASCII name where Clover names things, is refused outright; elsewhere any name is fine", () => {
    const { clover, home, fence } = make();
    expect(fence.check({ op: "write", path: join(clover, "ſettings.json") })).toEqual({ allowed: false, reason: "clover-home", path: clover });
    expect(fence.check({ op: "write", path: join(clover, "plugins-state", "öks") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.check({ op: "write", path: join(clover, "plugins", "lüna", "clover.json") })).toEqual({ allowed: true }); // no fenced item there
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

  test("a hard link to a fenced file is the fenced file: writing, deleting or moving it is refused", () => {
    const { home, clover, fence } = make();
    writeFileSync(join(clover, "levels", "computer.json"), "{}");
    linkSync(join(clover, "levels", "computer.json"), join(home, "project", "innocent.json"));
    expect(fence.check({ op: "write", path: join(home, "project", "innocent.json") })).toEqual({ allowed: false, reason: "levels", path: join(clover, "levels") });
    expect(fence.check({ op: "delete", path: join(home, "project", "innocent.json") }).allowed).toBe(false);
    expect(fence.check({ op: "read", path: join(home, "project", "innocent.json") })).toEqual({ allowed: true });
    writeFileSync(join(home, "project", "a.txt"), "x");
    linkSync(join(home, "project", "a.txt"), join(home, "project", "b.txt")); // two links, neither fenced
    expect(fence.check({ op: "write", path: join(home, "project", "b.txt") })).toEqual({ allowed: true });
  });
});
