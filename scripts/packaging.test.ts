// Clover's packages (plan §4 M1): the installers' hooks against packaging/installer-hooks.ts, electron-builder.yml's
// Linux packages and Windows installer against packaging/, winget's manifests, the Homebrew cask, and
// build-packages.ts's pure parts. The packages themselves are built and opened by CI's packages job.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTOSTART_SUBCOMMAND, INSTALLER_HOOKS, LAUNCHD_LABEL, autostartArgs } from "../packaging/installer-hooks";
import { linkBinaryName } from "../packages/core/src/links/sidecar-binary";
import { AFTER_INSTALL_MARK, checkPackage, electronBuilderArgs, LINK_BUILD, LINK_OUTPUT, packageArchNames, parseBuildPackagesArgs, parseListing, REQUIRED_FILES } from "./build-packages";
import { caskFrom } from "./release-lib";
import { renderWinget, wingetInstallerUrl } from "./winget";

const ROOT = join(import.meta.dir, "..");
const DESKTOP = join(ROOT, "apps", "desktop");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const builder = Bun.YAML.parse(read("apps/desktop/electron-builder.yml")) as Record<string, any>;

/** The lines a file runs, its comments dropped (`#` for shell and Ruby, `;` for NSIS). */
function codeLines(text: string, comment: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith(comment));
}

/** electron-builder's Linux script macros, as FpmTarget fills them. */
const MACROS: Record<string, string> = { executable: "clover", sanitizedProductName: "Clover", productFilename: "Clover" };
function renderLinux(rel: string): string {
  return read(rel).replace(/\$\{([a-zA-Z]+)\}/g, (_, name: string) => {
    if (!(name in MACROS)) throw new Error(`${rel}: electron-builder knows no macro ${name}`);
    return MACROS[name]!;
  });
}

