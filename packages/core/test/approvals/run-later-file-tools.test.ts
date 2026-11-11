// The coordinator's ruling (stage 2 on agent SDK 0.0.77): a bot's file tools never write a run-later place. With 0.0.77
// the session's sandbox `denyWrite` binds Write and Edit too, so a card's yes there would fail in the runtime: Clover
// refuses the call up front, with no card, and tells the bot what it can do instead. Every entry of the shell's
// run-later deny list, under a project at every level a write runs at, with Write and Edit: refused, and the broker
// never asked. An ordinary file in the same project still goes on to the broker.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Level, Os } from "@waifucave/clover-protocol";
import { botApprovalCheck, runsLaterPlace } from "../../src/approvals/bot-check";
import { pathsClassOnDisk } from "../../src/approvals/ordinary-paths";
import { CloverFence } from "../../src/fence/fence";
import { botSandboxSettings, runLaterByName } from "../../src/fence/sandbox-settings";
import { PROJECT_DENIES, PROJECT_WHOLE_DENIES } from "../../src/registry/plugin-fence";
import type { BotSessionContext } from "../../src/bots/service";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const os: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

function world(level: Level) {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "run-later-files-")));
  temps.push(user);
  const clover = join(user, ".clover");
  const scratch = join(clover, "scratch", "luna");
  mkdirSync(scratch, { recursive: true });
  const project = join(user, "Projects", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "ordinary");
  const ctx = {
    botId: "luna", sessionId: "s1", computer: "Studio", level, paths: { scratch, root: join(clover, "bots", "luna") },
    caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
  } as unknown as BotSessionContext;
  const fence = new CloverFence({ home: user, cloverHome: clover });
  const pathFolders = [join(user, ".local", "bin")];
  const sandboxOf = () => botSandboxSettings(fence.forCaller(ctx.caller).policy(), { cloverHome: clover, userHome: user, level, ownFolders: [scratch], pathFolders });
  const classOf = (paths: readonly string[]) => pathsClassOnDisk(paths, { home: user, os, cloverHome: clover, pathFolders });
  const asked: string[] = [];
  const broker = { request: async (req: { paths?: string[] }) => { asked.push(...(req.paths ?? [])); return { allowed: true, by: "card" }; } };
  const check = botApprovalCheck(broker as never, {
    localComputer: "Studio",
    runsLater: (_c, path) => runsLaterPlace(path, sandboxOf().filesystem?.denyWrite ?? [], { os, userHome: user, cloverHome: clover }, classOf),
  })(ctx, () => "user");
  const call = (tool: string, input: Record<string, unknown>) => check(tool, input, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" } as never);
  return { user, project, call, asked };
}

/** Every run-later entry, as a file a bot's write would change. */
function runLaterTargets(user: string, project: string): string[] {
  return [
    join(project, ".git", "config"), join(project, ".git", "hooks", "pre-commit"), join(project, "mirror.git", "HEAD"),
    ...PROJECT_WHOLE_DENIES.map((n) => join(project, n, "settings.json")),
    ...PROJECT_DENIES.map((n) => join(project, n)),
    join(project, "Tool.app", "Contents", "Info.plist"),
    join(user, ".local", "bin", "tool"),
    join(user, ".zshrc"),
  ];
}

describe("a bot's file tools never write a run-later place: refused before any card", () => {
  for (const level of ["ask-risky", "accept-edits", "automatic"] as const) {
    test(`at ${level}: every entry, Write and Edit, refused with no card; an ordinary file still goes to the broker`, async () => {
      const w = world(level);
      const targets = runLaterTargets(w.user, w.project);
      expect(targets.length).toBeGreaterThan(20);
      for (const path of targets) {
        for (const [tool, input] of [["Write", { file_path: path, content: "x" }], ["Edit", { file_path: path, old_string: "a", new_string: "b" }]] as const) {
          const d = await w.call(tool, input);
          if (d?.behavior !== "deny") throw new Error(`${tool} ${path.slice(w.user.length)} -> ${d?.behavior}`);
          expect((d as { message: string }).message).toContain("run or apply later outside any sandbox");
          expect((d as { message: string }).message).toContain("command outside the sandbox");
        }
      }
      expect(w.asked).toEqual([]);
      const ordinary = await w.call("Write", { file_path: join(w.project, "notes.md"), content: "x" });
      expect(ordinary?.behavior).toBe("allow");
      expect(w.asked).toEqual([join(w.project, "notes.md")]);
    });
  }

  test("a Read of a run-later place is unchanged (it isn't refused for being one)", async () => {
    const w = world("ask-risky");
    const d = await w.call("Read", { file_path: join(w.project, ".vscode", "settings.json") });
    expect(d?.behavior).toBe("allow");
  });

  test("the bot's own scratch, under the Clover home, is never a run-later place by name", async () => {
    const w = world("ask-risky");
    const d = await w.call("Write", { file_path: join(w.user, ".clover", "scratch", "luna", "draft.md"), content: "x" });
    expect(d?.behavior).toBe("allow");
  });
});

