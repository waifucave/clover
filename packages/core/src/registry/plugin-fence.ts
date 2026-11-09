// The plugin-process fence (B-M2's 2f; spec §5.2, §9.1): on macOS every process that runs a plugin's code (a plugin-host
// process, a supervised host, a hook's command, a plugin's stdio MCP server) runs under a Seatbelt profile that keeps it
// to its own plugin. The load guard (`plugin-run.ts`) holds which code a Bun process loads; this holds what any process
// a plugin starts can read, write and ask the system for.
//
// What a fenced process can't reach:
// * the Clover home (`<home>/**`): the run folder (the app's token, the socket, every run file but its own), the other
//   plugins' folders and data, the bots, the session transcripts, the settings, the secrets file, the logs;
// * the user's home, but the folders its kind of process is given (`tools` below);
// * the Keychain: its files (`~/Library/Keychains`) and the security daemon's services, so no item is read through
//   `security` or the Security framework (measured on macOS 26: with `com.apple.SecurityServer` denied, a keychain
//   item that a plain process reads is "not found");
// * launchd and the services that start programs for it (`LAUNCH_SERVICES_DENIES`, the same list the bot and dev
//   sandboxes deny, `sandbox.denyLaunchServices` in the agent runtime): `launchctl`, `open` and `osascript` don't run,
//   so a plugin can't have launchd start something outside the fence;
// * for a host process, any program but its Bun and its plugin's own files (`exec: "plugin"`).
//
// What it can: read its plugin's tree (and, for the `clover` process, the verified copy of the bundled plugins), read
// Clover's run files and shared packages that the guard loads, read and write its own data folder and its own temp
// folder (`<home>/run/plugin-tmp/<key>`, its TMPDIR), the network, and everything outside the user's and Clover's homes
// that the system leaves readable.
//
// Hooks and MCP servers (`tools: true`): a server started with `npx`, `uvx` or `bunx` needs its package manager's
// caches and installs, so those folders are readable and their caches writable, and any program may run (fenced the
// same way). Measured: denying exec outside the plugin's folder breaks every server started through a package runner.
//
// Linux and Windows: not fenced yet (Linux under bubblewrap comes next; Windows waits, the owner's priority).
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { PluginRunFiles } from "./plugin-run";

/** What the agent runtime's `sandbox.denyLaunchServices` denies (`@waifucave/clover-agent-runtime`'s
 *  `LAUNCH_SERVICES_DENIES`, not exported; a test holds this equal to the installed runtime's). */
export const LAUNCH_SERVICES_DENIES = {
  exec: ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"],
  services: [
    "com.apple.coreservices.launchservicesd",
    "com.apple.lsd.mapdb",
    "com.apple.lsd.modifydb",
    "com.apple.xpc.smd",
    "com.apple.backgroundtaskmanagementagent",
    "com.apple.backgroundtaskmanagement.agent",
    "com.apple.coreservices.appleevents",
    "com.apple.coreservices.quarantine-resolver",
  ],
} as const;

/** The resolver's services: a plugin resolves no name itself; its proxy does (2g). */
export const DNS_SERVICES: readonly string[] = ["com.apple.mDNSResponder", "com.apple.mDNSResponderHelper", "com.apple.dnssd.service"];

/** The security daemon's services: the Keychain's way in, for `security` and the Security framework alike. */
export const KEYCHAIN_SERVICES: readonly string[] = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.securityd.xpc", "com.apple.security.agent", "com.apple.security.authhost"];

/** The user's folders a hook or MCP server may read (package managers' installs and caches), and of them the caches it
 *  may write. Relative to the user's home. */
export const TOOL_READ_DIRS: readonly string[] = [
  ".npm", ".npmrc", ".nvm", ".volta", ".asdf", ".pyenv", ".rbenv", ".cargo", ".rustup", ".bun", ".deno", ".local/bin", ".local/share/uv",
  ".local/share/pnpm", ".cache", "Library/Caches", "Library/pnpm", ".config/uv", ".gitconfig",
];
export const TOOL_WRITE_DIRS: readonly string[] = [".npm", ".cache", "Library/Caches", ".local/share/uv", ".bun/install/cache", ".local/share/pnpm", "Library/pnpm"];

