// M-M0: Clover imports nothing from an older install, on any home, until a later lane turns one import on
// HERE, in code, under its own review. Spec §12 retires the legacy migrations; the carry-over from the
// previous product (its settings and logins, C1) is a new import that gets its own switch when it is built.
//
// What each switch guards, all OFF:
//   home          Migration B: a legacy home (`legacy-names.ts`'s `LEGACY_HOME_DIR`, `LEGACY_DEV_HOME_DIR`) and its
//                      Keychain items (`LEGACY_KEYCHAIN_SERVICE[_DEV]`) copied into a pristine home by `clover migrate
//                      --from` and `--resume`. A daemon boot never runs it outside a test's seam (C0 review S2), and
//                      `clover doctor` never looks at a legacy home, so neither needs this switch.
//   launchdAgent  the teardown of the pre-profiles launchd agent (`LEGACY_LAUNCHD_LABEL`, `cli/src/launchd.ts`).
//   projectFiles  a project's unconverted legacy instructions file and project dir, read when the Clover-named ones
//                      are absent: the default of `legacy.readLegacyProjectFiles` (settings.ts). `clover migrate-project`,
//                      which a user runs on a project by hand, is not an import into a home and is not switched.
//
// The legacy items themselves stay untouched as the rollback source: with a switch off, nothing reads, moves, copies or
// deletes them. Tests still drive the machinery through explicit seams with their own throwaway legacy homes and stores
// (`startDaemon({ migration })`, `runMigrateCommand({ legacyImports })`, `migrateFromLaunchdAgent({ enabled })`) —
// never through these switches.
export const LEGACY_IMPORTS = {
  home: false,
  launchdAgent: false,
  projectFiles: false,
} satisfies Record<string, boolean>;

export type LegacyImport = keyof typeof LEGACY_IMPORTS;

export function legacyImportOn(kind: LegacyImport): boolean {
  return LEGACY_IMPORTS[kind];
}

/** The one line every refusal and every skipped probe prints, so the advice is the same everywhere. */
export const LEGACY_IMPORTS_OFF =
  "Clover imports nothing from a legacy install (spec §12 retires the legacy migrations); the legacy items stay untouched";
