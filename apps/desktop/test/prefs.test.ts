import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFS, readPrefs, withLegacyHidden, writePrefs } from "../src/main/prefs";

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
  test("the one mute over plugin sound is off unless turned on, and is kept across a restart", () => {
    const file = join(dir, "mute.json");
    expect(readPrefs(file).soundMuted).toBe(false);
    writePrefs(file, { ...DEFAULT_PREFS, soundMuted: true });
    expect(readPrefs(file).soundMuted).toBe(true);
  });
  test("surfaces put away are kept by ref; the old pillHidden applies once to the surface a tray toggle names, then clears", () => {
    const file = join(dir, "prefs2.json");
    writePrefs(file, { ...DEFAULT_PREFS, hiddenSurfaces: ["moss/pill#pill"] });
    expect(readPrefs(file).hiddenSurfaces).toEqual(["moss/pill#pill"]);
    // A file from before (only `pillHidden`) hides the surface that carries a toggle, whatever plugin that is, and no other.
    writeFileSync(join(dir, "old.json"), JSON.stringify({ pillHidden: true, fourFingerTap: true }));
    const old = readPrefs(join(dir, "old.json"));
    expect(old.hiddenSurfaces).toEqual([]);
    expect(withLegacyHidden(old, "some-pill#pill")).toMatchObject({ pillHidden: false, hiddenSurfaces: ["some-pill#pill"] });
    expect(withLegacyHidden(withLegacyHidden(old, "a#x"), "b#y").hiddenSurfaces).toEqual(["a#x"]); // the old switch is spent once
    expect(withLegacyHidden(DEFAULT_PREFS, "a#x")).toBe(DEFAULT_PREFS);
    writeFileSync(join(dir, "junk.json"), JSON.stringify({ hiddenSurfaces: ["ok#x", 3, null] }));
    expect(readPrefs(join(dir, "junk.json")).hiddenSurfaces).toEqual(["ok#x"]);
  });
  test("a write that can't happen is logged, never thrown", () => {
    const lines: string[] = [];
    writePrefs(join(dir, "no-such-dir", "prefs.json"), DEFAULT_PREFS, (l) => lines.push(l));
    expect(lines[0]).toContain("prefs: not saved");
  });
});
