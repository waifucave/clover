// The workshop (the coordinator's ruling for the owner's next test: a bot builds a plugin that hot-reloads, then a video
// editor plugin). A plugin whose install record says `provenance {by: "bot", bot}` (the bot installed it from its
// scratch with `PluginInstall`, on the user's OK card) is written by THAT bot's own conversation and side threads:
// inside `<home>/plugins/<id>/`, by its file tools, through the tree on any computer that holds it, and by its shell's
// sandbox. Never the plugin's folder itself (no rename or delete), never a `.git` in it, never another plugin, never a
// `node_modules` above the plugins, and never for its agents, another bot, a coding session or plugin code.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { fenceContextFor, policyAllows, type FenceOp } from "../../src/contracts/fence";
import { CloverFence } from "../../src/fence/fence";
import { macFenceProfile } from "../../src/fence/macos-profile";
import { callerPlaces } from "../../src/fence/per-caller";
import { botSandboxSettings, KEPT_FOLDER_PIN, sandboxSettingsOf } from "../../src/fence/sandbox-settings";
import { botSandbox } from "../../src/runtime-sdk/turn-loop/driver";
import { LocalHolder } from "../../src/tree/holder";
import { hostOs } from "../../src/tree/names";
import { darwinDescribe, darwinTest } from "../helpers/darwin-only";

