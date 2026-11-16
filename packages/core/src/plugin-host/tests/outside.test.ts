// P5 (the owner, 2026-11-15: "Yes, named on the card"): a plugin's manifest names programs of the user's that its host
// half runs outside the plugin sandbox, and folders of the user's that it reads. On real plugin-host processes under the
// fence: the plugin that names them reads its named folder and nothing else of the user's, and its named program runs
// outside the fence (it reads a file the fence refuses the plugin); a program it doesn't name is refused. A plugin that
// names neither is refused both. A change to the list is a change card; OK'd, a new process has the new fence. Temp homes; nothing opens a window.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";
import { expandUserPath, findProgram, outsideApi, outsideReadFolders } from "../api/outside";
import { pluginToolContained, pluginToolReadOnly, pluginWebTool, treeRunsOutside } from "../../registry/read-only-tools";
import { darwinDescribe } from "../../../test/helpers/darwin-only";

const USER: Caller = { kind: "user", client: "app" };
const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (cond()) return; await Bun.sleep(20); }
  throw new Error(`never: ${what}`);
}

const HOST = `
import { readFileSync } from "node:fs";
let api;
export async function start(a) { api = a; }
export async function stop() {}
export const read = async (args) => {
  try { return { ok: true, text: readFileSync(args.path, "utf8") }; } catch (e) { return { ok: false, err: String((e && e.code) || (e && e.message) || e) }; }
};
export const run = async (args) => {
  try { const r = await api.outside.run(args.program, args.args || []); return { ok: true, code: r.code, out: r.stdout }; } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 300) }; }
};
export const pid = async () => process.pid;
`;

