// The catch-up look's fingerprint: the same print as a full walk at every moment, but an unchanged directory isn't
// listed again (a listing costs about six stats, and a look runs every few seconds over every waiting folder).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FingerprintCache, fingerprint, fingerprintStats } from "../fingerprint";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "clover-fp-"));
  for (const d of ["a", "a/b", "c", "node_modules/x"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["clover.json", "a/one.ts", "a/b/two.ts", "c/three.ts", "node_modules/x/skipped.js"]) writeFileSync(join(root, f), `// ${f}`);
  return root;
}
const readdirsDuring = (f: () => void): number => { const n = fingerprintStats.readdirs; f(); return fingerprintStats.readdirs - n; };

describe("FingerprintCache", () => {
  test("an unchanged folder is looked at again with no directory listing, and gives the full walk's print", () => {
    const root = tree();
    const cache = new FingerprintCache();
    expect(readdirsDuring(() => cache.print(root))).toBe(4); // root, a, a/b, c (node_modules is never walked)
    for (let i = 0; i < 3; i++) {
      let got = "";
      expect(readdirsDuring(() => { got = cache.print(root); })).toBe(0);
      expect(got).toBe(fingerprint(root));
    }
  });

  test("every kind of change is seen at once, and the print stays the full walk's", () => {
    const root = tree();
    const cache = new FingerprintCache();
    const same = () => expect(cache.print(root)).toBe(fingerprint(root));
    cache.print(root);
    const steps: [string, () => void][] = [
      ["an edit in place", () => writeFileSync(join(root, "a/b/two.ts"), "// edited, and longer")],
      ["a new file in a nested folder", () => writeFileSync(join(root, "a/b/new.ts"), "x")],
      ["a new folder", () => { mkdirSync(join(root, "d/e"), { recursive: true }); writeFileSync(join(root, "d/e/f.ts"), "x"); }],
      ["a file in the folder just made", () => writeFileSync(join(root, "d/e/g.ts"), "x")],
      ["a rename", () => renameSync(join(root, "c/three.ts"), join(root, "c/four.ts"))],
      ["a file taken away", () => rmSync(join(root, "a/one.ts"))],
      ["a folder taken away", () => rmSync(join(root, "d"), { recursive: true })],
      ["a link", () => symlinkSync(join(root, "clover.json"), join(root, "a/link"))],
    ];
    for (const [what, act] of steps) {
      const before = cache.print(root);
      act();
      const after = cache.print(root);
      expect(after, what).not.toBe(before);
      same();
    }
  });

  test("a file put into a folder whose modification time is set back is still seen (the change time can't be)", () => {
    const root = tree();
    const cache = new FingerprintCache();
    const dir = join(root, "a");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(dir, old, old);
    const before = cache.print(root);
    writeFileSync(join(dir, "sneaked.ts"), "x");
    utimesSync(dir, old, old);
    expect(cache.print(root)).not.toBe(before);
    expect(cache.print(root)).toBe(fingerprint(root));
  });

  test("a folder that isn't there yet is seen when it comes, and one that goes is seen going", () => {
    const parent = mkdtempSync(join(tmpdir(), "clover-fp-"));
    const folder = join(parent, "later");
    const cache = new FingerprintCache();
    expect(cache.print(folder)).toBe("");
    expect(cache.print(folder)).toBe("");
    mkdirSync(folder);
    writeFileSync(join(folder, "clover.json"), "{}");
    expect(cache.print(folder)).toContain("clover.json");
    rmSync(folder, { recursive: true });
    expect(cache.print(folder)).toBe("");
  });
});
