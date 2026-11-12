// Picked files (the coordinator's ruling for the owner's video-editor test, agreed with lane G): a file or folder the
// user picked in a plugin's page is THAT plugin's to reach, through its host half's `files.*` (`grant:<uuid>` paths),
// `files.path` for a program it starts, and its own processes' fence; nothing else of the user's comes with it, no
// other plugin reaches it, and a grant can never be the disk, the home, Clover's folder, a secret place, a fenced place
// or a folder holding one. Kept until the user removes it or the plugin goes.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filesApiRoutes } from "../../src/computers/api";
import { CloverFence } from "../../src/fence/fence";
import { grantFiles, grantRefusal, pluginGrantMethods, PluginGrants } from "../../src/fence/plugin-grants";
import { pluginFenceProfile } from "../../src/registry/plugin-fence";
import type { CoreTree } from "../../src/tree/tree";
import { darwinTest } from "../helpers/darwin-only";

const T1 = "grant:11111111-1111-4111-8111-111111111111";
const T2 = "grant:22222222-2222-4222-8222-222222222222";
const T3 = "grant:33333333-3333-4333-8333-333333333333";
const T4 = "grant:44444444-4444-4444-8444-444444444444";

const temps: { dir: string; locked: string[] }[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) {
    for (const l of t.locked) { try { chmodSync(l, 0o700); } catch { /* gone */ } }
    rmSync(t.dir, { recursive: true, force: true });
  }
});

/** A user's home with a video, an export folder, secret places (Mail closed to this process) and a Clover home. */
function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "grants-home-")));
  const t = { dir: home, locked: [] as string[] };
  temps.push(t);
  const clover = join(home, ".clover");
  for (const d of ["Movies/project", "Movies/export", ".ssh", "Library/Mail/V10", ".clover/plugins/cutter", ".clover/plugins-state"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "Movies/project/clip.mp4"), "VIDEO");
  writeFileSync(join(home, "Movies/other.mp4"), "OTHER");
  writeFileSync(join(home, ".ssh/id_ed25519"), "KEY");
  writeFileSync(join(home, ".zshrc"), "# shell");
  const fenced = () => new CloverFence({ home, cloverHome: clover }).fencedSet();
  const grants = new PluginGrants({ cloverHome: clover, userHome: home, fenced, installed: (id) => id === "cutter" || id === "other", now: () => 1000 });
  return { home, clover, grants, fenced, lock: (rel: string) => { chmodSync(join(home, rel), 0o000); t.locked.push(join(home, rel)); } };
}

