// A host of its own that runs programs (`host.programs`, the coordinator's ruling for the owner's video-editor test): on
// real plugin-host processes under the fence, its host code starts a program (`/bin/cat` standing in for ffmpeg) that
// reads a file the user picked, and nothing else of the user's; a pick added or removed while it runs starts its process
// again with the new fence. A host without the declaration starts no program, as before. Temp homes; nothing opens a
// window.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { PluginGrants } from "../../fence/plugin-grants";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";
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

function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => {
      if (registry.get(id)?.state !== "found") {
        off();
        resolve();
      }
    });
    if (registry.get(id)?.state !== "found") {
      off();
      resolve();
    }
  });
}

/** Until `cond` holds, or fails after a few seconds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (cond()) return; await Bun.sleep(20); }
  throw new Error(`never: ${what}`);
}

/** A plugin whose host code runs `/bin/cat` on a path and reports what came back (or why it failed), and what its own
 *  process id is (a relaunch shows as a new one). */
function plugin(home: string, id: string, host: Record<string, unknown>): void {
  const root = join(home, "plugins", id);
  mkdirSync(join(root, "host"), { recursive: true });
  writeFileSync(join(root, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", ...host } }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "host", "index.js"), `
export const cat = async (args) => {
  try {
    const r = Bun.spawnSync(["/bin/cat", args.path], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString().slice(0, 200) };
  } catch (e) {
    return { code: -1, out: "", err: String(e && e.message || e).slice(0, 200) };
  }
};
export const pid = async () => process.pid;
export const slow = async (args) => {
  const p = Bun.spawn(["/bin/sleep", String(args.s)]);
  return { code: await p.exited };
};
export const cp = async (args) => {
  const r = Bun.spawnSync(["/bin/cp", args.from, args.to], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode };
};
`);
}

darwinDescribe("a host of its own that runs programs", () => {
  test("its program reads a picked file and nothing else of the user's; a pick added or removed restarts its process; without the declaration no program starts", async () => {
    const home = temp("cf-progs-");
    const userHome = temp("cf-progs-user-");
    const movies = join(userHome, "Movies");
    mkdirSync(movies, { recursive: true });
    const clip = join(movies, "clip.txt");
    const other = join(movies, "other.txt");
    writeFileSync(clip, "the picked clip");
    writeFileSync(other, "not picked");
    plugin(home, "vid", { process: "own", programs: true });
    plugin(home, "plain", { process: "own" });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const grants = new PluginGrants({ cloverHome: home, userHome });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome, picked: (id) => grants.fencePaths(id) });
    // The daemon's wiring (daemon.ts): a grant's change reaches the host.
    const changed: Promise<void>[] = [];
    const off = grants.watch((id) => void changed.push(ph.picksChanged(id)));
    try {
      const approve = async (id: string) => {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, id);
      };
      for (const id of ["vid", "plain"]) await approve(id);
      const cat = (id: string, path: string) => ph.host.invoke<{ code: number; out: string; err: string }>({ pluginId: id, handler: "cat", args: { path }, caller: USER });
      const pid = (id: string) => ph.host.invoke<number>({ pluginId: id, handler: "pid", args: null, caller: USER });

      // Running, nothing picked: its program starts, and the user's file is out of reach.
      const before = await cat("vid", clip);
      expect(before.code).not.toBe(0);
      expect(before.code).not.toBe(-1); // the program started; the fence refused the read
      expect(before.out).toBe("");
      const pid1 = await pid("vid");

      // The user picks the clip while it runs: its process starts again with the pick in its fence.
      grants.add({ pluginId: "vid", token: "grant:11111111-2222-4333-8444-555555555555", path: clip, kind: "file", access: "read" });
      await Promise.all(changed.splice(0));
      const pid2 = await pid("vid");
      expect(pid2).not.toBe(pid1);
      expect(await cat("vid", clip)).toMatchObject({ code: 0, out: "the picked clip" });
      // Its neighbour wasn't picked.
      expect(await cat("vid", other)).toMatchObject({ out: "" });
      expect((await cat("vid", other)).code).not.toBe(0);
      // A change that leaves the picks as they were doesn't restart it (another plugin's pick).
      grants.add({ pluginId: "plain", token: "grant:21111111-2222-4333-8444-555555555555", path: other, kind: "file", access: "read" });
      await Promise.all(changed.splice(0));
      expect(await pid("vid")).toBe(pid2);

      // The pick removed: its process starts again, and the clip is out of reach once more.
      grants.remove("vid", "grant:11111111-2222-4333-8444-555555555555");
      await Promise.all(changed.splice(0));
      expect(await pid("vid")).not.toBe(pid2);
      expect((await cat("vid", clip)).out).toBe("");
      expect(ph.host.status("vid").state).toBe("running");
      expect(ph.host.status("vid").crashes ?? 0).toBe(0);

      // The first call right after a pick (the page's next step) already runs in the new process: no await between.
      grants.add({ pluginId: "vid", token: "grant:31111111-2222-4333-8444-555555555555", path: clip, kind: "file", access: "read" });
      expect(await cat("vid", clip)).toMatchObject({ code: 0, out: "the picked clip" });
      await Promise.all(changed.splice(0));
      // An export: a save pick (not there yet) is written by its program; the folder around it isn't.
      const saveTo = join(movies, "export.txt");
      grants.add({ pluginId: "vid", token: "grant:41111111-2222-4333-8444-555555555555", path: saveTo, kind: "file", access: "write" });
      expect(await ph.host.invoke({ pluginId: "vid", handler: "cp", args: { from: clip, to: saveTo }, caller: USER })).toMatchObject({ code: 0 });
      expect(readFileSync(saveTo, "utf8")).toBe("the picked clip");
      expect((await ph.host.invoke<{ code: number }>({ pluginId: "vid", handler: "cp", args: { from: clip, to: join(movies, "beside.txt") }, caller: USER })).code).not.toBe(0);
      expect(existsSync(join(movies, "beside.txt"))).toBe(false);
      await Promise.all(changed.splice(0));

      // A host of its own without the declaration runs only its Bun: no program starts, not even on its own manifest,
      // which its process reads (the control: the declared host's program reads its own the same way).
      expect(await cat("vid", join(home, "plugins", "vid", "clover.json"))).toMatchObject({ code: 0 });
      const refused = await cat("plain", join(home, "plugins", "plain", "clover.json"));
      expect(refused.code).not.toBe(0);
      expect(refused.out).toBe("");

      // The same plugin gains the declaration (an edit of its tree) and the user OKs it: it runs in a new process with
      // the programs fence, never in the one it had.
      const plainPid = await pid("plain");
      writeFileSync(join(home, "plugins", "plain", "clover.json"), JSON.stringify({ manifest: 1, id: "plain", name: "plain", version: "1.0.1", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", process: "own", programs: true } }));
      await until(() => opened.registry.get("plain")?.state === "found", "plain's change asks again");
      await approve("plain");
      expect(await cat("plain", join(home, "plugins", "plain", "clover.json"))).toMatchObject({ code: 0 });
      expect(await pid("plain")).not.toBe(plainPid);
      // And back: dropping it (OK'd again) leaves no process that runs programs behind.
      writeFileSync(join(home, "plugins", "plain", "clover.json"), JSON.stringify({ manifest: 1, id: "plain", name: "plain", version: "1.0.2", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js", process: "own" } }));
      await until(() => opened.registry.get("plain")?.manifest?.version === "1.0.2", "plain's tree read again");
      if (opened.registry.get("plain")?.state === "found") await approve("plain");
      await until(() => ph.host.status("plain").state === "running" || ph.host.status("plain").state === "idle", "plain settled");
      expect((await cat("plain", join(home, "plugins", "plain", "clover.json"))).code).not.toBe(0);
    } finally {
      off();
      await ph.close();
      opened.close();
    }
  }, 90_000);

  test("a pick added while a program runs (an export) waits for it to end; a pick taken back ends it after the grace; a call past the wait is cut short", async () => {
    const home = temp("cf-progs-wait-");
    const userHome = temp("cf-progs-wait-user-");
    const movies = join(userHome, "Movies");
    mkdirSync(movies, { recursive: true });
    const clip = join(movies, "clip.txt");
    const second = join(movies, "second.txt");
    writeFileSync(clip, "the first clip");
    writeFileSync(second, "the second clip");
    plugin(home, "vid", { process: "own", programs: true });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const grants = new PluginGrants({ cloverHome: home, userHome });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome, picked: (id) => grants.fencePaths(id), pickWaitMs: 3_000 });
    const changed: Promise<void>[] = [];
    const off = grants.watch((id) => void changed.push(ph.picksChanged(id)));
    try {
      const { card } = await opened.registry.installed("vid", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await approved(opened.registry, "vid");
      const call = <R>(handler: string, args: unknown) => ph.host.invoke<R>({ pluginId: "vid", handler, args, caller: USER });
      grants.add({ pluginId: "vid", token: "grant:a1111111-2222-4333-8444-555555555555", path: clip, kind: "file", access: "read" });
      await Promise.all(changed.splice(0));
      const pid1 = await call<number>("pid", null);

      // An export runs; the user picks a second clip meanwhile. The export isn't cut short and its process stays...
      const exporting = call<{ code: number }>("slow", { s: 2 });
      await Bun.sleep(200);
      grants.add({ pluginId: "vid", token: "grant:b1111111-2222-4333-8444-555555555555", path: second, kind: "file", access: "read" });
      await Bun.sleep(500);
      expect(await call<number>("pid", null)).toBe(pid1);
      expect(await exporting).toEqual({ code: 0 });
      // ...and once it ends, the process is replaced: the next call reads the new pick.
      await Promise.all(changed.splice(0));
      expect(await call<number>("pid", null)).not.toBe(pid1);
      expect(await call("cat", { path: second })).toMatchObject({ code: 0, out: "the second clip" });

      // A pick taken back while a program runs: the grace (5 s), then the call is cut short and the file is out of reach.
      const pid2 = await call<number>("pid", null);
      const running = call<{ code: number }>("slow", { s: 30 }).then(() => "finished", (e: Error) => e.message);
      await Bun.sleep(200);
      const t0 = Date.now();
      grants.remove("vid", "grant:b1111111-2222-4333-8444-555555555555");
      expect(await running).toMatch(/interrupted|cancelled/);
      expect(Date.now() - t0).toBeLessThan(15_000);
      await Promise.all(changed.splice(0));
      expect(await call<number>("pid", null)).not.toBe(pid2);
      expect((await call<{ out: string }>("cat", { path: second })).out).toBe("");

      // A pick added while a call runs past the wait (3 s here, 10 minutes in Clover): replaced anyway, after the grace.
      const pid3 = await call<number>("pid", null);
      const long = call<{ code: number }>("slow", { s: 40 }).then(() => "finished", (e: Error) => e.message);
      await Bun.sleep(200);
      grants.add({ pluginId: "vid", token: "grant:c1111111-2222-4333-8444-555555555555", path: second, kind: "file", access: "read" });
      await Bun.sleep(1_500);
      expect(await call<number>("pid", null)).toBe(pid3); // still waiting
      expect(await long).toMatch(/interrupted|cancelled/);
      await Promise.all(changed.splice(0));
      expect(await call<number>("pid", null)).not.toBe(pid3);
      expect(await call("cat", { path: second })).toMatchObject({ code: 0, out: "the second clip" });
      expect(ph.host.status("vid").crashes ?? 0).toBe(0);
    } finally {
      off();
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
