// What Clover's installers do with the daemon's login start (spec §3.1, plan §4 M1). Lane C's command (C-M1)
// writes and removes the launchd agent, the systemd user unit and the Task Scheduler task, each running
// `clover-core supervise`; an installer only ever calls that command, never launchctl, systemctl or schtasks itself.
// This file is the one place that names it, and `packaging.test.ts` checks every installer's hook against it.
//
// Who turns login start ON: the app, at its first launch (spec §3.1: "On first launch the app installs the matching
// clover-core and its login item"), on every OS. An installer can't do it everywhere: a deb or rpm script runs as
// root, outside the user's systemd session, and a dmg has no script at all. So the installers only turn it OFF, on
// an uninstall that is not an upgrade, from the installed binary, as the user. The deb and rpm can't reach a user's
// unit either; there the unit itself must stay inert once its binary is gone (a question for lane C).

/** The daemon's login-start command, lane C's: `clover-core autostart enable|disable|status`. */
export const AUTOSTART_SUBCOMMAND = "autostart";
export type AutostartAction = "enable" | "disable" | "status";

/** The arguments that run it. */
export function autostartArgs(action: AutostartAction): string[] {
  return [AUTOSTART_SUBCOMMAND, action];
}

export type Installer = "homebrew" | "dmg" | "nsis" | "winget" | "deb" | "rpm" | "appimage";

/** Where each installer leaves the daemon binary, as its own script spells it. */
export const INSTALLED_DAEMON: Readonly<Record<Installer, string>> = {
  homebrew: "#{appdir}/Clover.app/Contents/Resources/daemon/clover-core",
  dmg: "/Applications/Clover.app/Contents/Resources/daemon/clover-core",
  nsis: "$INSTDIR\\resources\\daemon\\clover-core.exe",
  winget: "$INSTDIR\\resources\\daemon\\clover-core.exe", // winget runs the NSIS installer
  deb: "/opt/Clover/resources/daemon/clover-core",
  rpm: "/opt/Clover/resources/daemon/clover-core",
  appimage: "(inside the AppImage; the app copies it out, spec §3.1)",
};

export interface InstallerHook {
  /** What the installer runs on install, if anything. */
  readonly onInstall: AutostartAction | null;
  /** What it runs on an uninstall that is not an upgrade. */
  readonly onUninstall: AutostartAction | null;
  /** Where the hook lives. */
  readonly file: string | null;
  readonly why: string;
}

export const INSTALLER_HOOKS: Readonly<Record<Installer, InstallerHook>> = {
  homebrew: { onInstall: null, onUninstall: "disable", file: "packaging/clover.rb.tmpl", why: "the cask's uninstall runs as the user, before the app is removed" },
  dmg: { onInstall: null, onUninstall: null, file: null, why: "a dmg has no scripts: the app turns login start on at first launch, and Homebrew's uninstall (or the app's own) turns it off" },
  nsis: { onInstall: null, onUninstall: "disable", file: "packaging/windows/installer.nsh", why: "a per-user installer runs as the user; an upgrade runs the old uninstaller with --updated, which keeps login start" },
  winget: { onInstall: null, onUninstall: null, file: null, why: "winget runs the NSIS installer and its uninstaller, which carry the hooks" },
  deb: { onInstall: null, onUninstall: null, file: "packaging/linux/after-remove.sh", why: "maintainer scripts run as root, outside every user's systemd session, so they can't reach a user unit" },
  rpm: { onInstall: null, onUninstall: null, file: "packaging/linux/after-remove.sh", why: "as for the deb" },
  appimage: { onInstall: null, onUninstall: null, file: null, why: "an AppImage has no installer: the app copies the daemon out and turns login start on (spec §3.1)" },
};
