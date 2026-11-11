// Stage 2 of "bots ask less" (the controller's ruling, option A): a bot's sandboxed shell commands run without asking
// inside its level's roots; for more it asks with `RequestAccess` (a folder: a card, its "always" kept for that bot;
// hosts: the reviewer, then a card), and what is granted joins the conversation's sandbox. While a background command
// runs, a file tool's write inside the shell's folders isn't contained (the link race's interim).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, Level, Os } from "@waifucave/clover-protocol";
import { CloverApprovalBroker, type CloverApprovalRequest } from "../../src/approvals/broker";
import { botApprovalCheck, CORE_TOOL_RULES } from "../../src/approvals/bot-check";
import { pathsClassOnDisk } from "../../src/approvals/ordinary-paths";
import { NETWORK_UNSUPPORTED, REQUEST_ACCESS_TOOL, requestAccessTool, validHost } from "../../src/approvals/request-access";
import { SandboxGrants, sandboxGrantsFile } from "../../src/approvals/sandbox-grants";
import type { ApprovalRequest, Reviewer } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { BotSessionContext } from "../../src/bots/service";
import { CloverFence } from "../../src/fence/fence";
import { anyCase, botSandboxSettings, CONTROL, denyRegex, rootCovered, shellRunLaterDenies } from "../../src/fence/sandbox-settings";
import { GIT_IN_SANDBOX, folderHolds, holdsLine } from "../../src/approvals/request-access";
import { secretReadPlaces } from "../../src/contracts/fence";
import { PROJECT_DENIES, PROJECT_WHOLE_DENIES } from "../../src/registry/plugin-fence";

const os: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

function world() {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-shell-")));
  const clover = join(user, ".clover");
  for (const d of [clover, join(user, "Documents"), join(user, "Projects", "app"), join(user, ".aws"), join(clover, "scratch", "luna")]) mkdirSync(d, { recursive: true });
  const classOf = (paths: readonly string[]) => pathsClassOnDisk(paths, { home: user, os, cloverHome: clover, pathFolders: [join(user, "bin")] });
  const ctx = {
    botId: "luna", sessionId: "s1", computer: "Studio", paths: { scratch: join(clover, "scratch", "luna") },
    caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
  } as unknown as BotSessionContext;
  return { user, clover, classOf, ctx };
}

function brokerAt(level: Level, reviewer?: Reviewer) {
  return new CloverApprovalBroker({ clock: new FakeClock(), levels: () => level, localComputer: "Studio", ...(reviewer === undefined ? {} : { reviewer }) });
}

/** The next card, answered with `optionId` through the app's sealed frame. */
function answerNext(b: CloverApprovalBroker, optionId: string): Promise<Card> {
  return new Promise((resolve) => {
    const off = b.watch((e) => {
      if (e.type !== "requested") return;
      off();
      void b.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: b.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
    });
  });
}