const LUNA: Caller = { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" };
const LUNA_SIDE: Caller = { kind: "session", sessionId: "s_luna2", sessionKind: "side-thread", bot: "luna" };
const SOL: Caller = { kind: "session", sessionId: "s_sol", sessionKind: "bot", bot: "sol" };
const LUNA_AGENT: Caller = { kind: "session", sessionId: "s_agent", sessionKind: "agent", bot: "luna" };
const CODING: Caller = { kind: "session", sessionId: "s_code", sessionKind: "coding" };
const PLUGIN: Caller = { kind: "plugin", pluginId: "luna-cutter" };

const HOME = "/Users/me";
const CLOVER = `${HOME}/.clover`;
const CUTTER = `${CLOVER}/plugins/luna-cutter`;

/** The registry's install records: luna built `luna-cutter`; `fish-audio` came from an index. */
function records(built: { id: string; bot?: string }[]) {
  const fns = new Set<() => void>();
  let list = built.map((b) => ({ id: b.id, provenance: b.bot === undefined ? { by: "found" } : { by: "bot", bot: b.bot } }));
  return {
    list: () => list,
    watch: (fn: () => void) => { fns.add(fn); return () => fns.delete(fn); },
    set(next: { id: string; bot?: string }[]) {
      list = next.map((b) => ({ id: b.id, provenance: b.bot === undefined ? { by: "found" } : { by: "bot", bot: b.bot } }));
      for (const fn of fns) fn();
    },
  };
}

function fence(os: "macos" | "linux" = "macos") {
  const f = new CloverFence({ os, home: HOME, cloverHome: CLOVER, temp: "/tmp", canonical: (p) => p });
  const reg = records([{ id: "luna-cutter", bot: "luna" }, { id: "fish-audio" }, { id: "sol-tool", bot: "sol" }]);
  f.followWorkshop(reg);
  return { f, reg };
}
const may = (f: CloverFence, as: Caller, op: FenceOp) => f.forCaller(as).check(op).allowed;

describe("the workshop: a bot writes inside the plugins it built", () => {
  test("its main conversation and side threads write, remove and move inside its plugin", () => {
    const { f } = fence();
    for (const as of [LUNA, LUNA_SIDE]) {
      expect(may(f, as, { op: "write", path: `${CUTTER}/src/main.ts` })).toBe(true);
      expect(may(f, as, { op: "write", path: `${CUTTER}/manifest.json` })).toBe(true);
      expect(may(f, as, { op: "delete", path: `${CUTTER}/old.ts` })).toBe(true);
      expect(may(f, as, { op: "move", path: `${CUTTER}/a.ts`, to: `${CUTTER}/lib/a.ts` })).toBe(true);
      // Its own dependencies inside its plugin (a `bun install` there).
      expect(may(f, as, { op: "write", path: `${CUTTER}/node_modules/x/index.js` })).toBe(true);
      // In another case, on a disk that folds names.
      expect(may(f, as, { op: "write", path: `${CLOVER}/Plugins/Luna-Cutter/src/x.ts` })).toBe(true);
      // Reads, as before (a bot reads the home).
      expect(may(f, as, { op: "read", path: `${CUTTER}/src/main.ts` })).toBe(true);
    }
  });

  test("never the plugin's folder itself, a .git in it, another plugin, the plugins folder or a node_modules above it", () => {
    const { f } = fence();
    for (const op of [
      { op: "delete", path: CUTTER }, { op: "write", path: CUTTER }, { op: "move", path: CUTTER, to: `${CLOVER}/plugins/elsewhere` },
      { op: "move", path: `${CLOVER}/scratch/luna/x`, to: CUTTER },
      { op: "write", path: `${CUTTER}/.git/config` }, { op: "write", path: `${CUTTER}/.git/hooks/pre-commit` }, { op: "write", path: `${CUTTER}/sub/.GIT/HEAD` },
      { op: "write", path: `${CLOVER}/plugins/fish-audio/index.ts` }, { op: "write", path: `${CLOVER}/plugins/sol-tool/index.ts` },
      { op: "write", path: `${CLOVER}/plugins/new.json` }, { op: "delete", path: `${CLOVER}/plugins` },
      { op: "write", path: `${CLOVER}/plugins/node_modules/evil/index.js` }, { op: "write", path: `${CLOVER}/node_modules/evil/index.js` },
      { op: "write", path: `${CLOVER}/plugins-state/installed.json` },
      // Out of the plugin through `..`: judged where it lands.
      { op: "write", path: `${CUTTER}/../fish-audio/index.ts` },
    ] as FenceOp[]) {
      expect([op, may(f, LUNA, op)]).toEqual([op, false]);
    }
  });

  test("nobody else: another bot, its agents, a coding session, plugin code (its own included)", () => {
    const { f } = fence();
    for (const as of [SOL, LUNA_AGENT, CODING, PLUGIN]) {
      expect([as, may(f, as, { op: "write", path: `${CUTTER}/src/main.ts` })]).toEqual([as, false]);
    }
    // Sol's own plugin is Sol's.
    expect(may(f, SOL, { op: "write", path: `${CLOVER}/plugins/sol-tool/index.ts` })).toBe(true);
  });

  test("the records decide, read at each check: a removed plugin or a changed record closes it", () => {
    const { f, reg } = fence();
    let told = 0;
    f.watch(() => { told++; });
    expect(may(f, LUNA, { op: "write", path: `${CUTTER}/a.ts` })).toBe(true);
    reg.set([{ id: "luna-cutter" }]);
    expect(told).toBe(1);
    expect(may(f, LUNA, { op: "write", path: `${CUTTER}/a.ts` })).toBe(false);
    reg.set([]);
    expect(may(f, LUNA, { op: "write", path: `${CUTTER}/a.ts` })).toBe(false);
    // A fence with no records (none followed) has no workshop.
    const bare = new CloverFence({ os: "macos", home: HOME, cloverHome: CLOVER, temp: "/tmp", canonical: (p) => p });
    expect(may(bare, LUNA, { op: "write", path: `${CUTTER}/a.ts` })).toBe(false);
    // An id that isn't a plugin id never builds a way in.
    const odd = new CloverFence({ os: "macos", home: HOME, cloverHome: CLOVER, temp: "/tmp", canonical: (p) => p, workshopOf: () => ["..", "../settings", ""] });
    expect(may(odd, LUNA, { op: "write", path: `${CLOVER}/settings.json` })).toBe(false);
    expect(odd.policy(fenceContextFor(LUNA)).ownPlugins).toBeUndefined();
  });

  test("the shell's sandbox: the plugin a write root, the folder itself and its .git held; the reference agrees", () => {
    for (const os of ["macos", "linux"] as const) {
      const { f } = fence(os);
      const policy = f.forCaller(LUNA).policy();
      expect(policy.ownPlugins).toEqual([CUTTER]);
      expect(f.forCaller(SOL).policy().ownPlugins).toEqual([`${CLOVER}/plugins/sol-tool`]);
      for (const as of [LUNA_AGENT, CODING, PLUGIN]) expect(f.forCaller(as).policy().ownPlugins).toBeUndefined();
      expect(policyAllows(policy, "write", `${CUTTER}/src/a.ts`, os)).toBe(true);
      expect(policyAllows(policy, "write", `${CUTTER}/.git/config`, os)).toBe(false);
      expect(policyAllows(policy, "rename", CUTTER, os)).toBe(false);
      expect(policyAllows(policy, "unlink", CUTTER, os)).toBe(false);
      expect(policyAllows(policy, "write", `${CLOVER}/plugins/fish-audio/a.ts`, os)).toBe(false);
      // The bot's Bash sandbox (the runtime's settings): the plugin kept, its own entry pinned, the plugins folder's
      // other entries still denied.
      const disk: Record<string, string[]> = { [`${CLOVER}/plugins`]: ["luna-cutter", "fish-audio", "sol-tool"], [CLOVER]: ["plugins", "scratch", "bots"] };
      const fs = sandboxSettingsOf(policy, CLOVER, { list: (d) => disk[d] ?? [], plain: () => true, file: () => false }).filesystem!;
      expect(fs.allowWrite).toContain(CUTTER);
      expect(fs.denyWrite).toContain(`${CUTTER}/${KEPT_FOLDER_PIN}`);
      expect(fs.denyWrite).toContain(`${CLOVER}/plugins/fish-audio`);
      expect(fs.denyWrite).not.toContain(`${CLOVER}/plugins`);
    }
  });
});

const temps: { dir: string; locked: string[] }[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) {
    for (const l of t.locked) { try { chmodSync(l, 0o700); } catch { /* gone */ } }
    rmSync(t.dir, { recursive: true, force: true });
  }
});

