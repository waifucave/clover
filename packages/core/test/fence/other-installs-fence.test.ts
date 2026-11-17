// The old install is read-only for bots and plugins (the one-time copy's ruling 9): every other install's home (the
// installed old app's and its dev profile's among them) and the old app's data folders, built from `other-installs.ts`,
// are write-denied to every tool runner as places another install runs what is written there, outside MOSS's sandbox.
// Reads stay open. Temp homes only: the user's real home is never named.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRunPaths, fenceContextFor, type FenceContext } from "../../src/contracts/fence";
import { MossFence } from "../../src/fence/fence";
import { macFenceProfile } from "../../src/fence/macos-profile";
import { callerPlaces } from "../../src/fence/per-caller";
import { runLaterExtras } from "../../src/fence/run-later";
import { OTHER_INSTALL_APP_DATA_DIRS, OTHER_INSTALL_HOMES, OLD_INSTALL_DEV_HOME_DIR, OLD_INSTALL_HOME_DIR, otherInstallPlaces, otherInstallReadDenied } from "../../src/other-installs";
import { persistencePlaces } from "../../src/registry/plugin-fence";
import { darwinDescribe } from "../helpers/darwin-only";
import { persistencePaths } from "../../src/runtime-sdk/mode-options";

const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

describe("the other installs' places", () => {
  test("every home other-installs.ts lists, and the old app's data folders, on each OS", () => {
    expect(otherInstallPlaces("macos", "/Users/u")).toEqual([...OTHER_INSTALL_HOMES.map((o) => `/Users/u/${o.dir}`), ...OTHER_INSTALL_APP_DATA_DIRS.map((d) => `/Users/u/Library/Application Support/${d}`)]);
    expect(otherInstallPlaces("linux", "/home/u")).toContain(`/home/u/.config/${OTHER_INSTALL_APP_DATA_DIRS[0]}`);
    expect(otherInstallPlaces("windows", "C:\\Users\\u")).toContain(`C:\\Users\\u\\AppData\\Roaming\\${OTHER_INSTALL_APP_DATA_DIRS[0]}`);
    expect(otherInstallPlaces("macos", "/Users/u")).toEqual(expect.arrayContaining([`/Users/u/${OLD_INSTALL_HOME_DIR}`, `/Users/u/${OLD_INSTALL_DEV_HOME_DIR}`]));
  });

  test("they are on the shared run-later list, so the sandboxed Bash's denyWrite and the write tools' floor carry them", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "moss-other-installs-")));
    const listed = autoRunPaths(os, home, runLaterExtras(os, home));
    for (const p of otherInstallPlaces(os, home)) expect([p, listed.includes(p)]).toEqual([p, true]);
    for (const p of otherInstallPlaces(os, home)) expect([p, persistencePaths(home).includes(p)]).toEqual([p, true]);
    // Every fenced plugin process (its host half, hooks, stdio MCP servers) has them last in its profile.
    if (os !== "windows") for (const p of otherInstallPlaces(os, home)) expect([p, persistencePlaces(home, join(home, ".moss")).includes(p)]).toEqual([p, true]);
  });
});

