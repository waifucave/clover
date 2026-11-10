// A plugin's command hook runs under ITS PLUGIN's fence (#414's review), never the hooked session's: the plugin's tree
// to read, its own data and temp folders to write, nothing else of the Clover home, and the session's project folders
// readable (writable with `project.write`). The macOS cases run the real Seatbelt door.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import type { Contribution } from "../../../src/contracts/plugin-registry";
import type { FencedRun } from "../../../src/fence/spawn";
import { ensurePluginRunFiles } from "../../../src/registry/plugin-run";
import { pluginHooks, type HookSession } from "../../../src/runtime-sdk/turn-loop/hooks";
import { pluginHookSpawner } from "../../../src/runtime-sdk/turn-loop/plugin-hook-spawn";
import { darwinTest } from "../../helpers/darwin-only";

const caller: Caller = { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" };
const session: HookSession = { id: "b_luna", kind: "bot", caller, bot: "luna", computer: "Studio" };

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hookfence-")));
  temps.push(base);
  const home = join(base, "clover");
  const userHome = join(base, "user");
  const root = join(home, "plugins", "acme", "guard");
  const project = join(userHome, "proj");
  for (const d of [root, project, join(home, "scratch", "luna"), join(home, "bots", "luna", "memory"), join(home, "plugin-data", "other")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "guard.sh"), "#!/bin/sh\n");
  writeFileSync(join(home, "secrets.enc"), "sealed");
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", "app.token"), "app-token-not-real", { mode: 0o600 });
  writeFileSync(join(home, "bots", "luna", "memory", "notes.md"), "luna's");
  writeFileSync(join(home, "plugin-data", "other", "x"), "other's");
  writeFileSync(join(project, "a.txt"), "before\n");
  const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: { userHome } };
  return { home, userHome, root, project, guard };
}

const run = (command: string): FencedRun => ({ command, cwd: "/ignored", env: { PATH: "/usr/bin:/bin" }, stdin: "{}", timeoutMs: 20_000, who: { caller, hook: "g", pluginId: "acme/guard" } });

