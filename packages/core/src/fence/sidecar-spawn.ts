// The link sidecar under the fence (C-M3 item 4; lane H's `SidecarWireOptions.spawn`, links/sidecar-wire.ts). The
// sidecar holds the device's key (sent over its stdin) and talks to the network; it needs its pipes, the network and
// the system's own libraries, and nothing of the user's or Clover's files.
//   * macOS: Seatbelt (`sandbox-exec`), deny by default: the system's base rules (`system.sb`: dyld, the shared
//     cache, the OS's own reads), running only its own binary, reading only that binary, the network (QUIC over UDP,
//     the relays over TCP), and the system services name lookup and certificate checks use. No file is writable and
//     nothing under the user's home or the Clover home is readable.
//   * Linux: bubblewrap. The root is bound read-only, every home (`/home`, `/root`, the user's home wherever it is)
//     and `/run/user` (the session's sockets) are empty tmpfs mounts, `/tmp` is a fresh tmpfs (the binary alone bound
//     back in, read-only, wherever it lives), with its own pid, IPC and
//     UTS namespaces, no capabilities, a new session and dying with the daemon. The network stays the host's.
//     Without bwrap at a system location the sidecar isn't started (the links say so); it never runs unfenced.
//   * Windows: until Bash's sandbox principal lands (#207, after C-M2 part 2), when the sidecar moves under it as part
//     of C-M3: a restricted token at low integrity in a kill-on-close Job Object (fence/windows-sidecar.ts), with
//     `sidecarEnv`. Links stay on (the controller's ruling: one user's processes have no boundary between them).
// The binary is the one beside the daemon (`bundledLinkBinary`, after links), never one from the environment in a
// release build (`linkSidecarBinary`, ipc/device-links.ts).
import { closeSync, existsSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeWriter, sidecarEnv, spawnSidecar, type SidecarProcess } from "../links/sidecar-wire";
import { unixSocketFilter } from "./seccomp";
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

/** The folders above `path`, each as a literal, `/` included: dyld and the runtime stat each step of the binary's path. */
function ancestors(path: string): string[] {
  const out: string[] = ["/"];
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}

/** The Seatbelt profile the sidecar runs under on macOS. `hidden` (the user's home and the Clover home, wherever they
 *  are) can't even be listed or stat'ed, whatever the rules before say; only the binary itself, wherever it is, is read.
 *  The network is IP only: outbound to remote IP addresses, binding and taking inbound on local UDP (QUIC), and the one
 *  Unix socket name lookup needs (mDNSResponder's); no other Unix socket, so nothing on the disk the user's processes
 *  listen on can be reached. Metadata reads only for the system's folders and the steps of its own path. */
export function sidecarSeatbeltProfile(binary: string, hidden: readonly string[] = [homedir()]): string {
  const bin = sbplString(binary);
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    `(allow file-read-metadata ${ancestors(binary).map((a) => `(literal ${sbplString(a)})`).join(" ")}`,
    "  (subpath \"/usr\") (subpath \"/System\") (subpath \"/Library\") (subpath \"/private/etc\") (subpath \"/private/var/db\")",
    "  (subpath \"/private/var/run\") (subpath \"/dev\") (literal \"/etc\") (literal \"/var\") (literal \"/private\") (literal \"/private/var\") (literal \"/tmp\"))",
    "(allow file-read* (subpath \"/usr/lib\") (subpath \"/usr/share\") (subpath \"/System\") (subpath \"/Library/Preferences\")",
    "  (subpath \"/private/etc\") (subpath \"/private/var/db/timezone\") (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/null\"))",
    "(allow file-write-data (literal \"/dev/null\"))",
    "(allow sysctl-read)",
    "(allow system-socket)",
    "(allow network-outbound (remote ip))",
    // Listening is QUIC's only: UDP. No TCP listener can be opened (measured on macOS 26: `nc -l` refused, `nc -u -l` taking).
    "(allow network-bind (local udp \"*:*\"))",
    "(allow network-inbound (local udp \"*:*\"))",
    "(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))",
    `(allow mach-lookup ${SIDECAR_MACH_SERVICES.map((n) => `(global-name ${sbplString(n)})`).join(" ")})`,
    "(allow ipc-posix-shm-read-data (ipc-posix-name \"apple.shm.notification_center\"))",
    ...hidden.filter((h) => h !== "" && h !== "/").map((h) => `(deny file-read* file-write* (subpath ${sbplString(h)}))`),
    // Last, so a binary under a hidden folder (an app in ~/Applications, a dev build, a server's <home>/bin) still runs.
    `(allow process-exec (literal ${bin}))`,
    `(allow file-read* (literal ${bin}))`,
    "",
  ].join("\n");
}

/** The bubblewrap arguments the sidecar runs under on Linux (before `--` and its argv). Every home, removable media and
 *  the Clover home (wherever it lives) are empty tmpfs mounts; the binary itself is bound back in, read-only, at its own
 *  path (a server keeps it in <home>/bin, an AppImage under /tmp). With `seccompFd`, the filter that makes Unix sockets
 *  and io_uring fail (`unixSocketFilter`): the sidecar keeps the host network for QUIC, so `--unshare-net` can't do
 *  that. `disableUserns`: bwrap 0.8 or later, so the sidecar can make no user namespace of its own. */
