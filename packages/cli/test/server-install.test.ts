// `clover-core server install|uninstall` (src/server-install.ts) against a temp home, a recording runner and lane C's
// login start faked: never launchctl, systemctl, loginctl or schtasks for real.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstallMarker, removeInstallMarker, writeInstallMarker, type LoginSpec } from "@waifucave/clover-core";
import { earlierLayoutFiles, insideApp, migrateEarlierLayout, parseServerArgs, profileNote, serverBinary, serverInstall, serverUninstall, type ServerDeps } from "../src/server-install";
import { serverPluginBun, type PluginBunResult } from "../src/plugin-bun-install";
import { serverPluginsDir, type PluginsResult } from "../src/plugins-install";

function setup(os: LoginSpec["os"], opts: { lingerBefore?: "yes" | "no"; registered?: boolean; bin?: string; pluginBun?: PluginBunResult; plugins?: PluginsResult } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clover-server-install-"));
  const home = join(root, "home");
  mkdirSync(home);
  const bin = opts.bin ?? join(root, "Downloads", "clover-core-1.2.3-linux-x64");
  mkdirSync(join(bin, ".."), { recursive: true });
  writeFileSync(bin, "the daemon");
  const ran: string[] = [];
  const enabled: LoginSpec[] = [];
  const removed: LoginSpec[] = [];
  const lines: string[] = [];
  const deps: ServerDeps = {
    spec: { os, bin, home, logsDir: join(home, "logs"), profile: "dist" },
    os: { register: async () => true, unregister: async () => {}, query: async () => "on" },
    run: async (argv) => {
      ran.push(argv.join(" "));
      if (argv[1] === "show-user") return { ok: true, out: `${opts.lingerBefore ?? "no"}\n` };
      return { ok: true, out: "" };
    },
    loginEnable: async (spec) => { enabled.push(spec); return { registered: opts.registered ?? true, label: "com.waifucave.clover.core" }; },
    loginRemove: async (spec) => { removed.push(spec); },
    stopDaemon: async (spec) => { stopped.push(spec.bin); return "not-running"; },
    readMarker: (h) => readInstallMarker(h), writeMarker: writeInstallMarker, removeMarker: removeInstallMarker,
    user: "srv", log: (l) => lines.push(l),
    pluginBun: async (path, channel) => {
      plugin.push({ path, channel });
      if (opts.pluginBun?.kind !== "refused") writeFileSync(path, "plain bun");
      return opts.pluginBun ?? { kind: "installed", version: "1.4.4", from: "release" };
    },
    plugins: async (dir, channel) => {
      bundled.push({ dir, channel });
      if (opts.plugins?.kind !== "refused") { mkdirSync(join(dir, "clover"), { recursive: true }); writeFileSync(join(dir, "clover", "clover.json"), "{}"); }
      return opts.plugins ?? { kind: "installed", version: "1.2.3", files: 1 };
    },
  };
  const plugin: Array<{ path: string; channel: string }> = [];
  const bundled: Array<{ dir: string; channel: string }> = [];
  const stopped: string[] = [];
  return { home, bin, deps, ran, enabled, removed, lines, plugin, bundled, stopped };
}