export interface PluginFenceInput {
  /** The Clover home: denied whole, but what `read` and `write` name. */
  cloverHome: string;
  /** The user's home: denied whole, but what `read`, `write` and `tools` give. */
  userHome: string;
  /** Folders and files it reads (its plugin's tree, the run files, the shared packages, its Bun). */
  read: readonly string[];
  /** Folders it reads and writes (its data folder, its temp folder). */
  write: readonly string[];
  /** `plugin`: it runs only `execs` (its Bun) and its plugin's own files (`read`'s first folder). `any`: any program,
   *  fenced the same. */
  exec: "plugin" | "any";
  /** The programs an `exec: "plugin"` process may run besides its plugin's files. */
  execs?: readonly string[];
  /** A hook or MCP server: the package managers' folders (`TOOL_READ_DIRS`, `TOOL_WRITE_DIRS`). */
  tools?: boolean;
  /** False: it starts no process at all (a host process: its plugins' workers are threads, and it may run only its Bun),
   *  so nothing it starts can leave its process group (`setsid`), which Seatbelt has no rule for (#322's review, B1). */
  fork?: boolean;
  /** No native code from what it reads or writes (`file-map-executable` denied there): the clover process (B3). */
  noNativeCode?: boolean;
  /** Its way to the network (2g): its proxy's loopback port, the only address it may reach (`net-proxy.ts`), or
   *  `none`. Default `none`. Name resolution is the proxy's: no DNS of its own (UDP 53 and mDNS denied). */
  network?: { proxyPort: number } | "none";
  /** Unix sockets under the homes it may connect to (a supervised host's daemon socket); every other one there is
   *  denied. A file rule doesn't hold a socket's connect, only `network-outbound` does (measured). */
  sockets?: readonly string[];
}

