// The session panels' reads: a real git folder's changes (a changed file, a new one, a deleted one, a binary one, a
// symlink shown as its target, the bounds), a folder that isn't a repository, the outputs folder's names, the context
// use from the last measured turn, and the connectors' counts. Temp folders only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionView } from "@waifucave/clover-protocol";
import type { SessionRecord } from "../../contracts/session-host";
import { DIFF_FILE_MAX_LINES, folderDiff } from "../diff";
import { sessionPanelMethods } from "../panel-reads";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `clover-a-${name}-`)));
  temps.push(d);
  return d;
};
const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
const USER = { caller: { kind: "user", client: "app" } } as never;

function repo(): string {
  const dir = temp("diff");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "kept.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  writeFileSync(join(dir, "pic.bin"), Buffer.from([0, 1, 2, 3]));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(join(dir, "kept.txt"), "one\nTWO\nthree\nfour\n");
  rmSync(join(dir, "gone.txt"));
  writeFileSync(join(dir, "pic.bin"), Buffer.from([0, 9, 9, 9]));
  writeFileSync(join(dir, "new.md"), "# New\nhello\n");
  return dir;
}

describe("session.diff's folder read", () => {
  test("a changed, a deleted, a binary and a new file, with hunks and line numbers; base is the branch", async () => {
    const dir = repo();
    const d = await folderDiff(dir);
    expect(d.base).toBe("main");
    expect(d.target).toBe("working tree");
    expect(d.notice).toBeUndefined();
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(["gone.txt", "kept.txt", "new.md", "pic.bin"]);
    expect(by["kept.txt"]).toMatchObject({ status: "modified", added: 2, removed: 1 });
    const lines = by["kept.txt"]!.hunks![0]!.lines;
    expect(lines).toEqual([
      { kind: "context", old: 1, new: 1, text: "one" },
      { kind: "del", old: 2, text: "two" },
      { kind: "add", new: 2, text: "TWO" },
      { kind: "context", old: 3, new: 3, text: "three" },
      { kind: "add", new: 4, text: "four" },
    ]);
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", added: 0, removed: 1 });
    expect(by["pic.bin"]).toMatchObject({ status: "modified", binary: true });
    expect(by["pic.bin"]!.hunks).toBeUndefined();
    expect(by["new.md"]).toMatchObject({ status: "added", added: 2, removed: 0 });
    expect(by["new.md"]!.hunks![0]!.lines.map((l) => l.text)).toEqual(["# New", "hello"]);
  });

  test("a new symlink is shown as its target's path, never followed; a file past the bound is listed without lines and said", async () => {
    const dir = repo();
    const secret = join(temp("outside"), "secret.txt");
    writeFileSync(secret, "NOT-TO-BE-READ\n");
    symlinkSync(secret, join(dir, "link.txt"));
    writeFileSync(join(dir, "big.txt"), Array.from({ length: DIFF_FILE_MAX_LINES + 5 }, (_, i) => `line ${i}`).join("\n"));
    const d = await folderDiff(dir);
    const link = d.files.find((f) => f.path === "link.txt")!;
    expect(JSON.stringify(link)).not.toContain("NOT-TO-BE-READ");
    expect(link.hunks![0]!.lines[0]!.text).toBe(secret);
    expect(d.files.find((f) => f.path === "big.txt")).toMatchObject({ status: "added", tooLarge: true });
    expect(d.notice).toContain("too big to show here");
  });

  test("a folder that isn't a git repository answers no files and says why; a repository with no commits shows its files as added", async () => {
    const plain = temp("plain");
    writeFileSync(join(plain, "a.txt"), "x\n");
    expect(await folderDiff(plain)).toEqual({ base: "", target: "working tree", targets: [], files: [], notice: "This folder isn't a git repository, so there are no changes to compare." });
    const fresh = temp("fresh");
    git(fresh, "init", "-q");
    writeFileSync(join(fresh, "first.txt"), "hi\n");
    const d = await folderDiff(fresh);
    expect(d.base).toBe("no commits yet");
    expect(d.files).toEqual([expect.objectContaining({ path: "first.txt", status: "added", added: 1 })]);
  });

  test("the folder's own config can't run a program: fsmonitor and an external diff are not used", async () => {
    const dir = repo();
    const marker = join(temp("marker"), "ran");
    const hook = join(dir, ".git", "evil.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(dir, "config", "core.fsmonitor", hook);
    git(dir, "config", "diff.external", hook);
    await folderDiff(dir);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("the user's global config, their home's attributes file and a clean filter they name are not used", async () => {
    const dir = repo();
    const home = temp("user-home");
    const marker = join(temp("marker"), "ran");
    const filter = join(home, "filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
    const attributes = join(home, "attributes");
    writeFileSync(attributes, "* filter=evil\n");
    // The global config defines the filter and names an attributes file; the home's default attributes file names it too.
    writeFileSync(join(home, ".gitconfig"), `[filter "evil"]\n\tclean = ${filter}\n[core]\n\tattributesFile = ${attributes}\n`);
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "attributes"), "* filter=evil\n");
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      const d = await folderDiff(dir);
      expect(d.files.find((f) => f.path === "kept.txt")).toMatchObject({ status: "modified", added: 2, removed: 1 });
      // The home's default attributes file alone, with the filter defined in the repository's own config: still unused.
      const dir2 = repo();
      git(dir2, "config", "filter.evil.clean", filter);
      await folderDiff(dir2);
    } finally {
      process.env.HOME = was;
    }
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

describe("the session panels' reads", () => {
  const view = (o: Partial<SessionView> = {}): SessionView => ({ id: "s_code", kind: "coding", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, model: "anthropic/claude-sonnet-5-5", root: "home/Studio/work", ...o }) as SessionView;
  const turn = (seq: number, contextTokens?: number): SessionRecord => ({ type: "turn_ended", seq, sessionId: "s_code", ts: seq, end: { reason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, ...(contextTokens === undefined ? {} : { contextTokens }) } } }) as unknown as SessionRecord;

  function methods(o: { view?: SessionView; records?: SessionRecord[]; folder?: string; home?: string; window?: number } = {}) {
    const records = o.records ?? [];
    return sessionPanelMethods({
      home: o.home ?? temp("home"),
      view: (id) => (id === "s_code" ? (o.view ?? view()) : undefined),
      history: (_id, { afterSeq, limit }) => records.filter((r) => r.seq > afterSeq).slice(0, limit),
      length: () => records.length,
      localFolder: (root) => (o.folder !== undefined ? { path: o.folder } : { reason: `The session's folder is on Laptop (${root}).` }),
      contextWindowOf: () => o.window,
      connectorsOf: async () => ({ total: 3, needSignIn: 1 }),
    }) as Record<string, (params: unknown, ctx: unknown) => Promise<unknown>>;
  }

  test("session.diff: the session's folder here; another computer's, or no folder, says why; an unknown session is not found", async () => {
    const dir = repo();
    const here = (await methods({ folder: dir })["session.diff"]!({ id: "s_code" }, USER)) as { files: unknown[] };
    expect(here.files.length).toBe(4);
    expect(await methods()["session.diff"]!({ id: "s_code" }, USER)).toEqual({ base: "", target: "working tree", targets: [], files: [], notice: "The session's folder is on Laptop (home/Studio/work)." });
    expect(await methods({ view: view({ root: undefined }) })["session.diff"]!({ id: "s_code" }, USER)).toMatchObject({ files: [], notice: "This session has no folder, so it has no changes to show." });
    await expect(methods()["session.diff"]!({ id: "s_other" }, USER)).rejects.toThrow("no session s_other");
  });

  test("session.outputs: the outputs folder's files, newest first, with their kinds and how many more", async () => {
    const home = temp("outhome");
    const dir = join(home, "outputs", "s_code");
    mkdirSync(dir, { recursive: true });
    for (const [i, n] of ["report.md", "chart.png", "data.csv", ".hidden"].entries()) {
      writeFileSync(join(dir, n), "x");
      utimesSync(join(dir, n), 1_000 + i, 1_000 + i);
    }
    mkdirSync(join(dir, "folder"));
    expect(await methods({ home })["session.outputs"]!({ id: "s_code", limit: 2 }, USER)).toEqual({ items: [{ id: "data.csv", name: "data.csv", kind: "file" }, { id: "chart.png", name: "chart.png", kind: "image" }], more: 1 });
    expect(await methods({ home: temp("empty") })["session.outputs"]!({ id: "s_code" }, USER)).toEqual({ items: [], more: 0 });
  });

  test("session.context: the last measured turn against the model's window; null without a window or a measured turn", async () => {
    const records = [turn(0, 40_000), turn(1, 50_000), turn(2)];
    expect(await methods({ records, window: 200_000 })["session.context"]!({ id: "s_code" }, USER)).toEqual({ used: 0.25, tokens: 50_000, window: 200_000 });
    expect(await methods({ records })["session.context"]!({ id: "s_code" }, USER)).toBeNull();
    expect(await methods({ records: [turn(0)], window: 200_000 })["session.context"]!({ id: "s_code" }, USER)).toBeNull();
  });

  test("session.diff from a plugin's own connection needs files too: a third-party layer with conversation.read alone is refused, the bundled diff panel is served", async () => {
    const dir = repo();
    const grants: Record<string, string[]> = { "acme/diffy": ["conversation.read"], "clover/panel-diff": ["conversation.read", "files"] };
    const m = sessionPanelMethods({
      home: temp("home"),
      view: (id) => (id === "s_code" ? view() : undefined),
      history: () => [],
      length: () => 0,
      localFolder: () => ({ path: dir }),
      grantsOf: (id) => grants[id] ?? [],
    }) as Record<string, (params: unknown, ctx: unknown) => Promise<unknown>>;
    const as = (pluginId: string) => ({ caller: { kind: "plugin", pluginId } });
    await expect(m["session.diff"]!({ id: "s_code" }, as("acme/diffy"))).rejects.toMatchObject({ code: -32011, message: expect.stringContaining("needs the capability files as well") });
    expect(((await m["session.diff"]!({ id: "s_code" }, as("clover/panel-diff"))) as { files: unknown[] }).files.length).toBe(4);
    // The user's own clients are as they were.
    expect(((await m["session.diff"]!({ id: "s_code" }, USER)) as { files: unknown[] }).files.length).toBe(4);
  });

  test("session.connectors: the counts the daemon gives", async () => {
    expect(await methods()["session.connectors"]!({ id: "s_code" }, USER)).toEqual({ total: 3, needSignIn: 1 });
  });
});
