// A record whose write counter didn't reach the secret store before the core stopped (the counter is kept after the
// file): the next start takes Clover's own newer file and adopts its counter; an older copy put back is still refused.
// The upgrade pair's step 11 found it: a plugin's removal wrote indexes.json three times right before a quit.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { IndexClient } from "../indexes/client";
import { emptyIndexesState, fileRegistryStore, memoryRegistryStore } from "../state";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "clover-gen-ahead-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("a registry record ahead of its kept counter", () => {
  test("three saves, only the first counter kept, then a stop: the next start reads the file and adopts its counter", () => {
    const dir = temp();
    const macKey = new Uint8Array(randomBytes(32));
    let kept: Record<string, number> = {};
    let landed = 0;
    const one = fileRegistryStore(dir, { macKey, onCounters: (c) => { if (landed++ === 0) kept = c; } });
    for (const pinned of [["a"], ["a", "b"], ["a", "b", "c"]]) one.saveIndexes!({ ...emptyIndexesState(), pinned });
    expect(kept).toEqual({ "indexes.json": 1 });
    // The next start, on the counters the secret store kept.
    const tampered: string[] = [];
    let adopted: Record<string, number> | undefined;
    const two = fileRegistryStore(dir, { macKey, counters: kept, onTampered: (f) => tampered.push(f), onCounters: (c) => void (adopted = c) });
    expect(two.loadIndexes!().pinned).toEqual(["a", "b", "c"]);
    expect(tampered).toEqual([]);
    expect(adopted).toEqual({ "indexes.json": 3 });
    // Its next write follows on from the adopted counter, and a start on the counters kept then reads it.
    two.saveIndexes!({ ...emptyIndexesState(), pinned: ["d"] });
    expect(adopted).toEqual({ "indexes.json": 4 });
    expect(fileRegistryStore(dir, { macKey, counters: adopted!, onTampered: (f) => tampered.push(f) }).loadIndexes!().pinned).toEqual(["d"]);
    expect(tampered).toEqual([]);
  });

  test("an older copy put back is still refused, for every kind of record, and so is a copy ahead whose MAC isn't Clover's", () => {
    const dir = temp();
    const macKey = new Uint8Array(randomBytes(32));
    let kept: Record<string, number> = {};
    const signed = (onTampered?: (f: string) => void) => fileRegistryStore(dir, { macKey, counters: kept, onCounters: (c) => void (kept = c), ...(onTampered ? { onTampered } : {}) });
    const files = { indexes: join(dir, "indexes.json"), installed: join(dir, "installed.json"), ok: join(dir, "oks", "luna.json") };
    signed().saveIndexes!({ ...emptyIndexesState(), pinned: ["old"] });
    signed().save({ v: 1, order: ["old"], plugins: {}, dev: [] });
    signed().saveOk("luna", { okHash: "old", files: [], plugins: {}, cards: "", codePaths: [] });
    const older = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]));
    signed().saveIndexes!({ ...emptyIndexesState(), pinned: ["new"] });
    signed().save({ v: 1, order: ["new"], plugins: {}, dev: [] });
    signed().saveOk("luna", { okHash: "new", files: [], plugins: {}, cards: "", codePaths: [] });
    for (const [k, f] of Object.entries(files)) writeFileSync(f, older[k]!);
    const tampered: string[] = [];
    const s = signed((f) => tampered.push(f.slice(dir.length + 1)));
    expect(s.loadIndexes!()).toEqual(emptyIndexesState());
    expect(s.load().order).toEqual([]);
    expect(s.loadOk("luna")).toBeUndefined();
    expect(tampered).toEqual(["indexes.json", "installed.json", "oks/luna.json"]);
    // A copy ahead of the counter with a MAC of another key: refused, its counter not adopted.
    const before = { ...kept };
    const other = fileRegistryStore(temp(), { macKey: new Uint8Array(randomBytes(32)), counters: { "indexes.json": 9 } });
    other.saveIndexes!({ ...emptyIndexesState(), pinned: ["forged"] });
    writeFileSync(files.indexes, readFileSync(join(dirs.at(-1)!, "indexes.json"), "utf8"));
    const t2: string[] = [];
    expect(signed((f) => t2.push(f)).loadIndexes!()).toEqual(emptyIndexesState());
    expect(t2).toHaveLength(1);
    expect(kept).toEqual(before);
  });

  test("a removal's clearing of a plugin's index records writes nothing when there is nothing to clear", () => {
    const store = memoryRegistryStore();
    let saves = 0;
    const counted = { ...store, saveIndexes: (s: Parameters<NonNullable<typeof store.saveIndexes>>[0]) => { saves++; store.saveIndexes!(s); } };
    const c = new IndexClient({ store: counted, cacheDir: temp() });
    c.setPinned("tarot", false);
    expect(saves).toBe(0);
    c.setPinned("tarot", true);
    c.setPinned("tarot", true);
    expect(saves).toBe(1);
    c.setPinned("tarot", false);
    expect(saves).toBe(2);
  });
});
