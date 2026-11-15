// A folder watch that has been set up hears every change made after it, however busy the computer: the platform's
// watcher (FSEvents on macOS) starts listening some time after it is set up, and a change made in between was lost
// (the plugin API's `files.watch`, then a write, heard nothing in about one run in three under load). Temp folders.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderWatches, type TreeWatchEvent } from "../../src/tree/watch";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-watch-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Waits for a watch to report `name`, at most `ms`; true when it did. */
function hears(watches: FolderWatches, dir: string, name: string, write: () => void, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let off: () => void = () => {};
    const end = (heard: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(heard);
    };
    const timer = setTimeout(() => end(false), ms);
    off = watches.subscribe(dir, "home/Studio/w", () => true, (e: TreeWatchEvent) => {
      if (e.type === "resync" || e.paths.some((p) => p.endsWith(`/${name}`))) end(true);
    });
    // The watch is set up: now the write.
    write();
  });
}

test("watch, then write, 200 times in a row with the event loop kept busy: every write is heard", async () => {
  const watches = new FolderWatches({ budget: 1_000, total: 1_000 });
  // Busy: the event loop runs 15 ms of work every turn it gets.
  const spin = setInterval(() => {
    const until = Date.now() + 15;
    while (Date.now() < until) { /* busy */ }
  }, 1);
  const missed: number[] = [];
  try {
    for (let i = 0; i < 200; i++) {
      // A folder of its own each time, so each watch is a new start of the platform's watcher (the case that lost).
      const dir = join(root, `w${i}`);
      mkdirSync(dir);
      if (i % 2 === 1) writeFileSync(join(dir, "there.txt"), "before");
      const ok = await hears(watches, dir, "page.txt", () => writeFileSync(join(dir, "page.txt"), `write ${i}`), 5_000);
      if (!ok) missed.push(i);
    }
  } finally {
    clearInterval(spin);
    watches.close();
  }
  expect(missed).toEqual([]);
}, 600_000);

test("the catch-up reports a change in a subfolder, a removal and a rewrite of the same size, and nothing when nothing changed", async () => {
  // A watcher that never hears anything: only the catch-up looks report.
  const deaf = (() => ({ on: () => {}, close: () => {} })) as unknown as typeof import("node:fs").watch;
  const watches = new FolderWatches({ watch: deaf });
  const dir = join(root, "catch-up");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "gone.txt"), "x");
  writeFileSync(join(dir, "same.txt"), "aaaa");
  writeFileSync(join(dir, "quiet.txt"), "q");
  const events: TreeWatchEvent[] = [];
  const off = watches.subscribe(dir, "home/Studio/c", () => true, (e) => events.push(e));
  try {
    writeFileSync(join(dir, "sub", "new.txt"), "n");
    rmSync(join(dir, "gone.txt"));
    await Bun.sleep(5);
    writeFileSync(join(dir, "same.txt"), "bbbb");
    await Bun.sleep(400);
    const paths = events.flatMap((e) => (e.type === "changed" ? e.paths : ["resync"])).sort();
    expect([...new Set(paths)]).toEqual(["home/Studio/c/gone.txt", "home/Studio/c/same.txt", "home/Studio/c/sub/new.txt"]);
  } finally {
    off();
    watches.close();
  }
});