/** A user's home on this disk, its Clover home with Luna's plugin and another, and the fence following their records. */
function onDisk() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "workshop-home-")));
  const t = { dir: home, locked: [] as string[] };
  temps.push(t);
  const clover = join(home, ".clover");
  for (const d of ["plugins/luna-cutter/src", "plugins/fish-audio", "scratch/luna", "bots/luna/memory", "Desktop", "Library/Mail/V10"]) mkdirSync(join(d.startsWith("Desktop") || d.startsWith("Library") ? home : clover, d), { recursive: true });
  writeFileSync(join(clover, "plugins/luna-cutter/manifest.json"), "{}");
  writeFileSync(join(clover, "plugins/fish-audio/manifest.json"), "{}");
  const f = new CloverFence({ home, cloverHome: clover });
  f.followWorkshop(records([{ id: "luna-cutter", bot: "luna" }, { id: "fish-audio" }]));
  return { home, clover, f, cutter: join(clover, "plugins", "luna-cutter"), lock: (rel: string) => { chmodSync(join(home, rel), 0o000); t.locked.push(join(home, rel)); } };
}

describe("the workshop on the holder (every computer's tree)", () => {
  test("Luna's sessions write, move and remove inside its plugin through the tree; the folder, a .git and another plugin refuse", async () => {
    const { home, clover, f, cutter } = onDisk();
    const h = new LocalHolder({
      clock: { now: () => Date.now() }, name: () => "Studio", home, os: hostOs(), cloverHome: clover, botsRoot: join(clover, "bots"),
      runsBot: (b) => b === "luna" || b === "sol", fence: f,
    });
    const at = (rel: string) => `home/Studio/.clover/plugins/luna-cutter/${rel}`;
    const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
    const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";
    for (const as of [LUNA, LUNA_SIDE]) {
      await h.write(at("src/main.ts"), utf8("export {}"), { as });
      expect(readFileSync(join(cutter, "src/main.ts"), "utf8")).toBe("export {}");
      await h.move(at("src/main.ts"), at("src/index.ts"), { as });
      await h.remove(at("src/index.ts"), { as });
      expect(existsSync(join(cutter, "src/index.ts"))).toBe(false);
    }
    expect(await code(h.write(at(".git/config"), utf8("x"), { as: LUNA }))).toBe("fenced");
    expect(await code(h.remove("home/Studio/.clover/plugins/luna-cutter", { as: LUNA, recursive: true }))).toBe("fenced");
    expect(await code(h.write("home/Studio/.clover/plugins/fish-audio/index.ts", utf8("x"), { as: LUNA }))).toBe("fenced");
    for (const as of [SOL, LUNA_AGENT, CODING]) expect([as, await code(h.write(at("src/x.ts"), utf8("x"), { as }))]).toEqual([as, "fenced"]);
    expect(existsSync(join(cutter, "manifest.json"))).toBe(true);
  });
});