function plugin(home: string, id: string, host: Record<string, unknown>, version = "1.0.0"): void {
  const root = join(home, "plugins", id);
  mkdirSync(join(root, "host"), { recursive: true });
  writeFileSync(join(root, "moss.json"), JSON.stringify({ manifest: 1, id, name: id, version, engines: { moss: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", process: "own", ...host } }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "host", "index.js"), HOST);
}

test("the folders it names: in the user's home, never the whole home or the MOSS home; a program by name on the PATH", () => {
  const userHome = temp("cf-out-user-");
  const mossHome = join(userHome, ".moss");
  mkdirSync(join(userHome, "Notes"), { recursive: true });
  mkdirSync(mossHome, { recursive: true });
  const rec = (read: string[]) => ({ manifest: { host: { outside: { read } } } }) as never;
  expect(outsideReadFolders(rec(["~/Notes"]), { userHome, mossHome })).toEqual([join(userHome, "Notes")]);
  expect(outsideReadFolders(rec(["~/.moss", "~/.moss/secrets", "~"]), { userHome, mossHome })).toEqual([]);
  expect(outsideReadFolders(rec([userHome]), { userHome, mossHome })).toEqual([]);
  // A folder that holds the home (the reviewer's read 44: `/Users` opened the whole home) is never opened.
  expect(outsideReadFolders(rec([join(userHome, ".."), "/"]), { userHome, mossHome })).toEqual([]);
  expect(expandUserPath("~/a/b", "/Users/x")).toBe("/Users/x/a/b");
  const bin = temp("cf-out-bin-");
  writeFileSync(join(bin, "probe"), "#!/bin/sh\necho hi\n");
  chmodSync(join(bin, "probe"), 0o755);
  writeFileSync(join(bin, "plain"), "not a program");
  expect(findProgram("probe", `/nonexistent:${bin}`)).toBe(join(bin, "probe"));
  expect(findProgram("plain", bin)).toBeUndefined();
  expect(findProgram("/bin/cat", undefined)).toBe("/bin/cat");
});

test("\"of yours\": a program in MOSS's folder, the plugin's own or one it can write is refused, by its path or on the PATH; never run in MOSS's folder", async () => {
  const userHome = temp("cf-out-user-");
  const mossHome = join(userHome, ".moss");
  const own = join(mossHome, "plugins", "gitter");
  const picked = temp("cf-out-picked-");
  const bin = temp("cf-out-bin-");
  const mossBin = join(mossHome, "bin");
  for (const d of [own, mossBin, picked, bin]) mkdirSync(d, { recursive: true });
  const exe = (dir: string, name: string) => {
    writeFileSync(join(dir, name), "#!/bin/sh\necho ran\n");
    chmodSync(join(dir, name), 0o755);
    return join(dir, name);
  };
  const inMoss = exe(mossBin, "tool");
  const inOwn = exe(own, "tool");
  const inPick = exe(picked, "tool");
  exe(bin, "tool");
  const programs = [inMoss, inOwn, inPick, "tool"];
  const api = outsideApi({ userHome, mossHome, path: () => `${mossBin}:${bin}`, writable: () => [picked] });
  const ctx = { pluginId: "gitter", record: { manifest: { host: { outside: { programs } } }, folder: own } } as never;
  const run = (args: unknown[]) => (api["outside.run"] as (c: unknown, a: unknown[]) => Promise<{ code: number; stdout: string }>)(ctx, args);
  const refused = async (args: unknown[]) => { try { await run(args); return "ran"; } catch (e) { return (e as Error).message; } };
  for (const p of [inMoss, inOwn, inPick]) expect(await refused([p])).toContain("isn't a program of yours");
  // A bare name skips the PATH folder inside MOSS's home and finds the user's own.
  expect(findProgram("tool", `${mossBin}:${bin}`, [mossHome])).toBe(join(bin, "tool"));
  expect(await run(["tool"])).toMatchObject({ code: 0, stdout: "ran\n" });
  // Run in the user's home by default; never in MOSS's folder.
  expect(await refused(["tool", [], { cwd: mossBin }])).toContain("MOSS's own folder");
  expect(await run(["tool", [], { cwd: bin }])).toMatchObject({ code: 0 });
});

test("a tree that names programs outside its sandbox has no card-free tool: read-only, display-only, web and Browser lists, the build's copy's too", () => {
  const server = { type: "host", tools: { status: "preload", show: "preload", find: "preload", page: "preload", surf: "preload" }, readOnly: ["status"], contained: ["show"], webSearch: ["find"], webFetch: ["page"], browserTools: ["surf"] };
  const record = (id: string, outside: boolean) => ({
    id, state: "running", enabled: true, dev: false, okHash: "sha256:a", treeHash: "sha256:a", capabilities: [], granted: ["browser"], provenance: {}, source: "bundled",
    manifest: { host: { entry: "host/index.js", process: "own", ...(outside ? { outside: { programs: ["git"] } } : {}) }, contributes: { mcpServers: { tools: server } } },
  });
  const records = [record("plain", false), record("gitter", true)];
  const reg = { get: (id: string) => records.find((r) => r.id === id), list: () => records } as never;
  expect([treeRunsOutside(reg, "plain"), treeRunsOutside(reg, "gitter")]).toEqual([false, true]);
  const lists = (id: string, built?: () => boolean) => [
    pluginToolReadOnly(reg, id, "tools", "status", { fenced: true, ...(built ? { built } : {}) }),
    pluginToolContained(reg, id, "tools", "show", { fenced: true }),
    pluginWebTool(reg, id, "tools", "find", built ? { built } : {}) ?? false,
    pluginWebTool(reg, id, "tools", "page", built ? { built } : {}) ?? false,
    pluginWebTool(reg, id, "tools", "surf", built ? { built } : {}) ?? false,
  ];
  expect(lists("plain")).toEqual([true, true, "web-search", "web-fetch", "browser"]);
  expect(lists("gitter")).toEqual([false, false, false, false, false]);
  expect(lists("gitter", () => true)).toEqual([false, false, false, false, false]);
});

test("a named folder that holds the user's home or MOSS's, or lies in MOSS's, is refused with why: at install and when its folder is read", async () => {
  const { validatePluginFolder } = await import("../../registry/validate");
  const { readPluginFolder } = await import("../../registry/folders");
  const { installStaged } = await import("../../registry/install-folder");
  const top = temp("cf-out-homes-");
  const userHome = join(top, "user");
  const mossHome = join(userHome, ".moss");
  mkdirSync(join(mossHome, "plugins"), { recursive: true });
  mkdirSync(join(userHome, "Notes"), { recursive: true });
  const homes = { userHome, mossHome };
  const write = (name: string, read: string[]) => {
    const dir = join(top, "src", name);
    mkdirSync(join(dir, "host"), { recursive: true });
    writeFileSync(join(dir, "moss.json"), JSON.stringify({ manifest: 1, id: name, name, version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", process: "own", outside: { read } } }));
    writeFileSync(join(dir, "package.json"), "{\"type\":\"module\"}");
    writeFileSync(join(dir, "host", "index.js"), "export async function start() {}\n");
    return dir;
  };
  const codes = async (dir: string) => (await validatePluginFolder(dir, { os: "macos", homes })).issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`);
  expect(await codes(write("fine", ["~/Notes"]))).toEqual([]);
  expect(await codes(write("holder", [top]))).toEqual([`outside_folder_home: "${top}" holds your whole home folder, so it isn't a folder it may read outside its sandbox: name the folder inside your home that it needs`]);
  expect((await codes(write("mossish", ["~/.moss/plugins"])))[0]).toContain("is inside MOSS's own folder");
  // The registry reads it as invalid, with why.
  const read = await readPluginFolder(write("holder2", [userHome]), { source: "local", homes });
  expect(read.inputs[0]!.invalid).toContain("holds your whole home folder");
  // And an install is refused with the words.
  const refused = await installStaged(write("holder3", [top]), { pluginsDir: join(mossHome, "plugins"), stagingDir: join(top, "staging"), os: "macos", taken: () => false }).then(() => "installed", (e: Error) => e.message);
  expect(refused).toContain("isn't valid");
  expect(refused).toMatch(/holds (your whole home folder|MOSS's own folder)/);
});

darwinDescribe("programs and folders outside the sandbox (P5)", () => {
  test("a named folder: its other files read, never what a bot may not read (the coding agents' sign-ins, a password manager's, the browsers' stores: the plugin fence's last deny)", async () => {
    const home = temp("cf-out-");
    const userHome = temp("cf-out-user-");
    const files = {
      usage: join(userHome, ".codex", "sessions", "usage.jsonl"), auth: join(userHome, ".codex", "auth.json"), claudeUsage: join(userHome, ".claude", "stats.json"), claudeAuth: join(userHome, ".claude", ".credentials.json"),
      // A parent folder named: what a bot may never read stays out (a password manager's, a developer tool's sign-in, the
      // browsers' cookies), what's beside it reads.
      configApp: join(userHome, ".config", "app", "settings.json"), op: join(userHome, ".config", "op", "config"), gh: join(userHome, ".config", "gh", "hosts.yml"),
      notes: join(userHome, "Library", "Notes", "n.txt"), cookies: join(userHome, "Library", "Cookies", "Cookies.binarycookies"), onePassword: join(userHome, "Library", "Application Support", "1Password", "data.sqlite"),
    };
    for (const f of Object.values(files)) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, `contents of ${f.slice(userHome.length)}`);
    }
    plugin(home, "usage", { outside: { read: ["~/.codex", "~/.claude", "~/.config", "~/Library"] } });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ mossHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome, log: () => undefined });
    try {
      const { card } = await opened.registry.installed("usage", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until(() => opened.registry.get("usage")?.state !== "found", "usage OK'd");
      type Read = { ok: boolean; text?: string; err?: string };
      const read = (path: string) => ph.host.invoke<Read>({ pluginId: "usage", handler: "read", args: { path }, caller: USER });
      expect(await read(files.usage)).toEqual({ ok: true, text: "contents of /.codex/sessions/usage.jsonl" });
      expect(await read(files.claudeUsage)).toEqual({ ok: true, text: "contents of /.claude/stats.json" });
      expect(await read(files.auth)).toEqual({ ok: false, err: "EPERM" });
      expect(await read(files.claudeAuth)).toEqual({ ok: false, err: "EPERM" });
      expect(await read(files.configApp)).toEqual({ ok: true, text: "contents of /.config/app/settings.json" });
      expect(await read(files.notes)).toEqual({ ok: true, text: "contents of /Library/Notes/n.txt" });
      for (const f of [files.op, files.gh, files.cookies, files.onePassword]) expect([f, await read(f)]).toEqual([f, { ok: false, err: "EPERM" }]);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 120_000);

  test("named: its folder read and its program run outside the fence; not named: refused; the folder dropped, out of its fence", async () => {
    const home = temp("cf-out-");
    const userHome = temp("cf-out-user-");
    mkdirSync(join(userHome, "Notes"), { recursive: true });
    mkdirSync(join(userHome, "Private"), { recursive: true });
    const note = join(userHome, "Notes", "note.txt");
    const secret = join(userHome, "Private", "secret.txt");
    writeFileSync(note, "the named folder's note");
    writeFileSync(secret, "a file the fence refuses");
    const bin = temp("cf-out-bin-");
    const probe = join(bin, "outside-cat");
    writeFileSync(probe, "#!/bin/sh\nexec /bin/cat \"$1\"\n");
    chmodSync(probe, 0o755);
    plugin(home, "reader", { outside: { programs: [probe], read: ["~/Notes"] } });
    plugin(home, "plain", {});
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const lines: string[] = [];
    const opened = await openPluginRegistry({ mossHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome, log: (l) => lines.push(l) });
    try {
      const cards: Record<string, string> = {};
      const approve = async (id: string) => {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        cards[id] = JSON.stringify(shown);
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await until(() => opened.registry.get(id)?.state !== "found", `${id} OK'd`);
      };
      for (const id of ["reader", "plain"]) await approve(id);
      // Its OK card names each, with its warning; the plain one's names neither.
      expect(cards.reader).toContain(`It runs this program of yours outside MOSS's sandbox, with whatever arguments it chooses and your own access (your sign-ins, your Keychain, your files and your network): ${probe}.`);
      expect(cards.reader).toContain("It reads this folder of yours outside its sandbox: ~/Notes.");
      expect(cards.plain).not.toContain("outside");
      type Read = { ok: boolean; text?: string; err?: string };
      type Ran = { ok: boolean; code?: number; out?: string; err?: string };
      const read = (id: string, path: string) => ph.host.invoke<Read>({ pluginId: id, handler: "read", args: { path }, caller: USER });
      const run = (id: string, program: string, args: string[]) => ph.host.invoke<Ran>({ pluginId: id, handler: "run", args: { program, args }, caller: USER });

      // The plugin that names them: its folder read, nothing else of the user's; its program outside the fence.
      expect(await read("reader", note)).toEqual({ ok: true, text: "the named folder's note" });
      expect((await read("reader", secret)).ok).toBe(false);
      expect(await run("reader", probe, [secret])).toEqual({ ok: true, code: 0, out: "a file the fence refuses" });
      expect(lines.some((l) => l.includes(`reader ran ${probe} outside its sandbox: exit 0`))).toBe(true);
      expect(lines.join("\n")).not.toContain(secret);
      const other = await run("reader", "/bin/cat", [secret]);
      expect(other.ok).toBe(false);
      expect(other.err).toContain("isn't a program reader names outside its sandbox");

      // The plugin that names neither: both refused.
      expect((await read("plain", note)).ok).toBe(false);
      const plainRun = await run("plain", probe, [secret]);
      expect(plainRun.ok).toBe(false);
      expect(plainRun.err).toContain("isn't a program plain names outside its sandbox");

      // A folder added to its manifest asks again (a change card); OK'd, its new process reads it.
      const pid1 = await ph.host.invoke<number>({ pluginId: "reader", handler: "pid", args: null, caller: USER });
      mkdirSync(join(userHome, "More"), { recursive: true });
      writeFileSync(join(userHome, "More", "more.txt"), "another named folder's file");
      plugin(home, "reader", { outside: { programs: [probe], read: ["~/Notes", "~/More"] } }, "1.0.1");
      await opened.folders.scan();
      await until(() => opened.registry.get("reader")?.state === "found", "the folder added asks again");
      await approve("reader");
      expect(cards.reader).toContain("It reads these folders of yours outside its sandbox: ~/Notes, ~/More.");
      expect(await read("reader", join(userHome, "More", "more.txt"))).toEqual({ ok: true, text: "another named folder's file" });
      const pid2 = await ph.host.invoke<number>({ pluginId: "reader", handler: "pid", args: null, caller: USER });
      expect(pid2).not.toBe(pid1);
      // Both folders dropped: a change to the list is a change card too; OK'd, its next process reads neither.
      plugin(home, "reader", { outside: { programs: [probe] } }, "1.0.2");
      await opened.folders.scan();
      await until(() => opened.registry.get("reader")?.state === "found", "the folders dropped ask again");
      await approve("reader");
      expect(cards.reader).not.toContain("It reads");
      expect((await read("reader", note)).ok).toBe(false);
      expect(await ph.host.invoke<number>({ pluginId: "reader", handler: "pid", args: null, caller: USER })).not.toBe(pid2);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 120_000);
});

test("an update or a bot's edit that changes what it names outside its sandbox waits for a new OK; the same lists don't", async () => {
  const { updateAddsTrigger, workshopAdds } = await import("../../registry/changes");
  const fp = (outside?: unknown) => ({
    class: "code" as const, capabilities: [], networkHosts: [], helperPermissions: [], hookEvents: [], fetchesCode: [], addons: false, adult: false,
    runs: JSON.stringify({ host: { entry: "host/index.js", process: "own", ...(outside === undefined ? {} : { outside }) } }), defaults: "{}", reaches: "{}", dynamicHosts: false, label: "{}", agentBackends: "[]",
  });
  const snap = (p: ReturnType<typeof fp>) => ({ okHash: "a", files: [], plugins: { "": p }, cards: "", codePaths: [] });
  expect(updateAddsTrigger(snap(fp()), snap(fp()))).toBeUndefined();
  expect(updateAddsTrigger(snap(fp({ programs: ["codex"] })), snap(fp({ programs: ["codex"] })))).toBeUndefined();
  for (const [before, after] of [[undefined, { programs: ["codex"] }], [{ programs: ["codex"] }, { programs: ["codex", "claude"] }], [{ read: ["~/.codex"] }, { read: ["~/.codex", "~/.ssh"] }], [{ read: ["~/.codex"] }, undefined]] as const) {
    expect(updateAddsTrigger(snap(fp(before)), snap(fp(after)))).toContain("changes the programs it runs or the folders it reads outside its sandbox");
    expect(workshopAdds(snap(fp(before)), snap(fp(after)))).toContain("outside its sandbox");
  }
});

test("with no user home named, a program runs in an empty stand-in folder, never the real home", async () => {
  const mossHome = temp("cf-out-moss-");
  const bin = temp("cf-out-bin-");
  writeFileSync(join(bin, "where"), "#!/bin/sh\npwd -P\n");
  chmodSync(join(bin, "where"), 0o755);
  const api = outsideApi({ mossHome, path: () => bin });
  const ctx = { pluginId: "p", record: { manifest: { host: { outside: { programs: ["where"] } } } } } as never;
  const r = (await api["outside.run"]!(ctx, ["where"])) as { stdout: string };
  expect(r.stdout.trim()).toBe(realpathSync(join(tmpdir(), "moss-no-user-home")));
  expect(r.stdout.trim()).not.toBe(realpathSync(homedir()));
});
