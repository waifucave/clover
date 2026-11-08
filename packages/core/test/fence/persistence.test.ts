// The #301 review's ruling: the places where a file runs later outside any sandbox (shell start files, login items,
// SSH's rc and keys, autostart, the Windows Startup folder and PowerShell profiles) and the coding agents' sandbox
// settings are write-denied to every runner (Clover's fence: its policy, which part 2's Seatbelt and bwrap, the agents'
// sandbox and lane K's writers take; the approval broker refuses a bot's or an agent's write there without a card), and
// a code session the user drives asks for them (the protected card, no "always"; a typed deny in chat; its sandboxed
// Bash can't write them).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { buildMandatoryFloorProfile } from "@waifucave/clover-agent-sdk";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import type { BotSessionContext } from "../../src/bots/service";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { agentConfigPaths, autoRunPaths } from "../../src/contracts/fence";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { CloverFence } from "../../src/fence/fence";
import { persistencePaths, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { escapeFloorHit } from "../../src/runtime-sdk/hooks";
import { darwinDescribe } from "../helpers/darwin-only";
import { protectedPathsFor, protectedWriteDecision } from "../../src/runtime-sdk/protected-paths";

const SAMPLES = {
  macos: { home: "/Users/me", auto: ["Library/LaunchAgents/evil.plist", ".zshrc", ".bash_login", ".ssh/authorized_keys", ".ssh/rc", ".config/fish/config.fish", "Library/Application Support/com.apple.backgroundtaskmanagementagent/backgrounditems.btm"], agent: [".codex/config.toml", ".claude/settings.json", ".config/opencode/opencode.json"] },
  linux: { home: "/home/me", auto: [".config/autostart/x.desktop", ".config/systemd/user/x.service", ".local/share/systemd/user/x.service", ".config/environment.d/x.conf", ".pam_environment", ".xprofile", ".bashrc", ".profile"], agent: [".codex/config.toml", ".claude/settings.local.json"] },
  windows: { home: "C:\\Users\\me", auto: ["AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk", "Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1", "Documents\\WindowsPowerShell\\profile.ps1", ".bashrc", ".ssh\\authorized_keys"], agent: [".codex\\config.toml", ".config\\opencode\\opencode.json"] },
} as const;

describe("the shared list", () => {
  test("each OS has its groups", () => {
    expect(autoRunPaths("macos", "/Users/me")).toEqual(expect.arrayContaining(["/Users/me/Library/LaunchAgents", "/Users/me/.zshrc", "/Users/me/.ssh/authorized_keys", "/Users/me/.config/fish"]));
    expect(autoRunPaths("linux", "/home/me")).toEqual(expect.arrayContaining(["/home/me/.config/systemd/user", "/home/me/.local/share/systemd/user", "/home/me/.pam_environment", "/home/me/.xprofile", "/home/me/.bash_login"]));
    expect(autoRunPaths("windows", "C:\\Users\\me")).toEqual(expect.arrayContaining(["C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", "C:\\Users\\me\\Documents\\PowerShell", "C:\\Users\\me\\Documents\\WindowsPowerShell"]));
    expect(agentConfigPaths("linux", "/home/me")).toEqual(["/home/me/.codex/config.toml", "/home/me/.claude/settings.json", "/home/me/.claude/settings.local.json", "/home/me/.config/opencode"]);
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
    for (const rel of [".zshrc.bak", "Documents/notes.md", ".config/other/x", ".codex/sessions/x.jsonl"]) expect([rel, write(rel)]).toEqual([rel, true]);
  });
});