export function sidecarBwrapArgs(
  userHome: string, binary: string, exists: (p: string) => boolean = existsSync,
  o: { cloverHome?: string; seccompFd?: number; disableUserns?: boolean } = {},
): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  const hidden = new Set<string>();
  for (const p of ["/home", "/root", "/run/user", "/media", "/run/media", "/mnt", userHome, o.cloverHome ?? ""]) {
    if (p !== "" && p !== "/" && exists(p)) hidden.add(p);
  }
  for (const p of hidden) args.push("--tmpfs", p);
  args.push("--ro-bind", binary, binary);
  args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try");
  if (o.disableUserns) args.push("--unshare-user", "--disable-userns");
  args.push("--cap-drop", "ALL", "--new-session", "--die-with-parent");
  if (o.seccompFd !== undefined) args.push("--seccomp", String(o.seccompFd));
  return args;
}

/** Whether this bwrap takes `--disable-userns` (0.8.0 and later), asked once per binary. */
const usernsSupport = new Map<string, boolean>();
function bwrapDisablesUserns(bwrap: string): boolean {
  let known = usernsSupport.get(bwrap);
  if (known === undefined) {
    try { known = /--disable-userns/.test(Bun.spawnSync([bwrap, "--help"], { env: {} }).stdout.toString()); } catch { known = false; }
    usernsSupport.set(bwrap, known);
  }
  return known;
}

/** The sidecar under bwrap with the seccomp filter as its fd 3: the filter is written to a file only this start uses,
 *  opened, and the file removed at once (the open descriptor is what bwrap reads). */
function spawnUnderBwrap(argv: readonly string[], filter: Buffer, onLog?: (line: string) => void): SidecarProcess {
  const dir = mkdtempSync(join(tmpdir(), "clover-link-seccomp-"));
  const file = join(dir, "filter.bpf");
  writeFileSync(file, filter, { mode: 0o600 });
  const fd = openSync(file, "r");
  rmSync(dir, { recursive: true, force: true });
  try {
    const p = Bun.spawn([...argv], { stdio: ["pipe", "pipe", onLog ? "pipe" : "ignore", fd], env: sidecarEnv() });
    if (onLog && p.stderr) {
      void (async () => {
        let rest = "";
        const decoder = new TextDecoder();
        try {
          for await (const chunk of p.stderr as ReadableStream<Uint8Array>) {
            rest += decoder.decode(chunk, { stream: true });
            const lines = rest.split("\n");
            rest = lines.pop() ?? "";
            for (const line of lines) if (line.trim()) onLog(line.slice(0, 2000));
          }
        } catch { /* the pipe closed */ }
      })();
    }
    return { write: pipeWriter(p.stdin), stdout: p.stdout, kill: () => p.kill(), exited: p.exited, pid: p.pid };
  } finally {
    closeSync(fd);
  }
}

export interface FencedSidecarOptions {
  platform?: NodeJS.Platform;
  /** The user's home, hidden from it. */
  userHome?: string;
  /** The Clover home, hidden from it wherever it lives (`CLOVER_HOME` may be outside the user's home). */
  cloverHome?: string;
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
      const hidden = [o.userHome ?? homedir(), ...(o.cloverHome ? [o.cloverHome] : [])]
        .flatMap((h) => { try { return [h, realpathSync(h)]; } catch { return [h]; } });
      return spawn([SANDBOX_EXEC, "-p", sidecarSeatbeltProfile(real, [...new Set(hidden)]), real, ...rest], o.onLog);
    }
    if (platform === "linux") {
      const bwrap = (o.bwrapPaths ?? BWRAP_PATHS).find((p) => existsSync(p));
      if (bwrap === undefined) throw new SidecarFenceUnavailable("bubblewrap (bwrap) isn't installed, so the link sidecar can't run fenced");
      let real: string;
      try { real = realpathSync(binary); } catch { throw new SidecarFenceUnavailable("the link sidecar isn't there"); }
      const filter = unixSocketFilter();
      if (filter === null) throw new SidecarFenceUnavailable(`no seccomp filter for ${process.arch}, so the link sidecar can't run fenced`);
      const homes = (h: string | undefined) => (h === undefined ? undefined : (() => { try { return realpathSync(h); } catch { return h; } })());
      const args = sidecarBwrapArgs(homes(o.userHome ?? homedir())!, real, existsSync, {
        ...(o.cloverHome === undefined ? {} : { cloverHome: homes(o.cloverHome)! }), seccompFd: 3, disableUserns: bwrapDisablesUserns(bwrap),
      });
      const argv2 = [bwrap, ...args, "--", real, ...rest];
      return o.spawn ? o.spawn(argv2, o.onLog) : spawnUnderBwrap(argv2, filter, o.onLog);
    }
    if (platform === "win32" && o.spawn === undefined) return reducedSidecarSpawn(o.onLog)(argv);
    return spawn(argv, o.onLog);
  };
}