describe("the fence refuses a write there for every kind of caller, and lets every read through", () => {
  const callers: [string, FenceContext][] = [
    ["a bot's conversation", fenceContextFor({ kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" })],
    ["a side thread", fenceContextFor({ kind: "session", sessionId: "s_side", sessionKind: "side-thread", bot: "alpha" })],
    ["a coding session", fenceContextFor({ kind: "session", sessionId: "s_code", sessionKind: "coding" })],
    ["a delegated agent", fenceContextFor({ kind: "session", sessionId: "s_agent", sessionKind: "agent" })],
    ["a plugin", fenceContextFor({ kind: "plugin", pluginId: "acceptance-echo" })],
    ["a bundled plugin", fenceContextFor({ kind: "plugin", pluginId: "moss/web" })],
    ["a peer (no context)", {}],
  ];
  const home = realpathSync(mkdtempSync(join(tmpdir(), "moss-other-installs-fence-")));
  const old = join(home, OLD_INSTALL_HOME_DIR);
  mkdirSync(join(old, "plugins"), { recursive: true });
  writeFileSync(join(old, "settings.json"), "{}\n");
  const fence = new MossFence({ os, home, mossHome: join(home, ".moss") });

  test.each(callers)("%s", (_name, ctx) => {
    for (const p of [join(old, "settings.json"), join(old, "plugins", "planted", "index.ts"), old, join(home, OLD_INSTALL_DEV_HOME_DIR, "x"), ...OTHER_INSTALL_APP_DATA_DIRS.map((d) => join(otherInstallPlaces(os, home).find((x) => x.endsWith(d))!, "Local Storage", "x"))]) {
      expect([p, fence.check({ op: "write", path: p }, ctx).allowed]).toEqual([p, false]);
      expect([p, fence.check({ op: "delete", path: p }, ctx).allowed]).toEqual([p, false]);
    }
    // A move out of it, and a move into it.
    expect(fence.check({ op: "move", path: join(old, "settings.json"), to: join(home, "stolen.json") }, ctx).allowed).toBe(false);
    expect(fence.check({ op: "move", path: join(home, "w.txt"), to: join(old, "w.txt") }, ctx).allowed).toBe(false);
    // `..` and case variants (APFS folds case).
    expect(fence.check({ op: "write", path: join(home, "w", "..", OLD_INSTALL_HOME_DIR, "x") }, ctx).allowed).toBe(false);
    if (os === "macos") expect(fence.check({ op: "write", path: join(home, OLD_INSTALL_HOME_DIR.toUpperCase(), "x") }, ctx).allowed).toBe(false);
    // The read-only level: reads stay free.
    expect(fence.check({ op: "read", path: join(old, "settings.json") }, ctx)).toEqual({ allowed: true });
    expect(fence.check({ op: "list", path: old }, ctx)).toEqual({ allowed: true });
    // A name that only starts like it is another folder.
    expect(fence.check({ op: "write", path: join(home, `${OLD_INSTALL_HOME_DIR}-notes`, "x") }, ctx).allowed).toBe(true);
  });

  test.each(callers)("%s: the old install's run folder, secret files and browser partitions can't be read either", (_name, ctx) => {
    for (const os2 of ["macos", "linux", "windows"] as const) {
      const h = os2 === "windows" ? "C:\\Users\\u" : os2 === "macos" ? "/Users/u" : "/home/u";
      const f = new MossFence({ os: os2, home: h, mossHome: os2 === "windows" ? `${h}\\.moss` : `${h}/.moss`, canonical: (q) => q });
      const denied = otherInstallReadDenied(os2, h);
      expect(denied.some((d) => d.kind === "browser-profiles")).toBe(true);
      expect(denied.filter((d) => d.kind === "secrets-file").length).toBe(os2 === "macos" ? 0 : OTHER_INSTALL_HOMES.length);
      for (const d of denied) {
        const inside = d.kind === "run-folder" || d.kind === "browser-profiles" ? `${d.path}${os2 === "windows" ? "\\" : "/"}x` : d.path;
        expect([os2, d.kind, inside, f.check({ op: "read", path: inside }, ctx).allowed]).toEqual([os2, d.kind, inside, false]);
        if (d.kind === "run-folder" || d.kind === "browser-profiles") expect(f.check({ op: "list", path: d.path }, ctx).allowed).toBe(false);
      }
      // The rest of the old home stays readable.
      const settings = os2 === "windows" ? `${h}\\${OLD_INSTALL_HOME_DIR}\\settings.json` : `${h}/${OLD_INSTALL_HOME_DIR}/settings.json`;
      expect(f.check({ op: "read", path: settings }, ctx)).toEqual({ allowed: true });
    }
    // On this computer's real fence too, by the same names.
    expect(fence.check({ op: "read", path: join(old, "run", "harness-token") }, ctx).allowed).toBe(false);
  });

  test("a link planted in a writable folder leads into it: refused where it lands", () => {
    mkdirSync(join(home, "w"), { recursive: true });
    symlinkSync(old, join(home, "w", "into-old"));
    const ctx = fenceContextFor({ kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" });
    expect(fence.check({ op: "write", path: join(home, "w", "into-old", "settings.json") }, ctx).allowed).toBe(false);
  });

  test("the old home not there yet: a write that would make it is refused as well", () => {
    const h2 = realpathSync(mkdtempSync(join(tmpdir(), "moss-other-installs-absent-")));
    const f2 = new MossFence({ os, home: h2, mossHome: join(h2, ".moss") });
    expect(f2.check({ op: "write", path: join(h2, OLD_INSTALL_HOME_DIR, "settings.json") }, {}).allowed).toBe(false);
    expect(f2.check({ op: "write", path: join(h2, OLD_INSTALL_HOME_DIR) }, {}).allowed).toBe(false);
  });

  test("deny wins over the user's home being writable (the rest of it stays writable)", () => {
    expect(fence.check({ op: "write", path: join(home, "Documents", "x.md") }, {}).allowed).toBe(true);
    expect(fence.check({ op: "write", path: join(old, "settings.json") }, {}).allowed).toBe(false);
  });
});

describe("a sandboxed command can't write it (the session sandbox's denyWrite)", () => {
  test("the runtime's denyWrite takes the persistence list, which names each place (a temp user home: the real one is never named)", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "moss-other-installs-deny-")));
    const listed = persistencePaths(home);
    for (const p of otherInstallPlaces(os, home)) expect([p, listed.includes(p)]).toEqual([p, true]);
    // The session sandbox's denyWrite is built from that same list (`protectedHomeDenyWrite`, test/fence/persistence.test.ts).
  });
});

darwinDescribe("the fence's own Seatbelt, as a bot's and a plugin's commands run under it", () => {
  test("write, rename the folder away, plant a link, make it when absent, case and `..`: each refused; reads go through", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "moss-other-installs-sb-")));
    const at = (...p: string[]) => join(home, ...p);
    const old = at(OLD_INSTALL_HOME_DIR);
    mkdirSync(join(old, "plugins"), { recursive: true });
    mkdirSync(at("w"), { recursive: true });
    writeFileSync(join(old, "settings.json"), "PROBE_SECRET=dummy123\n");
    const run = (profile: string, script: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...args], { encoding: "utf8" });
    for (const ctx of [fenceContextFor({ kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" }), fenceContextFor({ kind: "plugin", pluginId: "acceptance-echo" })]) {
      const fence = new MossFence({ os: "macos", home, mossHome: at(".moss"), temp: at("tmp") });
      const profile = macFenceProfile({ policy: fence.policy(ctx), mossHome: at(".moss"), home, perUserTemp: null, caller: callerPlaces(at(".moss"), "macos", ctx) });
      const refused = [
        ['printf x >> "$1"', join(old, "settings.json")],
        ['mkdir -p "$1"', join(old, "plugins", "planted")],
        ['mv "$1" "$1.away"', old],
        ['rm -rf "$1"', join(old, "plugins")],
        ['ln -s "$1" "$2" && printf x > "$2/planted.json"', old, at("w", "link")],
        ['printf x > "$1"', join(home, OLD_INSTALL_HOME_DIR.toUpperCase(), "x.json")],
        ['printf x > "$1"', join(home, "w", "..", OLD_INSTALL_HOME_DIR, "y.json")],
        ['mkdir -p "$1"', at(OLD_INSTALL_DEV_HOME_DIR, "sub")],
      ];
      for (const [script, ...args] of refused) expect([script, run(profile, script!, ...args).status === 0]).toEqual([script, false]);
      expect(readFileSync(join(old, "settings.json"), "utf8")).toBe("PROBE_SECRET=dummy123\n");
      expect(existsSync(`${old}.away`)).toBe(false);
      expect(existsSync(at(OLD_INSTALL_DEV_HOME_DIR))).toBe(false);
      // Reading it is free (the probe says only whether the dummy value was seen).
      const read = run(profile, 'cat "$1"', join(old, "settings.json"));
      expect(read.stdout.includes("dummy123")).toBe(true);
    }
  });
});
