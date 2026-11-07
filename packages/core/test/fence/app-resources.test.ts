// C-M3 item 5: the app's resources folder (the bundled plugins, approved without a card, and the daemon) is fenced like
// `runtimes`: the sandbox's denyWrite, the escape floor on any mention, the write tools and their deny rules, and
// Clover's own fence. A server's `<home>/bin` is fenced the same way (fences-ws21.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appResourcesDirFor, appResourcesDirs, setAppResourcesDirs } from "../../src/platform/app-resources";
import { controlPlaneDenyRules, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { escapeFloorHit } from "../../src/runtime-sdk/hooks";
import { controlPlaneTargetForCall } from "../../src/runtime-sdk/control-plane";
import { homeFenceFor } from "../../src/runtime-sdk/home-fence";
import { CloverFence } from "../../src/fence/fence";

const H = "/Users/x/.clover";
const R = "/Applications/Clover.app/Contents/Resources";
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
    expect(appResourcesDirs()).toEqual([]); // the test runner isn't a compiled daemon
    if (process.platform !== "win32") {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-res-")));
      mkdirSync(join(root, "App", "resources", "daemon"), { recursive: true });
      writeFileSync(join(root, "App", "resources", "daemon", "clover-core"), "");
      symlinkSync(join(root, "App", "resources", "daemon", "clover-core"), join(root, "clover"));
      expect(appResourcesDirFor(join(root, "clover"), true)).toBe(join(root, "App", "resources"));
    }
  });
});

describe("the resources folder is fenced like runtimes", () => {
  test("the sandbox, the write tools, their deny rules and the escape floor on any mention", () => {
    restore = setAppResourcesDirs([R]);
    expect(sandboxConfigFor(H).filesystem!.denyWrite).toContain(R);
    expect(homeFenceFor(H).dirs).toContain(R);
    for (const f of [`${R}/plugins/clover/manifest.json`, `${R}/plugins/clover/hooks/x.js`, `${R}/daemon/clover-core`]) {
      expect(controlPlaneTargetForCall("Write", { file_path: f }, "/", homeFenceFor(H)), f).not.toBeNull();
      expect(controlPlaneTargetForCall("Edit", { file_path: f, old_string: "a", new_string: "b" }, "/", homeFenceFor(H)), f).not.toBeNull();
    }
    expect(controlPlaneDenyRules(H).some((r) => r.startsWith("Write(") && r.includes("/Applications/Clover.app/Contents/Resources/**"))).toBe(true);
    for (const cmd of [
      `echo x > ${R}/plugins/clover/hooks/x.js`, `cp evil.js ${R}/plugins/clover/index.js`, `rm -rf ${R}/plugins`,
      `python3 -c "open('${R}/plugins/clover/index.js','w').write('x')"`, `ls ${R}/plugins`, `cat ${R}/daemon/clover-core`,
    ]) expect(escapeFloorHit(cmd, H), cmd).toBeDefined();
    // Elsewhere stays free.
    expect(escapeFloorHit("ls /Applications", H)).toBeUndefined();
    expect(controlPlaneTargetForCall("Write", { file_path: "/Users/x/notes.md" }, "/", homeFenceFor(H))).toBeNull();
  });

  test("without a resources folder (from source, a server) nothing extra is fenced", () => {
    restore = setAppResourcesDirs([]);
    expect(sandboxConfigFor(H).filesystem!.denyWrite).not.toContain(R);
    expect(escapeFloorHit(`ls ${R}/plugins`, H)).toBeUndefined();
  });

  test("Clover's own fence: write-denied as plugins, reads free", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-c-res-fence-")));
    const res = join(root, "Clover.app", "Contents", "Resources");
    mkdirSync(join(res, "plugins", "clover"), { recursive: true });
    const fence = new CloverFence({ home: join(root, "home"), cloverHome: join(root, "home", ".clover"), temp: join(root, "tmp"), appResources: [res] });
    expect(fence.check({ op: "write", path: join(res, "plugins", "clover", "index.js") })).toMatchObject({ allowed: false, reason: "plugins" });
    expect(fence.check({ op: "delete", path: join(res, "plugins") })).toMatchObject({ allowed: false });
    expect(fence.check({ op: "read", path: join(res, "plugins", "clover", "index.js") })).toMatchObject({ allowed: true });
  });
});
