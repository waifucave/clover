// Agent SDK 0.0.77 on the bot side: the runtime's file tools write the file they checked, and a bot's are held to its
// write roots (`botSandbox`'s `filesystem.enforceWriteRootsInFileTools`). What Clover adds: every bot-side session kind
// turns it on, and an allowed Write, Edit or NotebookEdit runs with the REAL path its check judged and its card showed
// (`withRealPaths`), so the runtime's waiver for a `canUseTool` allow of a link-free path can apply.
//
// The SDK's own swap seam is internal to its bundle, so the races here are driven from Clover's side: a link put in
// place inside the `canUseTool` answer, after Clover's check judged the path and before the runtime writes.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BOT_SANDBOX, BotSessionDriver, botFileFence, botSandbox, withBotKeyReads, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { CloverFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { botApprovalCheck, withRealPaths } from "../../../src/approvals/bot-check";
import { BOT_KEY_PATHS } from "../../../src/runtime-sdk/turn-loop/file-fence";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { darwinTest } from "../../helpers/darwin-only";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function control(): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: () => {} } as unknown as TurnControl;
}
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });
const results = (end: { text?: string }) => JSON.parse(end.text ?? "[]") as { name: string | null; isError: boolean; content: string }[];

function context(home: string, model: string): BotSessionContext & { bot: EffectiveBot } {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model, modelFrom: "user", userLayer: [] };
  return {
    bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
  };
}

describe("botSandbox: every bot-side session's file tools are held to its write roots", () => {
  test("enforce on, hard-link writes never allowed, BOT_SANDBOX last, the host's roots and denies kept", () => {
    const s = botSandbox({ enabled: false, allowUnsandboxedCommands: true, filesystem: { allowWrite: ["/w"], denyWrite: ["/d"], allowHardLinkWrites: true } as never });
    expect(s).toMatchObject(BOT_SANDBOX);
    expect(s.filesystem).toEqual({ allowWrite: ["/w"], denyWrite: ["/d"], enforceWriteRootsInFileTools: true });
    expect(botSandbox({}).filesystem).toEqual({ enforceWriteRootsInFileTools: true });
  });

  test("the home's key places, the checkpoint store and image copies among them, are read-denied to the shell too", () => {
    const s = withBotKeyReads({ filesystem: { denyRead: ["/x"] } }, { home: "/h" });
    for (const rel of BOT_KEY_PATHS) expect(s.filesystem?.denyRead).toContain(join("/h", ...rel));
    expect(s.filesystem?.denyRead).toContain("/h/sdk/file-history");
    expect(s.filesystem?.denyRead).toContain("/h/sdk/projects/**/*.auto-state.json");
    expect(s.filesystem?.denyRead).toContain("/h/sdk/projects/**/*.provider-state.jsonl");
    expect(s.filesystem?.denyRead).toContain("/x");
    expect(withBotKeyReads({ enabled: true }, undefined)).toEqual({ enabled: true });
  });
});

