// The #301 review's ruling: the places where a file runs later outside any sandbox (shell start files, login items,
// SSH's rc and keys, autostart, the Windows Startup folder and PowerShell profiles) and the coding agents' sandbox
// settings are write-denied to every runner (Clover's fence: its policy, which part 2's Seatbelt and bwrap, the agents'
// sandbox and lane K's writers take; the approval broker refuses a bot's or an agent's write there without a card), and
// a code session the user drives asks for them (the protected card, no "always"; a typed deny in chat; its sandboxed
// Bash can't write them).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { buildMandatoryFloorProfile } from "@waifucave/clover-agent-sdk";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import type { BotSessionContext } from "../../src/bots/service";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { agentConfigPaths, autoRunEntries, autoRunPaths } from "../../src/contracts/fence";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { CloverFence } from "../../src/fence/fence";
import { GIT_CONFIG_READ_CAP, expandWindowsEnv, gitConfiguredDirs, parseRegValue, readGitConfigFile, runLaterExtras, runLaterExtrasFrom } from "../../src/fence/run-later";
import { persistencePaths, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import type { NewSessionEvent } from "@waifucave/clover-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { canUseToolFor } from "../../src/runtime-sdk/approval-bridge";
import { escapeFloorHit } from "../../src/runtime-sdk/hooks";
import { darwinDescribe } from "../helpers/darwin-only";
import { protectedPathsFor, protectedWriteDecision } from "../../src/runtime-sdk/protected-paths";

const SAMPLES = {
  macos: {
    home: "/Users/me",
    auto: [
      "Library/LaunchAgents/evil.plist", ".zshrc", ".bash_login", ".zlogout", ".ssh/authorized_keys", ".ssh/rc", ".ssh/config", ".config/fish/config.fish",
      "Library/Application Support/com.apple.backgroundtaskmanagementagent/backgrounditems.btm", "Library/Preferences/com.apple.loginwindow.plist",
      "Library/Application Support/iTerm2/Scripts/AutoLaunch/x.py", "Library/Workflows/Applications/Folder Actions/x.workflow",
      ".gitconfig", ".config/git/config", ".git-templates/hooks/post-checkout", ".local/bin/ls", "bin/git", ".cargo/bin/x",
      "Library/Python/3.12/lib/python/site-packages/x.pth", ".npmrc", ".yarnrc.yml", ".bunfig.toml", ".cargo/config.toml", ".gradle/init.d/x.gradle",
      ".config/pip/pip.conf", ".pip/pip.conf", ".vimrc", ".config/nvim/init.lua", ".emacs.d/init.el", ".tmux.conf", ".inputrc", ".config/zsh/.zshrc",
    ],
    agent: [".codex/config.toml", ".claude/settings.json", ".claude/agents/x.md", ".claude.json", ".gemini/settings.json", ".gemini/extensions/x/gemini-extension.json", ".cursor/mcp.json", ".config/opencode/opencode.json"],
  },
  linux: {
    home: "/home/me",
    auto: [
      ".config/autostart/x.desktop", ".config/systemd/user/x.service", ".local/share/systemd/user/x.service", ".config/environment.d/x.conf",
      ".pam_environment", ".xprofile", ".xinitrc", ".xsession", ".xsessionrc", ".config/plasma-workspace/env/x.sh", ".config/i3/config",
      ".config/sway/config", ".config/hypr/hyprland.conf", ".config/openbox/autostart", ".bashrc", ".profile", ".cshrc", ".kshrc",
      ".config/nushell/config.nu", ".local/lib/python3.12/site-packages/x.pth", ".gitconfig", ".local/bin/x", ".npmrc", ".vimrc",
    ],
    agent: [".codex/config.toml", ".claude/settings.local.json", ".claude.json", ".gemini/settings.json"],
  },
  windows: {
    home: "C:\\Users\\me",
    auto: [
      "AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk", "Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
      "Documents\\WindowsPowerShell\\profile.ps1", ".bashrc", ".ssh\\authorized_keys", ".gitconfig", ".npmrc", "AppData\\Roaming\\Python\\Python312\\site-packages\\x.pth",
    ],
    agent: [".codex\\config.toml", ".config\\opencode\\opencode.json", ".claude.json", ".cursor\\mcp.json"],
  },
} as const;

describe("the shared list", () => {
  test("each OS has its groups", () => {
    expect(autoRunPaths("macos", "/Users/me")).toEqual(expect.arrayContaining(["/Users/me/Library/LaunchAgents", "/Users/me/.zshrc", "/Users/me/.ssh/authorized_keys", "/Users/me/.config/fish"]));
    expect(autoRunPaths("linux", "/home/me")).toEqual(expect.arrayContaining(["/home/me/.config/systemd/user", "/home/me/.local/share/systemd/user", "/home/me/.pam_environment", "/home/me/.xprofile", "/home/me/.bash_login"]));
    expect(autoRunPaths("windows", "C:\\Users\\me")).toEqual(expect.arrayContaining(["C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", "C:\\Users\\me\\Documents\\PowerShell", "C:\\Users\\me\\Documents\\WindowsPowerShell"]));
    expect(agentConfigPaths("linux", "/home/me")).toEqual(["/home/me/.claude", "/home/me/.claude.json", "/home/me/.codex/config.toml", "/home/me/.gemini", "/home/me/.cursor", "/home/me/.config/opencode"]);
    // No duplicates, and nothing that ssh, git or a shell writes as it runs.
    for (const os of ["macos", "linux", "windows"] as const) {
      const list = autoRunPaths(os, os === "windows" ? "C:\\Users\\me" : "/home/me");
      expect(new Set(list).size).toBe(list.length);
      expect(list.some((p) => /known_hosts|\.zsh_history|\.bash_history|\.lesshst/.test(p))).toBe(false);
    }
  });

  test("the user's own settings add theirs: git's templates and hooks, ZDOTDIR, PYTHONSTARTUP, a moved Documents", () => {
    expect(gitConfiguredDirs([
      "[core]", "\thooksPath = ~/.githooks   # mine", "[init]", '  templateDir = "/opt/tmpl"', "[alias]", "  hooksPath = /not/this",
      '[includeIf "gitdir:~/w/"]', "  path = x", "[core]", "  hooksPath = .husky",
    ].join("\n"), "linux", "/home/me")).toEqual(["/home/me/.githooks", "/opt/tmpl"]);
    const files: Record<string, string> = { "/home/me/.config/git/config": "[init]\n\ttemplatedir = ~/tmpl\n" };
    const extras = runLaterExtrasFrom("linux", "/home/me", { env: { ZDOTDIR: "/home/me/.zdot", PYTHONSTARTUP: "/home/me/.py.py" }, read: (f) => files[f] });
    expect(extras).toEqual({ gitDirs: ["/home/me/tmpl"], envPaths: ["/home/me/.zdot"], envFiles: ["/home/me/.py.py"] });
    expect(autoRunEntries("linux", "/home/me", extras).filter((e) => e.path === "/home/me/.py.py" || e.path === "/home/me/.zdot"))
      .toEqual([{ path: "/home/me/.zdot", file: false }, { path: "/home/me/.py.py", file: true }]);
    // git's includes are followed, conditional ones too, relative to the including file, each file once (#308's check 2).
    const inc: Record<string, string> = {
      "/home/me/.gitconfig": "[include]\n\tpath = ~/.config/git/extra\n[includeIf \"gitdir:~/w/\"]\n\tpath = work.inc\n",
      "/home/me/.config/git/extra": "[core]\n\thooksPath = /opt/hooks\n[include]\n\tpath = /home/me/.gitconfig\n",
      "/home/me/work.inc": "[init]\n\ttemplateDir = ~/wtmpl\n",
    };
    const followed = runLaterExtrasFrom("linux", "/home/me", { env: {}, read: (f) => inc[f] });
    expect(followed.gitDirs).toEqual(["/opt/hooks", "/home/me/wtmpl"]);
    // Each included file is global config itself, so it's held as a file: a write there could set core.hooksPath or
    // core.fsmonitor. One that isn't there yet (`~/.gitconfig.local`) is held too; the roots aren't listed again.
    const local: Record<string, string> = { ...inc, "/home/me/.gitconfig": `${inc["/home/me/.gitconfig"]}[include]\n\tpath = ~/.gitconfig.local\n` };
    const withLocal = runLaterExtrasFrom("linux", "/home/me", { env: {}, read: (f) => local[f] });
    expect(withLocal.gitFiles).toEqual(["/home/me/.config/git/extra", "/home/me/work.inc", "/home/me/.gitconfig.local"]);
    expect(autoRunEntries("linux", "/home/me", withLocal).filter((e) => withLocal.gitFiles!.includes(e.path)))
      .toEqual(withLocal.gitFiles!.map((path) => ({ path, file: true })));
    expect(runLaterExtrasFrom("linux", "/home/me", { env: {}, read: () => undefined }).gitFiles).toBeUndefined();
    expect(autoRunPaths("linux", "/home/me", extras)).toEqual(expect.arrayContaining(["/home/me/tmpl", "/home/me/.zdot", "/home/me/.py.py"]));
    // Windows: OneDrive moved Documents, and the PowerShell profiles with it.
    const reg = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Personal    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Documents\r\n";
    expect(parseRegValue(reg, "Personal")).toBe("%USERPROFILE%\\OneDrive\\Documents");
    expect(expandWindowsEnv("%UserProfile%\\x", { USERPROFILE: "C:\\Users\\me" })).toBe("C:\\Users\\me\\x");
    expect(expandWindowsEnv("%NOPE%\\x", {})).toBeUndefined();
    const win = runLaterExtrasFrom("windows", "C:\\Users\\me", { env: { USERPROFILE: "C:\\Users\\me" }, read: () => undefined, documentsValue: () => parseRegValue(reg, "Personal") });
    expect(win.documents).toBe("C:\\Users\\me\\OneDrive\\Documents");
    expect(autoRunPaths("windows", "C:\\Users\\me", win)).toEqual(expect.arrayContaining([
      "C:\\Users\\me\\Documents\\PowerShell", "C:\\Users\\me\\OneDrive\\Documents\\PowerShell", "C:\\Users\\me\\OneDrive\\Documents\\WindowsPowerShell",
    ]));
  });
});

describe("Clover's fence: every runner refused, on every OS", () => {
  for (const os of ["macos", "linux", "windows"] as const) {
    test(os, () => {
      const s = SAMPLES[os];
      const path = os === "windows" ? win32 : posix;
      const fence = new CloverFence({ os, home: s.home, cloverHome: path.join(s.home, ".clover"), canonical: (p) => path.normalize(p) });
      const deny = fence.policy().denyWrite;
      for (const rel of s.auto) {
        const p = path.join(s.home, rel);
        expect([rel, fence.check({ op: "write", path: p })]).toMatchObject([rel, { allowed: false, reason: "login-start" }]);
        expect(fence.check({ op: "read", path: p })).toEqual({ allowed: true }); // reads stay free
        expect(deny.some((d) => p === d || p.startsWith(`${d}${path.sep}`)), rel).toBe(true); // in the sandbox's policy
      }
      for (const rel of s.agent) {
        const p = path.join(s.home, rel);
        expect([rel, fence.check({ op: "write", path: p })]).toMatchObject([rel, { allowed: false, reason: "agent-installs" }]);
        expect(deny.some((d) => p === d || p.startsWith(`${d}${path.sep}`)), rel).toBe(true);
      }
      // The rest of the home stays writable.
      expect(fence.check({ op: "write", path: path.join(s.home, "Documents", "notes.md") })).toEqual({ allowed: true });
      expect(fence.check({ op: "write", path: path.join(s.home, ".zshrc.bak") })).toEqual({ allowed: true });
    });
  }
});

describe("bots and agents: their writes there are refused without a card, at every level", () => {
  for (const os of ["macos", "linux", "windows"] as const) {
    test(os, async () => {
      const s = SAMPLES[os];
      const path = os === "windows" ? win32 : posix;
      const fence = new CloverFence({ os, home: s.home, cloverHome: path.join(s.home, ".clover"), canonical: (p) => path.normalize(p) });
      const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "automatic", fence: () => fence });
      const req = (kind: "tool" | "agent-permission", effect: ApprovalRequest["effect"], p: string): ApprovalRequest => ({
        kind, session: "s1", bot: "luna", origin: "user", computers: ["Studio"], effect, paths: [p], fields: { title: { type: "text", text: "Write a file" } },
      });
      for (const rel of [...s.auto, ...s.agent]) {
        const p = path.join(s.home, rel);
        expect([rel, await broker.request(req("tool", "edit", p))]).toEqual([rel, { allowed: false, by: "fence" }]);
        expect([rel, await broker.request(req("agent-permission", "delete", p))]).toEqual([rel, { allowed: false, by: "fence" }]);
      }
      expect(broker.cards()).toHaveLength(0);
      expect(await broker.request(req("tool", "edit", path.join(s.home, "Documents", "notes.md")))).toMatchObject({ allowed: true, by: "level" });
    });
  }

  test("a bot's Write tool is told why", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-bot-home-")));
    const fence = new CloverFence({ os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux", home, cloverHome: join(home, ".clover") });
    const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "automatic", fence: () => fence });
    const ctx = { sessionId: "s1", botId: "luna", computer: "Studio", paths: { root: home } } as unknown as BotSessionContext;
    const check = botApprovalCheck(broker, { home: join(home, ".clover") })(ctx, () => "user");
    const r = await check("Write", { file_path: join(home, ".bashrc"), content: "curl x | sh" }, { signal: new AbortController().signal, toolUseID: "t1" } as Parameters<typeof check>[2]);
    expect(r).toMatchObject({ behavior: "deny", message: expect.stringContaining("no bot writes there") });
  });
});