describe("RequestAccess", () => {
  test("its card's headline names the bot as the user sees it, from the bot side", async () => {
    const w = world();
    const broker = brokerAt("ask-risky");
    broker.setBotNames((id) => (id === "luna" ? { en: "Luna Moth" } : undefined));
    const grants = new SandboxGrants({ isOrdinary: (f) => w.classOf([f]) === "ordinary" });
    const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
    const card = answerNext(broker, "deny");
    await tool.run({ folder: "~/Documents", why: "to save the report" });
    expect((await card).fields.what).toEqual({ type: "code", code: `Luna Moth wants write access to ${join(w.user, "Documents")} for shell commands` });
  });

  test("a folder: an ordinary one is a card naming it, never the reviewer; granted, it joins the conversation's write roots and the turn goes on", async () => {
    const w = world();
    let reviewed = 0;
    const broker = brokerAt("ask-risky", async () => { reviewed++; return "safe"; });
    const grants = new SandboxGrants({ isOrdinary: (f) => w.classOf([f]) === "ordinary" });
    const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
    expect(tool.name).toBe(REQUEST_ACCESS_TOOL);
    const card = answerNext(broker, "approve");
    const r = await tool.run({ folder: "~/Documents", why: "to save the report the build makes" });
    const shown = await card;
    expect(reviewed).toBe(0);
    expect(shown.fields.title).toEqual({ type: "text", text: "Give shell commands write access" });
    expect(shown.fields.what).toEqual({ type: "code", code: `luna wants write access to ${join(w.user, "Documents")} for shell commands` });
    expect(shown.fields.reason).toEqual({ type: "code", code: "to save the report the build makes" });
    expect(shown.options.map((o) => o.id)).toEqual(["approve", "always", "deny"]);
    expect(r).toMatchObject({ isError: false, endTurn: { note: expect.stringContaining(join(w.user, "Documents")) } });
    expect(grants.folders("s1", "luna")).toEqual([join(w.user, "Documents")]);
    // Only this conversation's: another of the bot's has none.
    expect(grants.folders("s2", "luna")).toEqual([]);
    // Asked again: already given, no card, no new turn.
    const again = await tool.run({ folder: join(w.user, "Documents"), why: "again" });
    expect(again).toMatchObject({ isError: false, text: expect.stringContaining("can already write") });
    expect(again.endTurn).toBeUndefined();
  });

  test("a sensitive folder is refused with no card: a dot-folder, the Clover home, a PATH folder, outside the home", async () => {
    const w = world();
    const broker = brokerAt("ask-risky");
    const grants = new SandboxGrants({ isOrdinary: (f) => w.classOf([f]) === "ordinary" });
    const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
    for (const folder of [join(w.user, ".aws"), w.clover, join(w.user, "bin"), "/etc", w.user, join(w.user, "Projects", "app", ".git")]) {
      const r = await tool.run({ folder, why: "x" });
      expect([folder, r.isError, r.text]).toEqual([folder, true, expect.stringContaining("never get write access")]);
    }
    expect(broker.cards()).toHaveLength(0);
    expect(grants.folders("s1", "luna")).toEqual([]);
  });

  test("declined: nothing granted, no new turn; read only refuses; \"always\" keeps it for the bot, across conversations and restarts", async () => {
    const w = world();
    const broker = brokerAt("ask-risky");
    const grants = new SandboxGrants({ home: w.clover, isOrdinary: (f) => w.classOf([f]) === "ordinary" });
    const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
    const no = answerNext(broker, "deny");
    const declined = await tool.run({ folder: join(w.user, "Projects", "app"), why: "build" });
    await no;
    expect(declined).toMatchObject({ isError: true, text: expect.stringContaining("the user declined it") });
    expect(declined.endTurn).toBeUndefined();
    const ro = requestAccessTool({ broker: brokerAt("read-only"), grants, pathClass: w.classOf, home: w.user, levelOf: () => "read-only" }, w.ctx, () => "user");
    expect(await ro.run({ folder: join(w.user, "Projects", "app"), why: "build" })).toMatchObject({ isError: true, text: expect.stringContaining("level doesn't allow it") });
    const yes = answerNext(broker, "always");
    expect((await tool.run({ folder: join(w.user, "Projects", "app"), why: "build" })).isError).toBe(false);
    await yes;
    expect(grants.folders("s9", "luna")).toEqual([join(w.user, "Projects", "app")]);
    expect(grants.folders("s9", "sol")).toEqual([]);
    // Kept in the fenced rules folder, owner-only, and read back.
    const file = sandboxGrantsFile(w.clover);
    expect(JSON.parse(readFileSync(file, "utf8")).grants).toMatchObject([{ bot: "luna", folder: join(w.user, "Projects", "app") }]);
    if (os !== "windows") expect(statSync(file).mode & 0o777).toBe(0o600);
    const reborn = new SandboxGrants({ home: w.clover, isOrdinary: (f) => w.classOf([f]) === "ordinary" });
    expect(reborn.folders("s10", "luna")).toEqual([join(w.user, "Projects", "app")]);
    // A granted folder swapped for a link since (to a sensitive place) is dropped, never followed.
    renameSync(join(w.user, "Projects", "app"), join(w.user, "Projects", "app-moved"));
    symlinkSync(join(w.user, ".aws"), join(w.user, "Projects", "app"));
    expect(reborn.folders("s10", "luna")).toEqual([]);
    reborn.forgetBot("luna");
    expect(JSON.parse(readFileSync(file, "utf8")).grants).toEqual([]);
  });

  test("hosts: refused with no card and nothing granted (the runtime's sandbox can't let only some hosts through)", async () => {
    for (const bad of ["*.example.com", "example", "10.0.0.5", "localhost", "https://api.example.com", "api.example.com:443", "api.example.com/x", "a..b.com", "x.123"]) expect([bad, validHost(bad)]).toEqual([bad, undefined]);
    expect(validHost("API.Example.com.")).toBe("api.example.com");
    const w = world();
    let reviewed = 0;
    const broker = brokerAt("automatic", async () => { reviewed++; return "safe"; });
    const grants = new SandboxGrants({ isOrdinary: () => true });
    const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "automatic" }, w.ctx, () => "user");
    expect(await tool.run({ network: ["*.example.com"], why: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("never a pattern") });
    const r = await tool.run({ network: ["registry.npmjs.org"], why: "npm install" });
    expect(r).toEqual({ isError: true, text: NETWORK_UNSUPPORTED });
    expect(reviewed).toBe(0);
    expect(broker.cards()).toHaveLength(0);
  });

  test("never a socket or Clover's run/ folder: core.sock, the run folder, a socket in an ordinary folder, a file", async () => {
    const w = world();
    mkdirSync(join(w.clover, "run"), { recursive: true });
    const server = createServer(() => {});
    const sock = join(w.user, "Documents", "agent.sock");
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const core = join(w.clover, "run", "core.sock");
    const coreServer = createServer(() => {});
    await new Promise<void>((resolve) => coreServer.listen(core, resolve));
    writeFileSync(join(w.user, "Documents", "notes.txt"), "n");
    try {
      const broker = brokerAt("ask-risky");
      const grants = new SandboxGrants({ isOrdinary: (f) => w.classOf([f]) === "ordinary" });
      const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
      for (const folder of [core, join(w.clover, "run"), sock, join(w.user, "Documents", "notes.txt"), "/var/run/docker.sock", "/var/run"]) {
        const r = await tool.run({ folder, why: "x" });
        expect([folder, r.isError]).toEqual([folder, true]);
      }
      expect(broker.cards()).toHaveLength(0);
      expect(grants.folders("s1", "luna")).toEqual([]);
    } finally {
      server.close();
      coreServer.close();
    }
  });

  test("asking is itself a read for the approvals (no card for the call; the tool raises its own)", () => {
    expect(CORE_TOOL_RULES.get(REQUEST_ACCESS_TOOL)).toBe("read");
  });
});

