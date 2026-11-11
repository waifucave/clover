// A bot's child is never wider than its bot, by construction (the coordinator's ruling on stage 2's review). Its
// command sandbox is drawn by the bot's own builder (agents/bot-child.ts), with its working folder (`spec.root`, which
// the runtime always writes) among the roots the run-later denies are drawn under:
//   * its rendered deny set holds every deny of its bot's (given the same root) that bears on what the child can write,
//     and its write roots are never wider than its bot's with that root granted;
//   * on the real runtime, with the child's cwd the project, its commands never make the run-later files a commit, an
//     editor or an agent would run later (`.husky/pre-commit`, `.claude/settings.json`, a bare repository's `hooks/`
//     not named `*.git`, `.git/hooks`), even with every card answered yes; its Write to one is refused with no card.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Level, Os } from "@waifucave/clover-protocol";
import type { AgentPermissionAsk, AgentStartSpec } from "../../../src/contracts/agent-backend";
import type { SandboxPolicy } from "../../../src/contracts/fence";
import { CloverFence } from "../../../src/fence/fence";
import { botSandboxSettings, rootCovered } from "../../../src/fence/sandbox-settings";
import { botChildFor, botChildSandboxSettings } from "../../../src/agents/bot-child";
import { botChildPolicy } from "../../../src/agents/manager";
import { agentPolicyOf, withHomeDenied, withSecretsDenied } from "../../../src/agents/memory";
import { inProcessAgentBackend } from "../../../src/runtime-sdk/turn-loop/subagent-backend";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { darwinTest } from "../../helpers/darwin-only";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const os: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

/** A temp user home with the Clover home, a temp folder and a project holding a repository, a bare repository not
 *  named `*.git`, and a PATH folder. */