/** A path as a literal inside an SBPL `#"…"` regex. */
const regexLiteral = (p: string): string => p.replace(/[\\^$.*+?()[\]{}|"]/g, (c) => `\\${c}`);
/** Escapes a path for an SBPL string. */
const sbpl = (p: string): string => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** A path as the kernel sees it: its real path when it exists (`/var` is `/private/var`), else as given, resolved. */
export function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
const paths = (ps: readonly string[]): string[] => [...new Set(ps.flatMap((p) => {
  const real = realOrResolved(p);
  const plain = resolve(p);
  return real === plain ? [real] : [real, plain];
}))];
const subpaths = (ps: readonly string[]) => paths(ps).map((p) => `(subpath "${sbpl(p)}")`).join(" ");

/** The folders above each of `ps` that sit inside one of `roots` (each root included), real and as given. */
function ancestorsWithin(ps: readonly string[], roots: readonly string[]): string[] {
  const rs = paths(roots);
  const out = new Set<string>();
  for (const p of paths(ps)) {
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) {
      if (rs.some((r) => d === r || d.startsWith(r.endsWith(sep) ? r : r + sep))) out.add(d);
    }
  }
  return [...out];
}

/** The Seatbelt profile for one fenced process. Later rules win over earlier ones (measured): the homes are denied
 *  first, then what the process is given is allowed back, then what no process gets is denied last. */
export function pluginFenceProfile(i: PluginFenceInput): string {
  const user = i.userHome;
  const read = [...i.read, ...(i.execs ?? []), ...(i.tools ? TOOL_READ_DIRS.map((d) => join(user, d)) : [])];
  const write = [...i.write, ...(i.tools ? TOOL_WRITE_DIRS.map((d) => join(user, d)) : [])];
  const lines = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* ${subpaths([user, i.cloverHome])})`,
    // The folders above what it's given, by metadata only (a stat, never a listing or a file's contents): a path is
    // resolved component by component, so a real path through a denied folder fails without it (measured).
    ...ancestorsWithin([...read, ...write], [user, i.cloverHome]).map((a) => `(allow file-read-metadata (literal "${sbpl(a)}"))`),
    `(allow file-read* ${subpaths(read)})`,
    `(allow file-read* file-write* ${subpaths(write)})`,
    // Never, whatever was allowed above: the Keychain's files and every way in to launchd.
    `(deny file-read* file-write* ${subpaths([join(user, "Library", "Keychains")])})`,
    `(deny mach-lookup ${[...KEYCHAIN_SERVICES, ...LAUNCH_SERVICES_DENIES.services].map((s) => `(global-name "${sbpl(s)}")`).join(" ")})`,
    // No network but its proxy (2g): every outbound address and socket denied (the daemon's among them: connect isn't
    // a file read), the proxy's loopback port allowed back, and no DNS of its own.
    "(deny network-outbound)",
    ...(i.network !== undefined && i.network !== "none" ? [`(allow network-outbound (remote ip "localhost:${Math.trunc(i.network.proxyPort)}"))`] : []),
    `(deny mach-lookup ${DNS_SERVICES.map((s) => `(global-name "${sbpl(s)}")`).join(" ")})`,
    ...((i.sockets ?? []).length > 0 ? [`(allow network-outbound ${paths(i.sockets!).map((p) => `(remote unix-socket (path-literal "${sbpl(p)}"))`).join(" ")})`] : []),
  ];
  if (i.exec === "plugin") {
    const own = i.read[0];
    lines.push("(deny process-exec*)");
    lines.push(`(allow process-exec ${[...paths(i.execs ?? []).map((p) => `(literal "${sbpl(p)}")`), ...(own !== undefined ? [subpaths([own])] : [])].join(" ")})`);
  }
  if (i.fork === false) lines.push("(deny process-fork)");
  if (i.noNativeCode) lines.push(`(deny file-map-executable ${subpaths([...i.read.slice(0, 1), ...i.write])})`);
  lines.push(`(deny process-exec ${LAUNCH_SERVICES_DENIES.exec.map((p) => `(literal "${sbpl(p)}")`).join(" ")})`);
  return `${lines.join("\n")}\n`;
}

/** Whether this computer fences plugin processes: macOS with `sandbox-exec`. */
export function pluginFenceAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

/** `cmd` under the fence where there is one; as it is elsewhere. */
export function fencedCommand(cmd: readonly string[], fence: PluginFenceInput | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (fence === undefined || !pluginFenceAvailable(platform)) return [...cmd];
  return ["/usr/bin/sandbox-exec", "-p", pluginFenceProfile(fence), ...cmd];
}

/** Where a plugin's data folder and a fenced process's temp folder are (`<home>/plugin-data/<top>`, made on first
 *  use; `<home>/run/plugin-tmp/<name>`). A plugin id that isn't one gets none. */
export function fenceFolders(cloverHome: string, pluginId: string | undefined, name: string): { data?: string; tmp: string } {
  const tmp = join(cloverHome, "run", "plugin-tmp", name.replace(/[^a-z0-9-]/gi, "_").slice(0, 120));
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const top = pluginId?.split("/")[0];
  if (top === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(top)) return { tmp };
  const data = join(cloverHome, "plugin-data", top);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  return { data, tmp };
}

/** The fence for a plugin's hook command or stdio MCP server: its plugin's tree, Clover's run files and shared
 *  packages and its Bun to read; its data and temp folders to write; the package managers' folders (`tools`); any
 *  program, fenced the same. Returns the temp folder for its TMPDIR. */
export function toolFence(o: { files: Pick<PluginRunFiles, "guard" | "bin" | "cloverHome">; shared?: readonly string[]; pluginRoot: string; pluginId?: string; userHome?: string; name: string; proxyPort?: number }): { fence: PluginFenceInput; tmp: string } {
  const { data, tmp } = fenceFolders(o.files.cloverHome, o.pluginId, o.name);
  return {
    tmp,
    fence: {
      cloverHome: o.files.cloverHome, userHome: o.userHome ?? homedir(),
      read: [o.pluginRoot, dirname(o.files.guard), ...(o.shared ?? []), realOrResolved(join(o.files.bin, process.platform === "win32" ? "bun.exe" : "bun"))],
      write: [...(data !== undefined ? [data] : []), tmp], exec: "any", tools: true,
      network: o.proxyPort !== undefined ? { proxyPort: o.proxyPort } : "none",
    },
  };
}