describe("the conversation's sandbox", () => {
  test("granted folders join the write roots under the fence's denies; no network, at any level", () => {
    const w = world();
    const fence = new CloverFence({ os, home: w.user, cloverHome: w.clover, temp: join(w.user, "tmp") });
    const policy = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } as never).policy();
    const plain = botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level: "ask-risky" });
    expect(plain.filesystem?.allowWrite).not.toContain(join(w.user, "Documents"));
    expect(plain.network).toBeUndefined();
    const granted = botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level: "ask-risky", grantedWrite: [join(w.user, "Documents")] });
    expect(granted.filesystem?.allowWrite).toContain(join(w.user, "Documents"));
    // Every deny still holds, and the new root's git hooks are denied too.
    expect(granted.filesystem?.denyWrite).toEqual(expect.arrayContaining(plain.filesystem?.denyWrite ?? []));
    // Under every root, whole `.git` folders in any letter case (the glob from `/`).
    if (os === "macos") expect(granted.filesystem?.denyWrite).toContain("/**/*.[gG][iI][tT]");
    // Never a network key, at any level: the runtime then denies the whole network, unix sockets included.
    for (const level of ["read-only", "ask", "ask-risky", "accept-edits", "automatic"] as const) {
      const at = botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level, grantedWrite: [join(w.user, "Documents")] });
      expect([level, "network" in at, "allowUnsandboxedCommands" in at]).toEqual([level, false, false]);
    }
  });
});

