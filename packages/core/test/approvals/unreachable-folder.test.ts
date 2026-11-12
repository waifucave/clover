// A bot's Write to a folder this computer's privacy settings keep Clover out of (the owner's try 14: Alpha's Write of a new
// file on his Desktop came back "Error: protected host path access refused", twice, with no card). The runtime's file
// tools resolve each path before they act and fail closed when a folder on the way can't be looked into (agent SDK
// `hostCodePathAllowed`: a resolution error other than "not there" refuses, whenever the session has deny lists, as every
// bot's has since stage 2). macOS answers EPERM there for a Desktop, Documents or Downloads folder Clover hasn't been let
// into; a folder without search permission answers EACCES, which this test uses. Clover now refuses such a call up front,
// with no card, telling the bot to ask the user to allow it or to save elsewhere. Every other ordinary folder goes on.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import { botApprovalCheck, unreachableFolder } from "../../src/approvals/bot-check";
import type { BotSessionContext } from "../../src/bots/service";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) {
    for (const l of ["Desktop", "Library/Mail"]) { try { chmodSync(join(d, l), 0o700); } catch { /* not locked */ } }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A user's home shaped like a real one, its Clover home inside, and Alpha's check at a level (`home`: the check knows
 *  the user's home, and so their secret places, as the daemon's does). */
function world(level: Level | undefined, o: { home?: boolean } = {}) {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "unreachable-home-")));
  temps.push(user);
  for (const d of ["Desktop", "Downloads", "Documents", "Library/Application Support", "Library/Mail", ".config", ".ssh"]) mkdirSync(join(user, d), { recursive: true });
  writeFileSync(join(user, "Downloads", "story.md"), "once");
  writeFileSync(join(user, "Documents", "notes.md"), "once");
  const clover = join(user, ".clover");
  const scratch = join(clover, "scratch", "alpha");
  mkdirSync(scratch, { recursive: true });
  const ctx = {
    botId: "alpha", sessionId: "s1", computer: "Studio", level, paths: { scratch, root: join(clover, "bots", "alpha") },
    caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" },
  } as unknown as BotSessionContext;
  const asked: string[] = [];
  const broker = { request: async (req: { paths?: string[] }) => { asked.push(...(req.paths ?? [])); return { allowed: true, by: "level" }; } };
  const check = botApprovalCheck(broker as never, { localComputer: "Studio", ...(o.home ? { home: user } : {}) })(ctx, () => "user");
  const call = (tool: string, input: Record<string, unknown>) => check(tool, input, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" } as never);
  return { user, call, asked };
}

describe("a file tool's path in a folder Clover is kept out of", () => {
  test("the folder is found on the way to a new file and to an existing one; a missing file or folder is no such folder", () => {
    const { user } = world(undefined);
    chmodSync(join(user, "Desktop"), 0o000);
    try {
      expect(unreachableFolder(join(user, "Desktop", "hello_world.md"))).toBe(join(user, "Desktop"));
      expect(unreachableFolder(join(user, "Desktop", "deeper", "x.md"))).toBe(join(user, "Desktop"));
      expect(unreachableFolder(join(user, "Downloads", "story.md"))).toBeUndefined();
      expect(unreachableFolder(join(user, "Downloads", "new", "deeper", "x.md"))).toBeUndefined();
    } finally {
      chmodSync(join(user, "Desktop"), 0o700);
    }
    // macOS's privacy refusal is EPERM, on the file inside the folder.
    const tcc = (p: string) => { if (p.startsWith(join(user, "Desktop") + "/")) throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" }); };
    expect(unreachableFolder(join(user, "Desktop", "hello_world.md"), tcc)).toBe(join(user, "Desktop"));
    expect(unreachableFolder(join(user, "Documents", "notes.md"), tcc)).toBeUndefined();
  });

  test("Alpha's Write of a new file on a Desktop she can't look into, at the default level: refused up front, no card, with what to do next", async () => {
    const { user, call, asked } = world(undefined);
    chmodSync(join(user, "Desktop"), 0o000);
    try {
      for (const input of [{ file_path: join(user, "Desktop", "hello_world.md"), content: "hi" }]) {
        const r = await call("Write", input) as { behavior: string; message?: string };
        expect(r.behavior).toBe("deny");
        expect(r.message).toContain(`doesn't let Clover into ${join(user, "Desktop")}`);
        expect(r.message).toContain("Ask the user to allow Clover there");
        expect(r.message).not.toContain("protected host path");
      }
      const read = await call("Read", { file_path: join(user, "Desktop", "old.md") }) as { behavior: string };
      expect(read.behavior).toBe("deny");
      expect(asked).toEqual([]);
    } finally {
      chmodSync(join(user, "Desktop"), 0o700);
    }
  });

  test("a secret place Clover can't look into is refused as a secret place, never as a folder to ask the user to let Clover into", async () => {
    const { user, call, asked } = world(undefined, { home: true });
    chmodSync(join(user, "Library", "Mail"), 0o000);
    try {
      for (const [tool, input] of [
        ["Read", { file_path: join(user, "Library", "Mail", "V10", "inbox.mbox") }],
        ["Write", { file_path: join(user, "Library", "Mail", "note.md"), content: "hi" }],
      ] as const) {
        const r = await call(tool, input as Record<string, unknown>) as { behavior: string; message?: string };
        expect([tool, r.behavior]).toEqual([tool, "deny"]);
        expect([tool, r.message ?? ""]).toEqual([tool, expect.not.stringContaining("Ask the user to allow Clover there")]);
        expect([tool, r.message ?? ""]).toEqual([tool, expect.stringContaining("mail and messages")]);
      }
      expect(asked).toEqual([]);
    } finally {
      chmodSync(join(user, "Library", "Mail"), 0o700);
    }
  });

  test("every folder Clover may look into goes on as before: Downloads and Documents, a new file and an existing one", async () => {
    const { user, call } = world(undefined);
    for (const [tool, input] of [
      ["Write", { file_path: join(user, "Downloads", "new.md"), content: "hi" }],
      ["Edit", { file_path: join(user, "Downloads", "story.md"), old_string: "once", new_string: "twice" }],
      ["Write", { file_path: join(user, "Documents", "new.md"), content: "hi" }],
      ["Edit", { file_path: join(user, "Documents", "notes.md"), old_string: "once", new_string: "twice" }],
      ["Write", { file_path: join(user, "Desktop", "hello_world.md"), content: "hi" }],
    ] as const) {
      const r = await call(tool, input as Record<string, unknown>) as { behavior: string; message?: string };
      expect([tool, r.message ?? ""]).toEqual([tool, expect.not.stringContaining("doesn't let Clover into")]);
    }
  });
});
