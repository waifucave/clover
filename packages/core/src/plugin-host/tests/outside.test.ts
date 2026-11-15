// P5 (the owner, 2026-11-15: "Yes, named on the card"): a plugin's manifest names programs of the user's that its host
// half runs outside the plugin sandbox, and folders of the user's that it reads. On real plugin-host processes under the
// fence: the plugin that names them reads its named folder and nothing else of the user's, and its named program runs
// outside the fence (it reads a file the fence refuses the plugin); a program it doesn't name is refused. A plugin that
// names neither is refused both. A change to the list is a change card; OK'd, a new process has the new fence. Temp homes; nothing opens a window.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";
import { expandUserPath, findProgram, outsideReadFolders } from "../api/outside";
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
  writeFileSync(join(root, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version, engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", process: "own", ...host } }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "host", "index.js"), HOST);
}

test("the folders it names: in the user's home, never the whole home or the Clover home; a program by name on the PATH", () => {
  const userHome = temp("cf-out-user-");
  const cloverHome = join(userHome, ".clover");
  mkdirSync(join(userHome, "Notes"), { recursive: true });
  mkdirSync(cloverHome, { recursive: true });
  const rec = (read: string[]) => ({ manifest: { host: { outside: { read } } } }) as never;
  expect(outsideReadFolders(rec(["~/Notes"]), { userHome, cloverHome })).toEqual([join(userHome, "Notes")]);
  expect(outsideReadFolders(rec(["~/.clover", "~/.clover/secrets", "~"]), { userHome, cloverHome })).toEqual([]);
  expect(outsideReadFolders(rec([userHome]), { userHome, cloverHome })).toEqual([]);
  expect(expandUserPath("~/a/b", "/Users/x")).toBe("/Users/x/a/b");
  const bin = temp("cf-out-bin-");
  writeFileSync(join(bin, "probe"), "#!/bin/sh\necho hi\n");
  chmodSync(join(bin, "probe"), 0o755);
  writeFileSync(join(bin, "plain"), "not a program");
  expect(findProgram("probe", `/nonexistent:${bin}`)).toBe(join(bin, "probe"));
  expect(findProgram("plain", bin)).toBeUndefined();
  expect(findProgram("/bin/cat", undefined)).toBe("/bin/cat");
});

darwinDescribe("programs and folders outside the sandbox (P5)", () => {
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
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
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
      expect(cards.reader).toContain(`It runs this program of yours outside Clover's sandbox, with your own access (your sign-ins, your Keychain, your files and your network): ${probe}.`);
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