describe("the shell's write roots at accept edits (the coordinator's ruling on stage 2)", () => {
  test("the home's ordinary top-level folders only: never ~/Library, a dot-folder, ~/Applications, a PATH folder, a link or a file; automatic keeps the home", () => {
    const w = world();
    for (const d of ["Desktop", "Downloads", "Library/Preferences", ".config/git", "Applications", "bin"]) mkdirSync(join(w.user, d), { recursive: true });
    writeFileSync(join(w.user, "notes.txt"), "x");
    symlinkSync(join(w.user, ".config"), join(w.user, "Linked"));
    const fence = new CloverFence({ os, home: w.user, cloverHome: w.clover, temp: join(w.user, "tmp") });
    const policy = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } as never).policy();
    const draw = (level: Level) => botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level, pathFolders: [join(w.user, "bin")] }).filesystem?.allowWrite ?? [];
    const accept = draw("accept-edits");
    // (The fence's temp folder sits in this test's home; it is a root of its own at every level.)
    const top = accept.filter((r) => r.startsWith(`${w.user}/`) && !r.startsWith(`${w.clover}/`) && r !== w.clover && r !== join(w.user, "tmp"));
    expect(top.sort()).toEqual(["Desktop", "Documents", "Downloads", "Projects"].map((d) => join(w.user, d)));
    expect(accept).not.toContain(w.user);
    // Fully automatic: the home as before (its entries, the Clover home's way written out).
    const auto = draw("automatic");
    expect(auto).toContain(join(w.user, "notes.txt"));
    expect(auto).toContain(join(w.user, "Library"));
  });
});

describe("a git directory by its content, whatever its name (the review's item on stage 2)", () => {
  test("a bare repository not named *.git under a root is denied whole, to the shell and to the file tools", async () => {
    const w = world();
    const bare = join(w.user, "Projects", "app", "mirror");
    for (const d of ["objects", "refs/heads"]) mkdirSync(join(bare, d), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    const fence = new CloverFence({ os, home: w.user, cloverHome: w.clover, temp: join(w.user, "tmp") });
    const policy = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } as never).policy();
    const deny = botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level: "ask-risky", grantedWrite: [join(w.user, "Projects", "app")] }).filesystem?.denyWrite ?? [];
    expect(rootCovered(join(bare, "hooks", "pre-commit"), deny, os)).toBe(true);
    expect(rootCovered(bare, deny, os)).toBe(true);
    expect(rootCovered(join(w.user, "Projects", "app", "src.ts"), deny, os)).toBe(false);
    // The path classes call it a card (so a file tool's write there is a run-later place, refused before any card).
    expect(w.classOf([join(bare, "hooks", "pre-commit")])).toBe("card");
  });
});