describe("clover-core server install and uninstall", () => {
  test("arguments", () => {
    expect(parseServerArgs(["install"])).toEqual({ action: "install", channel: "latest" });
    expect(parseServerArgs(["install", "--channel", "beta"])).toEqual({ action: "install", channel: "beta" });
    expect(parseServerArgs(["install", "--channel=latest"])).toEqual({ action: "install", channel: "latest" });
    expect(parseServerArgs(["uninstall"])).toEqual({ action: "uninstall" });
    for (const bad of [[], ["install", "--channel", "nightly"], ["uninstall", "--force"], ["enable"]]) expect(() => parseServerArgs(bad)).toThrow(/usage/);
  });

  test("Linux: the binary into <home>/bin/daemon, lane C's login start for it, lingering on, and the server marker", async () => {
    const s = setup("linux");
    expect(await serverInstall(s.deps, "beta")).toBe(0);
    const bin = serverBinary(s.home, "linux");
    expect(bin).toBe(join(s.home, "bin", "daemon", "clover-core"));
    expect(readFileSync(bin, "utf8")).toBe("the daemon");
    expect(s.enabled.map((e) => e.bin)).toEqual([bin]);
    expect(s.ran).toEqual(["loginctl show-user srv --property=Linger --value", "loginctl enable-linger srv"]);
    expect(readInstallMarker(s.home)).toEqual({ kind: "server", channel: "beta", linger: true });
    // Uninstall undoes each: the login start, the lingering it turned on, the marker and the binary.
    expect(await serverUninstall(s.deps)).toBe(0);
    expect(s.removed.map((r) => r.bin)).toEqual([bin]);
    expect(s.ran.at(-1)).toBe("loginctl disable-linger srv");
    expect(readInstallMarker(s.home)).toBeUndefined();
    expect(existsSync(bin)).toBe(false);
  });

  test("lingering the user already had is left on at uninstall", async () => {
    const s = setup("linux", { lingerBefore: "yes" });
    expect(await serverInstall(s.deps, "latest")).toBe(0);
    expect(readInstallMarker(s.home)).toEqual({ kind: "server", channel: "latest" });
    await serverUninstall(s.deps);
    expect(s.ran.some((r) => r.includes("disable-linger"))).toBe(false);
  });

  test("macOS and Windows: their login start (LaunchAgent, logon task), no loginctl", async () => {
    for (const os of ["darwin", "win32"] as const) {
      const s = setup(os);
      expect(await serverInstall(s.deps, "latest")).toBe(0);
      expect(s.enabled.map((e) => e.bin)).toEqual([serverBinary(s.home, os)]);
      expect(s.ran).toEqual([]);
      expect(serverBinary(s.home, os).endsWith(os === "win32" ? "clover-core.exe" : "clover-core")).toBe(true);
    }
  });

  test("refused: the app's own daemon, a home the app or a package owns, and an uninstall with no server", async () => {
    const appBin = setup("darwin", { bin: join(mkdtempSync(join(tmpdir(), "clover-app-")), "Clover.app", "Contents", "Resources", "daemon", "clover-core") });
    expect(insideApp(appBin.bin)).toBe(true);
    expect(await serverInstall(appBin.deps, "latest")).toBe(1);
    expect(appBin.enabled).toEqual([]);
    const owned = setup("linux");
    writeInstallMarker(owned.home, { kind: "app" });
    expect(await serverInstall(owned.deps, "latest")).toBe(1);
    expect(readInstallMarker(owned.home)).toEqual({ kind: "app" });
    expect(await serverUninstall(owned.deps)).toBe(1);
    expect(owned.removed).toEqual([]);
    expect(await serverUninstall(setup("linux").deps)).toBe(1);
  });

  test("plain Bun for plugins goes beside the daemon on install, on the install's channel, and goes with it on uninstall", async () => {
    const s = setup("linux");
    expect(await serverInstall(s.deps, "beta")).toBe(0);
    const bun = serverPluginBun(s.home, "linux");
    expect(bun).toBe(join(s.home, "bin", "daemon", "clover-plugin-bun"));
    expect(s.plugin).toEqual([{ path: bun, channel: "beta" }]);
    expect(readFileSync(bun, "utf8")).toBe("plain bun");
    writeFileSync(`${bun}.old`, "older bun");
    expect(await serverUninstall(s.deps)).toBe(0);
    expect(existsSync(bun)).toBe(false);
    expect(existsSync(`${bun}.old`)).toBe(false);
    expect(serverPluginBun("/h", "win32")).toBe(join("/h", "bin", "daemon", "clover-plugin-bun.exe"));
  });

  test("the bundled plugins go in <home>/bin/plugins on install, on the install's channel, and go with it on uninstall", async () => {
    const s = setup("linux");
    expect(await serverInstall(s.deps, "beta")).toBe(0);
    const dir = serverPluginsDir(s.home);
    expect(dir).toBe(join(s.home, "bin", "plugins"));
    expect(s.bundled).toEqual([{ dir, channel: "beta" }]);
    expect(existsSync(join(dir, "clover", "clover.json"))).toBe(true);
    for (const d of [`${dir}.old`, `${dir}.new`]) mkdirSync(d);
    expect(await serverUninstall(s.deps)).toBe(0);
    for (const d of [dir, `${dir}.old`, `${dir}.new`]) expect(existsSync(d)).toBe(false);
  });

  test("a server whose bundled plugins can't be installed isn't installed: nothing registered, no marker", async () => {
    const s = setup("linux", { plugins: { kind: "refused", why: "clover-plugins-1.2.3-linux-x64.tar.gz isn't the tree this core's manifest names" } });
    expect(await serverInstall(s.deps, "latest")).toBe(1);
    expect(s.enabled).toEqual([]);
    expect(readInstallMarker(s.home)).toBeUndefined();
    expect(s.lines.at(-1)).toContain("isn't the tree this core's manifest names");
  });

  test("the earlier layout (<home>/bin/clover-core, plugin Bun beside it) is stopped and removed at install", async () => {
    const s = setup("linux");
    const earlier = earlierLayoutFiles(s.home, "linux");
    mkdirSync(join(s.home, "bin"), { recursive: true });
    for (const f of [earlier[0]!, `${earlier[0]}.old`, join(s.home, "bin", "clover-plugin-bun")]) writeFileSync(f, "earlier");
    expect(await serverInstall(s.deps, "latest")).toBe(0);
    expect(s.stopped).toEqual([earlier[0]!]);
    for (const f of earlier) expect(existsSync(f)).toBe(false);
    expect(existsSync(serverBinary(s.home, "linux"))).toBe(true);
  });

  test("a server that can't have plain Bun for plugins isn't installed: nothing registered, no marker", async () => {
    const s = setup("linux", { pluginBun: { kind: "refused", why: "clover-plugin-bun-1.4.4-linux-x64: bad signature" } });
    expect(await serverInstall(s.deps, "latest")).toBe(1);
    expect(s.enabled).toEqual([]);
    expect(readInstallMarker(s.home)).toBeUndefined();
    expect(s.lines.at(-1)).toContain("bad signature");
  });

  test("a login start the OS didn't register fails the install", async () => {
    const s = setup("darwin", { registered: false });
    expect(await serverInstall(s.deps, "latest")).toBe(1);
  });

  test("Windows: the logon task falls back to .old when the binary is missing or won't start", async () => {
    const s = setup("win32");
    expect(await serverInstall(s.deps, "latest")).toBe(0);
    const bin = serverBinary(s.home, "win32");
    expect(s.enabled.map((e) => e.fallbackBin)).toEqual([bin.replace(/\.exe$/, ".old.exe")]);
    const posix = setup("linux");
    await serverInstall(posix.deps, "latest");
    expect(posix.enabled[0]!.fallbackBin).toBeUndefined();
  });
});

