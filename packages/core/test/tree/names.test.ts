// How the tree compares and refuses names (S6 review round 2), and how the tool layer reads paths and `cd`.
import { describe, expect, test } from "bun:test";
import { isContractError } from "../../src/contracts/common";
import { checkSegment, foldName, mayBeShortName, sameName } from "../../src/tree/names";
import { bashTarget, treePathFor } from "../../src/tree/tools";

const invalid = (fn: () => unknown) => { try { fn(); } catch (e) { return isContractError(e, "invalid"); } return false; };

describe("names", () => {
  test("case and Unicode form fold on every OS; Windows drops trailing dots and spaces", () => {
    expect(foldName(".CLOVER", "macos")).toBe(".clover");
    expect(sameName(".café", ".CAFÉ", "linux")).toBe(true);
    expect(sameName("Key", "key", "macos")).toBe(true); // the Kelvin sign
    expect(foldName(".clover. .", "windows")).toBe(".clover");
    expect(foldName(".clover.", "macos")).toBe(".clover.");
  });

  test("names a disk would read as something else are refused", () => {
    for (const s of ["", ".", "..", "a/b", "a\0b"]) expect([s, invalid(() => checkSegment(s, "linux"))]).toEqual([s, true]);
    for (const s of ["NUL", "com1.txt", "LPT9", "con", "a:b", "a.", "a ", "x<y", "a\\b"]) expect([s, invalid(() => checkSegment(s, "windows"))]).toEqual([s, true]);
    for (const s of ["NUL", "a:b", "a."]) expect([s, invalid(() => checkSegment(s, "macos"))]).toEqual([s, false]);
    expect(mayBeShortName("CLOVER~1", "windows")).toBe(true);
    expect(mayBeShortName("CLOVER~1", "linux")).toBe(false);
  });
});

describe("the tool layer's paths", () => {
  test("relative paths join the session's folder and never climb out of its computer", () => {
    expect(treePathFor("home/Laptop1/a", "home/Studio/p")).toBe("home/Laptop1/a");
    expect(treePathFor("src/../b.ts", "home/Studio/p")).toBe("home/Studio/p/b.ts");
    expect(invalid(() => treePathFor("../../../etc", "home/Studio/p"))).toBe(true);
    expect(invalid(() => treePathFor("/etc/passwd", "home/Studio"))).toBe(true);
    expect(invalid(() => treePathFor("a.txt", undefined))).toBe(true);
  });

  test("a leading cd picks Bash's folder", () => {
    expect(bashTarget("cd home/Desktop1/project1 && git status", "home/Studio")).toEqual({ cwd: "home/Desktop1/project1", command: "git status" });
    expect(bashTarget("cd 'home/Desktop1/my project'; ls", "home/Studio")).toEqual({ cwd: "home/Desktop1/my project", command: "ls" });
    expect(bashTarget("cd sub", "home/Studio/p")).toEqual({ cwd: "home/Studio/p/sub", command: null });
    expect(bashTarget("git status && cd x", "home/Studio")).toEqual({ cwd: "home/Studio", command: "git status && cd x" });
  });
});
