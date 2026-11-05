// M-M0: Clover imports nothing from a legacy install until a later lane turns an import on in
// `src/migration/legacy-imports.ts`. Turning one on means changing the first test below, in review. (A daemon boot's
// Migration B is covered in `daemon-migration-boot.test.ts`: it runs only through a test's seam.)
import { describe, expect, test } from "bun:test";
import { LEGACY_IMPORTS, legacyImportOn } from "../../src/migration/legacy-imports";
import { legacyProjectFilesReadEnabled, Settings } from "../../src/settings";

describe("legacy imports (M-M0)", () => {
  test("every switch is off", () => {
    expect(LEGACY_IMPORTS).toEqual({ home: false, launchdAgent: false, projectFiles: false });
    for (const kind of Object.keys(LEGACY_IMPORTS) as (keyof typeof LEGACY_IMPORTS)[]) expect(legacyImportOn(kind)).toBe(false);
  });

  test("a project's legacy files are not read unless the settings say so", () => {
    expect(legacyProjectFilesReadEnabled(undefined)).toBe(false);
    expect(legacyProjectFilesReadEnabled(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/x" } }))).toBe(false);
    expect(legacyProjectFilesReadEnabled(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/x" }, legacy: {} }))).toBe(false);
    expect(legacyProjectFilesReadEnabled(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/x" }, legacy: { readLegacyProjectFiles: true } }))).toBe(true);
    expect(legacyProjectFilesReadEnabled(Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/x" }, legacy: { readLegacyProjectFiles: false } }))).toBe(false);
  });
});
