// The computer node's Bash on lane C's fenced process (the wiring ruling, item 3): every call goes through the
// spawner as its caller, with an environment built whole here; a spawner that can't start a fenced process refuses,
// and nothing ever runs unsandboxed. On the macOS job the real fenced process (Seatbelt) runs it.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { SystemClock } from "../../src/clock/system-clock";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, fencedExecutor, fencedPath } from "../../src/computers/fenced-executor";
import { nodeParts } from "../../src/computers/node-parts";
import { startDaemonParts } from "../../src/daemon-parts";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import type { FencedRun, FencedRunResult, FencedSpawner } from "../../src/fence/spawn";
import { startDaemonLinks } from "../../src/ipc/device-links";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { CloverSecretStore, KeychainValues, memoryVault } from "../../src/secrets/clover-secret-store";
import { hostOs } from "../../src/tree/names";
import type { ToolRunContext } from "../../src/tree/service";
import { darwinDescribe } from "../helpers/darwin-only";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { Drivers } from "../../src/bots/tests/fixtures";

const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const LUNA: Caller = { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" };
const PEER: Caller = { kind: "peer", device: "d_laptop", computer: "Laptop" } as Caller;

/** A spawner that records each run and answers as told. */
function fake(answer: (r: FencedRun) => FencedRunResult | Promise<FencedRunResult>, available = true): FencedSpawner & { runs: FencedRun[] } {
  const runs: FencedRun[] = [];
  return { available, runs, run: async (r) => { runs.push(r); return answer(r); } };
}

function ctx(over: Partial<ToolRunContext> = {}): ToolRunContext & { seen: string[] } {
  const seen: string[] = [];
  return { as: LUNA, session: "s_luna", callId: "c1", cwd: "/somewhere/real", treeCwd: "home/Studio", signal: new AbortController().signal, output: (chunk, stream) => seen.push(`${stream}:${chunk}`), seen, ...over };
}

describe("fencedExecutor over a spawner", () => {
  test("runs Bash as its caller, in its folder, with an environment built whole; output goes to the stream", async () => {
    const s = fake(() => ({ kind: "exited", code: 0, stdout: "hi\n", stderr: "warn\n", shell: "sh" }));
    process.env.LANE_J_DAEMON_ONLY = "never-in-a-child";
    try {
      const c = ctx();
      const r = await fencedExecutor({ spawner: s, home: "/Users/me", os: "macos" }).run("Bash", { command: "echo hi", cwd: "home/Studio" }, c);
      expect(r).toEqual({ output: { stdout: "hi\n", stderr: "warn\n", code: 0, aborted: false }, isError: false });
      expect(c.seen).toEqual(["stdout:hi\n", "stderr:warn\n"]);
      const run = s.runs[0]!;
      expect(run).toMatchObject({ command: "echo hi", cwd: "/somewhere/real", timeoutMs: BASH_DEFAULT_TIMEOUT_MS, who: { caller: LUNA } });
      expect(run.env).toEqual({ PATH: fencedPath("macos"), HOME: "/Users/me", LANG: "en_US.UTF-8", TERM: "dumb" });
      expect(run.signal).toBe(c.signal);
    } finally {
      delete process.env.LANE_J_DAEMON_ONLY;
    }
  });

  test("TMPDIR is the fence's temp folder when given", async () => {
    const s = fake(() => ({ kind: "exited", code: 0, stdout: "", stderr: "", shell: "sh" }));
    await fencedExecutor({ spawner: s, home: "/Users/me", temp: "/private/tmp", os: "macos" }).run("Bash", { command: "true" }, ctx());
    expect(s.runs[0]!.env).toEqual({ PATH: fencedPath("macos"), HOME: "/Users/me", LANG: "en_US.UTF-8", TERM: "dumb", TMPDIR: "/private/tmp" });
  });

  test("a bot's own run gets its own scratch folder as TMPDIR (made when missing); a link there, or another caller, gets the fence's", async () => {
    const clover = join(temp("lane-j-exec-scratch-"), ".clover");
    const s = fake(() => ({ kind: "exited", code: 0, stdout: "", stderr: "", shell: "sh" }));
    const exec = fencedExecutor({ spawner: s, home: "/Users/me", temp: "/private/tmp", cloverHome: clover, os: "macos" });
    await exec.run("Bash", { command: "true" }, ctx());
    expect(s.runs[0]!.env.TMPDIR).toBe(`${clover}/scratch/luna`);
    expect(lstatSync(join(clover, "scratch", "luna")).isDirectory()).toBe(true);
    await exec.run("Bash", { command: "true" }, ctx({ as: { kind: "session", sessionId: "s_code", sessionKind: "coding" } }));
    expect(s.runs[1]!.env.TMPDIR).toBe("/private/tmp");
    await exec.run("Bash", { command: "true" }, ctx({ as: PEER }));
    expect(s.runs[2]!.env.TMPDIR).toBe("/private/tmp");
    // A link where a bot's scratch folder should be: never followed, the fence's temp folder instead.
    symlinkSync(temp("lane-j-exec-elsewhere-"), join(clover, "scratch", "alpha"));
    await exec.run("Bash", { command: "true" }, ctx({ as: { kind: "session", sessionId: "s_a", sessionKind: "bot", bot: "alpha" } }));
    expect(s.runs[3]!.env.TMPDIR).toBe("/private/tmp");
    // A link in a parent (`scratch/` itself) is refused too: nothing is made through it.
    const other = join(temp("lane-j-exec-parent-"), ".clover");
    mkdirSync(other, { recursive: true });
    const elsewhere = temp("lane-j-exec-target-");
    symlinkSync(elsewhere, join(other, "scratch"));
    const viaLink = fencedExecutor({ spawner: s, home: "/Users/me", temp: "/private/tmp", cloverHome: other, os: "macos" });
    await viaLink.run("Bash", { command: "true" }, ctx());
    expect(s.runs[4]!.env.TMPDIR).toBe("/private/tmp");
    expect(existsSync(join(elsewhere, "luna"))).toBe(false);
  });

  test("another computer's call runs as that peer; a timeout asked for is capped", async () => {
    const s = fake(() => ({ kind: "exited", code: 3, stdout: "", stderr: "", shell: "sh" }));
    const r = await fencedExecutor({ spawner: s, home: "/home/me", os: "linux" }).run("Bash", { command: "false", cwd: "home/Studio", timeoutMs: 24 * 3600 * 1000 }, ctx({ as: PEER }));
    expect(r.isError).toBe(true);
    expect(s.runs[0]).toMatchObject({ timeoutMs: BASH_MAX_TIMEOUT_MS, who: { caller: PEER } });
    expect(s.runs[0]!.env.PATH).toBe(fencedPath("linux"));
  });

  test("a refusal, a timeout, a spawner that throws, another tool, no command, or a cancelled call: an error, nothing unsandboxed", async () => {
    const run = (s: FencedSpawner, tool = "Bash", input: unknown = { command: "ls" }, c = ctx()) => fencedExecutor({ spawner: s, home: "/h", os: "macos" }).run(tool, input, c);
    expect(await run(fake(() => ({ kind: "refused", reason: "no sandbox here" }), false))).toEqual({ output: { error: "refused: no sandbox here" }, isError: true });
    expect(await run(fake(() => ({ kind: "timeout", stdout: "part", stderr: "", shell: "sh" })))).toEqual({ output: { stdout: "part", stderr: "", code: null, timedOut: true, aborted: false }, isError: true });
    const throws: FencedSpawner = { available: true, run: async () => { throw new Error("sandbox-exec vanished"); } };
    expect((await run(throws)).output).toEqual({ error: "this computer's fenced process failed to start: sandbox-exec vanished" });
    const none = fake(() => ({ kind: "exited", code: 0, stdout: "", stderr: "", shell: "sh" }));
    expect((await run(none, "Write")).isError).toBe(true);
    expect((await run(none, "Bash", { command: "" })).isError).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    expect(await run(none, "Bash", { command: "ls" }, ctx({ signal: aborted.signal }))).toMatchObject({ isError: true, output: { aborted: true } });
    expect(none.runs).toHaveLength(0);
  });

  test("Windows: lane C's door is closed, so every call is refused with its reason", async () => {
    const root = temp("lane-j-exec-win-");
    const home = join(root, "home");
    mkdirSync(join(home, ".clover"), { recursive: true });
    const spawner = fencedSpawner({ fence: new CloverFence({ os: hostOs(), home, cloverHome: join(home, ".clover"), temp: join(root, "tmp") }), os: "windows" });
    expect(spawner.available).toBe(false);
    const r = await fencedExecutor({ spawner, home, os: "windows" }).run("Bash", { command: "echo hi" }, ctx({ cwd: home }));
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.output)).toContain("refused");
  });

  test("the fence's temp folder (CloverFence.temp, lane J's cross-lane getter) is the canonical one it lets every runner write", () => {
    const root = temp("lane-j-exec-temp-");
    const home = join(root, "home");
    mkdirSync(join(home, ".clover"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    const fence = new CloverFence({ os: hostOs(), home, cloverHome: join(home, ".clover"), temp: join(root, "tmp") });
    expect(fence.temp).toBe(realpathSync(join(root, "tmp")));
    expect(fence.policy().allowWrite).toContain(fence.temp);
  });

  test("nodeParts gives the node this executor only with a spawner", () => {
    expect(nodeParts({ computer: () => "Studio" }).executor).toBeUndefined();
    expect(nodeParts({ computer: () => "Studio", bash: { spawner: fake(() => ({ kind: "refused", reason: "x" })), home: "/h" } }).executor).toBeDefined();
  });
});

// The real sandbox on the macOS job (Seatbelt); Linux's bubblewrap door is lane C's own suite's (fenced-process.test.ts).
darwinDescribe("on this Mac's real fenced process (Seatbelt)", () => {
  test("Bash runs; a write to a fenced file is refused by the sandbox; the daemon's environment doesn't reach it", async () => {
    const root = temp("lane-j-exec-");
    const home = join(root, "home");
    const clover = join(home, ".clover");
    const project = join(home, "project");
    for (const d of [join(clover, "settings"), project, join(root, "tmp")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(clover, "settings.json"), "orig");
    const spawner = fencedSpawner({ fence: new CloverFence({ os: hostOs(), home, cloverHome: clover, temp: join(root, "tmp") }) });
    const exec = fencedExecutor({ spawner, home, temp: join(root, "tmp"), cloverHome: clover, os: hostOs() });
    const coding: Caller = { kind: "session", sessionId: "s_code", sessionKind: "coding" };
    process.env.LANE_J_DAEMON_ONLY = "never-in-a-child";
    try {
      const hi = await exec.run("Bash", { command: "echo hi > made.txt && cat made.txt && echo ${LANE_J_DAEMON_ONLY:-unset}" }, ctx({ as: coding, cwd: project }));
      expect(hi.isError).toBe(false);
      expect((hi.output as { stdout: string }).stdout).toBe("hi\nunset\n");
      expect(readFileSync(join(project, "made.txt"), "utf8")).toBe("hi\n");
    } finally {
      delete process.env.LANE_J_DAEMON_ONLY;
    }
    // Tools that make temp files land in the fence's temp folder, which the sandbox lets every caller write.
    const tmp = await exec.run("Bash", { command: 'f=$(mktemp "$TMPDIR/lane-j.XXXXXX") && echo made > "$f" && cat "$f"' }, ctx({ as: coding, cwd: project }));
    expect(tmp.isError).toBe(false);
    expect((tmp.output as { stdout: string }).stdout).toBe("made\n");
    // A bot's own run makes its temp files in its own scratch folder, which the sandbox lets it write.
    const botTmp = await exec.run("Bash", { command: 'f=$(mktemp "$TMPDIR/lane-j.XXXXXX") && echo "$f"' }, ctx({ as: LUNA, cwd: project }));
    expect(botTmp.isError).toBe(false);
    expect((botTmp.output as { stdout: string }).stdout.startsWith(join(clover, "scratch", "luna"))).toBe(true);
    const fenced = await exec.run("Bash", { command: `echo planted > ${JSON.stringify(join(clover, "settings.json"))}` }, ctx({ as: coding, cwd: project }));
    expect(fenced.isError).toBe(true);
    expect(readFileSync(join(clover, "settings.json"), "utf8")).toBe("orig");
  }, 30_000);
});

describe("through the daemon's parts (startDaemonParts), as the daemon wires it", () => {
  let stops: Array<() => unknown> = [];
  afterEach(async () => {
    for (const s of stops.reverse()) await s();
    stops = [];
  });

  async function start(spawner?: FencedSpawner) {
    const clock = new SystemClock();
    const home = temp("lane-j-exec-home-");
    const userHome = temp("lane-j-exec-user-");
    const net = new MemoryNetwork();
    const store = new CloverSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    const d = await startDaemonLinks({
      home, store, clock, self: { name: "Studio", os: hostOs() }, handlers: {}, binary: null, wire: (k) => net.endpoint(k.publicKey),
      handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {},
      dispatch: async () => null,
    });
    stops.push(() => d.close());
    const fakes = new Drivers();
    const parts = await startDaemonParts({
      cloverHome: home, userHome, clock, links: d.links, handlers: {},
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => fakes.factory, defaultModel: () => ({ model: "clover-test/calls" }) },
      ...(spawner ? { spawner } : {}),
    });
    stops.push(() => parts.close());
    return { node: parts.node!, userHome };
  }

  test("a bot's Bash on this computer runs through the daemon's spawner, as that bot, in the folder's real path", async () => {
    const s = fake(() => ({ kind: "exited", code: 0, stdout: "ok\n", stderr: "", shell: "sh" }));
    const { node, userHome } = await start(s);
    const name = node.registry.self().name;
    const r = await node.tools.run("Bash", { command: "echo ok" }, { session: "s_luna", sessionKind: "bot", bot: "luna", callId: "c1", cwd: `home/${name}` });
    expect(r.isError).toBe(false);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ command: "echo ok", cwd: realpathSync(userHome), who: { caller: { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" } } });
    expect(s.runs[0]!.env.HOME).toBe(userHome);
    // In production too: a coding session's TMPDIR is the fence's temp folder; the bot's is its own scratch folder.
    expect(s.runs[0]!.env.TMPDIR).toEndWith("/scratch/luna");
    await node.tools.run("Bash", { command: "echo ok" }, { session: "s_code", sessionKind: "coding", callId: "c2", cwd: `home/${name}` });
    expect(s.runs[1]!.env.TMPDIR).toBe(new CloverFence({ home: userHome, cloverHome: join(userHome, ".x") }).temp);
  }, 30_000);

  test("without a spawner the node has no executor: Bash on its tree is refused, never run unsandboxed", async () => {
    const { node } = await start();
    const name = node.registry.self().name;
    const r = await node.tools.run("Bash", { command: "echo ok" }, { session: "s_luna", sessionKind: "bot", bot: "luna", callId: "c1", cwd: `home/${name}` });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.output)).toContain("no executor");
  }, 30_000);
});