describe("the link race's interim", () => {
  test("while a background command runs, a file tool's write inside the shell's folders isn't contained (the bot's own folders too)", async () => {
    const w = world();
    const requests: CloverApprovalRequest[] = [];
    const recorder = { request: async (r: ApprovalRequest) => { requests.push(structuredClone(r) as CloverApprovalRequest); return { allowed: true, by: "level" as const }; } };
    let live = false;
    const roots = [w.ctx.paths.scratch, join(w.user, "Documents")];
    const fence = new CloverFence({ os, home: w.user, cloverHome: w.clover, temp: join(w.user, "tmp") });
    const check = botApprovalCheck(recorder, {
      fence, cloverHome: w.clover, levelOf: () => "ask-risky", home: w.user, liveShell: () => live, shellRoots: () => roots,
    });
    const call = async (path: string) => {
      requests.length = 0;
      const r = await check(w.ctx, () => "user")("Write", { file_path: path, content: "x" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
      return { behavior: r?.behavior, req: requests[0] };
    };
    // No background command: a write in the bot's own folder runs outright; one in Documents goes to the broker as is.
    expect(await call(join(w.ctx.paths.scratch, "a.txt"))).toEqual({ behavior: "allow", req: undefined });
    expect((await call(join(w.user, "Documents", "a.txt"))).req?.notContained).toBeUndefined();
    live = true;
    const own = await call(join(w.ctx.paths.scratch, "b.txt"));
    expect(own.req?.notContained).toBe(true);
    expect((await call(join(w.user, "Documents", "b.txt"))).req?.notContained).toBe(true);
    // Outside the shell's folders: as before.
    expect((await call(join(w.user, "Projects", "app", "c.txt"))).req?.notContained).toBeUndefined();
    expect(existsSync(join(w.user, "Documents", "b.txt"))).toBe(false);
  });

  test("the broker: a not-contained edit of an ordinary file goes to the reviewer, then a card", async () => {
    let reviewed = 0;
    const b = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => "ask-risky", localComputer: "Studio", pathClass: () => "ordinary", reviewer: async () => { reviewed++; return "unavailable"; } });
    const edit = (over: Partial<CloverApprovalRequest>): CloverApprovalRequest => ({ kind: "tool", bot: "luna", origin: "user", computers: ["Studio"], effect: "edit", paths: ["/Users/k/Documents/a"], fields: {}, ...over });
    expect(await b.request(edit({}))).toEqual({ allowed: true, by: "level", level: "ask-risky" });
    const card = answerNext(b, "deny");
    expect(await b.request(edit({ notContained: true }))).toMatchObject({ allowed: false, by: "card" });
    await card;
    expect(reviewed).toBe(1);
  });
});