describe("a code session the user drives: asks, never silently writes", () => {
  const H = "/Users/x/.clover";
  const me = join(tmpdir(), "lane-c-persistence-home"); // never the real home: nothing here touches it
  const rules = protectedPathsFor(H, null, { cwd: "/", userHome: me });
  const pick = (paths: string[]) => paths.filter((p) => /zshrc$|bashrc$|authorized_keys$|config\.toml$|LaunchAgents$|autostart$|Startup$|opencode$/.test(p));

  test("its sandboxed Bash can't write them (the runtime's Seatbelt and bwrap take this list)", () => {
    const deny = sandboxConfigFor(H).filesystem!.denyWrite!;
    const own = pick(persistencePaths(homedir())); // the list is for the daemon's user; strings only, nothing is read
    expect(own.length).toBeGreaterThan(4);
    for (const p of own) expect(deny, p).toContain(p);
  });

  test("an unsandboxed command (approved or not) never writes them; reading them, or next to them, is the floor's business no more", () => {
    if (process.platform === "win32") return; // the escape floor reads POSIX shell text
    const H2 = join(tmpdir(), "lane-c-floor-home");
    for (const cmd of ["echo 'curl x | sh' >> ~/.zshrc", process.platform === "darwin" ? "cp evil.plist ~/Library/LaunchAgents/" : "cp x.desktop ~/.config/autostart/", "tee $HOME/.ssh/authorized_keys < k", "cp c.toml ~/.codex/config.toml", "mv u ${HOME}/.config/fish/conf.d/x.fish", "sed -i s/a/b/ ~/.bashrc"]) {
      expect([cmd, escapeFloorHit(cmd, H2, "/")]).toEqual([cmd, expect.stringContaining("runs from later outside any sandbox")]);
    }
    for (const cmd of ["cat ~/.zshrc", "source ~/.zshrc && npm test", "echo x > ~/.zshrc.bak", "ssh-keyscan host >> ~/.ssh/known_hosts"]) {
      expect([cmd, escapeFloorHit(cmd, H2, "/")]).toEqual([cmd, undefined]);
    }
  });

  test("the card offers no \"always\": answered with one anyway, the next write is carded again", async () => {
    const approvals = new ApprovalBroker();
    const events: NewSessionEvent[] = [];
    const canUse = canUseToolFor({
      sessionId: "s1", mode: "code", policy: "auto", approvals, questions: new QuestionBroker(), gate: new PermissionGate(),
      emit: (e) => { events.push(e); }, log: { info: () => {}, error: () => {} }, now: () => 1, home: "/Users/x/.clover", cwd: "/",
    });
    const target = join(homedir(), ".zshrc"); // a string: the bridge only reads where it would lead
    for (const id of ["t1", "t2"]) {
      const pending = canUse("Write", { file_path: target, content: "x" }, { signal: new AbortController().signal, toolUseID: id, suggestions: [{ type: "addRules", behavior: "allow", destination: "userSettings", rules: [{ toolName: "Edit", ruleContent: "//Users/**" }] }] } as unknown as Parameters<typeof canUse>[2]);
      const card = events.filter((e) => e.type === "approval_requested").at(-1) as { callId: string; options?: { id: string; rule?: string }[] } | undefined;
      expect(card?.callId).toBe(id);
      expect((card?.options ?? []).filter((o) => o.rule !== undefined)).toEqual([]);
      approvals.resolve("s1", id, true, "user", "allow_global_0"); // the runtime suggested one; the card never offered it
      expect(await pending).toMatchObject({ behavior: "allow" });
      expect((await pending as { updatedPermissions?: unknown[] }).updatedPermissions ?? []).toEqual([]);
    }
  });

  test("a write tool gets the card in code and dispatch, a typed deny in chat; elsewhere is free", () => {
    const hits = pick(persistencePaths(me));
    expect(hits.length).toBeGreaterThan(4);
    for (const p of hits) {
      const target = /LaunchAgents$|autostart$|Startup$|opencode$/.test(p) ? join(p, "x") : p;
      expect(protectedWriteDecision("Write", { file_path: target, content: "x" }, { mode: "code", protected: rules, cwd: "/" }), target).toEqual({ decision: "ask" });
      expect(protectedWriteDecision("Edit", { file_path: target, old_string: "a", new_string: "b" }, { mode: "dispatch", protected: rules, cwd: "/" })).toEqual({ decision: "ask" });
      expect(protectedWriteDecision("Write", { file_path: target, content: "x" }, { mode: "chat", protected: rules, cwd: "/" })).toMatchObject({ decision: "deny" });
    }
    expect(protectedWriteDecision("Write", { file_path: join(me, "notes.md"), content: "x" }, { mode: "code", protected: rules, cwd: "/" })).toBeNull();
  });
});

