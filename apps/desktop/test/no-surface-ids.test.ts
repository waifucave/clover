// F4 (the owner's ruling of 2026-11-15: no infrastructure in the core or the app that only one plugin uses): nothing in the app's
// main process or in the core names the island's or the pill's plugin. What they do, a plugin says in its manifest (`window`
// fields, `app.tray`) and holds as capabilities (`overlay`, `approvals.all`, `user.send`, `tray`); a copy of either under another id,
// behind its OK card, gets the same. The scan reads the sources, not the tests; the exemptions are the places that list the build's
// own plugins (the app's layer map and ids, which are not scanned here) and the safe-mode list (by top-level id, none of these two).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const IDS = /moss\/(island|pill)\b/;
/** Files allowed to name them: none today (the build's plugin list is `apps/desktop/src/layer/moss/index.ts`, outside the scan). */
const EXEMPT: readonly string[] = [];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: dir })) {
    if (/(^|\/)(tests?|__tests__|node_modules|fixtures)\//.test(f.replaceAll("\\", "/")) || /\.test\.tsx?$/.test(f)) continue;
    out.push(join(dir, f));
  }
  return out;
}

describe("no door names the island's or the pill's plugin", () => {
  for (const [what, dir] of [["the app's main process", "apps/desktop/src/main"], ["the core", "packages/core/src"]] as const) {
    test(what, () => {
      const files = sources(join(ROOT, dir));
      expect(files.length).toBeGreaterThan(20);
      const hits = files.filter((f) => !EXEMPT.includes(relative(ROOT, f))).flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => (IDS.test(line) ? `${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}` : "")).filter((x) => x !== ""));
      expect(hits).toEqual([]);
    });
  }
});