describe("plugin.grant.add: what a pick can be", () => {
  test("a file to open, a file to save that isn't there yet, an export folder", () => {
    const { home, grants } = world();
    expect(grants.add({ pluginId: "cutter", token: T1, path: join(home, "Movies/project/clip.mp4"), kind: "file", access: "read" })).toMatchObject({ path: join(home, "Movies/project/clip.mp4"), access: "read" });
    expect(grants.add({ pluginId: "cutter", token: T2, path: join(home, "Movies/cut.mp4"), kind: "file", access: "write" })).toMatchObject({ path: join(home, "Movies/cut.mp4") });
    expect(grants.add({ pluginId: "cutter", token: T3, path: join(home, "Movies/export"), kind: "folder", access: "write" })).toMatchObject({ kind: "folder" });
    expect(grants.list("cutter").map((g) => g.token)).toEqual([T1, T2, T3]);
    expect(grants.list("other")).toEqual([]);
  });

  test("never the disk, the home, a folder holding it, Clover's folder or anything in it, a secret place, a fenced place, or a folder holding one", () => {
    const { home, clover, grants, lock } = world();
    lock("Library/Mail");
    const refused = (path: string, kind: "file" | "folder" = "folder", access: "read" | "write" = "read") => {
      try { grants.add({ pluginId: "cutter", token: T4, path, kind, access }); return "added"; } catch (e) { return (e as { code?: string }).code ?? "threw"; }
    };
    for (const p of ["/", home, dirname(home), clover, join(clover, "plugins"), join(clover, "plugins/cutter"), join(home, ".ssh"), join(home, "Library"), join(home, "Library/Mail")]) {
      expect([p, refused(p)]).toEqual([p, "refused"]);
    }
    for (const p of [join(home, ".ssh/id_ed25519"), join(home, ".zshrc"), join(clover, "settings.json"), join(home, "Library/Mail/V10/inbox.mbox")]) {
      expect([p, refused(p, "file", "write")]).toEqual([p, "refused"]);
    }
    // The sentence main shows.
    expect(grantRefusal(join(home, ".ssh"), { cloverHome: clover, userHome: home })).toContain("SSH");
    expect(grantRefusal(home, { cloverHome: clover, userHome: home })).toContain("whole home folder");
    // An unknown plugin, a malformed token, another plugin's token.
    const add = (pluginId: string, token: string) => { try { grants.add({ pluginId, token, path: join(home, "Movies/other.mp4"), kind: "file", access: "read" }); return "added"; } catch (e) { return (e as { code?: string }).code; } };
    expect(add("stranger", T1)).toBe("refused");
    expect(add("cutter", "grant:not-a-uuid")).toBe("invalid");
    expect(add("cutter", T1)).toBe("added");
    expect(add("other", T1)).toBe("refused");
    // Kind mismatches.
    expect(refused(join(home, "Movies/other.mp4"), "folder")).toBe("refused");
    expect(refused(join(home, "Movies/missing.mp4"), "file", "read")).toBe("refused");
    expect(grants.list("cutter").map((g) => g.token)).toEqual([T1]);
  });

  test("kept in the Clover home until the user removes it or the plugin goes", () => {
    const { home, clover, grants, fenced } = world();
    grants.add({ pluginId: "cutter", token: T1, path: join(home, "Movies/project/clip.mp4"), kind: "file", access: "read" });
    grants.add({ pluginId: "other", token: T2, path: join(home, "Movies/other.mp4"), kind: "file", access: "read" });
    expect(existsSync(join(clover, "plugins-state/grants.json"))).toBe(true);
    const again = new PluginGrants({ cloverHome: clover, userHome: home, fenced });
    expect(again.list("cutter").map((g) => g.token)).toEqual([T1]);
    expect(again.remove("cutter", T2)).toBe(false); // not cutter's
    expect(again.remove("cutter", T1)).toBe(true);
    expect(again.dropPlugin("other")).toBe(1);
    expect(new PluginGrants({ cloverHome: clover, userHome: home, fenced }).list("other")).toEqual([]);
  });

  test("the app's methods: adding and removing are the user's", async () => {
    const { home, grants } = world();
    const m = pluginGrantMethods(grants);
    const user = { caller: { kind: "user" } } as never;
    const plugin = { caller: { kind: "plugin", pluginId: "cutter" } } as never;
    const add = { pluginId: "cutter", token: T1, path: join(home, "Movies/project/clip.mp4"), kind: "file", access: "read" };
    await expect(m["plugin.grant.add"]!(add, plugin)).rejects.toBeDefined();
    expect(await m["plugin.grant.add"]!(add, user)).toMatchObject({ grant: { token: T1, kind: "file" } });
    expect(await m["plugin.grant.list"]!({ pluginId: "cutter" }, user)).toMatchObject({ grants: [{ token: T1 }] });
    expect(await m["plugin.grant.remove"]!({ pluginId: "cutter", token: T1 }, user)).toEqual({ removed: true });
  });
});

