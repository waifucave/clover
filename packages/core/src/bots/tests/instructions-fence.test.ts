// The instructions rule through the real fence (lane BT; spec §6.1, item 114), on a temp home on this disk: a bot
// writes its own `bots/<x>/instructions/` and those of the bots it made, with the normal Write and Edit (the fence's
// `check`, which the file tools ask) and in its runtime's sandbox (`sandboxSettingsOf`, which its Write, Edit and Bash
// meet); any other bot's is refused (its change is the core tool's, behind a card); no bot writes any `bot.json`, its
// own included; the folder itself is never removed, moved or written over; a coding session and an agent reach none.
// Before this lane the probe found every one of these refused, the bot's own instructions included.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRecord, Caller } from "@waifucave/moss-protocol";
import { policyAllows } from "../../contracts/fence";
import { MossFence } from "../../fence/fence";
import { sandboxSettingsOf } from "../../fence/sandbox-settings";
import { instructionsReach } from "../made-by";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bt-fence-")));
  temps.push(root);
  const user = join(root, "user");
  const moss = join(user, ".moss");
  mkdirSync(moss, { recursive: true });
  const bot = (id: string, madeBy: BotRecord["madeBy"]) => {
    const dir = join(moss, "bots", id.replace("/", "--"));
    mkdirSync(join(dir, "instructions"), { recursive: true });
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "bot.json"), JSON.stringify({ record: 1, id, name: id, madeBy, createdAt: 1 } satisfies BotRecord));
    writeFileSync(join(dir, "instructions", "instructions.md"), `I am ${id}.`);
  };
  bot("alpha", { kind: "default" });
  bot("scout", { kind: "bot", id: "alpha" });
  bot("luna", { kind: "user" });
  bot("pack/nova", { kind: "bot", id: "luna" });
  const fence = new MossFence({ home: user, mossHome: moss });
  const as = (bot: string, kind: "bot" | "side-thread" = "bot") => fence.forCaller({ kind: "session", sessionId: `b_${bot}`, sessionKind: kind, bot } as Caller);
  return { moss, fence, as, bot, ins: (seg: string) => join(moss, "bots", seg, "instructions", "instructions.md") };
}

const coding: Caller = { kind: "session", sessionId: "c_1", sessionKind: "coding" } as Caller;
const agent: Caller = { kind: "session", sessionId: "a_1", sessionKind: "agent", bot: "alpha" } as Caller;

