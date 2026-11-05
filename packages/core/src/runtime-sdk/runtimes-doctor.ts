// Winter Phase 8d — `clover doctor`'s "runtimes" section (Lane 1 fills; Lane 4 prints). Diagnoses
// where the `winter` executable resolves from (or the typed reason it does not) and, when the bundle
// carries them, the parsed runtimes record and `ant`'s own record.
//
// A-M1: NO SESSION RUNS THAT EXECUTABLE. Every session (code, dispatch, chat) runs the SDK embedded in
// `clover-core`, one Worker per session, so a missing or broken `winter` binary breaks no session. It
// is Winter's coding agent, kept for the ACP agent work (lane K); the report says so (`sessions`,
// `clover.usedBySessions`), so a doctor reader never takes an unresolved binary for a broken daemon. READ-ONLY: never spawns a runtime,
// never touches a store, safe beside a live daemon — every resolver this composes is itself
// pure/typed, and every remaining throw surface is caught here so a doctor run can NEVER crash
// `clover doctor`, only report an `error` string.
//
// WS-23: the official `claude` executable ladder and its diagnostics are gone with the leg.
import { existsSync, readFileSync } from "node:fs";
import { cloverOptionsFromSettings, type Settings } from "../settings";
import { bundleRuntimePath, parseAntVersionsJson, parseVersionsJson, type AntVersionsJson, type VersionsJson } from "./bundle-layout";
import { resolveWinterExecutable } from "./executable";

export interface RuntimesReport {
  /** A-M1: how sessions run. Always `"embedded"`: in `clover-core`, one Worker per session. */
  sessions: "embedded";
  /** The coding-agent executable. `usedBySessions` is always `false` (A-M1). */
  clover: { resolved?: { path: string; source: string }; error?: string; usedBySessions: false };
  /** `runtimes/VERSIONS.json` and `runtimes/ant/VERSIONS.json`, each present only when staged — a
   *  dev checkout has neither, which is a normal state, never an error. */
  bundle?: { versions?: VersionsJson; antVersions?: AntVersionsJson; error?: string };
}

/** `existsSync`, but a doctor run must never crash on a permissions error mid-stat. */
function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export async function diagnoseRuntimes(input: {
  execPath: string;
  home: string;
  env: Record<string, string | undefined>;
  settings: Settings | undefined;
  /** P9a fix wave (M1 collateral): test seam for the P9a-9 platform-package rung, threaded
   *  straight through to `resolveWinterExecutable`; defaults to its own default
   *  (`resolvePlatformPackageWinter`) — never a behaviour change for the real `clover doctor`
   *  route, which never sets this. */
  resolvePlatformPackageBin?: () => string | undefined;
}): Promise<RuntimesReport> {
  // The SAME settings door every real consumer reads (`create.ts`'s own
  // `cloverOptionsFromSettings(deps.settings()).winterExecutable`) — the doctor's "setting" rung must
  // be the identical value a live session would actually use, not a re-derived guess at
  // `settings.runtimes.*`.
  const options = cloverOptionsFromSettings(input.settings);

  // --- clover -----------------------------------------------------------------------------------
  const clover: RuntimesReport["clover"] = { usedBySessions: false };
  try {
    const resolution = resolveWinterExecutable({
      setting: options.winterExecutable,
      env: input.env,
      execPath: input.execPath,
      home: input.home,
      exists: safeExists,
      ...(input.resolvePlatformPackageBin === undefined ? {} : { resolvePlatformPackageBin: input.resolvePlatformPackageBin }),
    });
    if (resolution.ok) clover.resolved = { path: resolution.path, source: resolution.source };
    else clover.error = resolution.error.message;
  } catch (err) {
    // resolveWinterExecutable never throws by construction — this is belt-only, matching the
    // "never throws" contract this function promises regardless of what its composed pieces do.
    clover.error = err instanceof Error ? err.message : String(err);
  }

  // --- the bundle's records — independent of whether the clover ladder resolved via "bundle" (a
  // record that refuses on a pin mismatch is exactly the case a doctor reader most wants to see). ---
  const bundle: NonNullable<RuntimesReport["bundle"]> = {};
  const errors: string[] = [];
  const versionsPath = bundleRuntimePath(input.execPath, "versions");
  if (safeExists(versionsPath)) {
    try {
      bundle.versions = parseVersionsJson(readFileSync(versionsPath, "utf8"));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  const antVersionsPath = bundleRuntimePath(input.execPath, "antVersions");
  if (safeExists(antVersionsPath)) {
    try {
      bundle.antVersions = parseAntVersionsJson(readFileSync(antVersionsPath, "utf8"));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) bundle.error = errors.join("; ");

  const staged = bundle.versions !== undefined || bundle.antVersions !== undefined || bundle.error !== undefined;
  return { sessions: "embedded", clover, ...(staged ? { bundle } : {}) };
}
