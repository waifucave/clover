// Where a host that runs programs (lane A's `host.programs`, its fence and its picks) meets the crash rules' stop and
// its notice (lane B's): a pick that replaces the process is no crash, stops nothing and tells no bot; a builder's edit
// that starts a crash-stopped plugin again starts it with the picks as they are now and the fence its applied tree asks
// for (programs or not); an edit that adds `programs` to a crash-stopped plugin waits for the OK and starts nothing
// before it. Over the real registry, the real plugin host under the real fence (its processes, its workers, a fake
// clock for the backoffs) and the real crash notices into a fake bot door. Temp homes; nothing opens a window.
import { afterAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import type { HostedStatus } from "../../contracts/plugin-host";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { PluginGrants } from "../../fence/plugin-grants";
import { openPluginRegistry } from "../../registry/open";
import { crashNotices } from "../crash-notice";
import { startPluginHost } from "../daemon-host";
import { darwinTest } from "../../../test/helpers/darwin-only";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

const USER: Caller = { kind: "user", client: "app" };
/** Host code that runs `/bin/cat` on a path (or fails to start, with `broken`). */
const CODE = (broken: string | undefined) => `${broken !== undefined ? `export async function start() { throw new Error(${JSON.stringify(broken)}); }\n` : ""}
export const cat = async (args) => {
  try {
    const r = Bun.spawnSync(["/bin/cat", args.path], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() };
  } catch (e) {
    return { code: -1, out: "" };
  }
};
`;
const manifest = (id: string, version: string, programs: boolean) => JSON.stringify({
  manifest: 1, id, name: id, version, engines: { clover: `^${PLUGIN_API_VERSION}` },
  host: { entry: "host/index.js", process: "own", ...(programs ? { programs: true } : {}) },
});

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

async function until<T>(what: string, ms: number, f: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(10);
  }
}