describe("a plugin hook's door", () => {
  test("refuses a run that names no plugin, a plugin with no folder here, and on macOS a run with the fence off", async () => {
    const guard = { files: { guard: "/nowhere/guard.js", bin: "/nowhere", cloverHome: "/nowhere" } as never, fence: false as const };
    const linux = pluginHookSpawner({ guard, platform: "linux", pluginRoot: () => undefined });
    expect(await linux.run({ ...run("true"), who: { caller } })).toMatchObject({ kind: "refused", reason: expect.stringContaining("names no plugin") });
    expect(await linux.run(run("true"))).toMatchObject({ kind: "refused", reason: expect.stringContaining("no folder") });
    const mac = pluginHookSpawner({ guard, platform: "darwin", pluginRoot: () => "/x" });
    expect(mac.available).toBe(false);
    expect(await mac.run(run("true"))).toMatchObject({ kind: "refused", reason: expect.stringContaining("sandbox-exec") });
  });

  darwinTest("its plugin's fence, not the bot's: tree read, own data and temp written, no Clover home, no bot folders, the project read and written only with project.write", async () => {
    const w = world();
    const q = JSON.stringify;
    // A daemon socket, listening: a hook must not reach it, nor the app's token. The fence denies every connect
    // (`network*`), wherever the socket is; this one sits in a short folder of its own, since `<home>/run/core.sock`
    // under the test's temp root would pass macOS's 104-byte socket path limit.
    const sockDir = realpathSync(mkdtempSync("/private/tmp/hs-"));
    temps.push(sockDir);
    const sock = join(sockDir, "core.sock");
    const listener = Bun.listen({ unix: sock, socket: { data() {}, open(s) { s.end(); } } });
    const probe = [
      `cat ${q(join(w.root, "guard.sh"))} >/dev/null 2>&1 && echo tree=ok || echo tree=denied`,
      `echo x > "$CLOVER_PLUGIN_DATA/f" 2>/dev/null && echo data=ok || echo data=denied`,
      `echo x > "$TMPDIR/f" 2>/dev/null && echo tmp=ok || echo tmp=denied`,
      `[ -n "$CLOVER_PLUGIN_DATA" ] && [ "$CLAUDE_PLUGIN_DATA" = "$CLOVER_PLUGIN_DATA" ] && echo datavar=ok || echo datavar=missing`,
      `[ "$(pwd -P)" = ${q(w.root)} ] && echo cwd=root || echo cwd=other`,
      `cat ${q(join(w.home, "secrets.enc"))} >/dev/null 2>&1 && echo secrets=ok || echo secrets=denied`,
      `cat ${q(join(w.home, "plugin-data", "other", "x"))} >/dev/null 2>&1 && echo otherdata=ok || echo otherdata=denied`,
      `cat ${q(join(w.home, "bots", "luna", "memory", "notes.md"))} >/dev/null 2>&1 && echo botmemory=ok || echo botmemory=denied`,
      `echo x > ${q(join(w.home, "scratch", "luna", "f"))} 2>/dev/null && echo botscratch=ok || echo botscratch=denied`,
      `echo x > ${q(join(w.userHome, ".zshrc"))} 2>/dev/null && echo userhome=ok || echo userhome=denied`,
      `cat ${q(join(w.home, "run", "app.token"))} >/dev/null 2>&1 && echo apptoken=ok || echo apptoken=denied`,
      `/usr/bin/nc -U ${q(sock)} </dev/null >/dev/null 2>&1 && echo socket=ok || echo socket=denied`,
      `cat ${q(join(w.project, "a.txt"))} >/dev/null 2>&1 && echo projread=ok || echo projread=denied`,
      `echo after > ${q(join(w.project, "a.txt"))} 2>/dev/null && echo projwrite=ok || echo projwrite=denied`,
    ].join("; ");
    const door = (write: boolean) => pluginHookSpawner({ guard: w.guard, pluginRoot: (id) => (id === "acme/guard" ? w.root : undefined), projectFor: (id, sid) => (id === "acme/guard" && sid === "b_luna" ? { dirs: [w.project], write } : undefined) });
    const lines = async (write: boolean) => {
      const r = await door(write).run(run(probe));
      expect(r.kind).toBe("exited");
      return Object.fromEntries((r as { stdout: string }).stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
    };
    const walls = { secrets: "denied", otherdata: "denied", botmemory: "denied", botscratch: "denied", userhome: "denied", apptoken: "denied", socket: "denied" };
    // Control: unfenced, the same reads and the connect work, so the denials below are the fence's.
    const plain = Bun.spawn(["/bin/sh", "-c", `cat ${q(join(w.home, "run", "app.token"))} >/dev/null && echo apptoken=ok; /usr/bin/nc -U ${q(sock)} </dev/null >/dev/null 2>&1 && echo socket=ok || echo socket=denied`], { stdout: "pipe" });
    expect((await new Response(plain.stdout).text()).trim().split("\n")).toEqual(["apptoken=ok", "socket=ok"]);
    expect(await lines(false)).toEqual({ tree: "ok", data: "ok", tmp: "ok", datavar: "ok", cwd: "root", ...walls, projread: "ok", projwrite: "denied" });
    expect(readFileSync(join(w.project, "a.txt"), "utf8")).toBe("before\n");
    expect(await lines(true)).toEqual({ tree: "ok", data: "ok", tmp: "ok", datavar: "ok", cwd: "root", ...walls, projread: "ok", projwrite: "ok" });
    expect(readFileSync(join(w.project, "a.txt"), "utf8")).toBe("after\n");
    expect(existsSync(join(w.home, "plugin-data", "acme", "f"))).toBe(true);
    expect(existsSync(join(w.home, "scratch", "luna", "f"))).toBe(false);
    expect(existsSync(join(w.userHome, ".zshrc"))).toBe(false);
    listener.stop(true);
  }, 60_000);

  darwinTest("through the hooks, on the real door: an answer past the 1 MiB stdout cap is cut, isn't JSON, and a tool.before hook denies", async () => {
    const w = world();
    const big = `printf '{"input":{"command":"'; head -c 1200000 /dev/zero | tr '\\0' a; printf '"}}'`;
    const entries: Contribution[] = [{ point: "hooks", pluginId: "acme/guard", ref: "hooks/g", value: { id: "g", on: ["tool.before"], command: big }, state: "active" }];
    const skipped: string[] = [];
    const hooks = pluginHooks({
      registry: { entries: ((p: string) => (p === "hooks" ? entries : [])) as never, get: ((id: string) => ({ id, manifest: {}, folder: w.root })) as never },
      host: { invoke: (async () => { throw new Error("never"); }) as never },
      onSkipped: (s) => skipped.push(s.reason),
      commandSpawner: pluginHookSpawner({ guard: w.guard, pluginRoot: () => w.root }),
    });
    const r = await hooks.toolBefore(session, { name: "Bash", callId: "c1" }, { command: "ls" });
    expect(r.deny).toContain("isn't JSON");
    expect(r.input).toEqual({ command: "ls" });
    expect(skipped).toEqual(["its output isn't JSON"]);
    // Control: the same hook under 1 MiB is read and replaces the input.
    const small = `printf '{"input":{"command":"'; head -c 1000 /dev/zero | tr '\\0' a; printf '"}}'`;
    entries[0] = { ...entries[0]!, value: { id: "g", on: ["tool.before"], command: small } };
    expect((await hooks.toolBefore(session, { name: "Bash", callId: "c1" }, { command: "ls" })).input).toEqual({ command: "a".repeat(1000) });
  }, 60_000);

  darwinTest("the network only through its plugin tree's proxy (lane B's 2g): the proxy's port and env with one, nothing without", async () => {
    const w = world();
    const listen = () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(s) { s.end(); } } });
    const proxy = listen();
    const other = listen();
    try {
      const probe = [
        `/usr/bin/nc -z -w 2 127.0.0.1 ${proxy.port} >/dev/null 2>&1 && echo proxy=ok || echo proxy=denied`,
        `/usr/bin/nc -z -w 2 127.0.0.1 ${other.port} >/dev/null 2>&1 && echo other=ok || echo other=denied`,
        `[ "$HTTPS_PROXY" = "http://127.0.0.1:${proxy.port}" ] && echo env=ok || echo env=missing`,
      ].join("; ");
      const lines = async (withProxy: boolean) => {
        const guard = { ...w.guard, ...(withProxy ? { proxyFor: (id: string) => (id === "acme/guard" ? { port: proxy.port, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } } : undefined) } : {}) };
        const r = await pluginHookSpawner({ guard, pluginRoot: () => w.root }).run(run(probe));
        expect(r.kind).toBe("exited");
        return Object.fromEntries((r as { stdout: string }).stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
      };
      // Control: unfenced, both ports answer, so the denials below are the fence's.
      const plain = Bun.spawn(["/bin/sh", "-c", `/usr/bin/nc -z -w 2 127.0.0.1 ${other.port} && echo other=ok`], { stdout: "pipe" });
      expect((await new Response(plain.stdout).text()).trim()).toBe("other=ok");
      expect(await lines(true)).toEqual({ proxy: "ok", other: "denied", env: "ok" });
      expect(await lines(false)).toEqual({ proxy: "denied", other: "denied", env: "missing" });
    } finally {
      proxy.stop(true);
      other.stop(true);
    }
  }, 60_000);
});