describe("the run-later denies under every root (the review's blocker on 408d1c844)", () => {
  const levels = ["ask-risky", "accept-edits", "automatic"] as const;
  const setup = () => {
    const w = world();
    const fence = new CloverFence({ os, home: w.user, cloverHome: w.clover, temp: join(w.user, "tmp") });
    const policy = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } as never).policy();
    const own = [w.ctx.paths.scratch, join(w.clover, "scratch")];
    const draw = (level: Level, extra: { grantedWrite?: string[]; pathFolders?: string[] } = {}) =>
      botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level, ownFolders: own, ...extra });
    return { w, own, draw };
  };

  test("no deny covers a root it draws, at any level: the granted folder, the bot's own folders, the home's entries", () => {
    const { w, own, draw } = setup();
    for (const level of levels) {
      const s = draw(level, { grantedWrite: [join(w.user, "Projects", "app")] });
      const deny = s.filesystem?.denyWrite ?? [];
      for (const root of [...(s.filesystem?.allowWrite ?? []), ...own]) expect([level, root, rootCovered(root, deny, os)]).toEqual([level, root, false]);
      expect(s.filesystem?.allowWrite).toContain(join(w.user, "Projects", "app"));
    }
  });

  test("every shared run-later name is denied, whole, in any letter case; *.app and .clover too", () => {
    const { w, draw } = setup();
    for (const level of levels) {
      const deny = draw(level, { grantedWrite: [join(w.user, "Projects", "app")] }).filesystem?.denyWrite ?? [];
      const covers = (p: string) => rootCovered(p, deny, os);
      const app = join(w.user, "Projects", "app");
      for (const name of [".git", ".GIT", "x.git", ".vscode", ".idea", ".claude", ".husky", ".githooks", ".mcp.json", ".envrc", ".gitmodules", ".ripgreprc", ".zshrc", "Tool.app", ".clover"]) {
        if (os !== "macos" && name !== name.toLowerCase() && name !== "Tool.app") continue;
        expect([level, name, covers(join(app, "deep", "er", name, "inside"))]).toEqual([level, name, true]);
        expect([level, name, covers(join(app, name))]).toEqual([level, name, true]);
      }
      expect(covers(join(app, "src", "main.ts"))).toBe(false);
      expect(covers(join(app, "build", "out.txt"))).toBe(false);
    }
    expect(PROJECT_DENIES).toContain(".ripgreprc");
    expect(PROJECT_WHOLE_DENIES).toEqual(expect.arrayContaining([".husky", ".githooks"]));
  });

  test("the runtime's own default list for the working folder is a subset of what every root gets (never wider under a granted root)", () => {
    // index-q1vv1628.js:6200-6209, buildDefaultWriteProtectionBlock (cwd only).
    const runtimeCwd = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".vscode", ".idea", ".claude", ".git"];
    const { w, draw } = setup();
    const deny = draw("automatic", { grantedWrite: [join(w.user, "Projects", "app")] }).filesystem?.denyWrite ?? [];
    for (const n of runtimeCwd) expect([n, rootCovered(join(w.user, "Projects", "app", n), deny, os)]).toEqual([n, true]);
    expect(rootCovered(join(w.user, "Projects", "app", ".clover", "commands"), deny, os)).toBe(true);
  });

  test("PATH folders under a root are denied by path; the fixed ones too", () => {
    const { w, draw } = setup();
    const onPath = join(w.user, "Projects", "app", "node", "bin");
    const deny = draw("automatic", { grantedWrite: [join(w.user, "Projects", "app")], pathFolders: [onPath] }).filesystem?.denyWrite ?? [];
    expect(deny).toContain(onPath);
    expect(deny).toContain(join(w.user, ".local", "bin"));
  });

  test("the secret places are read- and write-denied to the shell at every level, and none is a root", () => {
    const { w, draw } = setup();
    for (const level of ["read-only", ...levels] as Level[]) {
      const s = draw(level);
      for (const p of secretReadPlaces(os, w.user)) {
        expect([level, p.path, (s.filesystem?.denyRead ?? []).includes(p.path), (s.filesystem?.denyWrite ?? []).includes(p.path)]).toEqual([level, p.path, true, true]);
        expect(s.filesystem?.allowWrite).not.toContain(p.path);
      }
    }
  });

  test("a root with a control character, or one that holds the Clover home, is never drawn", () => {
    const { w, draw } = setup();
    const odd = join(w.user, "Projects", "a\nb");
    const s = draw("ask-risky", { grantedWrite: [odd, w.user] });
    expect(s.filesystem?.allowWrite).not.toContain(odd);
    expect(s.filesystem?.allowWrite).not.toContain(w.user);
    expect(CONTROL.test(odd)).toBe(true);
  });

  test("denyRegex renders a glob as the runtime does: `**/` none or more folders, a class kept, the match recursive", () => {
    const g = `/r/**/${anyCase(".git", "macos")}`;
    expect(denyRegex(g, "macos").test("/r/.git")).toBe(true);
    expect(denyRegex(g, "macos").test("/r/a/b/.GiT/hooks/x")).toBe(true);
    expect(denyRegex(g, "macos").test("/r/a/.github")).toBe(false);
    expect(anyCase(".git", "linux")).toBe(".git");
    expect(shellRunLaterDenies([], { userHome: "/u", cloverHome: "/u/.clover", os: "linux", pathFolders: [] })).toEqual([]);
  });
});

