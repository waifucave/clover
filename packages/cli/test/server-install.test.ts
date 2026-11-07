// `clover-core server install|uninstall` (src/server-install.ts) against a temp home, a recording runner and lane C's
// login start faked: never launchctl, systemctl, loginctl or schtasks for real.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstallMarker, removeInstallMarker, writeInstallMarker, type LoginSpec } from "@waifucave/clover-core";
import { insideApp, parseServerArgs, serverBinary, serverInstall, serverUninstall, type ServerDeps } from "../src/server-install";
import { serverPluginBun, type PluginBunResult } from "../src/plugin-bun-install";

function setup(os: LoginSpec["os"], opts: { lingerBefore?: "yes" | "no"; registered?: boolean; bin?: string; pluginBun?: PluginBunResult } = {}) {
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
    stopDaemon: async () => "not-running",
    readMarker: (h) => readInstallMarker(h), writeMarker: writeInstallMarker, removeMarker: removeInstallMarker,
    user: "srv", log: (l) => lines.push(l),
    pluginBun: async (path, channel) => {
      plugin.push({ path, channel });
      if (opts.pluginBun?.kind !== "refused") writeFileSync(path, "plain bun");
      return opts.pluginBun ?? { kind: "installed", version: "1.4.4", from: "release" };
    },
  };
  const plugin: Array<{ path: string; channel: string }> = [];
  return { home, bin, deps, ran, enabled, removed, lines, plugin };
}

describe("clover-core server install and uninstall", () => {
  test("arguments", () => {
    expect(parseServerArgs(["install"])).toEqual({ action: "install", channel: "latest" });
    expect(parseServerArgs(["install", "--channel", "beta"])).toEqual({ action: "install", channel: "beta" });
    expect(parseServerArgs(["install", "--channel=latest"])).toEqual({ action: "install", channel: "latest" });
    expect(parseServerArgs(["uninstall"])).toEqual({ action: "uninstall" });
    for (const bad of [[], ["install", "--channel", "nightly"], ["uninstall", "--force"], ["enable"]]) expect(() => parseServerArgs(bad)).toThrow(/usage/);
  });

  test("Linux: the binary into <home>/bin, lane C's login start for it, lingering on, and the server marker", async () => {
    const s = setup("linux");
    expect(await serverInstall(s.deps, "beta")).toBe(0);
    const bin = serverBinary(s.home, "linux");
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
    expect(bun).toBe(join(s.home, "bin", "clover-plugin-bun"));
    expect(s.plugin).toEqual([{ path: bun, channel: "beta" }]);
    expect(readFileSync(bun, "utf8")).toBe("plain bun");
    writeFileSync(`${bun}.old`, "older bun");
    expect(await serverUninstall(s.deps)).toBe(0);
    expect(existsSync(bun)).toBe(false);
    expect(existsSync(`${bun}.old`)).toBe(false);
    expect(serverPluginBun("/h", "win32")).toBe(join("/h", "bin", "clover-plugin-bun.exe"));
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
});