describe("the instructions rule, through the real fence", () => {
  test("a bot writes its own instructions and those of a bot it made; another bot's is refused", () => {
    const h = home();
    const alpha = h.as("alpha");
    expect(alpha.check({ op: "write", path: h.ins("alpha") }).allowed).toBe(true);
    expect(alpha.check({ op: "write", path: h.ins("scout") }).allowed).toBe(true);
    expect(alpha.check({ op: "write", path: h.ins("luna") }).allowed).toBe(false);
    // The made bot doesn't write its maker's.
    expect(h.as("scout").check({ op: "write", path: h.ins("alpha") }).allowed).toBe(false);
    expect(h.as("scout").check({ op: "write", path: h.ins("scout") }).allowed).toBe(true);
    // A pack bot's id with `/`, its folder written `--`: its maker reaches it, itself too.
    expect(h.as("luna").check({ op: "write", path: h.ins("pack--nova") }).allowed).toBe(true);
    expect(h.as("pack/nova").check({ op: "write", path: h.ins("pack--nova") }).allowed).toBe(true);
    expect(h.as("pack/nova").check({ op: "write", path: h.ins("luna") }).allowed).toBe(false);
    // Its side threads as its conversation.
    expect(h.as("alpha", "side-thread").check({ op: "write", path: h.ins("scout") }).allowed).toBe(true);
    // A coding session and an agent (the bot's own included) reach no instructions.
    expect(h.fence.forCaller(coding).check({ op: "write", path: h.ins("alpha") }).allowed).toBe(false);
    expect(h.fence.forCaller(agent).check({ op: "write", path: h.ins("alpha") }).allowed).toBe(false);
    expect(instructionsReach(h.moss, "alpha").sort()).toEqual(["alpha", "scout"]);
  });

  test("no bot writes any bot.json, its own included, nor the instructions folder itself", () => {
    const h = home();
    const alpha = h.as("alpha");
    for (const seg of ["alpha", "scout", "luna"]) {
      expect(alpha.check({ op: "write", path: join(h.moss, "bots", seg, "bot.json") }).allowed).toBe(false);
      expect(alpha.check({ op: "delete", path: join(h.moss, "bots", seg, "bot.json") }).allowed).toBe(false);
    }
    expect(alpha.check({ op: "move", path: h.ins("alpha"), to: join(h.moss, "bots", "alpha", "bot.json") }).allowed).toBe(false);
    const folder = join(h.moss, "bots", "alpha", "instructions");
    expect(alpha.check({ op: "delete", path: folder }).allowed).toBe(false);
    expect(alpha.check({ op: "move", path: folder, to: join(h.moss, "scratch", "alpha", "x") }).allowed).toBe(false);
    expect(alpha.check({ op: "write", path: folder }).allowed).toBe(false);
    // `..` out of the folder lands on the record: judged where it lands.
    expect(alpha.check({ op: "write", path: join(folder, "..", "bot.json") }).allowed).toBe(false);
    // The policy agrees (its reference, `policyAllows`).
    const p = alpha.policy();
    expect(p.ownInstructions?.sort()).toEqual([join(h.moss, "bots", "alpha", "instructions"), join(h.moss, "bots", "scout", "instructions")].sort());
    expect(policyAllows(p, "write", h.ins("alpha"))).toBe(true);
    expect(policyAllows(p, "write", join(h.moss, "bots", "alpha", "bot.json"))).toBe(false);
    expect(policyAllows(p, "rename", folder)).toBe(false);
    expect(policyAllows(p, "unlink", folder)).toBe(false);
    expect(policyAllows(p, "write", h.ins("luna"))).toBe(false);
  });

  test("the runtime's sandbox keeps the bot's own and made bots' instructions folders, never a record or another's folder", () => {
    const h = home();
    const s = sandboxSettingsOf(h.as("alpha").policy(), h.moss).filesystem!;
    const ins = (seg: string) => join(h.moss, "bots", seg, "instructions");
    expect(s.allowWrite).toContain(ins("alpha"));
    expect(s.allowWrite).toContain(ins("scout"));
    expect(s.allowWrite).not.toContain(ins("luna"));
    // The record of each bot stays denied by name, and the kept folder's own entry is pinned.
    expect(s.denyWrite).toContain(join(h.moss, "bots", "alpha", "bot.json"));
    expect(s.denyWrite).toContain(join(h.moss, "bots", "scout", "bot.json"));
    expect(s.denyWrite).toContain(ins("luna"));
    expect(s.denyWrite).toContain(join(ins("alpha"), ".moss-kept-folder"));
    expect(s.denyWrite).not.toContain(ins("alpha"));
    // A coding session's sandbox keeps none.
    expect(h.fence.forCaller(coding).policy().ownInstructions).toBeUndefined();
  });

  test("the maker is read from the records when the check runs: a bot made later counts at once; a record no one wrote counts for nothing", () => {
    const h = home();
    const alpha = h.as("alpha");
    expect(alpha.check({ op: "write", path: h.ins("echo") }).allowed).toBe(false);
    h.bot("echo", { kind: "bot", id: "alpha" });
    expect(alpha.check({ op: "write", path: h.ins("echo") }).allowed).toBe(true);
    // A malformed record names no maker.
    writeFileSync(join(h.moss, "bots", "echo", "bot.json"), "{ not json");
    expect(alpha.check({ op: "write", path: h.ins("echo") }).allowed).toBe(false);
    // A record in the wrong folder (its id another folder's) names no maker either.
    writeFileSync(join(h.moss, "bots", "echo", "bot.json"), JSON.stringify({ record: 1, id: "luna", name: "x", madeBy: { kind: "bot", id: "alpha" }, createdAt: 1 }));
    expect(alpha.check({ op: "write", path: h.ins("echo") }).allowed).toBe(false);
  });

  test("no bot writes a record or an instructions file by a second name, its own included; its own linked notes stay writable", async () => {
    const { linkSync } = await import("node:fs");
    const h = home();
    const mine = h.ins("alpha");
    expect(h.as("alpha").check({ op: "write", path: mine }).allowed).toBe(true);
    linkSync(join(h.moss, "bots", "luna", "bot.json"), join(h.moss, "bots", "alpha", "instructions", "x.json"));
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "alpha", "instructions", "x.json") }).allowed).toBe(false);
    linkSync(mine, join(h.moss, "bots", "alpha", "memory", "copy.md"));
    expect(h.as("alpha").check({ op: "write", path: mine }).allowed).toBe(false);
    // A memory note that is really an instructions file (or a record) by another name: refused too.
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "alpha", "memory", "copy.md") }).allowed).toBe(false);
    linkSync(join(h.moss, "bots", "scout", "bot.json"), join(h.moss, "bots", "alpha", "memory", "scout.json"));
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "alpha", "memory", "scout.json") }).allowed).toBe(false);
    // Its own notes linked to each other: this rule doesn't judge them (it names the guarded file it refuses). The
    // fence's older hard-link rule still refuses a note with a second name, as the memory item's (`#hardLinked`).
    writeFileSync(join(h.moss, "bots", "alpha", "memory", "a.md"), "a");
    linkSync(join(h.moss, "bots", "alpha", "memory", "a.md"), join(h.moss, "bots", "alpha", "memory", "b.md"));
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "alpha", "memory", "a.md") })).toMatchObject({ allowed: false, reason: "bot-memory", path: join(h.moss, "bots", "alpha", "memory") });
    // A second name for a record in its own instructions folder is this rule's, by the record's inode.
    linkSync(join(h.moss, "bots", "luna", "bot.json"), join(h.moss, "bots", "alpha", "instructions", "luna.json"));
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "alpha", "instructions", "luna.json") })).toMatchObject({ allowed: false, path: join(h.moss, "bots", "alpha", "instructions", "luna.json") });
    // A new file has no second name.
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "alpha", "memory", "new.md") }).allowed).toBe(true);
  });

  test("an instructions folder that is a link is no one's to write; case variants are the same folder, never another's", () => {
    const h = home();
    // scout's instructions folder swapped for a link to luna's: alpha's reach drops scout, and the write lands on luna's
    // folder by its real path, which alpha doesn't reach.
    const scout = join(h.moss, "bots", "scout", "instructions");
    renameSync(scout, `${scout}-old`);
    symlinkSync(join(h.moss, "bots", "luna", "instructions"), scout);
    expect(instructionsReach(h.moss, "alpha")).toEqual(["alpha"]);
    expect(h.as("alpha").check({ op: "write", path: join(scout, "instructions.md") }).allowed).toBe(false);
    // Case: the fence folds names on every OS, so `ALPHA/Instructions` is alpha's own, and `LUNA/instructions` still luna's.
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "ALPHA", "Instructions", "instructions.md") }).allowed).toBe(true);
    expect(h.as("alpha").check({ op: "write", path: join(h.moss, "bots", "LUNA", "instructions", "instructions.md") }).allowed).toBe(false);
  });
});