describe("RequestAccess looks down before its card, and refuses what is never given", () => {
  test("the card says what the folder holds in plain words; the bot is told about .git", async () => {
    const w = world();
    const app = join(w.user, "Projects", "app");
    for (const r of ["one", "two/sub", "three"]) mkdirSync(join(app, r, ".git"), { recursive: true });
    mkdirSync(join(app, "dist", "Tool.app", "Contents"), { recursive: true });
    expect(folderHolds(app, [])).toEqual({ repos: 3, apps: 1, pathFolders: 0, complete: true });
    expect(holdsLine(folderHolds(app, []))).toContain("It holds 3 git repositories, 1 app");
    expect(holdsLine(folderHolds(join(w.user, "Documents"), []))).toBeUndefined();
    const broker = brokerAt("ask-risky");
    const grants = new SandboxGrants({ isOrdinary: (f) => w.classOf([f]) === "ordinary" });
    const tool = requestAccessTool({ broker, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky", os: "macos" }, w.ctx, () => "user");
    expect(tool.description).toContain(GIT_IN_SANDBOX);
    const card = answerNext(broker, "approve");
    const r = await tool.run({ folder: app, why: "build" });
    const shown = await card;
    expect(shown.fields.risk).toEqual({ type: "text", text: expect.stringContaining("3 git repositories") });
    expect(shown.fields.what).toEqual({ type: "code", code: `luna wants write access to ${app} for shell commands` });
    expect(r.endTurn?.note).toContain(GIT_IN_SANDBOX);
  });

  test("past the look's bound, the card says it holds more than was looked through", () => {
    const w = world();
    const big = join(w.user, "Projects", "big");
    for (let i = 0; i < 60; i++) for (let j = 0; j < 90; j++) mkdirSync(join(big, `d${i}`, `e${j}`), { recursive: true });
    const h = folderHolds(big, []);
    expect(h.complete).toBe(false);
    expect(holdsLine(h)).toContain("more than Clover looked through");
    // It promises only what is held by name; what the look didn't reach is said plainly.
    expect(holdsLine(h)).not.toContain("whatever git repositories");
    expect(holdsLine(h)).toContain("isn't protected");
  });

  test("never given, with no card: ~, ~/Applications, ~/Library, a PATH folder or one holding one, a folder holding the Clover home, a hidden character, Linux", async () => {
    const w = world();
    const broker = brokerAt("ask-risky");
    const grants = new SandboxGrants({ isOrdinary: () => true });
    const go = join(w.user, "go");
    mkdirSync(join(go, "bin"), { recursive: true });
    const odd = join(w.user, "Projects", "a\u202Eb");
    mkdirSync(odd, { recursive: true });
    const deps = { broker, grants, pathClass: () => "ordinary" as const, home: w.user, levelOf: () => "ask-risky" as const, os: "macos" as const, cloverHome: w.clover, pathFolders: () => [join(go, "bin")] };
    const tool = requestAccessTool(deps, w.ctx, () => "user");
    for (const folder of [w.user, join(w.user, "Applications"), join(w.user, "Library"), join(go, "bin"), go, odd]) {
      mkdirSync(folder, { recursive: true });
      const r = await tool.run({ folder, why: "x" });
      expect([folder, r.isError]).toEqual([folder, true]);
    }
    // A folder that holds the Clover home (the home's parent here is the user's home itself; a deeper one too).
    const parent = join(w.user, "outer");
    const nested = requestAccessTool({ ...deps, cloverHome: join(parent, "x", ".clover") }, w.ctx, () => "user");
    mkdirSync(parent, { recursive: true });
    expect((await nested.run({ folder: parent, why: "x" })).text).toContain("Clover's own folder");
    const linux = requestAccessTool({ ...deps, os: "linux" as const }, w.ctx, () => "user");
    expect((await linux.run({ folder: join(w.user, "Documents"), why: "x" })).text).toContain("On Linux");
    expect(broker.cards()).toHaveLength(0);
    expect(grants.folders("s1", "luna")).toEqual([]);
  });
});

describe("the grants' lifetime", () => {
  test("a removed bot's grants go, kept and per conversation; a bot made later with its id inherits none; a conversation's end forgets its own", () => {
    const w = world();
    const grants = new SandboxGrants({ home: w.clover, isOrdinary: () => true });
    const docs = join(w.user, "Documents"), app = join(w.user, "Projects", "app");
    grants.grantFolder("s1", "luna", docs, false);
    grants.grantFolder("s1", "luna", app, true);
    grants.grantFolder("s2", "sol", docs, false);
    expect(grants.folders("s1", "luna").sort()).toEqual([app, docs].sort());
    // Another bot asking with the same conversation id gets nothing of luna's.
    expect(grants.folders("s1", "nova")).toEqual([]);
    grants.forgetBot("luna");
    expect(grants.folders("s1", "luna")).toEqual([]);
    expect(new SandboxGrants({ home: w.clover, isOrdinary: () => true }).folders("s9", "luna")).toEqual([]);
    expect(grants.folders("s2", "sol")).toEqual([docs]);
    grants.forgetSession("s2");
    expect(grants.folders("s2", "sol")).toEqual([]);
    // A grant made after a removal starts clean under the reused id.
    grants.grantFolder("s1", "luna", docs, false);
    expect(grants.folders("s1", "luna")).toEqual([docs]);
  });
});