/** The installed runtime's own `hostCodePathAllowed` (see runtime-deny-forms.darwin.test.ts). */
async function runtimeCheck(): Promise<(path: string, access: "read" | "write", settings?: unknown) => boolean> {
  const dist = dirname(Bun.resolveSync("@waifucave/clover-agent-runtime", import.meta.dir));
  for (const f of readdirSync(dist)) {
    if (!f.endsWith(".js") || !readFileSync(join(dist, f), "utf8").includes("function hostCodePathAllowed(")) continue;
    const mod = await import(join(dist, f)) as { hostCodePathAllowed?: (p: string, a: "read" | "write", s?: unknown) => boolean };
    if (typeof mod.hostCodePathAllowed === "function") return mod.hostCodePathAllowed;
  }
  throw new Error("the installed runtime has no hostCodePathAllowed");
}

darwinDescribe("the workshop in the sandboxes, on a Mac", () => {
  test("the bot's file tools, as the runtime checks them, with ~/Library/Mail closed to Clover: inside its plugin yes; .git, the pin and another plugin no", async () => {
    const allowed = await runtimeCheck();
    const { home, clover, f, cutter, lock } = onDisk();
    lock("Library/Mail");
    const drawn = botSandboxSettings(f.forCaller(LUNA).policy(), { cloverHome: clover, userHome: home, level: undefined, ownFolders: [join(clover, "scratch", "luna")], pathFolders: [] });
    expect(drawn.filesystem!.allowWrite).toContain(cutter);
    const s = botSandbox(drawn, { userHome: home, os: "macos" });
    expect(allowed(join(cutter, "src", "main.ts"), "write", s)).toBe(true);
    expect(allowed(join(home, "Desktop", "a.md"), "write", s)).toBe(true);
    for (const p of [join(cutter, ".git", "config"), join(cutter, KEPT_FOLDER_PIN), join(clover, "plugins", "fish-audio", "x.ts"), join(home, "Library/Mail/V10/x")]) {
      expect([p, allowed(p, "write", s)]).toEqual([p, false]);
    }
  });

  darwinTest("the fenced process's profile (a bot's Bash on a computer it doesn't run on), live under sandbox-exec", () => {
    const { home, clover, f, cutter } = onDisk();
    const ctx = f.contextFor(LUNA);
    const policy = f.policy(ctx);
    const profile = macFenceProfile({ cloverHome: clover, home, perUserTemp: null, caller: callerPlaces(clover, "macos", ctx), policy });
    const sh = (script: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...args], { encoding: "utf8" });
    const made = sh('printf x > "$1/a.ts" && mkdir "$1/lib" && printf y > "$1/lib/b.ts"', join(cutter, "src")); expect([made.status, made.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(cutter, "src", "a.ts"), "utf8")).toBe("x");
    expect(readFileSync(join(cutter, "src", "lib", "b.ts"), "utf8")).toBe("y");
    expect(sh('mkdir "$1"', join(cutter, ".git")).status).not.toBe(0);
    expect(existsSync(join(cutter, ".git"))).toBe(false);
    expect(sh('mv "$1" "$2"', cutter, join(clover, "plugins", "moved")).status).not.toBe(0);
    // `rm -rf` empties it (its insides are the bot's) but the folder itself stays.
    expect(sh('rm -rf "$1"', cutter).status).not.toBe(0);
    expect(existsSync(cutter)).toBe(true);
    expect(sh('printf x > "$1"', join(clover, "plugins", "fish-audio", "x.ts")).status).not.toBe(0);
    // Sol's sandbox reaches none of it.
    const solCtx = f.contextFor(SOL);
    const solProfile = macFenceProfile({ cloverHome: clover, home, perUserTemp: null, caller: callerPlaces(clover, "macos", solCtx), policy: f.policy(solCtx) });
    expect(spawnSync("/usr/bin/sandbox-exec", ["-p", solProfile, "/bin/sh", "-c", 'printf x > "$1"', "sh", join(cutter, "b.ts")]).status).not.toBe(0);
    expect(existsSync(join(cutter, "b.ts"))).toBe(false);
  });
});