function world() {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "clover-bot-child-")));
  temps.push(user);
  const clover = join(user, ".clover");
  const temp = join(user, "tmp");
  const proj = join(user, "Projects", "app");
  const scratch = join(clover, "scratch", "alpha");
  for (const d of [clover, temp, scratch, join(proj, ".git", "hooks"), join(proj, "mirror", "objects"), join(proj, "mirror", "refs", "heads"), join(proj, "mirror", "hooks"), join(proj, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(proj, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(proj, ".git", "config"), "[core]\n\tbare = false\n");
  writeFileSync(join(proj, "mirror", "HEAD"), "ref: refs/heads/main\n");
  const fence = new CloverFence({ os, home: user, cloverHome: clover, temp });
  // The child's policy as the manager draws it for a bot's agent.
  const childPolicy: SandboxPolicy = withSecretsDenied(withHomeDenied(botChildPolicy(agentPolicyOf(fence.policy()), proj, user), clover), user, os);
  const botPolicy = fence.forCaller({ kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" } as never).policy();
  const pathFolders = [join(proj, "bin")];
  return { user, clover, temp, proj, scratch, fence, childPolicy, botPolicy, pathFolders };
}

describe("a bot's child's sandbox, by its bot's builder", () => {
  for (const level of ["ask-risky", "accept-edits", "automatic"] as const satisfies readonly Level[]) {
    test(`at ${level}: every bot deny bearing on the child's roots is the child's too; its write roots are never wider`, () => {
      const w = world();
      const bot = botSandboxSettings(w.botPolicy, { cloverHome: w.clover, userHome: w.user, level, grantedWrite: [w.proj], ownFolders: [w.scratch], pathFolders: w.pathFolders });
      const child = botChildSandboxSettings(w.childPolicy, { cloverHome: w.clover, userHome: w.user, os, root: w.proj, level, pathFolders: () => w.pathFolders });
      const childDeny = child.filesystem?.denyWrite ?? [];
      const childRoots = [w.proj, ...(child.filesystem?.allowWrite ?? [])];
      const bears = (p: string) => childRoots.some((r) => rootCovered(p, [r], os) || rootCovered(r, [p], os));
      const missing: string[] = [];
      // Each bot deny as places it holds: a literal as itself, a glob as a path it matches, put under each of the
      // child's roots where it can be (`**` as a folder there). A place the child can write is checked.
      const probesOf = (d: string): string[] => {
        if (!d.includes("*")) return [d];
        const fill = (x: string) => x.replace(/\[([a-z])[A-Z]\]/g, "$1").replace(/\*/g, "a");
        const at = d.indexOf("/**");
        const base = d.slice(0, at);
        const tail = fill(d.slice(at + 3));
        return base === "" ? childRoots.map((r) => `${r}/zz${tail}`) : [`${base}/zz${tail}`, ...childRoots.filter((r) => rootCovered(r, [base], os)).map((r) => `${r}/zz${tail}`)];
      };
      for (const d of bot.filesystem?.denyWrite ?? []) {
        // A kept folder's pin holds that folder's own entry where the home is written out entry by entry; the child's
        // roots are never renamed by it (their parents aren't its roots).
        if (d.endsWith("/.clover-kept-folder")) continue;
        for (const p of probesOf(d)) {
          if (!bears(p)) continue;
          if (!rootCovered(p, childDeny, os) && !childDeny.some((c) => !c.includes("*") && rootCovered(c, [p], os))) missing.push(`${d} (as ${p})`);
        }
      }
      expect(missing).toEqual([]);
      // Secret places, for reads and writes.
      for (const p of [join(w.user, ".ssh"), join(w.user, ".aws")]) {
        expect(rootCovered(p, childDeny, os)).toBe(true);
        expect(rootCovered(p, child.filesystem?.denyRead ?? [], os)).toBe(true);
      }
      // Never wider: the child's write roots are among its bot's (with the root granted).
      for (const r of child.filesystem?.allowWrite ?? []) expect([r, (bot.filesystem?.allowWrite ?? []).includes(r)]).toEqual([r, true]);
      // The run-later places under its root are denied (the runtime writes the root whatever the roots say).
      for (const p of [".husky/pre-commit", ".claude/settings.json", ".git/hooks/pre-commit", "mirror/hooks/post-checkout", "bin/tool", ".vscode/tasks.json", ".clover/settings.json"]) {
        expect([p, rootCovered(join(w.proj, p), childDeny, os)]).toEqual([p, true]);
      }
      expect(rootCovered(join(w.proj, "src", "main.ts"), childDeny, os)).toBe(false);
    });
  }
});

describeWithEmbeddedRuntime("a bot's child on the real runtime, its cwd the project", (spawn) => {
  darwinTest("its commands never make a run-later file, every card answered yes; its Write to one is refused with no card", async () => {
    const w = world();
    const backend = inProcessAgentBackend({
      home: w.clover, spawn, defaultModel: () => "winter-test/calls", pauseGateFor: () => ({ mayAct: () => true }), sandboxReady: () => true,
      botChild: botChildFor({ cloverHome: w.clover, userHome: w.user, pathFolders: () => w.pathFolders }),
    });
    const spec: AgentStartSpec & { level: Level } = {
      sessionId: "s_child", bot: "alpha", root: w.proj, model: "winter-test/calls", level: "ask-risky",
      bridge: { name: "clover_bridge", command: "/bin/sh", args: ["-c", "exit 0"], env: {}, tools: [] },
      fence: w.childPolicy,
    };
    const session = await backend.start(spec);
    const asks: AgentPermissionAsk[] = [];
    session.onPermission(async (ask) => { asks.push(ask); return { outcome: "selected", optionId: "allow" }; });
    const targets = [".husky/pre-commit", ".claude/settings.json", "mirror/hooks/post-checkout", ".git/hooks/pre-commit", "bin/tool"];
    try {
      const command = [
        ...targets.map((t) => `mkdir -p ${JSON.stringify(join(w.proj, t, ".."))} 2>/dev/null; printf 'echo pwned' > ${JSON.stringify(join(w.proj, t))} 2>/dev/null`),
        `printf ok > ${JSON.stringify(join(w.proj, "ok.txt"))}`,
      ].join("; ");
      const end = await session.prompt({ text: `CALL Bash ${JSON.stringify({ command, description: "write" })}` });
      expect(end.stopReason).toBe("end_turn");
      for (const t of targets) expect([t, existsSync(join(w.proj, t))]).toEqual([t, false]);
      // The control: an ordinary file in the project lands (the cwd is written, as the runtime always does).
      expect(readFileSync(join(w.proj, "ok.txt"), "utf8")).toBe("ok");
      // A Write to a run-later place: refused before any card.
      asks.length = 0;
      const wEnd = await session.prompt({ text: `CALL Write ${JSON.stringify({ file_path: join(w.proj, ".husky", "pre-commit"), content: "echo pwned" })}` });
      expect(wEnd.stopReason).toBe("end_turn");
      expect(existsSync(join(w.proj, ".husky", "pre-commit"))).toBe(false);
      expect(asks).toEqual([]);
    } finally {
      await session.stop();
    }
  }, 120_000);
});
