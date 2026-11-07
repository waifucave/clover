// `clover-core server install [--channel latest|beta]` and `clover-core server uninstall` (plan §4 M-M2): the daemon
// alone on a computer with no app (a server, a cloud computer), started by the OS and updating itself.
//
// `install` copies this binary to `<home>/bin/clover-core` (the one place a server's binary lives, which its own update
// replaces), registers lane C's login start for it (`loginEnable`: the same LaunchAgent on macOS, systemd user unit on
// Linux and per-user Task Scheduler task at logon on Windows that `clover-core autostart` writes, each running
// `clover-core supervise`), on Linux turns lingering on (`loginctl enable-linger`) so the unit runs with no one logged
// in, and writes `<home>/install.json` `{ kind: "server" }`, the marker that lets the daemon update itself. A binary
// inside an app (`…/resources/daemon/`) is refused: the app updates that one.
//
// `uninstall` stops the daemon cleanly, removes the login start, turns lingering off again if install turned it on,
// and removes the marker and the binaries. On Windows the binary running the uninstall can't delete itself, and says so.
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InstallChannel, InstallMarker, LoginOsDeps, LoginSpec, Runner } from "@waifucave/clover-core";

export const SERVER_USAGE = "usage: clover-core server install [--channel latest|beta] | server uninstall";

/** Where a server install keeps its binary. */
export function serverBinary(home: string, os: LoginSpec["os"]): string {
  return join(home, "bin", os === "win32" ? "clover-core.exe" : "clover-core");
}

/** Whether `bin` is the daemon inside an app (`Clover.app/Contents/Resources/daemon/`, `resources/daemon/`). */
export function insideApp(bin: string): boolean {
  return basename(dirname(bin)) === "daemon" && basename(dirname(dirname(bin))).toLowerCase() === "resources";
}

export function parseServerArgs(argv: readonly string[]): { action: "install"; channel: InstallChannel } | { action: "uninstall" } {
  const [action, ...rest] = argv;
  if (action === "uninstall" && rest.length === 0) return { action };
  if (action !== "install") throw new Error(SERVER_USAGE);
  let channel: InstallChannel = "latest";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = a === "--channel" ? rest[++i] : a.startsWith("--channel=") ? a.slice("--channel=".length) : undefined;
    if (v === "latest" || v === "beta") channel = v;
    else throw new Error(SERVER_USAGE);
  }
  return { action, channel };
}

export interface ServerDeps {
  /** The login spec for this home, with `bin` this process's binary. */
  spec: LoginSpec;
  os: LoginOsDeps;
  run: Runner;
  loginEnable(spec: LoginSpec, os: LoginOsDeps): Promise<{ registered: boolean; label: string }>;
  loginRemove(spec: LoginSpec, os: LoginOsDeps): Promise<unknown>;
  /** Stops a running daemon cleanly (`autostart remove`'s stop), for the binary to be free. */
  stopDaemon(spec: LoginSpec): Promise<string>;
  readMarker(home: string): InstallMarker | undefined;
  writeMarker(home: string, marker: InstallMarker): void;
  removeMarker(home: string): void;
  user: string | undefined;
  log(line: string): void;
}

const same = (a: string, b: string): boolean => {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  return real(a) === real(b);
};

export async function serverInstall(d: ServerDeps, channel: InstallChannel): Promise<number> {
  const { spec } = d;
  if (insideApp(spec.bin)) {
    d.log("server install: this clover-core is the app's, which updates it; a server install takes the clover-core-<version>-<target> release file");
    return 1;
  }
  const marker = d.readMarker(spec.home);
  if (marker !== undefined && marker.kind !== "server") {
    d.log(`server install: this home belongs to ${marker.kind === "app" ? "the app" : "a package"} (${join(spec.home, "install.json")})`);
    return 1;
  }
  const bin = serverBinary(spec.home, spec.os);
  if (!same(spec.bin, bin)) {
    mkdirSync(dirname(bin), { recursive: true });
    // A running server's binary is replaced by its own update, not here.
    if (existsSync(bin)) await d.stopDaemon({ ...spec, bin });
    copyFileSync(spec.bin, bin);
    if (spec.os !== "win32") chmodSync(bin, 0o755);
  }
  const served: LoginSpec = { ...spec, bin };
  let linger = marker?.linger ?? false;
  if (spec.os === "linux" && !linger && d.user !== undefined) {
    const shown = await d.run(["loginctl", "show-user", d.user, "--property=Linger", "--value"]);
    if (shown.out.trim() !== "yes") {
      const on = await d.run(["loginctl", "enable-linger", d.user]);
      if (!on.ok) d.log(`server install: loginctl enable-linger failed, so the daemon runs only while ${d.user} is logged in: ${on.out.trim().slice(0, 200)}`);
      linger = on.ok;
    }
  }
  d.writeMarker(spec.home, { kind: "server", channel, ...(linger ? { linger: true } : {}) });
  const st = await d.loginEnable(served, d.os);
  if (!st.registered) {
    d.log(`server install: the login start was written but the OS did not register it (${st.label})`);
    return 1;
  }
  d.log(`server install: clover-core at ${bin}, started by the OS (${st.label}), updating itself on ${channel}`);
  return 0;
}

export async function serverUninstall(d: ServerDeps): Promise<number> {
  const { spec } = d;
  const marker = d.readMarker(spec.home);
  if (marker?.kind !== "server") {
    d.log(`server uninstall: this home has no server install${marker === undefined ? "" : ` (it is ${marker.kind === "app" ? "the app's" : "a package's"})`}`);
    return 1;
  }
  const bin = serverBinary(spec.home, spec.os);
  const served: LoginSpec = { ...spec, bin };
  const stopped = await d.stopDaemon(served);
  await d.loginRemove(served, d.os);
  if (spec.os === "linux" && marker.linger === true && d.user !== undefined) {
    const off = await d.run(["loginctl", "disable-linger", d.user]);
    if (!off.ok) d.log(`server uninstall: loginctl disable-linger failed: ${off.out.trim().slice(0, 200)}`);
  }
  d.removeMarker(spec.home);
  let kept: string | undefined;
  for (const f of [`${bin}.new`, `${bin}.old`, `${bin}.bad`, bin]) {
    try {
      rmSync(f, { force: true });
    } catch {
      kept = f;
    }
  }
  d.log(`server uninstall: the daemon ${stopped}; login start and the marker removed${kept === undefined ? "" : `; ${kept} is in use and stays (delete it once this process ends)`}`);
  return 0;
}
