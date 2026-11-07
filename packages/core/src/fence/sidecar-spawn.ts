// The link sidecar under the fence (C-M3 item 4; lane H's `SidecarWireOptions.spawn`, links/sidecar-wire.ts). The
// sidecar holds the device's key (sent over its stdin) and talks to the network; it needs its pipes, the network and
// the system's own libraries, and nothing of the user's or Clover's files.
//   * macOS: Seatbelt (`sandbox-exec`), deny by default: the system's base rules (`system.sb`: dyld, the shared
//     cache, the OS's own reads), running only its own binary, reading only that binary, the network (QUIC over UDP,
//     the relays over TCP), and the system services name lookup and certificate checks use. No file is writable and
//     nothing under the user's home or the Clover home is readable.
//   * Linux: bubblewrap. The root is bound read-only, every home (`/home`, `/root`, the user's home wherever it is)
//     and `/run/user` (the session's sockets) are empty tmpfs mounts, `/tmp` is a fresh tmpfs, with its own pid, IPC and
//     UTS namespaces, no capabilities, a new session and dying with the daemon. The network stays the host's.
//     Without bwrap at a system location the sidecar isn't started (the links say so); it never runs unfenced.
//   * Windows: until Bash's sandbox principal lands (#207, after C-M2 part 2), when the sidecar moves under it as part
//     of C-M3: a restricted token at low integrity in a kill-on-close Job Object (fence/windows-sidecar.ts), with
//     `sidecarEnv`. Links stay on (the controller's ruling: one user's processes have no boundary between them).
// The binary is the one beside the daemon (`bundledLinkBinary`, after links), never one from the environment in a
// release build (`linkSidecarBinary`, ipc/device-links.ts).
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSidecar, type SidecarProcess } from "../links/sidecar-wire";
import { reducedSidecarSpawn } from "./windows-sidecar";

/** Where bubblewrap may be: system locations only, never the PATH. */
export const BWRAP_PATHS: readonly string[] = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A string as an SBPL literal. */
function sbplString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The Mach services name resolution, network configuration and certificate checks use. */
const SIDECAR_MACH_SERVICES: readonly string[] = [
  "com.apple.SystemConfiguration.configd",
  "com.apple.SystemConfiguration.DNSConfiguration",
  "com.apple.dnssd.service",
  "com.apple.mDNSResponder",
  "com.apple.networkd",
  "com.apple.nehelper",
  "com.apple.symptomsd",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.ocspd",
  "com.apple.logd",
  "com.apple.diagnosticd",
];

/** The Seatbelt profile the sidecar runs under on macOS. `hidden` (the user's home, which holds the Clover home)
 *  can't even be listed or stat'ed, whatever the rules before say; only the binary itself, wherever it is, is read. */
export function sidecarSeatbeltProfile(binary: string, hidden: readonly string[] = [homedir()]): string {
  const bin = sbplString(binary);
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow file-read-metadata)",
    "(allow file-read* (subpath \"/usr/lib\") (subpath \"/usr/share\") (subpath \"/System\") (subpath \"/Library/Preferences\")",
    "  (subpath \"/private/etc\") (subpath \"/private/var/db/timezone\") (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/null\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
    "(allow sysctl-read)",
    "(allow system-socket)",
    "(allow network*)",
    `(allow mach-lookup ${SIDECAR_MACH_SERVICES.map((n) => `(global-name ${sbplString(n)})`).join(" ")})`,
    "(allow ipc-posix-shm-read-data (ipc-posix-name \"apple.shm.notification_center\"))",
    ...hidden.filter((h) => h !== "" && h !== "/").map((h) => `(deny file-read* file-write* (subpath ${sbplString(h)}))`),
    // Last, so a binary under a hidden folder (an app in ~/Applications, a dev build) still runs.
    `(allow process-exec (literal ${bin}))`,
    `(allow file-read* (literal ${bin}))`,
    "",
  ].join("\n");
}

/** The bubblewrap arguments the sidecar runs under on Linux (before `--` and its argv). */
export function sidecarBwrapArgs(userHome: string, exists: (p: string) => boolean = existsSync): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  const hidden = new Set<string>();
  for (const p of ["/home", "/root", "/run/user", userHome]) if (p !== "" && p !== "/" && exists(p)) hidden.add(p);
  for (const p of hidden) args.push("--tmpfs", p);
  args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--cap-drop", "ALL", "--new-session", "--die-with-parent");
  return args;
}

export interface FencedSidecarOptions {
  platform?: NodeJS.Platform;
  /** The user's home, hidden from it. */
  userHome?: string;
  onLog?(line: string): void;
  /** Tests: where bwrap is looked for, and the spawn under the wrapper. */
  bwrapPaths?: readonly string[];
  spawn?(argv: readonly string[], onLog?: (line: string) => void): SidecarProcess;
}

/** Thrown where the sidecar can't run fenced: the links aren't started. */
export class SidecarFenceUnavailable extends Error {}

/** `SidecarWireOptions.spawn` for the daemon: the sidecar's argv under this OS's fence. */
export function fencedSidecarSpawn(o: FencedSidecarOptions = {}): (argv: readonly string[]) => SidecarProcess {
  const platform = o.platform ?? process.platform;
  const spawn = o.spawn ?? spawnSidecar;
  return (argv) => {
    const [binary, ...rest] = argv;
    if (binary === undefined) throw new SidecarFenceUnavailable("no sidecar to run");
    if (platform === "darwin") {
      let real: string;
      try { real = realpathSync(binary); } catch { throw new SidecarFenceUnavailable("the link sidecar isn't there"); }
      const hidden = [o.userHome ?? homedir()].flatMap((h) => { try { return [h, realpathSync(h)]; } catch { return [h]; } });
      return spawn([SANDBOX_EXEC, "-p", sidecarSeatbeltProfile(real, [...new Set(hidden)]), real, ...rest], o.onLog);
    }
    if (platform === "linux") {
      const bwrap = (o.bwrapPaths ?? BWRAP_PATHS).find((p) => existsSync(p));
      if (bwrap === undefined) throw new SidecarFenceUnavailable("bubblewrap (bwrap) isn't installed, so the link sidecar can't run fenced");
      return spawn([bwrap, ...sidecarBwrapArgs(o.userHome ?? homedir()), "--", binary, ...rest], o.onLog);
    }
    if (platform === "win32" && o.spawn === undefined) return reducedSidecarSpawn(o.onLog)(argv);
    return spawn(argv, o.onLog);
  };
}
