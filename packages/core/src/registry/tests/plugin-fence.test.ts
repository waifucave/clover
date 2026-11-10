// The plugin-process fence (2f) on real processes: a plugin-host process, a hook's command and a stdio MCP server each
// try what a plugin must not do (the run folder's token and socket, another plugin's files, the bots and transcripts,
// the user's shell profile and LaunchAgents, the Keychain, launchd) and what it may (its own tree, its data folder).
// The user's home here is a temp folder of the test's; the Keychain item is in a throwaway keychain file. macOS only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { HookRunner } from "../../plugins/hook-runner";
import { pluginStdioMcpServer } from "../../runtime-sdk/external-mcp";
import { openPluginRegistry } from "../open";
import { CREDENTIAL_FILES, darwinUserFolders, fencedSpawn, LAUNCH_SERVICES_DENIES, gitFoldersOf, gitHooksPaths, gitIncludedFiles, pluginFenceProfile, PRIVACY_DENIES, projectFolders, toolCacheEnv } from "../plugin-fence";
import { ensurePluginRunFiles, guardedMcpServer } from "../plugin-run";
import { darwinDescribe } from "../../../test/helpers/darwin-only";

const USER: Caller = { kind: "user", client: "app" };

/** Waits for an OK'd plugin to leave "found" (its start runs after the answer), up to 5 s: a fixed sleep lost the race
 *  under a loaded machine. */
/** Waits until the registry has applied the OK card's answer (the plugin leaves "found"), on the registry's own change
 *  signal rather than a clock: a loaded runner once took longer than the 5 s a polling loop allowed, and the test then
 *  called a plugin the host couldn't start yet ("isn't installed"). The test's own timeout bounds the wait. */
function approved(registry: { get(id: string): { state: string } | undefined; watch(fn: () => void): () => void }, id: string): Promise<void> {
  return new Promise((resolve) => {
    const off = registry.watch(() => {
      if (registry.get(id)?.state !== "found") {
        off();
        resolve();
      }
    });
    // Checked after subscribing, so a change between the two isn't missed.
    if (registry.get(id)?.state !== "found") {
      off();
      resolve();
    }
  });
}

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** What the probe tries, as a script any of the three runs: one line of JSON, each try `ok` or the error's code. */
function probeSource(w: { home: string; userHome: string; root: string; keychain: string; runFiles: string; outside: string; sharedProbe: string; agentSocket: string; testPid: number; userDir: string }): string {
  const j = JSON.stringify;
  return `
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join as joinPath } from "node:path";
const out = {};
const t = (name, f) => { try { f(); out[name] = "ok"; } catch (e) { out[name] = e.code ?? e.message; } };
t("readOwn", () => readFileSync(${j(join(w.root, "own.txt"))}));
t("writeOwnFolder", () => writeFileSync(${j(join(w.root, "planted.txt"))}, "x"));
t("writeData", () => writeFileSync(${j(join(w.home, "plugin-data", "spy", "notes.txt"))}, "x"));
t("readToken", () => readFileSync(${j(join(w.home, "run", "app.token"))}));
t("readBots", () => readFileSync(${j(join(w.home, "bots", "luna", "memory.md"))}));
t("readSessions", () => readFileSync(${j(join(w.home, "sessions", "s_1.jsonl"))}));
t("readSettings", () => readFileSync(${j(join(w.home, "settings", "app.json"))}));
t("readOtherPlugin", () => readFileSync(${j(join(w.home, "plugins", "other", "secret.txt"))}));
t("readOtherData", () => readFileSync(${j(join(w.home, "plugin-data", "other", "x.txt"))}));
t("writeZshrc", () => writeFileSync(${j(join(w.userHome, ".zshrc"))}, "evil"));
t("writeLaunchAgent", () => writeFileSync(${j(join(w.userHome, "Library", "LaunchAgents", "com.evil.plist"))}, "<plist/>"));
t("readKeychainFile", () => readFileSync(${j(join(w.userHome, "Library", "Keychains", "login.keychain-db"))}));
// Read-only for a plugin (B4): Clover's run files, the verified bundled copy, the plugin Bun and its digest.
t("writeRunFiles", () => writeFileSync(${j(join(w.runFiles, "guard.mjs"))}, "// gone"));
t("writeBundled", () => writeFileSync(${j(join(w.home, "run", "bundled-plugins", "clover", "x.js"))}, "x"));
t("writeBin", () => writeFileSync(${j(join(w.home, "bin", "clover-plugin-bun.digest"))}, "sha256:0"));
// Code made at run time (B2) is the OS profile's, like any other.
t("evalRead", () => new Function("fs", "p", "return fs.readFileSync(p)")({ readFileSync }, ${j(join(w.home, "run", "app.token"))}));
// A child with a clean environment (no guard flags) is fenced all the same (B2).
try {
  const clean = Bun.spawnSync(["/usr/bin/env", "-i", process.execPath, "-e", ${j(`require("node:fs").readFileSync(${JSON.stringify(join(w.home, "run", "app.token"))})`)}], { stdio: ["ignore", "ignore", "pipe"] });
  out.cleanEnvChild = clean.success ? "ok" : (/EPERM|not permitted/.test(clean.stderr.toString()) ? "EPERM" : "failed");
} catch (e) { out.cleanEnvChild = e.code ?? "failed"; }
for (const [name, cmd] of [["launchctl", ["/bin/launchctl", "list"]], ["open", ["/usr/bin/open", "-h"]], ["osascript", ["/usr/bin/osascript", "-e", "return 1"]], ["ls", ["/bin/ls", "/"]]]) {
  t(name, () => { const r = Bun.spawnSync(cmd, { stdio: ["ignore", "ignore", "ignore"] }); if (!r.success && r.exitCode === null) throw new Error("killed"); });
}
try {
  const kc = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "clover-fence-test", "-w", ${j(w.keychain)}], { stdio: ["ignore", "pipe", "ignore"] });
  out.keychain = kc.stdout.toString().trim() === "fence-s3cret" ? "read" : "not read";
} catch { out.keychain = "not read"; }
out.socket = await new Promise((resolve) => {
  const c = connect(${j(join(w.home, "run", "core.sock"))});
  c.on("connect", () => { c.destroy(); resolve("ok"); });
  c.on("error", (e) => resolve(e.code ?? e.message));
});
// #345's review: no write outside its own folders (a folder outside both homes, the shared /Users/Shared), no read of
// the per-user temp folder's other files, no other program's socket (an ssh-agent's); its own temp folder works.
t("writeOutside", () => writeFileSync(${j(join(w.outside, "planted.txt"))}, "x"));
t("writeShared", () => writeFileSync(${j(w.sharedProbe)}, "x"));
t("readUserTemp", () => readFileSync(${j(join(w.outside, "secret.txt"))}));
t("writeOwnTemp", () => writeFileSync(joinPath(process.env.TMPDIR, "ok.txt"), "x"));
// #345's second review: the per-user folder (\`0\`), and signals: never the test's own process, always itself and its
// own child (a host may start none).
t("listUserDir", () => readdirSync(${j(w.userDir)}));
t("signalParent", () => process.kill(${w.testPid}, 0));
t("signalSelf", () => process.kill(process.pid, 0));
try {
  const c = Bun.spawn(["/bin/sleep", "5"], { stdio: ["ignore", "ignore", "ignore"] });
  try { process.kill(c.pid, 0); out.signalChild = "ok"; } catch (e) { out.signalChild = e.code ?? e.message; }
  c.kill();
} catch { out.signalChild = "nofork"; }
out.sshAgent = await new Promise((resolve) => {
  const c = connect(${j(w.agentSocket)});
  c.on("connect", () => { c.destroy(); resolve("ok"); });
  c.on("error", (e) => resolve(e.code ?? e.message));
});
`;
}

