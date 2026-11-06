// The caller check's OS floor (spec §3.1). A connection may count as the user or the app only if it
// runs OUTSIDE every sandbox and escape floor; otherwise it is fenced and can never be the user,
// however its process tree looks — a bot's command that leaves Bash's sandbox still runs under the
// escape floor, which a process-tree check alone would miss. This module is the pure policy: given
// a probe of the peer process, it says whether that peer is outside the floor. `caller-probe.ts`
// reads the peer and probes it; mapping the verdict onto a protocol caller (user vs session vs peer)
// layers on top of B's roles. Denying `/proc/<pid>/fd` on Linux and process access on Windows is M2.
import type { DaemonPlatform } from "./transport";

/** What the per-OS probe reports about the peer process. A field is `undefined` when the probe
 *  could not determine it; the policy then fails closed (fenced), never guessing the caller safe. */
export interface SandboxProbe {
  /** macOS: the peer is in an App Sandbox / Seatbelt container (the inherited `sandbox-exec` fence). */
  readonly sandboxedMac?: boolean;
  /** Linux: the peer is in the host's namespaces — not a bubblewrap / user-namespace sandbox. */
  readonly inHostNamespacesLinux?: boolean;
  /** Windows: the peer's token is restricted (`IsTokenRestricted`). */
  readonly tokenRestrictedWin?: boolean;
  /** Windows: the peer runs in an AppContainer. */
  readonly appContainerWin?: boolean;
}

/** `outside-floor`: the peer is outside every sandbox and escape floor, so it MAY count as the user
 *  or the app (the role and token still decide which). `fenced`: it is inside a sandbox or escape
 *  floor, or the probe was inconclusive, so it is never the user — a bot, agent or plugin command. */
export type FloorVerdict = "outside-floor" | "fenced";

/** The §3.1 rule, per OS. Fails closed: any required signal missing → `fenced`. */
export function callerFloorVerdict(os: DaemonPlatform, probe: SandboxProbe): FloorVerdict {
  switch (os) {
    case "darwin":
      // Not sandboxed. Unknown sandbox state is treated as sandboxed (fail closed).
      return probe.sandboxedMac === false ? "outside-floor" : "fenced";
    case "linux":
      // In the host's namespaces. Unknown is treated as sandboxed (fail closed).
      return probe.inHostNamespacesLinux === true ? "outside-floor" : "fenced";
    case "win32":
      // Neither a restricted token nor an AppContainer. Either unknown → fail closed.
      return probe.tokenRestrictedWin === false && probe.appContainerWin === false ? "outside-floor" : "fenced";
  }
}

/** Whether a floor verdict permits counting the caller as the user or the app. */
export function mayBeUser(verdict: FloorVerdict): boolean {
  return verdict === "outside-floor";
}