describe("git's included config files, on this computer's real fence", () => {
  test("~/.gitconfig.local and an includeIf's work.inc can't be written; the rest of the home can", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-gitinc-")));
    mkdirSync(join(home, "w"));
    writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ~/.gitconfig.local\n[includeIf "gitdir:~/w/"]\n\tpath = w/work.inc\n`);
    writeFileSync(join(home, "w", "work.inc"), "[user]\n\tname = me\n");
    const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    const fence = new CloverFence({ os, home, cloverHome: join(home, ".clover") });
    for (const p of [join(home, ".gitconfig.local"), join(home, "w", "work.inc")]) {
      expect([p, fence.check({ op: "write", path: p })]).toMatchObject([p, { allowed: false, reason: "login-start" }]);
      expect(persistencePaths(home)).toContain(p);
    }
    expect(fence.check({ op: "write", path: join(home, "w", "notes.md") })).toEqual({ allowed: true });
  });
});

describe("git's includes are read again when the config changes, without a restart", () => {
  test("an include the user adds later is held from the next look; unchanged, nothing is read again", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-gitinc-late-")));
    const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    const fence = new CloverFence({ os, home, cloverHome: join(home, ".clover") });
    const local = join(home, ".gitconfig.local");
    expect(fence.check({ op: "write", path: local })).toEqual({ allowed: true });
    const first = runLaterExtras(os, home);
    expect(runLaterExtras(os, home)).toBe(first); // nothing changed: the same answer, nothing read again
    // The user adds an include: the same fence holds it at its next look.
    writeFileSync(join(home, ".gitconfig"), "[include]\n\tpath = ~/.gitconfig.local\n");
    expect(fence.check({ op: "write", path: local })).toMatchObject({ allowed: false, reason: "login-start" });
    expect(persistencePaths(home)).toContain(local);
    // A file an include names appears, and itself includes another: followed too.
    writeFileSync(local, "[include]\n\tpath = ~/deeper.inc\n");
    expect(fence.check({ op: "write", path: join(home, "deeper.inc") })).toMatchObject({ allowed: false, reason: "login-start" });
    // And taken out again: free again.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = me\n");
    expect(fence.check({ op: "write", path: local })).toEqual({ allowed: true });
  });

  test("the git walk's read never stalls: a FIFO, a link to /dev/zero, a huge file (the same hole as #366's review)", () => {
    if (process.platform === "win32") return; // no FIFOs or /dev/zero
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-gitinc-fifo-")));
    expect(spawnSync("mkfifo", [join(home, ".gitconfig")]).status).toBe(0);
    symlinkSync("/dev/zero", join(home, "zero.inc"));
    const started = Date.now();
    expect(readGitConfigFile(join(home, ".gitconfig"))).toBeUndefined();
    expect(readGitConfigFile(join(home, "zero.inc"))).toBeUndefined(); // never through a link
    const os = process.platform === "darwin" ? "macos" : "linux";
    runLaterExtras(os, home); // the walk itself, over the FIFO
    expect(Date.now() - started).toBeLessThan(5_000);
    // A huge config is read up to the cap: an include near its top still counts.
    const big = join(home, "big.cfg");
    writeFileSync(big, `[include]\n\tpath = ~/x.inc\n${"#".repeat(GIT_CONFIG_READ_CAP * 2)}\n`);
    const text = readGitConfigFile(big)!;
    expect(text.length).toBe(GIT_CONFIG_READ_CAP);
    expect(text).toContain("path = ~/x.inc");
  }, 20_000);
});

// macOS: the list rendered by the agent SDK's Seatbelt profile builder, run for real under sandbox-exec in a temp home.
darwinDescribe("Seatbelt, live", () => {
  test("a sample of each group can't be written; next to them can", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-seatbelt-")));
    const profile = buildMandatoryFloorProfile({ denyReadPaths: [], denyWritePaths: persistencePaths(home, "darwin") });
    const write = (rel: string): boolean => {
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", 'printf x >> "$1"', "sh", p], { encoding: "utf8" });
      return r.status === 0 && existsSync(p) && readFileSync(p, "utf8").includes("x");
    };
    writeFileSync(join(home, ".zshrc"), "# mine\n");
    for (const rel of [...SAMPLES.macos.auto, ...SAMPLES.macos.agent, ".zshrc"]) expect([rel, write(rel)]).toEqual([rel, false]);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# mine\n");
    for (const rel of [".zshrc.bak", "Documents/notes.md", ".config/other/x", ".codex/sessions/x.jsonl", ".ssh/known_hosts", ".local/share/x", ".claudex/x"]) expect([rel, write(rel)]).toEqual([rel, true]);
  });

  test("git's included config files: one that's there and one that isn't yet, both refused", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-seatbelt-inc-")));
    mkdirSync(join(home, "w"));
    writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ~/.gitconfig.local\n[includeIf "gitdir:~/w/"]\n\tpath = w/work.inc\n`);
    writeFileSync(join(home, "w", "work.inc"), "[user]\n\tname = me\n");
    const profile = buildMandatoryFloorProfile({ denyReadPaths: [], denyWritePaths: persistencePaths(home, "darwin") });
    const write = (p: string, text: string) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", 'printf "$2" >> "$1"', "sh", p, text], { encoding: "utf8" }).status === 0;
    expect(write(join(home, ".gitconfig.local"), "[core]\n\thooksPath = /tmp/h\n")).toBe(false);
    expect(existsSync(join(home, ".gitconfig.local"))).toBe(false);
    expect(write(join(home, "w", "work.inc"), "[core]\n\tfsmonitor = /tmp/m\n")).toBe(false);
    expect(readFileSync(join(home, "w", "work.inc"), "utf8")).toBe("[user]\n\tname = me\n");
    expect(write(join(home, "w", "notes.md"), "x")).toBe(true);
  });
});
