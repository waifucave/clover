// `clover-core server install [--channel latest|beta]` and `clover-core server uninstall` (plan §4 M-M2): the daemon
// alone on a computer with no app (a server, a cloud computer), started by the OS and updating itself.
//
// `install` copies this binary to `<home>/bin/daemon/clover-core` (the one place a server's binary lives, which its own
// update replaces), puts plain Bun for plugins beside it (`<home>/bin/daemon/clover-plugin-bun`, plugin-bun-install.ts)
// and the bundled plugins this core's manifest names in `<home>/bin/plugins` (plugins-install.ts: the release's
// tarball, checked), the layout core's `bundledPluginsDir` reads as the app's `resources/daemon` and
// `resources/plugins`; registers lane C's login start for it (`loginEnable`: the same LaunchAgent on macOS, systemd user unit on
// Linux and per-user Task Scheduler task at logon on Windows that `clover-core autostart` writes, each running
// `clover-core supervise`), on Linux turns lingering on (`loginctl enable-linger`) so the unit runs with no one logged
// in, and writes `<home>/install.json` `{ kind: "server" }`, the marker that lets the daemon update itself. A binary
// inside an app (`…/resources/daemon/`) is refused: the app updates that one.
//
// `uninstall` stops the daemon cleanly, removes the login start, turns lingering off again if install turned it on,
// and removes the marker, the binaries and the bundled plugins. A home with the earlier layout (`<home>/bin/clover-core`
// and plugin Bun beside it) has those removed at install and uninstall. On Windows the binary running the uninstall can't delete itself, and says so.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { schtasksFallbackProblem, type InstallChannel, type InstallMarker, type LoginOsDeps, type LoginSpec, type Runner } from "@waifucave/clover-core";
import { homedir } from "node:os";
import { syncDir, syncFile } from "./durable";
import { serverPluginBun, type PluginBunResult } from "./plugin-bun-install";
import { badBinary, oldBinary } from "./self-update";
import { serverPluginsDir, type PluginsResult } from "./plugins-install";

export const SERVER_USAGE = "usage: clover-core server install [--channel latest|beta] | server uninstall";

/**
 * What server install says when the account logs on (Windows) with a profile other than this process's home: a
 * profile moved, or a session with another environment. Undefined when they are the same folder.
 */
export function profileNote(profile: string, home: string = homedir()): string | undefined {
  return profile.toLowerCase() === home.toLowerCase() ? undefined : `server install: this account logs on with its profile at ${profile}, not ${home}: the logon task uses ${profile}`;
}

/** Where a server install keeps its binary: `<home>/bin/daemon/`, with plain Bun for plugins beside it and the bundled
 *  plugins in `<home>/bin/plugins`. */
export function serverBinary(home: string, os: LoginSpec["os"]): string {
  return join(home, "bin", "daemon", os === "win32" ? "clover-core.exe" : "clover-core");
}

/** The earlier layout's files (`<home>/bin/clover-core`, plugin Bun beside it, and what their updates left). */
export function earlierLayoutFiles(home: string, os: LoginSpec["os"]): string[] {
  const exe = os === "win32" ? ".exe" : "";
  const core = join(home, "bin", `clover-core${exe}`), bun = join(home, "bin", `clover-plugin-bun${exe}`);
  return [core, `${core}.new`, `${core}.old`, `${core}.bad`, bun, `${bun}.new`, `${bun}.old`, `${bun}.swap`];
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
  /** Puts plain Bun for plugins at `path` (plugin-bun-install.ts's `ensurePluginBun`, for this daemon's Bun and the
   *  install's channel). */
  pluginBun(path: string, channel: InstallChannel): Promise<PluginBunResult>;
  /** Puts the bundled plugins this daemon's manifest names in `dir` (plugins-install.ts's `ensureServerPlugins`, from
   *  the release's tarball for this daemon's version and the install's channel). */
  plugins(dir: string, channel: InstallChannel): Promise<PluginsResult>;
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
  // Windows: the logon task's fallback must be writable for this path, decided before anything is copied or marked.
  if (spec.os === "win32") {
    const problem = schtasksFallbackProblem(bin, oldBinary(bin), spec.homedir ?? homedir());
    if (problem !== undefined) {
      d.log(`server install: the logon task can't be written: ${problem}; nothing was installed`);
      return 1;
    }
  }
  const earlier = earlierLayoutFiles(spec.home, spec.os);
  if (!same(spec.bin, bin)) {
    mkdirSync(dirname(bin), { recursive: true });
    // A running server's binary is replaced by its own update, not here.
    if (existsSync(bin)) await d.stopDaemon({ ...spec, bin });
    else if (existsSync(earlier[0]!) && !same(spec.bin, earlier[0]!)) await d.stopDaemon({ ...spec, bin: earlier[0]! });
    copyFileSync(spec.bin, bin);
    if (spec.os !== "win32") chmodSync(bin, 0o755);
  }
  // Windows: the logon task falls back to `.old` when the binary is missing or won't start (self-update.ts's
  // replaceBinary: two renames there).
  const served: LoginSpec = { ...spec, bin, ...(spec.os === "win32" ? { fallbackBin: oldBinary(bin) } : {}) };
  // Plain Bun for plugins beside it (`pluginBun()` fails closed without it): from the release, checked as the daemon's
  // own update is. A server that can't have it isn't installed.
  const bun = await d.pluginBun(serverPluginBun(spec.home, spec.os), channel);
  if (bun.kind === "refused") {
    d.log(`server install: plain Bun for plugins could not be installed (${bun.why}); nothing was registered`);
    return 1;
  }
  // The bundled plugins this core's manifest names: from the release, checked, swapped in whole.
  const plugins = await d.plugins(serverPluginsDir(spec.home), channel);
  if (plugins.kind === "refused") {
    d.log(`server install: the bundled plugins could not be installed (${plugins.why}); nothing was registered`);
    return 1;
  }
  // The earlier layout's binaries go (this one, if it was one of them, keeps running and is removed by the OS's
  // unlink semantics; on Windows it stays until it ends).
  for (const f of earlier) {
    try { rmSync(f, { force: true }); } catch { /* in use (Windows) */ }
  }
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
  d.log(`server install: clover-core at ${bin} with plain Bun for plugins beside it and the bundled plugins in ${serverPluginsDir(spec.home)}, started by the OS (${st.label}), updating itself on ${channel}`);
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
  const bun = serverPluginBun(spec.home, spec.os);
  const plugins = serverPluginsDir(spec.home);
  for (const f of [`${bin}.new`, oldBinary(bin), badBinary(bin), `${bin}.heal`, bin, `${bun}.new`, `${bun}.old`, `${bun}.swap`, bun, ...earlierLayoutFiles(spec.home, spec.os)]) {
    try {
      rmSync(f, { force: true });
    } catch {
      kept = f;
    }
  }
  for (const dir of [plugins, `${plugins}.new`, `${plugins}.old`, `${plugins}.bad`]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      kept = dir;
    }
  }
  d.log(`server uninstall: the daemon ${stopped}; login start and the marker removed${kept === undefined ? "" : `; ${kept} is in use and stays (delete it once this process ends)`}`);
  return 0;
}