describe("withRealPaths: an allowed file write runs with the path the check judged", () => {
  const allowAll = { request: async () => ({ allowed: true, by: "card" }) } as never;
  function check(scratch: string) {
    const ctx = { botId: "luna", sessionId: "s1", computer: "Studio", paths: { scratch, root: scratch }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } } as unknown as BotSessionContext;
    const c = botApprovalCheck(allowAll, { localComputer: "Studio" })(ctx, () => "user");
    return (tool: string, input: Record<string, unknown>) => c(tool, input, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" } as never);
  }

  darwinTest("macOS: a file under /tmp runs as /private/tmp/…, and one in a bot's scratch under /var/folders as /private/var/folders/…", async () => {
    const underTmp = mkdtempSync("/tmp/clover-real-");
    temps.push(underTmp);
    const scratch = temp("clover-scratch-"); // os.tmpdir() on macOS: /var/folders/…
    expect(scratch.startsWith("/var/folders/")).toBe(true);
    const call = check(scratch);
    const a = await call("Write", { file_path: join(underTmp, "a.txt"), content: "x" });
    expect((a as unknown as { updatedInput: { file_path: string } }).updatedInput.file_path).toBe(join(realpathSync(underTmp), "a.txt"));
    expect(realpathSync(underTmp).startsWith("/private/tmp/")).toBe(true);
    const b = await call("Edit", { file_path: "notes.md", old_string: "a", new_string: "b" });
    expect((b as unknown as { updatedInput: { file_path: string } }).updatedInput.file_path).toBe(join(realpathSync(scratch), "notes.md"));
    expect(realpathSync(scratch).startsWith("/private/var/folders/")).toBe(true);
    const n = await call("NotebookEdit", { notebook_path: join(underTmp, "n.ipynb"), new_source: "x", cell_id: "c1" });
    expect((n as unknown as { updatedInput: { notebook_path: string } }).updatedInput.notebook_path).toBe(join(realpathSync(underTmp), "n.ipynb"));
  });

  test("a link at the path: the allowed call runs with the link's real target (what the card showed)", async () => {
    const scratch = realpathSync(temp("clover-scratch-"));
    const other = realpathSync(temp("clover-other-"));
    writeFileSync(join(other, "t.txt"), "t");
    symlinkSync(join(other, "t.txt"), join(scratch, "l.txt"));
    const r = await check(scratch)("Write", { file_path: join(scratch, "l.txt"), content: "x" });
    expect((r as unknown as { updatedInput: { file_path: string } }).updatedInput.file_path).toBe(join(other, "t.txt"));
  });

  test("other tools, and a session on another computer, keep their input", () => {
    expect(withRealPaths("Read", { file_path: "/tmp/a" }, { paths: ["/private/tmp/a"] })).toEqual({ file_path: "/tmp/a" });
    expect(withRealPaths("Write", { file_path: "/tmp/a" }, { paths: ["/private/tmp/a"], pathsUnresolved: true })).toEqual({ file_path: "/tmp/a" });
    expect(withRealPaths("Write", { file_path: "/tmp/a", content: "c" }, { paths: ["/private/tmp/a"] })).toEqual({ file_path: "/private/tmp/a", content: "c" });
  });
});

