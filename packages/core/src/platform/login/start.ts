// Starting the daemon through the OS (spec §3.1: "each starts the other through the OS"), never as the
// caller's child, so the daemon outlives the app or the CLI that started it and the OS restarts it
// after a crash:
//   macOS:   launchctl kickstart gui/<uid>/<label>; if the job isn't loaded (login start off, or after
//            a bootout), launchctl bootstrap from the login item or the parked plist
//   Linux:   systemctl --user start clover-core.service
//   Windows: schtasks /Run /TN \Clover\clover-core
// The app's side calls this as `clover-core daemon start` when no daemon answers, and so does the CLI.
import { existsSync } from "node:fs";
import { launchdPlistToLoad } from "./manager";
import { launchdDomain, type Runner } from "./live";
import { loginLabel, loginUnitPath, schtasksTaskName, systemdUnitName, type LoginSpec } from "./render";

export type DaemonStartResult = "started" | "not-installed" | "failed";

export async function startDaemonThroughOs(spec: LoginSpec, run: Runner): Promise<DaemonStartResult> {
  if (spec.os === "darwin") {
    const domain = await launchdDomain(run);
    if ((await run(["launchctl", "kickstart", `${domain}/${loginLabel(spec.profile)}`])).ok) return "started";
    const plist = launchdPlistToLoad(spec);
    if (plist === null) return "not-installed";
    return (await run(["launchctl", "bootstrap", domain, plist])).ok ? "started" : "failed";
  }
  if (spec.os === "linux") {
    if ((await run(["systemctl", "--user", "start", systemdUnitName(spec.profile)])).ok) return "started";
    const unit = loginUnitPath(spec);
    return unit !== null && existsSync(unit) ? "failed" : "not-installed";
  }
  if ((await run(["schtasks", "/Run", "/TN", schtasksTaskName(spec.profile)])).ok) return "started";
  return (await run(["schtasks", "/Query", "/TN", schtasksTaskName(spec.profile)])).ok ? "failed" : "not-installed";
}
