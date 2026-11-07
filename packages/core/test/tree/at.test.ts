// Changes anchored to folders (J-M1 review minor 6): every folder on the way is opened through the one above it and
// never through a link, so a folder swapped for a link can't carry a change anywhere else.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { atOps } from "../../src/tree/at";

const posix = process.platform === "darwin" || process.platform === "linux";
const caught = (fn: () => void) => { try { fn(); } catch (e) { return e; } return undefined; };

describe("anchored changes", () => {
  test("mkdirs, remove and rename work through real folders, and refuse a link on the way", () => {
    if (!posix) return;
    const at = atOps();
    expect(at).not.toBeNull();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lane-j-at-")));
    const root = join(base, "home");
    const outside = join(base, "fenced");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.json"), "{}");
    at!.mkdirs(root, ["a", "b", "c"], "a/b/c");
    expect(existsSync(join(root, "a", "b", "c"))).toBe(true);
    writeFileSync(join(root, "a", "b", "c", "f.txt"), "f");
    at!.rename(root, ["a", "b", "c", "f.txt"], root, ["a", "g.txt"], "f.txt");
    expect(readFileSync(join(root, "a", "g.txt"), "utf8")).toBe("f");
    expect(isContractError(caught(() => at!.remove(root, ["a"], { dir: true, recursive: false }, "a")), "invalid")).toBe(true);
    // A folder on the way that is a link (as if swapped mid-call): refused, and nothing outside is touched.
    symlinkSync(outside, join(root, "swapped"));
    expect(isContractError(caught(() => at!.remove(root, ["swapped", "keep.json"], { dir: false, recursive: false }, "swapped/keep.json")), "refused")).toBe(true);
    expect(isContractError(caught(() => at!.mkdirs(root, ["swapped", "new"], "swapped/new")), "refused")).toBe(true);
    expect(isContractError(caught(() => at!.rename(root, ["a", "g.txt"], root, ["swapped", "g.txt"], "g.txt")), "refused")).toBe(true);
    expect(existsSync(join(outside, "keep.json"))).toBe(true);
    expect(existsSync(join(outside, "new"))).toBe(false);
    // A rename into place never replaces what's there, not even an empty folder (check 2's N2).
    mkdirSync(join(root, "a", "staged"));
    mkdirSync(join(root, "a", "taken"));
    expect(isContractError(caught(() => at!.renameNew(root, ["a"], "staged", "taken", "a/taken")), "conflict")).toBe(true);
    expect(at!.renameNew(root, ["a"], "staged", "placed", "a/placed")).toBe(true);
    expect(existsSync(join(root, "a", "placed"))).toBe(true);
    // A recursive remove takes the link itself, never what it leads to.
    mkdirSync(join(root, "a", "deep", "er"), { recursive: true });
    symlinkSync(outside, join(root, "a", "deep", "out"));
    at!.remove(root, ["a"], { dir: true, recursive: true }, "a");
    expect(existsSync(join(root, "a"))).toBe(false);
    expect(readFileSync(join(outside, "keep.json"), "utf8")).toBe("{}");
  });
});