describe("the installers' hooks", () => {
  test("the one command they call is lane C's login start, and an uninstall removes it (stopping the daemon)", () => {
    expect(autostartArgs("remove")).toEqual([AUTOSTART_SUBCOMMAND, "remove"]);
    expect(AUTOSTART_SUBCOMMAND).toBe("autostart");
    // `disable` would keep the definitions and leave the daemon running, its files locked on Windows.
    for (const [installer, hook] of Object.entries(INSTALLER_HOOKS)) if (hook.onUninstall !== null) expect(hook.onUninstall, installer).toBe("remove");
  });

  test("no installer turns login start on (the app does, at its first launch), and every hook file exists", () => {
    for (const [installer, hook] of Object.entries(INSTALLER_HOOKS)) {
      expect(hook.onInstall, installer).toBeNull();
      if (hook.file !== null) expect(existsSync(join(ROOT, hook.file)), hook.file).toBe(true);
    }
  });

  test("the Homebrew cask's uninstall removes it through the daemon, as the user, and goes on without the app", () => {
    const code = codeLines(read("packaging/clover.rb.tmpl"), "#").join("\n");
    // Through /bin/sh, so a binary already gone (the app in the Trash) exits 0: Homebrew refuses a missing executable.
    expect(code).toContain('executable:   "/bin/sh"');
    expect(code).toContain(`args:         ["-c", '[ -x "$1" ] || exit 0; exec "$1" ${autostartArgs("remove").join(" ")}', "sh", "#{appdir}/Clover.app/Contents/Resources/daemon/clover-core"]`);
    expect(code).toContain("sudo:         false");
    // Homebrew fails an uninstall whose script fails unless told otherwise; the app may already be gone.
    expect(code).toContain("must_succeed: false");
    // The fallback for a deleted app, Clover's own label only.
    expect(code).toContain(`uninstall launchctl: "${LAUNCHD_LABEL}"`);
    // The guard itself: a missing binary exits 0 without running anything; a present one gets `autostart remove`.
    if (process.platform !== "win32") {
      const guard = '[ -x "$1" ] || exit 0; exec "$1" autostart remove';
      const dir = mkdtempSync(join(tmpdir(), "clover-cask-guard-"));
      const fake = join(dir, "clover-core");
      expect(spawnSync("/bin/sh", ["-c", guard, "sh", fake], { encoding: "utf8" }).status).toBe(0);
      writeFileSync(fake, `#!/bin/sh\necho "ran: $*"\n`, { mode: 0o755 });
      expect(spawnSync("/bin/sh", ["-c", guard, "sh", fake], { encoding: "utf8" }).stdout).toBe("ran: autostart remove\n");
    }
  });

  test("the cask's zap takes exactly the caches, the preferences, the logs and the login item (the owner's rule)", () => {
    const code = codeLines(read("packaging/clover.rb.tmpl"), "#").join("\n");
    const zap = code.slice(code.indexOf("zap trash: ["), code.indexOf("]", code.indexOf("zap trash: [")));
    const paths = [...zap.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toEqual(["~/Library/Caches/@waifucaveclover-desktop-updater", "~/Library/Caches/com.waifucave.clover", "~/Library/Caches/com.waifucave.clover.ShipIt",
      `~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`, "~/Library/Logs/Clover", "~/Library/Preferences/com.waifucave.clover.plist"]);
  });

  test("the Windows uninstaller removes it through the daemon, without a console window, and not on an upgrade", () => {
    const code = codeLines(read("packaging/windows/installer.nsh"), ";");
    expect(code).toContain("!macro customUnInstall");
    expect(code).toContain("${ifNot} ${isUpdated}");
    expect(code).toContain(`nsExec::ExecToLog '"$INSTDIR\\resources\\daemon\\clover-core.exe" ${autostartArgs("remove").join(" ")}'`);
    expect(code).not.toContain("ExecWait");
  });

  test("none reaches systemctl or Task Scheduler itself, launchctl only in the cask's fallback, and none turns it on", () => {
    for (const [rel, comment] of [["packaging/clover.rb.tmpl", "#"], ["packaging/windows/installer.nsh", ";"], ["packaging/linux/after-install.sh", "#"], ["packaging/linux/after-remove.sh", "#"]] as const) {
      const code = codeLines(read(rel), comment).filter((l) => !(rel.endsWith(".rb.tmpl") && l === `uninstall launchctl: "${LAUNCHD_LABEL}",`)).join("\n");
      expect(code, rel).not.toMatch(/\b(launchctl|systemctl|schtasks)\b/);
      expect(code, rel).not.toContain(`${AUTOSTART_SUBCOMMAND} enable`);
    }
  });
});

describe("the Linux packages (electron-builder.yml and packaging/linux)", () => {
  test("the deb and the rpm run packaging/linux's scripts and install its AppArmor profile", () => {
    for (const format of ["deb", "rpm"]) {
      const options = builder[format] as Record<string, string>;
      expect(resolve(DESKTOP, options.afterInstall!)).toBe(join(ROOT, "packaging", "linux", "after-install.sh"));
      expect(resolve(DESKTOP, options.afterRemove!)).toBe(join(ROOT, "packaging", "linux", "after-remove.sh"));
      expect(resolve(DESKTOP, options.appArmorProfile!)).toBe(join(ROOT, "packaging", "linux", "apparmor-profile"));
    }
  });

  test("the packages name the owner's contact as their maintainer", () => {
    expect(builder.linux.maintainer).toBe("Clover <w@waifucave.com>");
  });

  test("the deb and the rpm are named clover, file and package, with no folder in the name", () => {
    expect(builder.deb.packageName).toBe("clover");
    expect(builder.rpm.packageName).toBe("clover");
    expect(builder.deb.artifactName).toBe("clover_${version}_${arch}.${ext}");
    expect(builder.rpm.artifactName).toBe("clover-${version}.${arch}.${ext}");
    for (const name of [builder.deb.artifactName, builder.rpm.artifactName, builder.appImage.artifactName] as string[]) expect(name).not.toMatch(/[/@]|\$\{name\}/);
  });

  test("they depend on electron-builder's own list plus bubblewrap (the Bash tool's sandbox) and libsecret", () => {
    expect(builder.deb.depends).toEqual(["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "bubblewrap"]);
    expect(builder.rpm.depends).toEqual(["gtk3", "libnotify", "nss", "libXScrnSaver", "(libXtst or libXtst6)", "xdg-utils", "at-spi2-core", "(libuuid or libuuid1)", "libsecret", "bubblewrap"]);
  });

  test("the scripts and the profile use only macros electron-builder fills, and the scripts parse", () => {
    for (const rel of ["packaging/linux/after-install.sh", "packaging/linux/after-remove.sh", "packaging/linux/apparmor-profile"]) renderLinux(rel);
    if (process.platform === "win32") return;
    for (const rel of ["packaging/linux/after-install.sh", "packaging/linux/after-remove.sh"]) {
      const r = spawnSync("bash", ["-n"], { input: renderLinux(rel), encoding: "utf8" });
      expect(r.status, `${rel}: ${r.stderr}`).toBe(0);
    }
  });

  test("after-install links `clover` to the daemon's command line and loads the AppArmor profile; after-remove undoes both", () => {
    const install = renderLinux("packaging/linux/after-install.sh");
    expect(install).toContain(`CLI='${AFTER_INSTALL_MARK}'`);
    expect(install).toContain("update-alternatives --install '/usr/bin/clover' 'clover' \"$CLI\" 100");
    expect(install).toContain("APPARMOR_PROFILE_TARGET='/etc/apparmor.d/clover'");
    expect(install).toContain("apparmor_parser --replace");
    const remove = renderLinux("packaging/linux/after-remove.sh");
    expect(remove).toContain("update-alternatives --remove 'clover' \"$CLI\"");
    expect(remove).toContain("apparmor_parser --remove");
  });

  test("the AppArmor profile grants user namespaces to the app's executable alone", () => {
    const profile = renderLinux("packaging/linux/apparmor-profile");
    expect(builder.linux.executableName).toBe(MACROS.executable);
    expect(profile).toContain("profile clover /opt/Clover/clover flags=(unconfined) {");
    expect(profile).toContain("  userns,");
  });

  test("the daemon and its link sidecar go in every package's resources, side by side, from where build-packages.ts stages them", () => {
    expect(builder.extraResources).toEqual([{ from: "out/daemon", to: "daemon", filter: ["clover-core", "clover-core.exe", "clover-link", "clover-link.exe"] }]);
    // Beside the daemon, where the core looks for it (packages/core/src/links/sidecar-binary.ts).
    expect(REQUIRED_FILES as readonly string[]).toContain(`/opt/Clover/resources/daemon/${linkBinaryName("linux")}`);
    expect(LINK_OUTPUT.endsWith(`/${linkBinaryName("linux")}`)).toBe(true);
    expect(LINK_BUILD.join(" ")).toBe("cargo build --release --locked --manifest-path native/link/Cargo.toml");
  });

  test("the deb's and the rpm's launcher entry carries Quit, which runs the app with --quit (no tray on stock GNOME)", () => {
    for (const format of ["deb", "rpm"]) {
      expect(builder[format].desktop.entry.Actions, format).toBe("Quit;");
      expect(builder[format].desktop.desktopActions.Quit, format).toEqual({ Name: "Quit Clover", Exec: `/opt/Clover/${builder.linux.executableName} --quit` });
    }
  });

  test("on macOS the app is a menu-bar app: no Dock icon", () => {
    expect(builder.mac.extendInfo.LSUIElement).toBe(true);
  });

  test("the Windows installer, once there is an app to package, is per user and carries packaging/windows/installer.nsh", () => {
    expect(builder.nsis.perMachine).toBe(false);
    expect(resolve(DESKTOP, builder.nsis.include)).toBe(join(ROOT, "packaging", "windows", "installer.nsh"));
  });
});

describe("winget", () => {
  const values = { version: "1.111.1", url: wingetInstallerUrl("1.111.1"), sha256: "ab".repeat(32), releaseDate: "2026-12-01" };

  test("three manifests, one package, one version, every slot filled", () => {
    const manifests = renderWinget(ROOT, values);
    expect(Object.keys(manifests)).toEqual(["waifucave.Clover.installer.yaml", "waifucave.Clover.locale.en-US.yaml", "waifucave.Clover.yaml"]);
    const parsed = Object.fromEntries(Object.entries(manifests).map(([k, v]) => [k, Bun.YAML.parse(v) as Record<string, any>]));
    for (const m of Object.values(parsed)) {
      expect(m.PackageIdentifier).toBe("waifucave.Clover");
      expect(m.PackageVersion).toBe("1.111.1");
      expect(m.ManifestVersion).toBe("1.10.0");
    }
    expect(parsed["waifucave.Clover.yaml"]!.ManifestType).toBe("version");
    expect(parsed["waifucave.Clover.locale.en-US.yaml"]!.ManifestType).toBe("defaultLocale");
    const installer = parsed["waifucave.Clover.installer.yaml"]!;
    expect(installer.ManifestType).toBe("installer");
    expect(installer.InstallerType).toBe("nsis");
    expect(installer.Scope).toBe("user");
    expect(installer.ReleaseDate).toBe("2026-12-01");
    expect(installer.Installers).toEqual([{ Architecture: "x64", InstallerUrl: "https://github.com/waifucave/clover/releases/download/v1.111.1/Clover-Setup-1.111.1.exe", InstallerSha256: "AB".repeat(32) }]);
  });

  test("bad values are refused, never written", () => {
    expect(() => renderWinget(ROOT, { ...values, version: "1.111" })).toThrow(/N\.N\.N/);
    expect(() => renderWinget(ROOT, { ...values, sha256: "zz" })).toThrow(/sha256/);
    expect(() => renderWinget(ROOT, { ...values, releaseDate: "Dec 1" })).toThrow(/YYYY-MM-DD/);
    expect(() => renderWinget(ROOT, { ...values, url: "http://x" })).toThrow(/https/);
  });
});

describe("the Homebrew cask", () => {
  test("renders with every slot filled, and keeps the user's ~/.clover out of zap", () => {
    const cask = caskFrom(read("packaging/clover.rb.tmpl"), { version: "1.111.1", sha256: "ab".repeat(32), url: "unused" });
    expect(cask).not.toMatch(/\{\{\w+\}\}/);
    expect(cask).toContain('version "1.111.1"');
    const zap = cask.slice(cask.indexOf("zap trash:"));
    expect(zap).not.toContain("~/.clover");
  });
});

describe("build-packages.ts", () => {
  test("arguments: the host's architecture by default, every format, and nothing unknown", () => {
    expect(parseBuildPackagesArgs([], "x64")).toEqual({ arches: ["x64"], formats: ["deb", "rpm", "AppImage"], channel: "latest", check: false, dryRun: false });
    expect(parseBuildPackagesArgs(["--arch", "arm64", "--formats=deb", "--channel", "beta", "--check"], "arm64")).toEqual({ arches: ["arm64"], formats: ["deb"], channel: "beta", check: true, dryRun: false });
    expect(() => parseBuildPackagesArgs(["--channel", "nightly"], "x64")).toThrow(/latest or beta/);
    // One machine builds its own architecture (clover-link builds natively); a dry run may print any.
    expect(() => parseBuildPackagesArgs(["--arch", "x64,arm64"], "x64")).toThrow(/build arm64 on a machine of that architecture/);
    expect(parseBuildPackagesArgs(["--arch", "x64,arm64", "--dry-run"], "x64").arches).toEqual(["x64", "arm64"]);
    expect(() => parseBuildPackagesArgs([], "ia32")).toThrow(/--arch/);
    expect(() => parseBuildPackagesArgs(["--formats", "snap"], "x64")).toThrow(/not snap/);
    expect(() => parseBuildPackagesArgs(["--sign"], "x64")).toThrow(/unknown argument/);
  });

  test("electron-builder packages one architecture at a time and never publishes", () => {
    expect(electronBuilderArgs("arm64", ["deb", "rpm"])).toEqual(["electron-builder", "--linux", "deb", "rpm", "--arm64", "--publish", "never", "-c.publish.channel=latest"]);
    expect(electronBuilderArgs("x64", ["AppImage"], "beta")).toEqual(["electron-builder", "--linux", "AppImage", "--x64", "--publish", "never", "-c.publish.channel=beta"]);
    expect(packageArchNames("x64")).toEqual({ deb: "amd64", rpm: "x86_64", appImage: "x86_64" });
    expect(packageArchNames("arm64")).toEqual({ deb: "arm64", rpm: "aarch64", appImage: "arm64" });
  });

  test("a package is checked for the daemon, the link sidecar, the AppArmor profile and packaging/linux's after-install", () => {
    const debListing = [
      "drwxr-xr-x root/root 0 2026-11-05 12:00 ./opt/Clover/",
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/clover",
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/resources/daemon/clover-core",
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/resources/daemon/clover-link",
      "-rw-r--r-- root/root 100 2026-11-05 12:00 ./opt/Clover/resources/apparmor-profile",
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/chrome-sandbox",
      "lrwxrwxrwx root/root 0 2026-11-05 12:00 ./opt/Clover/libvk.so -> libvulkan.so.1",
    ].join("\n");
    const scripts = `CLI='${AFTER_INSTALL_MARK}'\napparmor_parser --replace x`;
    expect(checkPackage("deb", debListing, scripts)).toEqual([]);
    const rpmListing = [
      "-rwxr-xr-x    1 root     root          100 Nov  5 12:00 /opt/Clover/clover",
      "-rw-r--r--    1 root     root          100 Nov  5 12:00 /opt/Clover/resources/apparmor-profile",
    ].join("\n");
    expect(checkPackage("rpm", rpmListing, scripts)).toEqual(["rpm: /opt/Clover/resources/daemon/clover-core is missing", "rpm: /opt/Clover/resources/daemon/clover-link is missing"]);
    expect(checkPackage("deb", debListing, "ln -sf /opt/Clover/clover /usr/bin/clover")).toEqual([
      `deb: its after-install script is not packaging/linux/after-install.sh (no ${AFTER_INSTALL_MARK})`,
      "deb: its scripts never load the AppArmor profile",
    ]);
  });

  test("and for its file modes: the app, the daemon and the sidecar 0755 and root's, nothing world-writable, nothing set-user-ID", () => {
    const base = [
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/clover",
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/resources/daemon/clover-core",
      "-rw-r--r-- root/root 100 2026-11-05 12:00 ./opt/Clover/resources/apparmor-profile",
      "-rwxr-xr-x root/root 100 2026-11-05 12:00 ./opt/Clover/resources/daemon/clover-link",
    ];
    const scripts = `CLI='${AFTER_INSTALL_MARK}'\napparmor_parser --replace x`;
    const swap = (i: number, line: string) => base.map((l, j) => (j === i ? line : l)).join("\n");
    expect(checkPackage("deb", swap(1, "-rwxrwxr-x root/root 100 2026-11-05 12:00 ./opt/Clover/resources/daemon/clover-core"), scripts))
      .toEqual(["deb: /opt/Clover/resources/daemon/clover-core is -rwxrwxr-x root/root, not -rwxr-xr-x root/root"]);
    expect(checkPackage("deb", swap(0, "-rwxr-xr-x builder/builder 100 2026-11-05 12:00 ./opt/Clover/clover"), scripts))
      .toEqual(["deb: /opt/Clover/clover is -rwxr-xr-x builder/builder, not -rwxr-xr-x root/root"]);
    expect(checkPackage("deb", swap(3, "-rw-r--r-- root/root 100 2026-11-05 12:00 ./opt/Clover/resources/daemon/clover-link"), scripts))
      .toEqual(["deb: /opt/Clover/resources/daemon/clover-link is -rw-r--r-- root/root, not -rwxr-xr-x root/root"]);
    expect(checkPackage("deb", [...base, "-rw-rw-rw- root/root 1 2026-11-05 12:00 ./opt/Clover/resources/app.asar"].join("\n"), scripts))
      .toEqual(["deb: /opt/Clover/resources/app.asar is world-writable (-rw-rw-rw-)"]);
    expect(checkPackage("deb", [...base, "-rwsr-xr-x root/root 1 2026-11-05 12:00 ./opt/Clover/chrome-sandbox"].join("\n"), scripts))
      .toEqual(["deb: /opt/Clover/chrome-sandbox is set-user-ID or set-group-ID (-rwsr-xr-x)"]);
    // rpm -qlvp's spelling, a link among them: a link's lrwxrwxrwx is not a world-writable file.
    const rpm = [
      "-rwxr-xr-x    1 root     root          100 Nov  5 12:00 /opt/Clover/clover",
      "-rwxr-xr-x    1 root     root          100 Nov  5  2026 /opt/Clover/resources/daemon/clover-core",
      "-rwxr-xr-x    1 root     root          100 Nov  5  2026 /opt/Clover/resources/daemon/clover-link",
      "-rw-r--r--    1 root     root          100 Nov  5 12:00 /opt/Clover/resources/apparmor-profile",
      "lrwxrwxrwx    1 root     root           14 Nov  5 12:00 /opt/Clover/libvk.so -> libvulkan.so.1",
      "-rwxr-sr-x    1 root     root          100 Nov  5 12:00 /opt/Clover/helper",
    ].join("\n");
    expect(parseListing("rpm", rpm).map((e) => e.path)).toEqual(["/opt/Clover/clover", "/opt/Clover/resources/daemon/clover-core", "/opt/Clover/resources/daemon/clover-link", "/opt/Clover/resources/apparmor-profile", "/opt/Clover/libvk.so", "/opt/Clover/helper"]);
    expect(checkPackage("rpm", rpm, scripts)).toEqual(["rpm: /opt/Clover/helper is set-user-ID or set-group-ID (-rwxr-sr-x)"]);
  });

  test("after-remove acts on a removal only, never on an upgrade (the rpm runs it after the new version's after-install)", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "clover-after-remove-"));
    const log = join(dir, "calls.log");
    writeFileSync(join(dir, "update-alternatives"), `#!/bin/sh\necho "update-alternatives $*" >> '${log}'\n`, { mode: 0o755 });
    const run = (arg: string): string => {
      writeFileSync(log, "");
      const r = spawnSync("bash", ["-s", arg], { input: renderLinux("packaging/linux/after-remove.sh"), env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(log, "utf8");
    };
    for (const arg of ["upgrade", "failed-upgrade", "1", "2"]) expect(run(arg), arg).toBe("");
    for (const arg of ["remove", "purge", "0"]) expect(run(arg), arg).toBe(`update-alternatives --remove clover ${AFTER_INSTALL_MARK}\n`);
  });
});
