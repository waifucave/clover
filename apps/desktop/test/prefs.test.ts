import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFS, readPrefs, writePrefs } from "../src/main/prefs";

const dir = mkdtempSync(join(tmpdir(), "clv-prefs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the app's own choices", () => {
  test("a missing, damaged or odd file reads as the defaults", () => {
    expect(readPrefs(join(dir, "none.json"))).toEqual(DEFAULT_PREFS);
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(readPrefs(join(dir, "bad.json"))).toEqual(DEFAULT_PREFS);
    writeFileSync(join(dir, "odd.json"), JSON.stringify({ pillHidden: "yes", fourFingerTap: 3 }));
    expect(readPrefs(join(dir, "odd.json"))).toEqual(DEFAULT_PREFS);
  });
  test("the pill put away is kept across a restart, and shown again is kept too", () => {
    const file = join(dir, "prefs.json");
    writePrefs(file, { ...DEFAULT_PREFS, pillHidden: true });
    expect(readPrefs(file).pillHidden).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).pillHidden).toBe(true);
    writePrefs(file, { ...readPrefs(file), pillHidden: false });
    expect(readPrefs(file).pillHidden).toBe(false);
  });
  test("a write that can't happen is logged, never thrown", () => {
    const lines: string[] = [];
    writePrefs(join(dir, "no-such-dir", "prefs.json"), DEFAULT_PREFS, (l) => lines.push(l));
    expect(lines[0]).toContain("prefs: not saved");
  });
});