darwinTest("picks never count as crashes or notices; a crash-stopped plugin started again by an edit gets the current picks and its tree's fence; one that gains programs waits for the OK", async () => {
  const home = temp("cf-progs-crash-");
  const userHome = temp("cf-progs-crash-user-");
  const clip = join(userHome, "Movies", "clip.txt");
  write(dirname(clip), { "clip.txt": "the picked clip" });
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 60_000 });
  const clock = new FakeClock({ start: Date.now() });
  const lines: string[] = [];
  const grants = new PluginGrants({ cloverHome: home, userHome });
  const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, clock, userHome, log: (l) => lines.push(l), picked: (id) => grants.fencePaths(id) });
  const changed: Promise<void>[] = [];
  const offGrants = grants.watch((id) => void changed.push(ph.picksChanged(id)));
  const delivered: string[] = [];
  const notices = crashNotices({
    host: ph.host, registry: opened.registry, log: (l) => lines.push(l), now: () => clock.now(),
    bots: () => ({ has: (id) => id === "alpha", deliverTo: async (_id, input) => { delivered.push((input as { text: string }).text); return { disposition: "started" } as never; } }),
  });
  const states: Record<string, string[]> = {};
  const offStates = ph.host.watch((s: HostedStatus) => void (states[s.pluginId] ??= []).push(s.state));
  const approve = async (id: string, by: "bot" | "app") => {
    const { card } = await opened.registry.installed(id, by);
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    await until(`${id} OK'd`, 10_000, () => (opened.registry.get(id)?.state !== "found" ? true : undefined));
  };
  const install = async (id: string, programs: boolean, broken: string | undefined) => {
    write(join(home, "plugins", id), { "clover.json": manifest(id, "1.0.0", programs), "package.json": "{\"type\":\"module\"}", "host/index.js": CODE(broken) });
    await opened.folders.installed(id, "bot", { bot: "alpha" });
    await approve(id, "bot");
  };
  const crashToStop = async (id: string) => {
    void ph.host.ensureStarted(id).catch(() => {});
    try {
      await until(`${id} stopped by the crash rules`, 20_000, () => {
        clock.advance(60_000);
        return ph.host.status(id).state === "stopped" ? true : undefined;
      });
    } catch (e) {
      // Where the crash loop stood, so a slow or odd runner's failure says why.
      throw new Error(`${(e as Error).message}; status ${JSON.stringify(ph.host.status(id))}; states ${JSON.stringify(states[id] ?? [])}`, { cause: e });
    }
    await flush();
  };
  const edit = async (id: string, files: Record<string, string>) => {
    const hash = opened.registry.get(id)!.treeHash;
    write(join(home, "plugins", id), files);
    await opened.folders.refresh(join(home, "plugins", id));
    await until(`${id}'s edit read`, 10_000, () => (opened.registry.get(id)!.treeHash !== hash ? true : undefined));
  };
  const cat = (id: string, path: string) => ph.host.invoke<{ code: number; out: string }>({ pluginId: id, handler: "cat", args: { path }, caller: USER });
  try {
    // 1. A running plugin's picks replace its process: no stop, no crash, no notice.
    await install("cut", true, undefined);
    expect((await cat("cut", clip)).out).toBe("");
    grants.add({ pluginId: "cut", token: "grant:a1111111-2222-4333-8444-555555555555", path: clip, kind: "file", access: "read" });
    await Promise.all(changed.splice(0));
    expect(await cat("cut", clip)).toMatchObject({ code: 0, out: "the picked clip" });
    grants.remove("cut", "grant:a1111111-2222-4333-8444-555555555555");
    await Promise.all(changed.splice(0));
    expect((await cat("cut", clip)).out).toBe("");
    expect(states.cut).not.toContain("stopped");
    expect(states.cut).not.toContain("restarting");
    expect(ph.host.status("cut")).toMatchObject({ state: "running", crashes: 0 });

    // 2. Crash-stopped, then picked: it stays stopped (the pick starts nothing). The builder's fix starts it again with
    //    the pick in its fence, a fresh crash count, and one notice in all (the crash's, none for the pick).
    await install("reel", true, "bug");
    await crashToStop("reel");
    await until("the crash notice", 5_000, () => (delivered.length === 1 ? true : undefined));
    grants.add({ pluginId: "reel", token: "grant:b1111111-2222-4333-8444-555555555555", path: clip, kind: "file", access: "read" });
    await Promise.all(changed.splice(0));
    expect(ph.host.status("reel").state).toBe("stopped");
    await edit("reel", { "host/index.js": CODE(undefined) });
    await until("reel running the fix", 10_000, () => (ph.host.status("reel").state === "running" ? true : undefined));
    expect(ph.host.status("reel")).toMatchObject({ state: "running", crashes: 0 });
    expect(await cat("reel", clip)).toMatchObject({ code: 0, out: "the picked clip" });
    expect(delivered).toHaveLength(1);

    // 3. Crash-stopped with programs; the builder's fix also drops them (an edit that asks for nothing new applies): it
    //    starts again in a process without the programs fence, never the one it crashed in.
    await edit("reel", { "host/index.js": CODE("bug again") });
    await crashToStop("reel");
    await edit("reel", { "clover.json": manifest("reel", "1.0.1", false), "host/index.js": CODE(undefined) });
    await until("reel running without programs", 10_000, () => (ph.host.status("reel").state === "running" ? true : undefined));
    expect((await cat("reel", join(home, "plugins", "reel", "clover.json"))).code).not.toBe(0);

    // 4. Crash-stopped without programs; the builder's fix adds them: that asks for the OK, and nothing starts before it.
    await install("mix", false, "bug");
    await crashToStop("mix");
    await edit("mix", { "clover.json": manifest("mix", "1.0.1", true), "host/index.js": CODE(undefined) });
    await until("mix's change waits for the OK", 10_000, () => (opened.registry.get("mix")?.state === "found" ? true : undefined));
    await Bun.sleep(300);
    expect(ph.host.status("mix").state).not.toBe("running");
    expect(lines.some((l) => l.includes("mix: its tree changed after the crash rules stopped it"))).toBe(false);
    await approve("mix", "bot");
    expect(await cat("mix", join(home, "plugins", "mix", "clover.json"))).toMatchObject({ code: 0 });
    expect(ph.host.status("mix").crashes ?? 0).toBe(0);
  } finally {
    offGrants();
    offStates();
    notices.stop();
    await ph.close();
    opened.close();
  }
}, 120_000);
