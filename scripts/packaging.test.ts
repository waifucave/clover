// Clover's packages (plan §4 M1): the installers' hooks against packaging/installer-hooks.ts, electron-builder.yml's
// Linux packages and Windows installer against packaging/, winget's manifests, the Homebrew cask, and
// build-packages.ts's pure parts. The packages themselves are built and opened by CI's packages job.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AUTOSTART_SUBCOMMAND, INSTALLER_HOOKS, autostartArgs } from "../packaging/installer-hooks";
import { AFTER_INSTALL_MARK, checkPackage, electronBuilderArgs, packageArchNames, parseBuildPackagesArgs } from "./build-packages";
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
  test("the one command they call is lane C's login start", () => {
    expect(autostartArgs("disable")).toEqual([AUTOSTART_SUBCOMMAND, "disable"]);
    expect(AUTOSTART_SUBCOMMAND).toBe("autostart");
  });

  test("no installer turns login start on (the app does, at its first launch), and every hook file exists", () => {
    for (const [installer, hook] of Object.entries(INSTALLER_HOOKS)) {
      expect(hook.onInstall, installer).toBeNull();
      if (hook.file !== null) expect(existsSync(join(ROOT, hook.file)), hook.file).toBe(true);
    }
  });

  test("the Homebrew cask's uninstall turns it off through the daemon, as the user", () => {
    const code = codeLines(read("packaging/clover.rb.tmpl"), "#").join("\n");
    expect(code).toContain('executable: "#{appdir}/Clover.app/Contents/Resources/clover-core"');
    expect(code).toContain(`args:       ${JSON.stringify(autostartArgs("disable")).replace(/,/g, ", ")}`);
    expect(code).toContain("sudo:       false");
  });

  test("the Windows uninstaller turns it off through the daemon, and not on an upgrade", () => {
    const code = codeLines(read("packaging/windows/installer.nsh"), ";");
    expect(code).toContain("!macro customUnInstall");
    expect(code).toContain("${ifNot} ${isUpdated}");
    expect(code).toContain(`ExecWait '"$INSTDIR\\resources\\clover-core.exe" ${autostartArgs("disable").join(" ")}'`);
  });

  test("none reaches launchctl, systemctl or Task Scheduler itself, and none turns it on", () => {
    for (const [rel, comment] of [["packaging/clover.rb.tmpl", "#"], ["packaging/windows/installer.nsh", ";"], ["packaging/linux/after-install.sh", "#"], ["packaging/linux/after-remove.sh", "#"]] as const) {
      const code = codeLines(read(rel), comment).join("\n");
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

  test("the daemon goes in every package's resources, from where build-packages.ts stages it", () => {
    expect(builder.extraResources).toEqual([{ from: "out/daemon", to: ".", filter: ["clover-core", "clover-core.exe"] }]);
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
    expect(parseBuildPackagesArgs([], "x64")).toEqual({ arches: ["x64"], formats: ["deb", "rpm", "AppImage"], check: false, dryRun: false });
    expect(parseBuildPackagesArgs(["--arch", "x64,arm64", "--formats=deb", "--check"], "x64")).toEqual({ arches: ["x64", "arm64"], formats: ["deb"], check: true, dryRun: false });
    expect(() => parseBuildPackagesArgs([], "ia32")).toThrow(/--arch/);
    expect(() => parseBuildPackagesArgs(["--formats", "snap"], "x64")).toThrow(/not snap/);
    expect(() => parseBuildPackagesArgs(["--sign"], "x64")).toThrow(/unknown argument/);
  });

  test("electron-builder packages one architecture at a time and never publishes", () => {
    expect(electronBuilderArgs("arm64", ["deb", "rpm"])).toEqual(["electron-builder", "--linux", "deb", "rpm", "--arm64", "--publish", "never"]);
    expect(packageArchNames("x64")).toEqual({ deb: "amd64", rpm: "x86_64", appImage: "x86_64" });
    expect(packageArchNames("arm64")).toEqual({ deb: "arm64", rpm: "aarch64", appImage: "arm64" });
  });

  test("a package is checked for the daemon, the AppArmor profile and packaging/linux's after-install", () => {
    const debListing = [
      "drwxr-xr-x 0/0 0 2026-11-05 12:00 ./opt/Clover/",
      "-rwxr-xr-x 0/0 100 2026-11-05 12:00 ./opt/Clover/clover",
      "-rwxr-xr-x 0/0 100 2026-11-05 12:00 ./opt/Clover/resources/clover-core",
      "-rw-r--r-- 0/0 100 2026-11-05 12:00 ./opt/Clover/resources/apparmor-profile",
    ].join("\n");
    const scripts = `CLI='${AFTER_INSTALL_MARK}'\napparmor_parser --replace x`;
    expect(checkPackage("deb", debListing, scripts)).toEqual([]);
    expect(checkPackage("rpm", "/opt/Clover/clover\n/opt/Clover/resources/apparmor-profile\n", scripts)).toEqual(["rpm: /opt/Clover/resources/clover-core is missing"]);
    expect(checkPackage("deb", debListing, "ln -sf /opt/Clover/clover /usr/bin/clover")).toEqual([
      `deb: its after-install script is not packaging/linux/after-install.sh (no ${AFTER_INSTALL_MARK})`,
      "deb: its scripts never load the AppArmor profile",
    ]);
  });
});
