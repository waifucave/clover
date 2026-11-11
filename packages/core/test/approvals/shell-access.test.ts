// Stage 2 of "bots ask less" (the controller's ruling, option A): a bot's sandboxed shell commands run without asking
// inside its level's roots; for more it asks with `RequestAccess` (a folder: a card, its "always" kept for that bot;
// hosts: the reviewer, then a card), and what is granted joins the conversation's sandbox. While a background command
// runs, a file tool's write inside the shell's folders isn't contained (the link race's interim).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, Level, Os } from "@waifucave/clover-protocol";
import { CloverApprovalBroker, type CloverApprovalRequest } from "../../src/approvals/broker";
import { botApprovalCheck, CORE_TOOL_RULES } from "../../src/approvals/bot-check";
import { pathsClassOnDisk } from "../../src/approvals/ordinary-paths";
import { REQUEST_ACCESS_TOOL, requestAccessTool, validHost } from "../../src/approvals/request-access";
import { SandboxGrants, sandboxGrantsFile } from "../../src/approvals/sandbox-grants";
import type { ApprovalRequest, Reviewer } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { BotSessionContext } from "../../src/bots/service";
import { CloverFence } from "../../src/fence/fence";
import { botSandboxSettings } from "../../src/fence/sandbox-settings";

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
      expect([folder, r.isError, r.text]).toEqual([folder, true, expect.stringContaining("sensitive place")]);
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

  test("hosts: exact names only, then the reviewer (its safe grants), else a card with no \"always\"; granted ones join the conversation", async () => {
    for (const bad of ["*.example.com", "example", "10.0.0.5", "localhost", "https://api.example.com", "api.example.com:443", "api.example.com/x", "a..b.com", "x.123"]) expect([bad, validHost(bad)]).toEqual([bad, undefined]);
    expect(validHost("API.Example.com.")).toBe("api.example.com");
    const w = world();
    let reviewed: ApprovalRequest | undefined;
    const safe = brokerAt("ask-risky", async (req) => { reviewed = req; return "safe"; });
    const grants = new SandboxGrants({ isOrdinary: () => true });
    const tool = requestAccessTool({ broker: safe, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
    expect(await tool.run({ network: ["*.example.com"], why: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("never a pattern") });
    const r = await tool.run({ network: ["registry.npmjs.org", "registry.npmjs.org"], why: "npm install" });
    expect(r).toMatchObject({ isError: false, endTurn: { note: expect.stringContaining("registry.npmjs.org") } });
    expect(reviewed).toMatchObject({ effect: "fetch", fields: { host: { type: "code", code: "registry.npmjs.org" } } });
    expect(grants.hosts("s1")).toEqual(["registry.npmjs.org"]);
    // Unsure: a card, with no "always".
    const unsure = brokerAt("ask-risky", async () => "unavailable");
    const t2 = requestAccessTool({ broker: unsure, grants, pathClass: w.classOf, home: w.user, levelOf: () => "ask-risky" }, w.ctx, () => "user");
    const card = answerNext(unsure, "deny");
    expect((await t2.run({ network: ["evil.example"], why: "x" })).isError).toBe(true);
    expect((await card).options.map((o) => o.id)).toEqual(["approve", "deny"]);
    expect(grants.hosts("s1")).toEqual(["registry.npmjs.org"]);
  });

  test("asking is itself a read for the approvals (no card for the call; the tool raises its own)", () => {
    expect(CORE_TOOL_RULES.get(REQUEST_ACCESS_TOOL)).toBe("read");
  });
});

describe("the conversation's sandbox", () => {
  test("granted folders join the write roots under the fence's denies; granted hosts are the only ones reached", () => {
    const w = world();
    const fence = new CloverFence({ os, home: w.user, cloverHome: w.clover, temp: join(w.user, "tmp") });
    const policy = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } as never).policy();
    const plain = botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level: "ask-risky" });
    expect(plain.filesystem?.allowWrite).not.toContain(join(w.user, "Documents"));
    expect(plain.network).toBeUndefined();
    const granted = botSandboxSettings(policy, { cloverHome: w.clover, userHome: w.user, level: "ask-risky", grantedWrite: [join(w.user, "Documents")], allowedDomains: ["registry.npmjs.org"] });
    expect(granted.filesystem?.allowWrite).toContain(join(w.user, "Documents"));
    // Every deny still holds, and the new root's git hooks are denied too.
    expect(granted.filesystem?.denyWrite).toEqual(expect.arrayContaining(plain.filesystem?.denyWrite ?? []));
    expect(granted.filesystem?.denyWrite).toContain(join(w.user, "Documents", "**", "*.git", "hooks"));
    expect(granted.network).toEqual({ allowedDomains: ["registry.npmjs.org"] });
    expect(granted).not.toHaveProperty("allowUnsandboxedCommands");
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
      return { behavior: r.behavior, req: requests[0] };
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
