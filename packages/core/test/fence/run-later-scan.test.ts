// The look for what git runs later under a bot's write roots (`gitRunLaterPlaces`, the sandbox's `configNamed`) keeps
// each folder's listing by the folder's stamp: a crowded temp folder was read whole at every look (a second or more on
// the event loop). Kept or fresh, the look gives the same answer, through every change that matters. Temp folders only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetScanListings, gitRunLaterPlaces, scanFolderReads } from "../../src/approvals/ordinary-paths";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => forgetScanListings());

const o = { home: "/nonexistent-home", os: process.platform === "darwin" ? "macos" : "linux" } as const;
/** Past the window in which a change could hide in a coarse file time: what was just made is read once more, then kept. */
const settle = () => Bun.sleep(2_100);

function crowded(dirs: number, files: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-scan-")));
  temps.push(root);
  for (let i = 0; i < dirs; i++) {
    const d = join(root, `t${i}`, "work");
    mkdirSync(d, { recursive: true });
    for (let j = 0; j < files; j++) writeFileSync(join(root, `t${i}`, `f${j}`), "");
  }
  return root;
}
const repo = (dir: string, config: string) => {
  mkdirSync(join(dir, ".git", "objects"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "config"), config);
};
/** The look with what is kept, then a fresh one (nothing kept): the same answer. */
function both(root: string, budget = 6_000) {
  const kept = gitRunLaterPlaces(root, o, { left: budget });
  forgetScanListings();
  const fresh = gitRunLaterPlaces(root, o, { left: budget });
  return { kept: { places: [...kept.places].sort(), complete: kept.complete }, fresh: { places: [...fresh.places].sort(), complete: fresh.complete } };
}

describe("the run-later look, kept by the folders' stamps", () => {
  test("kept or fresh, the same places through each change that matters: a config edited in place, a repository made deep, a folder that becomes a bare repository, a rename, a folder replaced", async () => {
    const root = crowded(60, 3);
    repo(join(root, "t1", "work"), "[core]\n\thooksPath = tools/hooks\n");
    // A linked worktree: a `.git` file naming its git directory, whose config names a hooks folder.
    mkdirSync(join(root, "gitdirs", "wt"), { recursive: true });
    writeFileSync(join(root, "gitdirs", "wt", "config"), "[core]\n\thooksPath = wt-hooks\n");
    mkdirSync(join(root, "t2", "work", "linked"), { recursive: true });
    writeFileSync(join(root, "t2", "work", "linked", ".git"), `gitdir: ${join(root, "gitdirs", "wt")}\n`);
    await settle();
    gitRunLaterPlaces(root, o, { left: 6_000 });
    const before = scanFolderReads();
    let r = both(root);
    expect(scanFolderReads() - before).toBeGreaterThan(60); // the fresh one read them all again; the kept one, none
    expect(r.kept).toEqual(r.fresh);
    expect(r.kept.places).toEqual([join(root, "t1", "work", "tools", "hooks"), join(root, "t2", "work", "linked", "wt-hooks")].sort());

    // A config edited in place (its folder's stamp doesn't change): read again at every look.
    writeFileSync(join(root, "t1", "work", ".git", "config"), "[core]\n\thooksPath = other-hooks\n[include]\n\tpath = ../shared.gitconfig\n");
    gitRunLaterPlaces(root, o, { left: 6_000 });
    r = both(root);
    expect(r.kept).toEqual(r.fresh);
    expect(r.kept.places).toContain(join(root, "t1", "work", "other-hooks"));
    expect(r.kept.places).toContain(join(root, "t1", "work", "shared.gitconfig"));

    // Each of these changes, looked at once kept (warm) and then fresh, after the change has settled too.
    const changes: [string, () => void][] = [
      ["a repository made five folders down", () => { mkdirSync(join(root, "t3", "work", "a", "b", "c"), { recursive: true }); repo(join(root, "t3", "work", "a", "b", "c"), "[core]\n\thooksPath = deep-hooks\n"); }],
      ["a plain folder that becomes a bare repository", () => { mkdirSync(join(root, "t4", "work", "objects")); writeFileSync(join(root, "t4", "work", "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(root, "t4", "work", "config"), "[core]\n\thooksPath = bare-hooks\n"); }],
      ["a folder holding a repository renamed", () => renameSync(join(root, "t3"), join(root, "t3-moved"))],
      ["a folder replaced by another of the same name, now a repository", () => { rmSync(join(root, "t5"), { recursive: true }); mkdirSync(join(root, "t5")); repo(join(root, "t5"), "[core]\n\thooksPath = again-hooks\n"); }],
    ];
    for (const [what, change] of changes) {
      gitRunLaterPlaces(root, o, { left: 6_000 }); // kept from before the change
      change();
      r = both(root);
      expect([what, r.kept]).toEqual([what, r.fresh]);
      await settle();
      gitRunLaterPlaces(root, o, { left: 6_000 });
      r = both(root);
      expect([what, "settled", r.kept]).toEqual([what, "settled", r.fresh]);
    }
    expect(r.kept.places).toEqual(expect.arrayContaining([
      join(root, "t3-moved", "work", "a", "b", "c", "deep-hooks"), join(root, "t4", "work"), join(root, "t4", "work", "bare-hooks"), join(root, "t5", "again-hooks"),
    ]));
    expect(r.kept.places.some((p) => p.startsWith(`${join(root, "t3")}/`))).toBe(false);
  }, 60_000);

  test("past the budget, the same places and the same `complete: false`, kept or fresh", async () => {
    const root = crowded(400, 4);
    repo(join(root, "t0", "work"), "[core]\n\thooksPath = first-hooks\n");
    await settle();
    gitRunLaterPlaces(root, o, { left: 500 });
    const r = both(root, 500);
    expect(r.kept).toEqual(r.fresh);
    expect(r.kept.complete).toBe(false);
  }, 30_000);

  test("a crowded temp folder: the first look reads every folder, the next reads none of the unchanged ones and is much quicker", async () => {
    // Like a developer's temp folder: thousands of folders at the top, each with a few files and a folder in it.
    const root = crowded(3_500, 8);
    await settle();
    const r0 = scanFolderReads();
    let t = performance.now();
    const cold = gitRunLaterPlaces(root, o, { left: 6_000 });
    const coldMs = performance.now() - t;
    const coldReads = scanFolderReads() - r0;
    t = performance.now();
    const warm = gitRunLaterPlaces(root, o, { left: 6_000 });
    const warmMs = performance.now() - t;
    const warmReads = scanFolderReads() - r0 - coldReads;
    console.log(`crowded temp folder (3,500 folders, 8 files each): first look ${coldMs.toFixed(0)} ms reading ${coldReads} folders; next ${warmMs.toFixed(0)} ms reading ${warmReads}`);
    expect(warm).toEqual(cold);
    expect(coldReads).toBeGreaterThan(1_000);
    expect(warmReads).toBe(0);
  }, 120_000);
});