export type MigrationResult = { kind: "not needed" } | { kind: "restart" } | { kind: "next logon" } | { kind: "failed"; why: string };

/**
 * One step from the earlier layout (`<home>/bin/clover-core`, which no release shipped, but dev and test servers run):
 * when a server's daemon starts from that path, it copies itself to `<home>/bin/daemon/clover-core` (written, flushed,
 * renamed in place), moves plain Bun beside it, and points the old path at the new one:
 *   - macOS and Linux: the old path becomes a symlink to `daemon/clover-core` (one atomic rename), so the login unit,
 *     which runs `<home>/bin/clover-core supervise`, starts the new layout; the caller then exits with the restart
 *     code, and `supervise` starts it at once;
 *   - Windows (a running binary can't be replaced, and a symlink needs a privilege): the logon task is registered
 *     again for the new path (with its `.old` fallback); this daemon keeps running, and the next logon starts the new
 *     layout, whose start removes the old files.
 * Never throws.
 */
export async function migrateEarlierLayout(o: {
  home: string;
  os: LoginSpec["os"];
  execPath: string;
  /** Registers the login start again for `bin` (Windows; `loginEnable`). */
  reRegister(bin: string): Promise<boolean>;
  log(line: string): void;
}): Promise<MigrationResult> {
  const earlier = earlierLayoutFiles(o.home, o.os);
  const oldBin = earlier[0]!;
  const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
  try {
    if (real(o.execPath) === undefined || real(o.execPath) !== real(oldBin) || lstatSync(oldBin).isSymbolicLink()) {
      // The new layout: what the earlier one left (but the symlink the login unit runs through) goes.
      if (real(o.execPath) === real(serverBinary(o.home, o.os))) {
        for (const f of earlier.slice(1)) {
          try { rmSync(f, { force: true }); } catch { /* in use (Windows) */ }
        }
        if (o.os === "win32") {
          try { rmSync(oldBin, { force: true }); } catch { /* still running somewhere */ }
        }
      }
      return { kind: "not needed" };
    }
    const bin = serverBinary(o.home, o.os);
    mkdirSync(dirname(bin), { recursive: true });
    const staged = `${bin}.new`;
    rmSync(staged, { force: true });
    copyFileSync(oldBin, staged);
    if (o.os !== "win32") chmodSync(staged, 0o755);
    syncFile(staged);
    renameSync(staged, bin);
    syncDir(dirname(bin));
    const oldBun = earlier[4]!, bun = serverPluginBun(o.home, o.os);
    if (existsSync(oldBun) && !existsSync(bun)) renameSync(oldBun, bun);
    syncDir(dirname(bin));
    if (o.os === "win32") {
      if (!(await o.reRegister(bin))) return { kind: "failed", why: "the logon task could not be registered for the new layout" };
      o.log(`server: moved to ${bin}; the next logon starts it there`);
      return { kind: "next logon" };
    }
    const link = `${oldBin}.migrate`;
    rmSync(link, { force: true });
    symlinkSync(join("daemon", basename(bin)), link);
    renameSync(link, oldBin);
    syncDir(dirname(oldBin));
    o.log(`server: moved to ${bin} (${oldBin} now points there); restarting into it`);
    return { kind: "restart" };
  } catch (err) {
    return { kind: "failed", why: err instanceof Error ? err.message : String(err) };
  }
}
