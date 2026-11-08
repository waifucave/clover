// C-M3 item 5 and #306's review: the app's whole install (the bundle on macOS, the install folder elsewhere: the bundled
// plugins, approved without a card, the daemon and the app's own code) is fenced like `runtimes`, as started and with
// its links resolved: the sandbox's denyWrite, the escape floor on any mention, the write tools and their deny rules, and
// Clover's own fence. A server's `<home>/bin` is fenced the same way (fences-ws21.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appInstallDirs, appInstallDirsFor, appResourcesDirFor, setAppInstallDirs } from "../../src/platform/app-resources";
import { controlPlaneDenyRules, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { escapeFloorHit } from "../../src/runtime-sdk/hooks";
import { controlPlaneTargetForCall } from "../../src/runtime-sdk/control-plane";
import { homeFenceFor } from "../../src/runtime-sdk/home-fence";
import { CloverFence } from "../../src/fence/fence";

const H = "/Users/x/.clover";
const A = "/Applications/Clover.app";
const R = `${A}/Contents/Resources`;
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

describe("where the resources folder is", () => {
  test("a compiled daemon in <resources>/daemon, its links resolved; none from source or elsewhere", () => {
    const id = (p: string) => p;
    expect(appResourcesDirFor(`${R}/daemon/clover-core`, true, "darwin", id)).toBe(R);
    expect(appResourcesDirFor("C:\\Program Files\\Clover\\resources\\daemon\\clover-core.exe", true, "win32", id)).toBe("C:\\Program Files\\Clover\\resources");
    expect(appResourcesDirFor("/opt/Clover/resources/daemon/clover-core", true, "linux", id)).toBe("/opt/Clover/resources");
    expect(appResourcesDirFor(`${R}/daemon/clover-core`, false, "darwin", id)).toBeUndefined(); // from source
    expect(appResourcesDirFor(`${H}/bin/clover-core`, true, "darwin", id)).toBeUndefined(); // a server's (fenced as <home>/bin)
    expect(appResourcesDirFor("/usr/local/bin/clover-core", true, "darwin", (p) => (p === "/usr/local/bin/clover-core" ? `${R}/daemon/clover-core` : p))).toBe(R);
    expect(appResourcesDirFor("/nowhere/clover-core", true, "darwin", () => { throw new Error("ENOENT"); })).toBeUndefined();
    expect(appInstallDirs()).toEqual([]); // the test runner isn't a compiled daemon
    if (process.platform !== "win32") {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-res-")));
      mkdirSync(join(root, "App", "resources", "daemon"), { recursive: true });
      writeFileSync(join(root, "App", "resources", "daemon", "clover-core"), "");
      symlinkSync(join(root, "App", "resources", "daemon", "clover-core"), join(root, "clover"));
      expect(appResourcesDirFor(join(root, "clover"), true)).toBe(join(root, "App", "resources"));
    }
  });
});

describe("the install around it", () => {
  const id = (p: string) => p;
  test("the .app on macOS, the install folder on Windows and Linux; never a root or a folder holding the home", () => {
    expect(appInstallDirsFor(`${R}/daemon/clover-core`, true, "darwin", id, "/Users/x")).toEqual([A]);
    expect(appInstallDirsFor("C:\\Program Files\\Clover\\resources\\daemon\\clover-core.exe", true, "win32", id, "C:\\Users\\x")).toEqual(["C:\\Program Files\\Clover"]);
    expect(appInstallDirsFor("C:\\Users\\x\\AppData\\Local\\Programs\\Clover\\resources\\daemon\\clover-core.exe", true, "win32", id, "C:\\Users\\x")).toEqual(["C:\\Users\\x\\AppData\\Local\\Programs\\Clover"]);
    expect(appInstallDirsFor("/opt/Clover/resources/daemon/clover-core", true, "linux", id, "/home/x")).toEqual(["/opt/Clover"]);
    expect(appInstallDirsFor("/resources/daemon/clover-core", true, "linux", id, "/home/x")).toEqual(["/resources"]); // not "/"
    expect(appInstallDirsFor("/home/x/resources/daemon/clover-core", true, "linux", id, "/home/x")).toEqual(["/home/x/resources"]); // not the home
    expect(appInstallDirsFor("/Users/x/Resources/daemon/clover-core", true, "darwin", id, "/Users/x")).toEqual(["/Users/x/Resources"]); // no .app around it
    expect(appInstallDirsFor(`${R}/daemon/clover-core`, false, "darwin", id, "/Users/x")).toEqual([]); // from source
    expect(appInstallDirsFor(`${H}/bin/clover-core`, true, "darwin", id, "/Users/x")).toEqual([]);
  });

  test("a linked bundle (Link.app -> Real.app) is held under both spellings; the same one twice, once", () => {
    const real = (p: string) => p.replace("/Applications/Link.app/", "/Applications/Real.app/");
    expect(appInstallDirsFor("/Applications/Link.app/Contents/Resources/daemon/clover-core", true, "darwin", real, "/Users/x"))
      .toEqual(["/Applications/Link.app", "/Applications/Real.app"]);
    // A link to the binary itself has no bundle in its own spelling: only the resolved one.
    expect(appInstallDirsFor("/usr/local/bin/clover-core", true, "darwin", () => `${R}/daemon/clover-core`, "/Users/x")).toEqual([A]);
    expect(appInstallDirsFor("/applications/clover.app/Contents/Resources/daemon/clover-core", true, "darwin", () => `${R}/daemon/clover-core`, "/Users/x")).toEqual(["/applications/clover.app"]);
  });
});

describe("as started: argv0 (#306's check 2)", () => {
  test("an absolute argv0 adds its spelling; a relative one, or one outside an install, adds nothing", () => {
    const real = (p: string) => p.replace("/Applications/Link.app/", "/Applications/Real.app/");
    const resolved = "/Applications/Real.app/Contents/Resources/daemon/clover-core";
    expect(appInstallDirsFor(resolved, true, "darwin", real, "/Users/x", "/Applications/Link.app/Contents/Resources/daemon/clover-core"))
      .toEqual(["/Applications/Link.app", "/Applications/Real.app"]);
    expect(appInstallDirsFor(resolved, true, "darwin", real, "/Users/x", "./Link.app/Contents/Resources/daemon/clover-core")).toEqual(["/Applications/Real.app"]);
    expect(appInstallDirsFor(resolved, true, "darwin", real, "/Users/x", "/usr/local/bin/clover-core")).toEqual(["/Applications/Real.app"]);
    // Its root and home refusals hold for argv0's spelling too.
    expect(appInstallDirsFor(resolved, true, "darwin", real, "/Users/x", "/Users/x/Resources/daemon/clover-core")).toEqual(["/Users/x/Resources", "/Applications/Real.app"]);
    expect(appInstallDirsFor("C:\\Program Files\\Clover\\resources\\daemon\\clover-core.exe", true, "win32", (p) => p, "C:\\Users\\x", "C:\\Clover-link\\resources\\daemon\\clover-core.exe"))
      .toEqual(["C:\\Clover-link", "C:\\Program Files\\Clover"]);
  });

  test.skipIf(process.platform === "win32")("a compiled daemon started through a linked .app: execPath is resolved, argv0 keeps the link's spelling", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-argv0-")));
    const entry = join(root, "probe.ts");
    writeFileSync(entry, `import { realpathSync } from "node:fs";\nimport { appInstallDirsFor } from ${JSON.stringify(join(import.meta.dir, "../../src/platform/app-resources"))};\nconsole.log(JSON.stringify({ execPath: process.execPath, dirs: appInstallDirsFor(process.execPath, true, process.platform, realpathSync, "/nonexistent-home", process.argv0) }));\n`);
    const bin = join(root, "Real.app", "Contents", "Resources", "daemon", "clover-core");
    const built = Bun.spawnSync([process.execPath, "build", "--compile", "--no-macros", entry, "--outfile", bin], { stderr: "pipe" });
    expect(built.exitCode, new TextDecoder().decode(built.stderr)).toBe(0);
    symlinkSync(join(root, "Real.app"), join(root, "Link.app"));
    const run = Bun.spawnSync([join(root, "Link.app", "Contents", "Resources", "daemon", "clover-core")], { stdout: "pipe", stderr: "pipe" });
    const got = JSON.parse(new TextDecoder().decode(run.stdout)) as { execPath: string; dirs: string[] };
    expect(got.execPath).toBe(bin); // Bun resolved it: the link's spelling is gone from execPath
    const expected = process.platform === "darwin" ? [join(root, "Link.app"), join(root, "Real.app")] : [join(root, "Link.app", "Contents"), join(root, "Real.app", "Contents")];
    expect(got.dirs).toEqual(expected);
  }, 120_000);
});

