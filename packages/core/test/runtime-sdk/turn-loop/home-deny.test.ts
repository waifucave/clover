// The Clover home's read denial for a runner's Bash (`homeDenyReadExcept`): everything in the home but the runner's own
// folders, as a literal list, plus the names that matter whether or not they exist yet.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botPaths } from "../../../src/bots/paths";
import { botHomeSandbox, botOwnFolders } from "../../../src/runtime-sdk/turn-loop/driver";
import { homeDenyReadExcept, homeNamedDenials } from "../../../src/runtime-sdk/turn-loop/home-deny";
import type { BotSessionContext } from "../../../src/bots/service";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A home with a bot's folders, another bot's, the sessions' logs and the secrets file. */
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "clover-home-deny-"));
  temps.push(h);
  for (const d of ["bots/pack--luna/memory", "bots/pack--luna/agents", "bots/pack--mira/memory", "scratch/pack--luna", "scratch/pack--mira", "scratch/_/s_1", "sessions", "routines/pack--luna", "outputs/s_9", "run"]) mkdirSync(join(h, d), { recursive: true });
  writeFileSync(join(h, "sessions", "b_luna.jsonl"), "{}\n");
  writeFileSync(join(h, "secrets.enc"), "x");
  writeFileSync(join(h, "settings.json"), "{}");
  return h;
}

/** Whether `p` is denied by the list (it, or a folder above it, is on it). */
const denied = (list: readonly string[], p: string) => list.some((d) => p === d || p.startsWith(`${d}/`));

describe("homeDenyReadExcept", () => {
  test("denies every entry of the home but the kept folders and the way to them", () => {
    const h = home();
    const list = homeDenyReadExcept(h, [join(h, "bots/pack--luna"), join(h, "scratch/pack--luna")]);
    for (const p of ["sessions", "sessions/b_luna.jsonl", "secrets.enc", "settings.json", "run", "outputs", "routines", "bots/pack--mira", "bots/pack--mira/memory", "scratch/pack--mira", "scratch/_"]) {
      expect(denied(list, join(h, p))).toBe(true);
    }
    for (const p of ["bots/pack--luna", "bots/pack--luna/memory", "bots/pack--luna/agents", "scratch/pack--luna", "scratch/pack--luna/x.txt"]) {
      expect(denied(list, join(h, p))).toBe(false);
    }
    // The way in is walked, never denied whole.
    expect(list).not.toContain(join(h, "bots"));
    expect(list).not.toContain(join(h, "scratch"));
    expect(list).not.toContain(h);
  });

  test("names that matter are denied before they exist (a snapshot can't see them)", () => {
    const h = mkdtempSync(join(tmpdir(), "clover-home-deny-empty-"));
    temps.push(h);
    const list = homeDenyReadExcept(h, [join(h, "scratch/pack--luna")]);
    for (const p of ["sessions", "sessions-runtime", "secrets.enc", "secrets.key", "secrets.key.cred", "credentials", "run", "plugin-data", "user-layers"]) {
      expect(list).toContain(join(h, p));
    }
    // Every named path is in the home.
    for (const p of homeNamedDenials(h)) expect(p.startsWith(`${h}/`)).toBe(true);
  });

  test("a named path that holds a kept folder, or is in one, is left out", () => {
    const h = home();
    const list = homeDenyReadExcept(h, [join(h, "plugin-data/pack--luna")]);
    expect(list).not.toContain(join(h, "plugin-data"));
  });

  test("a link on the way to a kept folder is denied, not followed", () => {
    const h = home();
    const elsewhere = mkdtempSync(join(tmpdir(), "clover-home-deny-target-"));
    temps.push(elsewhere);
    mkdirSync(join(elsewhere, "pack--luna"));
    symlinkSync(elsewhere, join(h, "linked"));
    const list = homeDenyReadExcept(h, [join(h, "linked/pack--luna")]);
    expect(list).toContain(join(h, "linked"));
  });

  test("a kept folder outside the home is ignored; the home itself kept denies nothing", () => {
    const h = home();
    expect(denied(homeDenyReadExcept(h, ["/somewhere/else"]), join(h, "bots"))).toBe(true);
    expect(homeDenyReadExcept(h, [h])).toEqual([]);
  });
});

describe("a bot's Bash sandbox (botHomeSandbox, what the daemon passes)", () => {
  const ctx = (h: string) => ({
    paths: botPaths(h, "pack/luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "pack/luna" },
  }) as unknown as BotSessionContext;

  test("denies the sessions' logs and the secrets file, and keeps the bot's folder, scratch and routines", () => {
    const h = home();
    expect(botOwnFolders(h, ctx(h))).toEqual([join(h, "bots/pack--luna"), join(h, "scratch/pack--luna"), join(h, "routines/pack--luna")]);
    const list = botHomeSandbox(h)(ctx(h)).filesystem?.denyRead ?? [];
    expect(denied(list, join(h, "sessions/b_luna.jsonl"))).toBe(true);
    expect(denied(list, join(h, "secrets.enc"))).toBe(true);
    expect(denied(list, join(h, "bots/pack--mira/memory"))).toBe(true);
    for (const p of ["bots/pack--luna/memory", "scratch/pack--luna", "routines/pack--luna"]) expect(denied(list, join(h, p))).toBe(false);
  });
});