describe("one step from the earlier layout", () => {
  const earlierServer = () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-server-migrate-")));
    mkdirSync(join(home, "bin"));
    const [oldBin, , , , oldBun] = earlierLayoutFiles(home, "linux");
    writeFileSync(oldBin!, "the daemon", { mode: 0o755 });
    writeFileSync(oldBun!, "plain bun", { mode: 0o755 });
    return { home, oldBin: oldBin!, oldBun: oldBun! };
  };
  const lines: string[] = [];

  test.if(process.platform !== "win32")("macOS and Linux: copied into bin/daemon, plain Bun moved beside it, the old path a link to it; then a restart", async () => {
    const e = earlierServer();
    const r = await migrateEarlierLayout({ home: e.home, os: "linux", execPath: e.oldBin, reRegister: async () => { throw new Error("not on POSIX"); }, log: (l) => lines.push(l) });
    expect(r).toEqual({ kind: "restart" });
    const bin = serverBinary(e.home, "linux");
    expect(readFileSync(bin, "utf8")).toBe("the daemon");
    expect(readFileSync(join(e.home, "bin", "daemon", "clover-plugin-bun"), "utf8")).toBe("plain bun");
    expect(lstatSync(e.oldBin).isSymbolicLink()).toBe(true);
    expect(readlinkSync(e.oldBin)).toBe(join("daemon", "clover-core"));
    expect(realpathSync(e.oldBin)).toBe(bin);
    // The restarted daemon runs from the new layout: nothing more to do, and the link the login unit runs through stays.
    writeFileSync(`${e.oldBin}.old`, "an old one");
    expect(await migrateEarlierLayout({ home: e.home, os: "linux", execPath: bin, reRegister: async () => true, log: () => {} })).toEqual({ kind: "not needed" });
    expect(existsSync(`${e.oldBin}.old`)).toBe(false);
    expect(lstatSync(e.oldBin).isSymbolicLink()).toBe(true);
  });

  test("Windows: copied, and the logon task registered again for the new path; the next logon starts it", async () => {
    const e = earlierServer();
    const registered: string[] = [];
    const r = await migrateEarlierLayout({ home: e.home, os: "win32", execPath: e.oldBin.replace(/clover-core$/, "clover-core.exe"), reRegister: async (b) => { registered.push(b); return true; }, log: () => {} });
    // (The earlier Windows layout's binary is clover-core.exe: this one isn't, so nothing is to be done.)
    expect(r).toEqual({ kind: "not needed" });
    const exe = earlierLayoutFiles(e.home, "win32")[0]!;
    writeFileSync(exe, "the daemon");
    expect(await migrateEarlierLayout({ home: e.home, os: "win32", execPath: exe, reRegister: async (b) => { registered.push(b); return true; }, log: () => {} })).toEqual({ kind: "next logon" });
    expect(registered).toEqual([serverBinary(e.home, "win32")]);
    expect(readFileSync(serverBinary(e.home, "win32"), "utf8")).toBe("the daemon");
  });

  test("a daemon that isn't a server's earlier binary has nothing to move", async () => {
    const e = earlierServer();
    const elsewhere = join(e.home, "elsewhere");
    writeFileSync(elsewhere, "x");
    expect(await migrateEarlierLayout({ home: e.home, os: "linux", execPath: elsewhere, reRegister: async () => true, log: () => {} })).toEqual({ kind: "not needed" });
    expect(existsSync(serverBinary(e.home, "linux"))).toBe(false);
  });

  test("Windows: a folder the logon task can't name safely is refused before anything is copied or marked", async () => {
    const s = setup("win32");
    const spec = { ...s.deps.spec, home: join(s.home, "odd%PATH%"), homedir: join(s.home, "profile") };
    const deps = { ...s.deps, spec };
    expect(await serverInstall(deps, "latest")).toBe(1);
    expect(s.lines.at(-1)).toContain("holds a %");
    expect(existsSync(serverBinary(spec.home, "win32"))).toBe(false);
    expect(readInstallMarker(spec.home)).toBeUndefined();
    expect(s.plugin).toEqual([]);
  });
});

describe("the logon profile note", () => {
  test("says nothing when the logon profile is this process's home (any case), and names both when it isn't", () => {
    expect(profileNote("C:\\Users\\Ann", "c:\\users\\ann")).toBeUndefined();
    expect(profileNote("D:\\Profiles\\Ann", "C:\\Users\\Ann")).toBe("server install: this account logs on with its profile at D:\\Profiles\\Ann, not C:\\Users\\Ann: the logon task uses D:\\Profiles\\Ann");
  });
});