describe("a plugin's host half on what it was given", () => {
  function given() {
    const w = world();
    w.grants.add({ pluginId: "cutter", token: T1, path: join(w.home, "Movies/project/clip.mp4"), kind: "file", access: "read" });
    w.grants.add({ pluginId: "cutter", token: T2, path: join(w.home, "Movies/cut.mp4"), kind: "file", access: "write" });
    w.grants.add({ pluginId: "cutter", token: T3, path: join(w.home, "Movies/export"), kind: "folder", access: "write" });
    // A tree that answers nothing: a `grant:` path must never reach it.
    const tree = new Proxy({}, { get: () => () => { throw new Error("the tree was asked"); } }) as unknown as CoreTree;
    const files = grantFiles(w.grants);
    const routes = filesApiRoutes(tree, () => files);
    const call = async (name: string, args: unknown[], pluginId = "cutter") => {
      try { return { ok: await routes[name]!(args, { pluginId } as never) }; } catch (e) { return { err: (e as { code?: string; message?: string }).code ?? (e as Error).message }; }
    };
    return { ...w, call };
  }

  test("reads the file it was given to open, writes the one it was given to save, and fills the export folder", async () => {
    const { home, call } = given();
    expect(await call("files.readText", [T1])).toEqual({ ok: "VIDEO" });
    expect(await call("files.readBytes", [T1, { offset: 1, length: 2 }])).toEqual({ ok: new Uint8Array(Buffer.from("ID")) });
    expect(await call("files.stat", [T1])).toMatchObject({ ok: { path: T1, type: "file", size: 5 } });
    expect(await call("files.write", [T2, "CUT"])).toEqual({ ok: undefined });
    expect(readFileSync(join(home, "Movies/cut.mp4"), "utf8")).toBe("CUT");
    expect(await call("files.readText", [T2])).toEqual({ ok: "CUT" });
    expect(await call("files.write", [`${T3}/frames/0001.png`, new Uint8Array([1, 2, 3]), { createDirs: true }])).toEqual({ ok: undefined });
    expect(await call("files.list", [`${T3}/frames`])).toMatchObject({ ok: [{ path: `${T3}/frames/0001.png`, type: "file", size: 3 }] });
    // The real path, for ffmpeg.
    expect(await call("files.path", [T1])).toEqual({ ok: join(home, "Movies/project/clip.mp4") });
    expect(await call("files.path", [`${T3}/frames/0001.png`])).toEqual({ ok: join(home, "Movies/export/frames/0001.png") });
  });

  test("nothing more: no write on an open pick, nothing beside a file, no climbing, no link out, no other plugin, no remove or move", async () => {
    const { home, call } = given();
    symlinkSync(join(home, ".ssh"), join(home, "Movies/export/keys"));
    symlinkSync(join(home, "Movies/other.mp4"), join(home, "Movies/export/other.mp4"));
    for (const [name, args] of [
      ["files.write", [T1, "x"]], ["files.readText", [`${T1}/x`]], ["files.readText", [`${T3}/../other.mp4`]],
      ["files.readText", [`${T3}/keys/id_ed25519`]], ["files.write", [`${T3}/keys/id_ed25519`, "x"]], ["files.readText", [`${T3}/other.mp4`]],
      ["files.remove", [T1]], ["files.move", [T1, T2]], ["files.glob", ["*", { cwd: T3 }]],
    ] as const) {
      const r = await call(name, [...args]);
      expect([name, args, "err" in r]).toEqual([name, args, true]);
    }
    expect(readFileSync(join(home, ".ssh/id_ed25519"), "utf8")).toBe("KEY");
    expect(readFileSync(join(home, "Movies/project/clip.mp4"), "utf8")).toBe("VIDEO");
    // Another plugin holding the token gets nothing.
    expect(await call("files.readText", [T1], "other")).toEqual({ err: "not_found" });
    expect(await call("files.path", [T1], "other")).toEqual({ err: "not_found" });
  });
});

describe("the plugin's own processes", () => {
  test("their fence opens the picks: open picks read, save picks and export folders read and written; a moved pick drops out", () => {
    const { home, grants } = world();
    grants.add({ pluginId: "cutter", token: T1, path: join(home, "Movies/project/clip.mp4"), kind: "file", access: "read" });
    grants.add({ pluginId: "cutter", token: T2, path: join(home, "Movies/cut.mp4"), kind: "file", access: "write" });
    grants.add({ pluginId: "cutter", token: T3, path: join(home, "Movies/export"), kind: "folder", access: "write" });
    expect(grants.fencePaths("cutter")).toEqual({ read: [join(home, "Movies/project/clip.mp4")], write: [join(home, "Movies/cut.mp4"), join(home, "Movies/export")] });
    expect(grants.fencePaths("other")).toEqual({ read: [], write: [] });
    // The export folder swapped for a link to the secret place: dropped.
    rmSync(join(home, "Movies/export"), { recursive: true });
    symlinkSync(join(home, ".ssh"), join(home, "Movies/export"));
    expect(grants.fencePaths("cutter").write).toEqual([join(home, "Movies/cut.mp4")]);
  });

  darwinTest("live under sandbox-exec: ffmpeg's stand-in reads the picked input, writes the picked output, and reaches nothing else", () => {
    const { home, clover, grants } = world();
    grants.add({ pluginId: "cutter", token: T1, path: join(home, "Movies/project/clip.mp4"), kind: "file", access: "read" });
    grants.add({ pluginId: "cutter", token: T2, path: join(home, "Movies/cut.mp4"), kind: "file", access: "write" });
    const picked = grants.fencePaths("cutter");
    const profile = pluginFenceProfile({ cloverHome: clover, userHome: home, read: [], write: [...picked.write], picked: picked.read, exec: "any" });
    const sh = (script: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...args], { encoding: "utf8" });
    const r = sh('cat "$1" > "$2"', join(home, "Movies/project/clip.mp4"), join(home, "Movies/cut.mp4"));
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(home, "Movies/cut.mp4"), "utf8")).toBe("VIDEO");
    expect(sh('cat "$1"', join(home, "Movies/other.mp4")).stdout).not.toContain("OTHER");
    expect(sh('cat "$1"', join(home, ".ssh/id_ed25519")).stdout).not.toContain("KEY");
    expect(sh('printf x > "$1"', join(home, "Movies/project/clip.mp4")).status).not.toBe(0);
    expect(readFileSync(join(home, "Movies/project/clip.mp4"), "utf8")).toBe("VIDEO");
    expect(sh('printf x > "$1"', join(home, "Movies/elsewhere.mp4")).status).not.toBe(0);
  });
});
