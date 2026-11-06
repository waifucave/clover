import { join } from "node:path";
import { homedir } from "node:os";
import { unlinkSync, existsSync } from "node:fs";
import { LEGACY_LAUNCHD_LABEL, legacyImportOn, loginLabel, resolveCloverProfile, type CloverProfile } from "@waifucave/clover-core";

// C-M1 retired this file's LaunchAgent installer (`installDaemon`, `uninstallDaemon`, `daemonStatus`,
// `renderPlist`, `plistPath`): it ran `daemon run` under `KeepAlive true`, which restarted a daemon the
// user had quit. Login start is now core's cross-OS `platform/login/` behind `clover autostart
// enable|disable|status` (a crash-only unit running `clover-core supervise`); `clover daemon
// install|uninstall|status` forward to it. What stays: the profile label and the teardown of the
// historical pre-rename agent.

/** The LaunchAgent label for a profile: core's `loginLabel`, resolved at call time. */
export function launchdLabel(profile: CloverProfile = resolveCloverProfile()): string {
  return loginLabel(profile);
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
  return { ok: (await proc.exited) === 0, out };
}

/** Injectable seams for `migrateFromLaunchdAgent` — real filesystem/launchctl by default, fakes in
 * tests. Never touches a real user's home directory or launchd from a test process. */
export interface MigrateLaunchdDeps {
  /** M-M0: whether to run at all. Absent: `migration/legacy-imports.ts`'s `launchdAgent` (off), so the
   *  legacy agent and its plist stay untouched. A test passes `true` with its fakes. */
  enabled?: boolean;
  plistPath?: string;
  exists?: (path: string) => boolean;
  remove?: (path: string) => void;
  bootout?: (label: string) => Promise<void>;
}

/** Lifecycle T4: tears down the HISTORICAL `LEGACY_LAUNCHD_LABEL` KeepAlive launchd agent — a
 * pre-profiles, pre-rename install that predates BOTH the dev/dist profile split and this app's own
 * `DaemonSupervisor` embedding clover-core directly. A leftover `KeepAlive` agent would otherwise
 * relaunch a daemon the app just killed, defeating the app↔daemon lifecycle coupling entirely — so
 * this must run before/at app-driven daemon supervision starts. No-op if the plist was never
 * installed (fresh installs, or a machine already migrated). NEVER throws: a failed bootout/unlink
 * (e.g. permissions, already gone) must not block the app from starting.
 *
 * `LEGACY_LAUNCHD_LABEL` (`legacy-names.ts`, P9b-6) names the OLD pre-rename install — NOT today's
 * CURRENT dist label (`launchdLabel("dist")`). The rename made those two strings different again
 * after the mechanical pass briefly collapsed them onto the same literal; this teardown must keep
 * targeting the pre-rename install regardless, mirroring the Swift `LaunchdMigrationDeps.live`
 * hardcoding the same historical literal independently. */
export async function migrateFromLaunchdAgent(deps: MigrateLaunchdDeps = {}): Promise<void> {
  if (!(deps.enabled ?? legacyImportOn("launchdAgent"))) return;
  // Deliberately NOT `plistPath()` — that resolves the CURRENT profile's label/path, but this
  // teardown targets the historical pre-rename agent, which predates profiles and was always filed
  // under the literal `LEGACY_LAUNCHD_LABEL` regardless of what profile (or product name) is
  // running today.
  const path = deps.plistPath ?? join(homedir(), "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`);
  const exists = deps.exists ?? existsSync;
  const remove = deps.remove ?? unlinkSync;
  const bootout = deps.bootout ?? (async (label: string) => {
    await launchctl("bootout", `gui/${process.getuid!()}/${label}`);
  });
  try {
    if (!exists(path)) return; // never installed (or already migrated) — nothing to do
    await bootout(LEGACY_LAUNCHD_LABEL);
    remove(path);
  } catch (error) {
    console.error(`[launchd] migrateFromLaunchdAgent failed (non-fatal): ${error}`);
  }
}