// The real embedded runtime (one Worker per session) with the runtime's scripted test model, macOS only: a bot's
// commands run sandboxed and the runtime's sandbox is Seatbelt.
describeWithEmbeddedRuntime("the bot driver's file tools on agent SDK 0.0.77", (spawn) => {
  function setup(canUseTool: BotDriverDeps["canUseTool"]) {
    const home = temp("clover-roots-");
    const ctx = context(home, "winter-test/calls");
    mkdirSync(ctx.paths.scratch, { recursive: true });
    const outside = realpathSync(temp("clover-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "SECRET");
    const driver = new BotSessionDriver(ctx, { home, spawn, canUseTool, sandbox: () => ({}), stopGraceMs: 5_000, log: () => {} });
    return { home, ctx, outside, secret, driver };
  }
  const allow: BotDriverDeps["canUseTool"] = () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> });

  darwinTest("the checkpoint store and a classifier cache: neither Read nor the shell reads them", async () => {
    const home = temp("clover-store-");
    const ctx = context(home, "winter-test/calls");
    mkdirSync(ctx.paths.scratch, { recursive: true });
    const blob = join(home, "sdk", "file-history", "s1", "abc@v1");
    mkdirSync(join(home, "sdk", "file-history", "s1"), { recursive: true });
    writeFileSync(blob, "COPIED-SECRET");
    const cache = join(home, "sdk", "projects", "k", "s1.auto-state.json");
    mkdirSync(join(home, "sdk", "projects", "k"), { recursive: true });
    writeFileSync(cache, "CACHED-DECISIONS");
    const fence = new CloverFence({ home: dirname(home), cloverHome: home });
    const driver = new BotSessionDriver(ctx, { home, spawn, canUseTool: allow, sandbox: () => ({}), stopGraceMs: 5_000, log: () => {}, fileFence: botFileFence(fence, home) });
    try {
      const calls = [
        `CALL Read ${JSON.stringify({ file_path: blob })}`,
        `CALL Read ${JSON.stringify({ file_path: cache })}`,
        `CALL Bash ${JSON.stringify({ command: `cat ${JSON.stringify(blob)} ${JSON.stringify(cache)}; echo done`, description: "probe" })}`,
      ].join("\n");
      const end = await driver.turn(user(calls), control());
      for (const r of results(end)) {
        expect(r.content).not.toContain("COPIED-SECRET");
        expect(r.content).not.toContain("CACHED-DECISIONS");
      }
      expect(results(end).find((r) => r.name === "Bash")?.content).toContain("done");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("a Write through a link to a file outside the roots leaves that file unchanged (refused, naming the real file)", async () => {
    const { ctx, secret, driver } = setup(allow);
    const link = join(ctx.paths.scratch, "x.txt");
    symlinkSync(secret, link);
    try {
      const end = await driver.turn(user(`CALL Read ${JSON.stringify({ file_path: link })}\nCALL Write ${JSON.stringify({ file_path: link, content: "PWNED" })}`), control());
      const w = results(end).find((r) => r.name === "Write");
      expect(w?.isError).toBe(true);
      expect(w?.content).toContain("outside this session's write roots");
      expect(readFileSync(secret, "utf8")).toBe("SECRET");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("a link swapped in after Clover's check (inside the allow) leaves the outside file unchanged", async () => {
    let swapped = false;
    let target = "";
    let secretPath = "";
    const swapThenAllow: BotDriverDeps["canUseTool"] = (ctx, origin) => {
      const real = botApprovalCheck({
        request: async () => {
          // Clover's check has judged the path (a plain file in the bot's scratch); now a command's link takes its place.
          rmSync(target);
          symlinkSync(secretPath, target);
          swapped = true;
          return { allowed: true, by: "card" };
        },
      } as never, { localComputer: "Studio" })(ctx, origin);
      return (async (tool, input, opts) => (tool === "Write" ? real(tool, input, opts) : { behavior: "allow", updatedInput: input })) as CanUseTool;
    };
    const { ctx, secret, driver } = setup(swapThenAllow);
    target = join(ctx.paths.scratch, "y.txt");
    secretPath = secret;
    writeFileSync(target, "plain");
    try {
      const end = await driver.turn(user(`CALL Read ${JSON.stringify({ file_path: target })}\nCALL Write ${JSON.stringify({ file_path: target, content: "PWNED" })}`), control());
      expect(swapped).toBe(true);
      expect(results(end).find((r) => r.name === "Write")?.isError).toBe(true);
      expect(readFileSync(secret, "utf8")).toBe("SECRET");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("an auto-allowed write outside the roots (no card, allowed by the level): a link swapped in between Clover's resolution and the runtime's plan is refused, the outside file unchanged", async () => {
    // The ordinary file the bot asks to write, outside its roots, link-free: Clover resolves it (no link: the real path
    // is the path), the level allows it with no card, and the runtime is handed that real path.
    const elsewhere = realpathSync(temp("clover-elsewhere-"));
    const target = join(elsewhere, "notes.txt");
    writeFileSync(target, "ordinary");
    let secretPath = "";
    let resolved: string | undefined;
    const levelAllows: BotDriverDeps["canUseTool"] = (ctx, origin) => botApprovalCheck({
      request: async (req: { paths?: string[] }) => {
        resolved = req.paths?.[0];
        // After Clover's resolution, before the runtime plans its write: a command's link takes the file's place.
        rmSync(target);
        symlinkSync(secretPath, target);
        return { allowed: true, by: "level" };
      },
    } as never, { localComputer: "Studio" })(ctx, origin);
    const { secret, driver } = setup(levelAllows);
    secretPath = secret;
    try {
      const end = await driver.turn(user(`CALL Write ${JSON.stringify({ file_path: target, content: "PWNED" })}`), control());
      expect(resolved).toBe(target);
      const w = results(end).find((r) => r.name === "Write");
      expect(w?.isError).toBe(true);
      expect(readFileSync(secret, "utf8")).toBe("SECRET");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("a card's yes to a file outside the roots, under /tmp: written, through the real path the check judged", async () => {
    const underTmp = mkdtempSync("/tmp/clover-real-");
    temps.push(underTmp);
    const cardYes: BotDriverDeps["canUseTool"] = (ctx, origin) => botApprovalCheck({ request: async () => ({ allowed: true, by: "card" }) } as never, { localComputer: "Studio" })(ctx, origin);
    const { driver } = setup(cardYes);
    const file = join(underTmp, "approved.txt");
    try {
      const end = await driver.turn(user(`CALL Write ${JSON.stringify({ file_path: file, content: "APPROVED" })}`), control());
      const w = results(end).find((r) => r.name === "Write");
      expect(w?.isError).toBe(false);
      expect(w?.content).toContain(realpathSync(underTmp)); // the tool's result names the real path
      expect(readFileSync(file, "utf8")).toBe("APPROVED");
      // The model's own spelling keeps working for its later calls: a Read of it, and an Edit of it (the runtime's read
      // state is keyed by the real path, and the Edit is approved and run through the real path again).
      const later = await driver.turn(user(`CALL Read ${JSON.stringify({ file_path: file })}\nCALL Edit ${JSON.stringify({ file_path: file, old_string: "APPROVED", new_string: "EDITED" })}`), control());
      const r = results(later);
      expect(r.find((x) => x.name === "Read")?.content).toContain("APPROVED");
      expect(r.find((x) => x.name === "Edit")?.isError).toBe(false);
      expect(readFileSync(file, "utf8")).toBe("EDITED");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  // The owner's try 14: "Error: protected host path access refused" for a Write on his Desktop. The user's secret places
  // are in every bot's deny lists, and the runtime's file-tool check refused every path when one of them couldn't be
  // resolved (`~/Library/Mail` on a Mac that hasn't given Clover Full Disk Access; a folder at mode 000 here). No call
  // here names a path inside Mail: agent SDK 0.0.78's permission check ends the whole turn on one ("EACCES … lstat"),
  // before any hook, whatever Clover's settings (reported for the SDK). `~/.ssh` stands for a secret place Clover can
  // open (Full Disk Access given): the file tools and the shell's Seatbelt profile, which now meets it as a glob, keep
  // it unread.
  darwinTest("a user's home with ~/Library/Mail closed to Clover: a Write on the Desktop is written; Mail and ~/.ssh stay unread, by the file tools and the shell", async () => {
    const userHome = realpathSync(temp("clover-user-"));
    const cloverHome = join(userHome, ".clover");
    const ctx = context(cloverHome, "winter-test/calls");
    mkdirSync(ctx.paths.scratch, { recursive: true });
    for (const d of ["Desktop", "Library/Mail/V10", ".ssh"]) mkdirSync(join(userHome, d), { recursive: true });
    const mail = join(userHome, "Library/Mail/V10/inbox.mbox");
    writeFileSync(mail, "MAIL-SECRET");
    expect(existsSync(mail)).toBe(true);
    writeFileSync(join(userHome, ".ssh/id_ed25519"), "KEY-SECRET");
    const desk = join(userHome, "Desktop", "hello_world.md");
    const fence = new CloverFence({ home: userHome, cloverHome });
    const sandbox = (c: BotSessionContext) => botSandboxSettings(fence.forCaller(c.caller).policy(), {
      cloverHome, userHome, level: undefined, ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
    });
    const driver = new BotSessionDriver(ctx, { home: cloverHome, spawn, canUseTool: allow, sandbox, stopGraceMs: 5_000, log: () => {}, fileFence: botFileFence(fence, cloverHome, "macos", userHome) });
    chmodSync(join(userHome, "Library/Mail"), 0o000);
    try {
      const calls = [
        `CALL Write ${JSON.stringify({ file_path: desk, content: "hello" })}`,
        `CALL Read ${JSON.stringify({ file_path: desk })}`,
        `CALL Read ${JSON.stringify({ file_path: join(userHome, ".ssh/id_ed25519") })}`,
        `CALL Bash ${JSON.stringify({ command: `cat ${JSON.stringify(desk)}; cat ${JSON.stringify(join(userHome, ".ssh/id_ed25519"))}; echo done`, description: "probe" })}`,
      ].join("\n");
      const end = await driver.turn(user(calls), control());
      const r = results(end);
      expect(existsSync(desk) && readFileSync(desk, "utf8")).toBe("hello");
      expect(r.find((x) => x.name === "Write")?.isError).toBe(false);
      const reads = r.filter((x) => x.name === "Read");
      expect(reads[0]?.content).toBe("hello");
      expect(reads[1]?.content).toContain("bots never read or change");
      for (const x of r) {
        expect(x.content).not.toContain("protected host path access refused");
        expect(x.content).not.toContain("MAIL-SECRET");
        expect(x.content).not.toContain("KEY-SECRET");
      }
      const bash = r.find((x) => x.name === "Bash")?.content ?? "";
      expect(bash).toContain("hello");
      expect(bash).toContain("id_ed25519: Operation not permitted");
      expect(bash).toContain("done");
    } finally {
      chmodSync(join(userHome, "Library/Mail"), 0o700);
      await driver.stop();
    }
  }, 60_000);

  darwinTest("an auto-allowed Write outside the roots spelled through /tmp, as given (no real path), is refused by the runtime", async () => {
    const underTmp = mkdtempSync("/tmp/clover-real-");
    temps.push(underTmp);
    const { driver } = setup(allow);
    const file = join(underTmp, "spelled.txt");
    try {
      const end = await driver.turn(user(`CALL Write ${JSON.stringify({ file_path: file, content: "X" })}`), control());
      expect(results(end).find((r) => r.name === "Write")?.isError).toBe(true);
    } finally {
      await driver.stop();
    }
  }, 60_000);
});