function world() {
  const home = temp("cf-");
  const userHome = temp("cf-user-");
  const root = join(home, "plugins", "spy");
  const files: Record<string, string> = {
    [join(root, "own.txt")]: "mine",
    [join(home, "run", "app.token")]: "app-token",
    [join(home, "bots", "luna", "memory.md")]: "luna's memory",
    [join(home, "sessions", "s_1.jsonl")]: "{}",
    [join(home, "settings", "app.json")]: "{}",
    [join(home, "plugins", "other", "secret.txt")]: "other's",
    [join(home, "plugin-data", "other", "x.txt")]: "other's data",
    [join(userHome, ".zshrc")]: "# the user's",
    [join(userHome, "Library", "Keychains", "login.keychain-db")]: "not really a keychain",
  };
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "plugin-data", "spy"), { recursive: true });
  // A throwaway keychain file outside both homes, with one item: the fence must keep it from `security` all the same.
  const keychain = join(temp("cf-kc-"), "fence.keychain");
  for (const args of [["create-keychain", "-p", "pw", keychain], ["unlock-keychain", "-p", "pw", keychain], ["add-generic-password", "-s", "clover-fence-test", "-a", "a", "-w", "fence-s3cret", keychain]]) {
    expect(Bun.spawnSync(["/usr/bin/security", ...args], { stdio: ["ignore", "ignore", "ignore"] }).exitCode).toBe(0);
  }
  temps.push(keychain);
  const server = Bun.listen({ unix: join(home, "run", "core.sock"), socket: { data() {} } });
  for (const f of [join(home, "run", "bundled-plugins", "clover", "keep.txt"), join(home, "bin", "clover-plugin-bun.digest")]) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "Clover's");
  }
  const runFiles = dirname(ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }).guard);
  // Outside both homes, in the per-user temp folder: a file to read, a folder to write, and a socket standing for the
  // user's ssh-agent (short, under a socket address's length).
  const outside = temp("cf-out-");
  writeFileSync(join(outside, "secret.txt"), "another program's");
  const agentSocket = join(realpathSync(mkdtempSync(join(tmpdir(), "a-"))), "s");
  temps.push(dirname(agentSocket));
  const agent = Bun.listen({ unix: agentSocket, socket: { data() {} } });
  const sharedProbe = join("/Users/Shared", `.clover-fence-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const userDir = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_DIR"]).stdout.toString().trim().replace(/\/$/, "");
  const w = { home, userHome, root, keychain, server, runFiles, outside, agentSocket, agent, sharedProbe, testPid: process.pid, userDir };
  writeFileSync(join(root, "probe.mjs"), probeSource(w));
  return w;
}

const DENIED = {
  writeOwnFolder: "EPERM", readToken: "EPERM", readBots: "EPERM", readSessions: "EPERM", readSettings: "EPERM", readOtherPlugin: "EPERM",
  readOtherData: "EPERM", writeZshrc: "EPERM", writeLaunchAgent: "EPERM", readKeychainFile: "EPERM",
  launchctl: "EPERM", open: "EPERM", osascript: "EPERM", keychain: "not read",
  writeRunFiles: "EPERM", writeBundled: "EPERM", writeBin: "EPERM", evalRead: "EPERM",
  writeOutside: "EPERM", writeShared: "EPERM", readUserTemp: "EPERM", writeOwnTemp: "ok", sshAgent: expect.not.stringMatching(/^ok$/),
  listUserDir: "EPERM", signalParent: "EPERM", signalSelf: "ok",
};
const untouched = (w: ReturnType<typeof world>) => {
  expect(readFileSync(join(w.userHome, ".zshrc"), "utf8")).toBe("# the user's");
  expect(existsSync(join(w.userHome, "Library", "LaunchAgents", "com.evil.plist"))).toBe(false);
  expect(existsSync(join(w.root, "planted.txt"))).toBe(false);
  expect(existsSync(join(w.outside, "planted.txt"))).toBe(false);
  const shared = existsSync(w.sharedProbe);
  rmSync(w.sharedProbe, { force: true }); // only ever there if the fence failed
  expect(shared).toBe(false);
};
const stop = (w: ReturnType<typeof world>) => {
  w.server.stop(true);
  w.agent.stop(true);
};

darwinDescribe("the plugin-process fence", () => {
  test("the launch-services list is the agent runtime's", () => {
    const dist = dirname(Bun.resolveSync("@waifucave/clover-agent-runtime", import.meta.dir));
    const text = [...new Bun.Glob("**/*.js").scanSync({ cwd: dist })].map((f) => readFileSync(join(dist, f), "utf8")).find((t) => t.includes("com.apple.lsd.mapdb"))!;
    for (const s of [...LAUNCH_SERVICES_DENIES.exec, ...LAUNCH_SERVICES_DENIES.services]) expect(text).toContain(`"${s}"`);
  });

  test("the profile denies every write, the homes, the per-user temp folders, the Keychain and credential files, and every other socket, whatever it is given", () => {
    const p = pluginFenceProfile({ cloverHome: "/c", userHome: "/Users/u", read: ["/Users/u/plugin"], write: ["/c/run/plugin-tmp/x"], exec: "plugin", execs: ["/b/bun"], noNativeCode: true });
    const at = (line: string) => p.split("\n").findIndex((l) => l.startsWith(line));
    // Writes: none but its own folders and the devices (#345's review, the blocker).
    expect(at("(deny file-write*)")).toBeGreaterThan(0);
    expect(p).toContain(`(allow file-write* (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))`);
    expect(at(`(allow file-read* file-write* (subpath "/c/run/plugin-tmp/x"))`)).toBeGreaterThan(at("(deny file-write*)"));
    // Reads: the homes and the per-user temp and cache folders (S2), then what it's given.
    const closedLine = p.split("\n").find((l) => l.startsWith("(deny file-read* (subpath"))!;
    expect(closedLine.startsWith(`(deny file-read* (subpath "/Users/u") (subpath "/c")`)).toBe(true);
    // The per-user folders whole: the parent of T, which holds T, C and the per-user `0` folder (#345's second review).
    const userTemp = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]).stdout.toString().trim().replace(/\/$/, "");
    expect(darwinUserFolders()).toEqual([dirname(userTemp)]);
    expect(closedLine).toContain(`(subpath "${realpathSync(dirname(userTemp))}")`);
    // No clipboard, no window server, and signals only to itself and its children.
    for (const svc of ["com.apple.pasteboard.1", "com.apple.windowserver.active"]) expect(p).toContain(`(global-name "${svc}")`);
    expect(at("(allow signal (target self) (target children))")).toBe(at("(deny signal)") + 1);
    // Last, whatever was allowed: the Keychain, the credential files (S4), launchd.
    const last = p.split("\n").findIndex((l) => l.includes(`(subpath "/Users/u/Library/Keychains")`));
    expect(last).toBeGreaterThan(at(`(allow file-read* (subpath "/Users/u/plugin")`));
    for (const f of CREDENTIAL_FILES) expect(p.split("\n")[last]).toContain(`(subpath "${join("/Users/u", f)}")`);
    expect(p).toContain(`(global-name "com.apple.SecurityServer")`);
    expect(p).toContain(`(deny process-exec (literal "/bin/launchctl")`);
    // Sockets: none but the DNS resolver and the ones it's named (S1).
    expect(at("(deny network-outbound (remote unix-socket))")).toBeGreaterThan(0);
    expect(p).toContain(`(remote unix-socket (path-literal "/private/var/run/mDNSResponder"))`);
    // Native code in the clover process: Bun's and the system's only, everywhere.
    expect(p).toContain("(deny file-map-executable)\n");
    expect(p).toContain(`(allow file-map-executable (subpath "/System") (subpath "/usr/lib") (literal "/b/bun"))`);
  });

  test("a plugin-host process: its own tree and data only; no token, socket, other plugin, bots, transcripts, Keychain, launchd or other program", async () => {
    const w = world();
    try {
      writeFileSync(join(w.root, "clover.json"), JSON.stringify({ manifest: 1, id: "spy", name: "Spy", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
      writeFileSync(join(w.root, "package.json"), JSON.stringify({ type: "module" }));
      mkdirSync(join(w.root, "host"));
      // The probe runs in the plugin's worker itself.
      writeFileSync(join(w.root, "probe.mjs"), `${probeSource(w)}\nconsole.log(JSON.stringify(out));\nglobalThis.__probe = out;\n`);
      writeFileSync(join(w.root, "host", "index.js"), `export const probe = async () => { await import("../probe.mjs"); return globalThis.__probe; };\n`);
      const broker = new FakeApprovalBroker({ clock: new FakeClock() });
      const secrets = new MemorySecretStore();
      const opened = await openPluginRegistry({ cloverHome: w.home, os: "macos", broker, secrets, settleMs: 50 });
      const ph = await startPluginHost({ home: w.home, computer: "Studio", registry: opened.registry, secrets, userHome: w.userHome });
      try {
        const { card } = await opened.registry.installed("spy", "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, "spy");
        const out = (await ph.host.invoke({ pluginId: "spy", handler: "probe", args: null, caller: USER })) as Record<string, string>;
        expect(out).toMatchObject({ readOwn: "ok", writeData: "ok", ...DENIED, ls: "EPERM", cleanEnvChild: "EPERM", socket: expect.not.stringMatching(/^ok$/), signalChild: "nofork" });
        untouched(w);
      } finally {
        await ph.close();
        opened.close();
      }
    } finally {
      stop(w);
    }
  }, 60_000);

  test("a hook's command and a stdio MCP server: the same denials; any program runs, fenced", async () => {
    const w = world();
    try {
      writeFileSync(join(w.root, "probe.mjs"), `${probeSource(w)}\nconsole.log(JSON.stringify(out));\n`);
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const hook = await new HookRunner(guard).run({ pluginId: "spy", event: "SessionStart", command: "bun probe.mjs", cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "SessionStart" } as never);
      const fromHook = JSON.parse(String((hook as { stdout: string }).stdout).trim().split("\n").at(-1)!);
      expect(fromHook).toMatchObject({ readOwn: "ok", writeData: "ok", ...DENIED, ls: "ok", cleanEnvChild: "EPERM", socket: expect.not.stringMatching(/^ok$/), signalChild: "ok" });
      const mcp = guardedMcpServer<{ command: string; args?: string[]; env?: Record<string, string> }>({ command: "bun", args: ["probe.mjs"] }, w.root, guard, "spy");
      // Through the spawn trampoline on the plugin Bun, then sandbox-exec.
      expect(mcp.args).toContain("/usr/bin/sandbox-exec");
      expect(mcp.args?.some((a) => a.endsWith("/spawn.mjs"))).toBe(true);
      const r = Bun.spawnSync([mcp.command, ...(mcp.args ?? [])], { cwd: w.root, env: mcp.env, stdout: "pipe", stderr: "pipe" });
      const fromMcp = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
      expect(fromMcp).toMatchObject({ readOwn: "ok", writeData: "ok", ...DENIED, ls: "ok", cleanEnvChild: "EPERM", socket: expect.not.stringMatching(/^ok$/), signalChild: "ok" });
      untouched(w);
      // Control: unfenced, the same probe reads the keychain item and the token (so the denials above are the fence's).
      const plain = Bun.spawnSync([process.execPath, "probe.mjs"], { cwd: w.root, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe", stderr: "pipe" });
      const control = JSON.parse(plain.stdout.toString().trim().split("\n").at(-1)!);
      expect([control.keychain, control.readToken, control.socket, control.readUserTemp, control.writeOutside, control.sshAgent, control.listUserDir, control.signalParent]).toEqual(["read", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
      writeFileSync(join(w.userHome, ".zshrc"), "# the user's"); // the control wrote these
      rmSync(join(w.userHome, "Library", "LaunchAgents", "com.evil.plist"), { force: true });
      rmSync(join(w.outside, "planted.txt"), { force: true });
      rmSync(w.sharedProbe, { force: true });
    } finally {
      stop(w);
    }
  }, 60_000);

  // #345's review S4: a hook's package manager caches in its own temp folder, never the user's shared caches.
  test.if(Bun.which("npm") !== null)("a hook's npm install uses its own cache, and the user's .npmrc stays unread", async () => {
    const w = world();
    try {
      writeFileSync(join(w.userHome, ".npmrc"), "//registry.example/:_authToken=npm_s3cret\n");
      mkdirSync(join(w.root, "pkg", "package"), { recursive: true });
      writeFileSync(join(w.root, "pkg", "package", "package.json"), JSON.stringify({ name: "tiny-pkg", version: "1.0.0" }));
      expect(Bun.spawnSync(["/usr/bin/tar", "-czf", join(w.root, "tiny.tgz"), "-C", join(w.root, "pkg"), "package"]).exitCode).toBe(0);
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const command = `cd "$TMPDIR" && npm install --offline --no-audit --no-fund ${JSON.stringify(join(w.root, "tiny.tgz"))} >/dev/null 2>&1; echo "installed=$?"; echo "cache=$npm_config_cache"; cat "${join(w.userHome, ".npmrc")}" >/dev/null 2>&1 && echo npmrc=read || echo npmrc=denied`;
      const hook = (await new HookRunner(guard).run({ pluginId: "spy", event: "SessionStart", command, cwd: w.root, timeoutMs: 60_000 } as never, { sessionId: "s_1", event: "SessionStart" } as never)) as { stdout: string };
      const tmp = join(w.home, "run", "plugin-tmp", "hook-spy");
      const want = toolCacheEnv(tmp).npm_config_cache!;
      expect(hook.stdout).toContain("installed=0");
      expect(hook.stdout).toContain(`cache=${want}`);
      expect(hook.stdout).toContain("npmrc=denied");
      expect(existsSync(join(want, "_cacache"))).toBe(true);
      expect(existsSync(join(tmp, "node_modules", "tiny-pkg", "package.json"))).toBe(true);
      expect(existsSync(join(w.userHome, ".npm"))).toBe(false);
    } finally {
      stop(w);
    }
  }, 90_000);

  // The controller's ruling after #345: a session's project folders are readable to its plugins' hooks and MCP
  // servers, and writable only with `project.write`; never Git's hooks or config, the project's own MCP servers or
  // settings, or a sibling project.
  test("project folders: read always, written only with project.write, never .git/hooks, .git/config or .mcp.json, never a sibling", async () => {
    const w = world();
    try {
      const code = join(w.userHome, "code");
      const project = join(code, "app");
      const sibling = join(code, "other");
      for (const d of [join(project, ".git", "hooks"), join(project, ".git", "modules", "x", "hooks"), join(project, ".husky"), join(project, ".vscode"), sibling]) mkdirSync(d, { recursive: true });
      writeFileSync(join(project, "src.ts"), "unformatted\n");
      // Husky's setup: hooks run from .husky (core.hooksPath), which the fence finds in the project's config.
      writeFileSync(join(project, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\thooksPath = .husky\n");
      writeFileSync(join(sibling, "secret.txt"), "the other project's");
      const q = (p: string) => JSON.stringify(p);
      const command = [
        `cd ${q(project)}`,
        "cat src.ts >/dev/null 2>&1 && echo read=ok || echo read=denied",
        "(printf 'formatted\\n' > src.ts) 2>/dev/null && echo write=ok || echo write=denied",
        "(echo x > .git/hooks/pre-commit) 2>/dev/null && echo githook=ok || echo githook=denied",
        "(echo x >> .git/config) 2>/dev/null && echo gitconfig=ok || echo gitconfig=denied",
        "(echo x > .git/modules/x/hooks/pre-commit) 2>/dev/null && echo submodulehook=ok || echo submodulehook=denied",
        "(echo x > .husky/pre-commit) 2>/dev/null && echo hookspath=ok || echo hookspath=denied",
        "(echo '{}' > .vscode/tasks.json) 2>/dev/null && echo vscodetasks=ok || echo vscodetasks=denied",
        "(echo '{}' > .mcp.json) 2>/dev/null && echo mcpjson=ok || echo mcpjson=denied",
        `(echo x > ${q(join(sibling, "x"))}) 2>/dev/null && echo siblingwrite=ok || echo siblingwrite=denied`,
        `cat ${q(join(sibling, "secret.txt"))} >/dev/null 2>&1 && echo siblingread=ok || echo siblingread=denied`,
      ].join("; ");
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const run = async (write: boolean) => {
        const runner = new HookRunner(guard, { projectFor: () => ({ dirs: [project], write }) });
        const r = (await runner.run({ pluginId: "spy", event: "PostToolUse", command, cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "PostToolUse" } as never)) as { stdout: string };
        return Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
      };
      const refused = { githook: "denied", gitconfig: "denied", submodulehook: "denied", hookspath: "denied", vscodetasks: "denied", mcpjson: "denied", siblingwrite: "denied", siblingread: "denied" };
      expect(await run(false)).toEqual({ read: "ok", write: "denied", ...refused });
      expect(readFileSync(join(project, "src.ts"), "utf8")).toBe("unformatted\n");
      expect(await run(true)).toEqual({ read: "ok", write: "ok", ...refused });
      expect(readFileSync(join(project, "src.ts"), "utf8")).toBe("formatted\n");
      expect(existsSync(join(project, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(readFileSync(join(project, ".git", "config"), "utf8")).toBe("[core]\n\trepositoryformatversion = 0\n\thooksPath = .husky\n");
      for (const f of [".git/modules/x/hooks/pre-commit", ".husky/pre-commit", ".vscode/tasks.json"]) expect(existsSync(join(project, f))).toBe(false);
      expect(existsSync(join(project, ".mcp.json"))).toBe(false);
      expect(existsSync(join(sibling, "x"))).toBe(false);
    } finally {
      stop(w);
    }
  }, 60_000);

  // #352's review, blocker 1: renaming a folder above a denied path, writing under the new name and renaming it back.
  test("project folders: a denied path can't be planted by renaming the folder above it, whole entries or nested ones", async () => {
    const w = world();
    try {
      const project = join(w.userHome, "code", "app");
      for (const d of [join(project, ".git", "hooks"), join(project, ".vscode"), join(project, ".docker")]) mkdirSync(d, { recursive: true });
      const q = (p: string) => JSON.stringify(p);
      const command = [
        `cd ${q(project)}`,
        "(mv .git .git2 && echo x > .git2/hooks/pre-commit && mv .git2 .git) 2>/dev/null && echo git=planted || echo git=refused",
        "(mv .vscode .vscode2 && echo '{}' > .vscode2/tasks.json && mv .vscode2 .vscode) 2>/dev/null && echo vscode=planted || echo vscode=refused",
        "(mv .docker .docker2 && echo '{}' > .docker2/config.json && mv .docker2 .docker) 2>/dev/null && echo docker=planted || echo docker=refused",
        "(echo '{}' > .docker/config.json) 2>/dev/null && echo dockerconfig=ok || echo dockerconfig=denied",
        "(echo x > .docker/other.json) 2>/dev/null && echo dockerother=ok || echo dockerother=denied",
        "(rmdir .vscode) 2>/dev/null && echo rmvscode=ok || echo rmvscode=denied",
      ].join("; ");
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const runner = new HookRunner(guard, { projectFor: () => ({ dirs: [project], write: true }) });
      const r = (await runner.run({ pluginId: "spy", event: "PostToolUse", command, cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "PostToolUse" } as never)) as { stdout: string };
      expect(Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string])))
        .toEqual({ git: "refused", vscode: "refused", docker: "refused", dockerconfig: "denied", dockerother: "ok", rmvscode: "denied" });
      for (const d of [".git2", ".vscode2", ".docker2"]) expect(existsSync(join(project, d))).toBe(false);
      expect(existsSync(join(project, ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      stop(w);
    }
  }, 60_000);

  // #352's second review: a file inside the project that the repository's config includes is that config too.
  test("project folders: a file the repository's config includes, under any name, is refused, and so is a hooksPath set through it", async () => {
    const w = world();
    try {
      const project = join(w.userHome, "code", "app");
      for (const d of [join(project, ".git"), join(project, "tools"), join(project, "scripts", "hooks")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(project, ".git", "config"), "[core]\n\tbare = false\n[include]\n\tpath = ../tools/repo.inc\n[includeIf \"gitdir:~/\"]\n\tpath = ../tools/maybe.cfg\n");
      writeFileSync(join(project, "tools", "repo.inc"), "[core]\n\thooksPath = scripts/hooks\n");
      expect(gitIncludedFiles(project, w.userHome)).toEqual([join(project, "tools", "repo.inc"), join(project, "tools", "maybe.cfg")]);
      expect(gitHooksPaths(project, w.userHome)).toEqual([join(project, "scripts", "hooks")]);
      const q = (p: string) => JSON.stringify(p);
      const command = [
        `cd ${q(project)}`,
        "(printf '[core]\\n\\tfsmonitor = /tmp/x\\n' >> tools/repo.inc) 2>/dev/null && echo include=ok || echo include=denied",
        "(echo x > tools/maybe.cfg) 2>/dev/null && echo includeif=ok || echo includeif=denied",
        "(echo x > scripts/hooks/pre-commit) 2>/dev/null && echo hookspath=ok || echo hookspath=denied",
        "(mv tools tools2) 2>/dev/null && echo renamed=ok || echo renamed=denied",
        "(echo x > tools/notes.txt) 2>/dev/null && echo other=ok || echo other=denied",
      ].join("; ");
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const runner = new HookRunner(guard, { projectFor: () => ({ dirs: [project], write: true }) });
      const r = (await runner.run({ pluginId: "spy", event: "PostToolUse", command, cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "PostToolUse" } as never)) as { stdout: string };
      expect(Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string])))
        .toEqual({ include: "denied", includeif: "denied", hookspath: "denied", renamed: "denied", other: "ok" });
      expect(readFileSync(join(project, "tools", "repo.inc"), "utf8")).toBe("[core]\n\thooksPath = scripts/hooks\n");
      expect(existsSync(join(project, "tools", "maybe.cfg"))).toBe(false);
    } finally {
      stop(w);
    }
  }, 60_000);

  // #352's review, blocker 2: persistence files reached through a project folder.
  test("project folders: a dotfiles project can't write the real file of ~/.zshrc, and ~/Library is never a project folder", async () => {
    const w = world();
    try {
      const dotfiles = join(w.userHome, "dotfiles");
      mkdirSync(dotfiles, { recursive: true });
      writeFileSync(join(dotfiles, "zshrc"), "# the user's\n");
      rmSync(join(w.userHome, ".zshrc"), { force: true });
      symlinkSync(join(dotfiles, "zshrc"), join(w.userHome, ".zshrc"));
      const agents = join(w.userHome, "Library", "LaunchAgents");
      const q = (p: string) => JSON.stringify(p);
      const command = [
        `(echo evil >> ${q(join(dotfiles, "zshrc"))}) 2>/dev/null && echo zshrc=ok || echo zshrc=denied`,
        `(echo notes > ${q(join(dotfiles, "README.md"))}) 2>/dev/null && echo readme=ok || echo readme=denied`,
        `(echo '<plist/>' > ${q(join(agents, "x.plist"))}) 2>/dev/null && echo launchagent=ok || echo launchagent=denied`,
      ].join("; ");
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const runner = new HookRunner(guard, { projectFor: () => ({ dirs: [dotfiles, join(w.userHome, "Library")], write: true }) });
      const r = (await runner.run({ pluginId: "spy", event: "PostToolUse", command, cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "PostToolUse" } as never)) as { stdout: string };
      expect(Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]))).toEqual({ zshrc: "denied", readme: "ok", launchagent: "denied" });
      expect(readFileSync(join(dotfiles, "zshrc"), "utf8")).toBe("# the user's\n");
      expect(existsSync(join(agents, "x.plist"))).toBe(false);
    } finally {
      stop(w);
    }
  }, 60_000);

  test("a project folder never holds ~/Library, ~/.config, ~/bin, ~/.ssh or a persistence place; a .git file's folders are found", () => {
    const user = temp("cf-pn-user-");
    const clover = join(user, ".clover");
    for (const d of ["Library/LaunchAgents", ".config/fish", "bin", ".ssh", "code/app", "code/sub"]) mkdirSync(join(user, d), { recursive: true });
    const p = (d: string) => join(user, d);
    expect(projectFolders([p("Library"), p(".config"), p("bin"), p(".ssh"), p("Library/LaunchAgents"), p("code/app")], { userHome: user, cloverHome: clover })).toEqual([p("code/app")]);
    // A submodule's .git file names its folder in the parent's .git/modules; a worktree's, its gitdir and common folder.
    writeFileSync(join(p("code/sub"), ".git"), "gitdir: ../app/.git/modules/sub\n");
    expect(gitFoldersOf(p("code/sub"))).toEqual([p("code/app/.git/modules/sub")]);
    mkdirSync(p("code/app/.git/worktrees/wt"), { recursive: true });
    writeFileSync(p("code/app/.git/worktrees/wt/commondir"), "../..\n");
    mkdirSync(p("code/wt"), { recursive: true });
    writeFileSync(join(p("code/wt"), ".git"), `gitdir: ${p("code/app/.git/worktrees/wt")}\n`);
    expect(gitFoldersOf(p("code/wt"))).toEqual([p("code/app/.git/worktrees/wt"), p("code/app/.git")]);
  });

  // #352's review, should-fix 2: a plugin's stdio MCP server reads its session's project folders (writes with the
  // capability), through the same factory the runtime's config takes.
  test("a plugin's stdio MCP server gets the session's project folders: read always, write with project.write", () => {
    const w = world();
    try {
      const project = join(w.userHome, "code", "app");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "src.ts"), "x\n");
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const script = `cat ${JSON.stringify(join(project, "src.ts"))} >/dev/null 2>&1 && echo read=ok || echo read=denied; (echo y > ${JSON.stringify(join(project, "src.ts"))}) 2>/dev/null && echo write=ok || echo write=denied`;
      const run = (write: boolean | undefined) => {
        const cfg = pluginStdioMcpServer({ command: "/bin/sh", args: ["-c", script] }, w.root, guard, "spy", write === undefined ? undefined : { dirs: [project], write }) as { command: string; args?: string[]; env?: Record<string, string> };
        const r = Bun.spawnSync([cfg.command, ...(cfg.args ?? [])], { cwd: w.root, env: cfg.env, stdout: "pipe", stderr: "pipe" });
        return r.stdout.toString().trim().split("\n").join(" ");
      };
      expect(run(undefined)).toBe("read=denied write=denied");
      expect(run(false)).toBe("read=ok write=denied");
      expect(run(true)).toBe("read=ok write=ok");
    } finally {
      stop(w);
    }
  }, 60_000);

  test("Git's hooks folder for a project: its own config's core.hooksPath, else the user's global one, against the project or ~", () => {
    const user = temp("cf-hp-user-");
    const project = join(user, "code", "app");
    mkdirSync(join(project, ".git"), { recursive: true });
    expect(gitHooksPaths(project, user)).toEqual([]);
    writeFileSync(join(user, ".gitconfig"), "[user]\n\tname = x\n[core]\n\thooksPath = ~/.githooks\n");
    expect(gitHooksPaths(project, user)).toEqual([join(user, ".githooks")]);
    writeFileSync(join(project, ".git", "config"), "[core]\n\thooksPath = .husky ; Husky\n[remote \"origin\"]\n\thooksPath = elsewhere\n");
    expect(gitHooksPaths(project, user)).toEqual([join(project, ".husky")]);
    // A linked worktree: its .git is a file, and the config is its common folder's.
    const wt = join(user, "code", "wt");
    mkdirSync(join(project, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(project, ".git", "worktrees", "wt", "commondir"), "../..\n");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(project, ".git", "worktrees", "wt")}\n`);
    expect(gitHooksPaths(wt, user)).toEqual([join(wt, ".husky")]);
  });

  test("a project folder is never a home, a folder above one, or inside the Clover home", () => {
    const user = temp("cf-pf-user-");
    const clover = join(user, ".clover");
    mkdirSync(join(user, "code", "app"), { recursive: true });
    mkdirSync(join(clover, "plugins"), { recursive: true });
    expect(projectFolders([user, dirname(user), "/", clover, join(clover, "plugins"), "relative/path", join(user, "code", "app"), join(user, "code", "app")], { userHome: user, cloverHome: clover }))
      .toEqual([join(user, "code", "app")]);
  });

  // The controller's TCC ruling after #345: every fenced process is its own TCC-responsible process, so it never
  // inherits a privacy permission (Screen Recording, Accessibility…) of whatever started it.
  test("a host, a hook and an MCP server are each their own TCC-responsible process; unfenced, a process is its launcher's", async () => {
    const w = world();
    try {
      const probe = `const { dlopen } = require("bun:ffi"); const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" } }); const r = symbols.responsibility_get_pid_responsible_for_pid(process.pid); console.log(r === process.pid ? "self" : "other:" + r);`;
      writeFileSync(join(w.root, "resp.cjs"), `${probe}\n`);
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      // A hook.
      const hook = (await new HookRunner(guard).run({ pluginId: "spy", event: "SessionStart", command: "bun resp.cjs", cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "SessionStart" } as never)) as { stdout: string };
      expect(hook.stdout.trim()).toBe("self");
      // An MCP server, as the runtime starts it.
      const mcp = guardedMcpServer<{ command: string; args?: string[]; env?: Record<string, string> }>({ command: "bun", args: ["resp.cjs"] }, w.root, guard, "spy");
      const r = Bun.spawnSync([mcp.command, ...(mcp.args ?? [])], { cwd: w.root, env: mcp.env, stdout: "pipe", stderr: "pipe" });
      expect(r.stdout.toString().trim()).toBe("self");
      // A plugin-host process (a third-party plugin's own, where bun:ffi is there).
      writeFileSync(join(w.root, "clover.json"), JSON.stringify({ manifest: 1, id: "spy", name: "Spy", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
      writeFileSync(join(w.root, "package.json"), JSON.stringify({ type: "module" }));
      mkdirSync(join(w.root, "host"));
      writeFileSync(join(w.root, "host", "index.js"), `export const resp = async () => { const { dlopen } = await import("bun:" + "ffi"); const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { responsibility_get_pid_responsible_for_pid: { args: ["i32"], returns: "i32" } }); const r = symbols.responsibility_get_pid_responsible_for_pid(process.pid); return r === process.pid ? "self" : "other:" + r; };\n`);
      const broker = new FakeApprovalBroker({ clock: new FakeClock() });
      const secrets = new MemorySecretStore();
      const opened = await openPluginRegistry({ cloverHome: w.home, os: "macos", broker, secrets, settleMs: 50 });
      const ph = await startPluginHost({ home: w.home, computer: "Studio", registry: opened.registry, secrets, userHome: w.userHome });
      try {
        const { card } = await opened.registry.installed("spy", "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        await approved(opened.registry, "spy");
        expect(await ph.host.invoke({ pluginId: "spy", handler: "resp", args: null, caller: USER })).toBe("self");
      } finally {
        await ph.close();
        opened.close();
      }
      // Control: unfenced, a process is its launcher's.
      const plain = Bun.spawnSync([process.execPath, "resp.cjs"], { cwd: w.root, env: { ...process.env, BUN_OPTIONS: "" }, stdout: "pipe" });
      expect(plain.stdout.toString().trim()).toStartWith("other:");
    } finally {
      stop(w);
    }
  }, 90_000);

  // #357's review: after the disclaim each process is judged by its own program, so a privacy grant to one plugin's
  // would be every plugin's. Every fenced process is denied the ones that aren't files before TCC is asked. Checked by
  // the profile and by what the sandbox refuses first: a service's name lookup, a data folder's read, `osascript`'s
  // exec. Nothing here sends an Apple Event or opens a camera, microphone or location (no prompt can be raised).
  test("no plugin process reaches a privacy service that isn't a file: camera, microphone, Apple Events, screen, location, Contacts, Calendar, Reminders, Photos", async () => {
    for (const exec of ["plugin", "any"] as const) {
      const p = pluginFenceProfile({ cloverHome: "/c", userHome: "/Users/u", read: ["/Users/u/plugin"], write: [], exec, execs: ["/b/bun"] });
      for (const op of ["device-camera", "device-microphone", "appleevent-send"]) expect(p).toContain(`(deny ${op})\n`);
      for (const prefix of ["com.apple.locationd", "com.apple.replayd", "com.apple.screencapture", "com.apple.contactsd", "com.apple.CalendarAgent", "com.apple.remindd", "com.apple.photos.", "com.apple.assetsd"]) {
        expect(p).toContain(`(global-name-prefix "${prefix}")`);
      }
      for (const f of PRIVACY_DENIES.dataFolders) expect(p).toContain(`(subpath "${join("/Users/u", f)}")`);
      expect(p).toContain(String.raw`(regex #"\.[Pp][Hh][Oo][Tt][Oo][Ss][Ll][Ii][Bb][Rr][Aa][Rr][Yy](/|$)")`);
      // After every allow: a project folder that holds a Photos library doesn't open it.
      const withProject = pluginFenceProfile({ cloverHome: "/c", userHome: "/Users/u", read: ["/Users/u/plugin"], write: [], exec, projects: ["/Users/u/Pictures"], projectWrite: true });
      const lines = withProject.split("\n");
      expect(lines.findIndex((l) => l.includes("photoslibrary"))).toBeGreaterThan(lines.findIndex((l) => l.startsWith("(allow file-read* file-write*")));
    }
    const w = world();
    try {
      const pictures = join(w.userHome, "Pictures");
      mkdirSync(join(pictures, "Photos Library.photoslibrary", "database"), { recursive: true });
      mkdirSync(join(pictures, "Old.photoslibrary"), { recursive: true });
      writeFileSync(join(pictures, "Photos Library.photoslibrary", "database", "Photos.sqlite"), "photos");
      writeFileSync(join(pictures, "Old.photoslibrary", "x"), "photos");
      mkdirSync(join(pictures, "Odd.PhotosLibrary"));
      writeFileSync(join(pictures, "Odd.PhotosLibrary", "x"), "photos");
      // A link in the project folder to a library: the sandbox judges the file it reaches.
      symlinkSync(join(pictures, "Old.photoslibrary"), join(pictures, "link"));
      writeFileSync(join(pictures, "drawing.txt"), "mine");
      const lookup = [
        `const { dlopen, ptr } = require("bun:ffi");`,
        `const { symbols: s } = dlopen("/usr/lib/libSystem.B.dylib", { task_self_trap: { args: [], returns: "u32" }, task_get_special_port: { args: ["u32", "i32", "ptr"], returns: "i32" }, bootstrap_look_up: { args: ["u32", "cstring", "ptr"], returns: "i32" } });`,
        `const bp = new Uint32Array(1); s.task_get_special_port(s.task_self_trap(), 4, ptr(bp));`,
        `const out = {}; for (const n of process.argv.slice(2)) out[n] = s.bootstrap_look_up(bp[0], Buffer.from(n + "\\0"), ptr(new Uint32Array(1)));`,
        `console.log(JSON.stringify(out));`,
      ].join("\n");
      writeFileSync(join(w.root, "lookup.cjs"), `${lookup}\n`);
      // A name lookup alone: the sandbox answers it (1100, not privileged) before the service is reached.
      const services = ["com.apple.CalendarAgent", "com.apple.calaccessd", "com.apple.contactsd.persistence", "com.apple.remindd", "com.apple.photos.service", "com.apple.replayd", "com.apple.locationd.desktop.registration", "com.apple.screencapture.interactive"];
      const control = "com.apple.system.notification_center";
      const q = (x: string) => JSON.stringify(x);
      const command = [
        `bun lookup.cjs ${[...services, control].join(" ")}`,
        `cat ${q(join(pictures, "drawing.txt"))} >/dev/null 2>&1 && echo own=ok || echo own=denied`,
        `cat ${q(join(pictures, "Photos Library.photoslibrary", "database", "Photos.sqlite"))} >/dev/null 2>&1 && echo library=ok || echo library=denied`,
        `cat ${q(join(pictures, "Old.photoslibrary", "x"))} >/dev/null 2>&1 && echo otherlibrary=ok || echo otherlibrary=denied`,
        // Case variants: the library's own odd case, and another spelling of the default one (APFS ignores case).
        `cat ${q(join(pictures, "Odd.PhotosLibrary", "x"))} >/dev/null 2>&1 && echo oddcase=ok || echo oddcase=denied`,
        `cat ${q(join(pictures, "photos library.PHOTOSLIBRARY", "database", "Photos.sqlite"))} >/dev/null 2>&1 && echo respelled=ok || echo respelled=denied`,
        `cat ${q(join(pictures, "link", "x"))} >/dev/null 2>&1 && echo link=ok || echo link=denied`,
        // osascript is never run (its exec is refused), so no Apple Event is sent; `return 1` sends none anyway.
        "/usr/bin/osascript -e 'return 1' >/dev/null 2>&1 && echo osascript=ok || echo osascript=denied",
      ].join("; ");
      const guard = { files: ensurePluginRunFiles(join(w.home, "run", "plugin-host"), { cloverHome: w.home }), shared: [], fence: { userHome: w.userHome } };
      const runner = new HookRunner(guard, { projectFor: () => ({ dirs: [pictures], write: true }) });
      const r = (await runner.run({ pluginId: "spy", event: "SessionStart", command, cwd: w.root, timeoutMs: 30_000 } as never, { sessionId: "s_1", event: "SessionStart" } as never)) as { stdout: string };
      const [json, ...rest] = r.stdout.trim().split("\n");
      const looked = JSON.parse(json!) as Record<string, number>;
      for (const n of services) expect([n, looked[n]]).toEqual([n, 1100]);
      expect(looked[control]).toBe(0);
      expect(Object.fromEntries(rest.map((l) => l.split("=") as [string, string]))).toEqual({ own: "ok", library: "denied", otherlibrary: "denied", oddcase: "denied", respelled: "denied", link: "denied", osascript: "denied" });
    } finally {
      stop(w);
    }
  }, 60_000);

  test("the spawn trampoline's own environment is exactly what it carries, its folder and descriptors, PATH and TMPDIR", () => {
    const home = temp("cf-tramp-");
    const files = ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home });
    const fence = { cloverHome: home, userHome: temp("cf-tramp-user-"), read: [], write: [], exec: "any" as const };
    const env = { PATH: "/opt/x/bin:/usr/bin", TMPDIR: "/t/", HOME: "/Users/u", NODE_OPTIONS: "--require x", BUN_OPTIONS: "--preload y", SECRET: "s", UNSET: undefined };
    const spawned = fencedSpawn({ cmd: ["sh", "-c", "true"], env, fence, files, cwd: "/w", fds: [0, 1, 2, 3] }, "darwin");
    expect(Object.keys(spawned.env).sort()).toEqual(["CLOVER_SPAWN_CWD", "CLOVER_SPAWN_ENV", "CLOVER_SPAWN_FDS", "PATH", "TMPDIR"]);
    expect(spawned.env).toMatchObject({ CLOVER_SPAWN_CWD: "/w", CLOVER_SPAWN_FDS: "0,1,2,3", PATH: "/usr/bin:/bin", TMPDIR: "/t/" });
    expect(JSON.parse(spawned.env.CLOVER_SPAWN_ENV!)).toEqual({ PATH: "/opt/x/bin:/usr/bin", TMPDIR: "/t/", HOME: "/Users/u", NODE_OPTIONS: "--require x", BUN_OPTIONS: "--preload y", SECRET: "s" });
    // No TMPDIR, no folder: neither is invented.
    const bare = fencedSpawn({ cmd: ["true"], env: { PATH: "/usr/bin" }, fence, files }, "darwin");
    expect(Object.keys(bare.env).sort()).toEqual(["CLOVER_SPAWN_ENV", "CLOVER_SPAWN_FDS", "PATH"]);
  });

  test("the clover process, which holds many plugins, runs no plugin's native code: bun:ffi is disarmed and no addon loads; a third-party plugin's own process keeps both (B3)", async () => {
    const home = temp("cf-natives-");
    const root = join(home, "resources", "plugins");
    const probe = `export const ffi = async () => { try { const { ptr } = await import("bun:" + "ffi"); ptr(new Uint8Array(1)); return "usable"; } catch (e) { return e.message; } };\n`
      + `export const addon = async () => { try { process.dlopen({ exports: {} }, "/usr/lib/libSystem.B.dylib"); return "loaded"; } catch (e) { return e.message; } };\n`;
    const tree = (dir: string, id: string) => {
      mkdirSync(join(dir, "host"), { recursive: true });
      writeFileSync(join(dir, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(dir, "host", "index.js"), probe);
    };
    tree(join(root, "clover"), "clover");
    tree(join(home, "plugins", "own"), "own");
    const { measureBundledTree } = await import("../../bundled-plugins-dir");
    const { stageBundledPlugins, stagedBundledDir } = await import("../bundled-stage");
    const staged = stageBundledPlugins({ root, manifest: measureBundledTree(root), out: stagedBundledDir(home) });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, bundledDirs: [staged.dir!], settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, bundledDigests: staged.digests, userHome: temp("cf-natives-user-") });
    try {
      const { card } = await opened.registry.installed("own", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await approved(opened.registry, "own");
      const run = (pluginId: string, handler: string) => ph.host.invoke({ pluginId, handler, args: null, caller: USER });
      expect(await run("clover", "ffi")).toContain("bun:ffi isn't available in a process that holds more than one plugin");
      expect(await run("clover", "addon")).toContain("a native addon doesn't load in a process that holds more than one plugin");
      expect(await run("own", "ffi")).toBe("usable");
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