describe("the install is fenced like runtimes", () => {
  test("the whole bundle: the sandbox, the write tools, their deny rules and the escape floor on any mention", () => {
    restore = setAppInstallDirs([A]);
    expect(sandboxConfigFor(H).filesystem!.denyWrite).toContain(A);
    expect(homeFenceFor(H).dirs).toContain(A);
    expect(controlPlaneDenyRules(H).some((r) => r.startsWith("Write(") && r.includes(`${A}/**`))).toBe(true);
    for (const f of [`${A}/Contents/MacOS/Clover`, `${A}/Contents/Frameworks/Electron Framework.framework/x`, `${A}/Contents/Info.plist`, `/APPLICATIONS/clover.app/Contents/Info.plist`]) {
      expect(controlPlaneTargetForCall("Write", { file_path: f }, "/", homeFenceFor(H)), f).not.toBeNull();
    }
    for (const cmd of [`cp x "${A}/Contents/MacOS/Clover"`, `plutil -replace x -string y ${A}/Contents/Info.plist`, `ls /applications/CLOVER.app/Contents/Frameworks`]) {
      expect(escapeFloorHit(cmd, H), cmd).toBeDefined();
    }
    expect(escapeFloorHit("ls /Applications/Other.app/Contents", H)).toBeUndefined();
  });

  test("a linked bundle's own spelling is refused too", () => {
    restore = setAppInstallDirs(appInstallDirsFor("/Applications/Link.app/Contents/Resources/daemon/clover-core", true, "darwin", (p) => p.replace("/Link.app/", "/Real.app/"), "/Users/x"));
    for (const cmd of ["echo x > /Applications/Link.app/Contents/Resources/plugins/clover/index.js", "echo x > /applications/real.app/Contents/Info.plist"]) {
      expect(escapeFloorHit(cmd, H), cmd).toBeDefined();
    }
    expect(sandboxConfigFor(H).filesystem!.denyWrite).toEqual(expect.arrayContaining(["/Applications/Link.app", "/Applications/Real.app"]));
  });

  test("the resources folder inside it, as before", () => {
    restore = setAppInstallDirs([A]);
    for (const f of [`${R}/plugins/clover/manifest.json`, `${R}/plugins/clover/hooks/x.js`, `${R}/daemon/clover-core`]) {
      expect(controlPlaneTargetForCall("Write", { file_path: f }, "/", homeFenceFor(H)), f).not.toBeNull();
      expect(controlPlaneTargetForCall("Edit", { file_path: f, old_string: "a", new_string: "b" }, "/", homeFenceFor(H)), f).not.toBeNull();
    }
    for (const cmd of [
      `echo x > ${R}/plugins/clover/hooks/x.js`, `cp evil.js ${R}/plugins/clover/index.js`, `rm -rf ${R}/plugins`,
      `python3 -c "open('${R}/plugins/clover/index.js','w').write('x')"`, `ls ${R}/plugins`, `cat ${R}/daemon/clover-core`,
    ]) expect(escapeFloorHit(cmd, H), cmd).toBeDefined();
    // Elsewhere stays free.
    expect(escapeFloorHit("ls /Applications", H)).toBeUndefined();
    expect(controlPlaneTargetForCall("Write", { file_path: "/Users/x/notes.md" }, "/", homeFenceFor(H))).toBeNull();
  });

  test("without an install (from source, a server) nothing extra is fenced", () => {
    restore = setAppInstallDirs([]);
    expect(sandboxConfigFor(H).filesystem!.denyWrite).not.toContain(A);
    expect(escapeFloorHit(`ls ${R}/plugins`, H)).toBeUndefined();
  });

  test("Clover's own fence: write-denied as plugins, reads free", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-res-fence-")));
    const res = join(root, "Clover.app", "Contents", "Resources");
    mkdirSync(join(res, "plugins", "clover"), { recursive: true });
    const app = join(root, "Clover.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    const fence = new CloverFence({ home: join(root, "home"), cloverHome: join(root, "home", ".clover"), temp: join(root, "tmp"), appResources: [app] });
    for (const p of [join(res, "plugins", "clover", "index.js"), join(app, "Contents", "MacOS", "Clover"), join(app, "Contents", "Info.plist")]) {
      expect(fence.check({ op: "write", path: p }), p).toMatchObject({ allowed: false, reason: "plugins" });
    }
    expect(fence.check({ op: "delete", path: join(res, "plugins") })).toMatchObject({ allowed: false });
    expect(fence.check({ op: "read", path: join(res, "plugins", "clover", "index.js") })).toMatchObject({ allowed: true });
    // Windows and Linux: the install folder, its executable and libraries beside the resources.
    const opt = join(root, "opt", "Clover");
    mkdirSync(join(opt, "resources", "daemon"), { recursive: true });
    const linux = new CloverFence({ os: "linux", home: join(root, "home"), cloverHome: join(root, "home", ".clover"), temp: join(root, "tmp"), appResources: [opt] });
    for (const p of [join(opt, "clover"), join(opt, "libffmpeg.so"), join(opt, "resources", "daemon", "clover-core")]) {
      expect(linux.check({ op: "write", path: p }), p).toMatchObject({ allowed: false, reason: "plugins" });
    }
    expect(linux.check({ op: "write", path: join(root, "opt", "Other", "x") })).toEqual({ allowed: true });
  });
});