describe("a session on another computer: paths not resolved here, the name rule still holds (lexically)", () => {
  test("Write, Edit and NotebookEdit to a run-later name are refused with no card; an ordinary path goes to the broker as unresolved", async () => {
    const user = "/Users/remote";
    const asked: { paths?: string[]; pathsUnresolved?: boolean }[] = [];
    const broker = { request: async (req: { paths?: string[]; pathsUnresolved?: boolean }) => { asked.push(req); return { allowed: true, by: "card" }; } };
    const ctx = {
      botId: "luna", sessionId: "s1", computer: "Laptop", level: "ask-risky", paths: { scratch: "/Users/remote/.clover/scratch/luna", root: "/Users/remote/.clover/bots/luna" },
      caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
    } as unknown as BotSessionContext;
    let fullChecks = 0;
    const check = botApprovalCheck(broker as never, {
      localComputer: "Studio",
      runsLater: () => { fullChecks++; return true; },
      runsLaterByName: (_c, path) => runLaterByName(path, { os, userHome: "/Users/local", cloverHome: "/Users/local/.clover" }),
    })(ctx, () => "user");
    const call = (tool: string, input: Record<string, unknown>) => check(tool, input, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" } as never);
    const named = [
      `${user}/Projects/app/.git/config`, `${user}/Projects/app/.vscode/tasks.json`, `${user}/Projects/app/.clover/settings.json`,
      `${user}/Projects/app/.envrc`, `${user}/.zshrc`, `${user}/Projects/mirror.git/HEAD`, `${user}/Projects/Tool.app/Contents/Info.plist`,
      "/usr/local/bin/tool", "relative/.husky/pre-commit",
    ];
    for (const path of named) {
      for (const [tool, input] of [
        ["Write", { file_path: path, content: "x" }], ["Edit", { file_path: path, old_string: "a", new_string: "b" }], ["NotebookEdit", { notebook_path: path, new_source: "x" }],
      ] as const) {
        const d = await call(tool, input);
        if (d?.behavior !== "deny") throw new Error(`${tool} ${path} -> ${d?.behavior}`);
        expect((d as { message: string }).message).toContain("run or apply later outside any sandbox");
      }
    }
    expect(asked).toEqual([]);
    // The checks that need the real path are left out for such a call.
    expect(fullChecks).toBe(0);
    const ordinary = await call("Write", { file_path: `${user}/Projects/app/src/main.ts`, content: "x" });
    expect(ordinary?.behavior).toBe("allow");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.pathsUnresolved).toBe(true);
  });
});

describe("runLaterByName: held wherever it sits, whatever the roots", () => {
  const user = "/home/u";
  const clover = "/home/u/.clover";
  for (const os of ["linux", "macos", "windows"] as const) {
    test(`on ${os}`, () => {
      const form = (p: string) => (os === "windows" ? `C:${p.replace(/\//g, "\\")}` : p);
      const at = (p: string) => runLaterByName(form(p), { userHome: form(user), cloverHome: form(clover), os });
      expect(at("/srv/x/app/.git/config")).toBe(true);
      expect(at("/srv/x/app/.GIT/hooks/pre-commit")).toBe(true);
      expect(at("/srv/x/mirror.git/HEAD")).toBe(true);
      expect(at("/srv/x/app/.clover/settings.json")).toBe(true);
      expect(at("/srv/x/app/.Clover/settings.json")).toBe(true);
      expect(at("/srv/x/app/.vscode/tasks.json")).toBe(true);
      expect(at("/srv/x/app/.envrc")).toBe(true);
      expect(at("/srv/x/app/.zshrc")).toBe(true);
      expect(at("/srv/x/Tool.app/Contents/MacOS/tool")).toBe(true);
      expect(at("/home/u/.local/bin/tool")).toBe(true);
      if (os !== "windows") expect(at("/usr/local/bin/tool")).toBe(true);
      expect(at("/srv/x/app/src/main.ts")).toBe(false);
      expect(at("/srv/x/app/gitignore.md")).toBe(false);
      expect(at("/home/u/.clover/scratch/luna/notes.md")).toBe(false);
    });
  }
});
