// The user's `routine.edit` (spec §7, the file stays the truth): who may call it, and that it rewrites only that
// routine's own file under the Routine tool's rules, on a fake clock in temp homes.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_ERR, MOSS_ROLES, SESSIONS_METHODS, type Caller, type Level, type RoutineRunView } from "@waifucave/moss-protocol";
import type { ApprovalDecision, ApprovalRequest } from "../../contracts/approval-broker";
import { gateMossRequest } from "../../auth/moss-caller";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import type { SideThreadRun } from "../../bots/service";
import { RoutineEngine, routineFilePath } from "../engine";
import { parseRoutine } from "../file";
import { routineMethods } from "../rpc";

const M = SESSIONS_METHODS;
const homes: string[] = [];
function tempHome(): string {
  const h = mkdtempSync(join(tmpdir(), "moss-d-routine-edit-"));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function fakeBots(installed = new Set(["alpha", "luna"])) {
  const runs: SideThreadRun[] = [];
  let n = 0;
  return {
    runs,
    bots: {
      has: (id: string) => installed.has(id),
      runSideThread: async (_bot: string, run: SideThreadRun): Promise<RoutineRunView> => {
        runs.push(run);
        const session = `s_side_${++n}`;
        run.onSession?.(session);
        return { routine: run.routine, session, startedAt: 1, endedAt: 2, outcome: "done", summary: "Done." };
      },
    },
  };
}

function engineOn(home: string, clock: FakeClock, opts: { level?: Level; approvals?: { request(req: ApprovalRequest): Promise<ApprovalDecision> }; secrets?: MemorySecretStore } = {}) {
  const bots = fakeBots();
  const engine = new RoutineEngine({
    home, computer: "Studio", clock, bots: bots.bots, computerLevel: () => opts.level ?? "ask-risky", watchFiles: false,
    userTimeZone: () => "UTC",
    ...(opts.approvals ? { approvals: opts.approvals } : {}), ...(opts.secrets ? { secrets: opts.secrets } : {}),
  });
  return { engine, bots };
}

function write(home: string, name: string, frontmatter: string, body = "Do the thing.", bot = "alpha"): string {
  const path = routineFilePath(home, bot, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}\n`);
  return path;
}

const theWindow: Caller = { kind: "user", client: "app" };
const code = (e: unknown) => (e as { code?: unknown }).code;

describe("routine.edit: who may call it", () => {
  test("the protocol lets only the app role call it, as the user, with no change card that would let a layer through", () => {
    expect(M.routineEdit.roles).toEqual(["app"]);
    expect(M.routineEdit.userOnly).toBe(true);
    expect((M.routineEdit as { change?: unknown }).change).toBeUndefined();
    // Every other role is refused by its allow list: a plugin's layer or host, a bot's or tool's CLI, a phone, the web, a peer.
    for (const role of MOSS_ROLES.filter((r) => r !== "app")) {
      const caller: Caller = role === "peer" ? { kind: "peer", device: "dev_peer", asKind: "user" } as Caller
        : role === "layer" || role === "plugin-host" ? { kind: "plugin", pluginId: "pack/sidebar" } as Caller
        : role === "cli" ? { kind: "session", sessionId: "s_bot", sessionKind: "bot", bot: "alpha" } as Caller
        : { kind: "user", client: role === "remote" ? "ios" : role === "web" ? "web" : "cli" } as Caller;
      expect(gateMossRequest(role, caller, M.routineEdit.name)).toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    }
    // The user's own terminal is not a window either.
    expect(gateMossRequest("cli", { kind: "user", client: "cli" }, M.routineEdit.name)).toMatchObject({ code: MOSS_ERR.ROLE_REFUSED });
    // On the app role, anyone but the user is refused (a bot's session, a plugin, the core).
    expect(gateMossRequest("app", { kind: "session", sessionId: "s_bot", sessionKind: "bot", bot: "alpha" }, M.routineEdit.name)).toMatchObject({ code: MOSS_ERR.NOT_THE_USER });
    expect(gateMossRequest("app", { kind: "plugin", pluginId: "pack/sidebar" } as Caller, M.routineEdit.name)).toMatchObject({ code: MOSS_ERR.NOT_THE_USER });
    expect(gateMossRequest("app", { kind: "core" }, M.routineEdit.name)).toMatchObject({ code: MOSS_ERR.NOT_THE_USER });
    expect(gateMossRequest("app", theWindow, M.routineEdit.name)).toBeNull();
  });

  test("the handler refuses everyone but the user's window, and the file is untouched", async () => {
    const home = tempHome();
    const path = write(home, "brief", "id: r_brief001\nname: Brief\ntriggers:\n  - schedule: every 1h");
    const { engine } = engineOn(home, new FakeClock());
    await engine.start();
    const methods = routineMethods({ routines: engine });
    const before = readFileSync(path, "utf8");
    const callers: Caller[] = [
      { kind: "plugin", pluginId: "pack/sidebar" } as Caller,
      { kind: "session", sessionId: "s_bot", sessionKind: "bot", bot: "alpha" } as Caller,
      { kind: "peer", device: "dev_peer", asKind: "user" } as Caller,
      { kind: "core" },
      { kind: "user", client: "cli" },
      { kind: "user", client: "ios" },
      { kind: "user", client: "web" },
    ];
    for (const caller of callers) {
      const err = await methods[M.routineEdit.name]!({ bot: "alpha", id: "r_brief001", patch: { paused: true } }, { caller }).catch((e: unknown) => e);
      expect(code(err)).toBe(MOSS_ERR.NOT_THE_USER);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    const ok = (await methods[M.routineEdit.name]!({ bot: "alpha", id: "r_brief001", patch: { paused: true } }, { caller: theWindow })) as { routine: { state: string } };
    expect(ok.routine.state).toBe("paused");
    engine.stop();
  });

  test("the plugin API has no routine.edit: plugins see routines read-only", () => {
    const catalog = readFileSync(join(import.meta.dir, "../../../../plugin-sdk/generated/catalog.json"), "utf8");
    expect(catalog.includes("routine.edit") || catalog.includes("routines.edit")).toBe(false);
  });
});

describe("routine.edit: the file", () => {
  test("name, schedule and instructions are written to its own file, renamed in the bot's folder, the id and the other triggers kept", async () => {
    const home = tempHome();
    const clock = new FakeClock({ start: Date.parse("2026-11-06T07:00:00Z") });
    const path = write(home, "brief", "id: r_brief001\nname: Brief\nlevel: ask\ntimezone: \"Europe/London\"\nmissed: skip\ntriggers:\n  - schedule: \"0 8 * * *\"\n  - type: slack\n    channel: general");
    const { engine } = engineOn(home, clock);
    await engine.start();
    const view = await engine.edit("r_brief001", "alpha", { name: "Evening digest", schedule: "every 2h", instructions: "Sum up the day." });
    expect(view).toMatchObject({ id: "r_brief001", name: "Evening digest", file: "home/Studio/.moss/routines/alpha/evening-digest.md", level: "ask", state: "active" });
    expect(view.triggers.map((t) => t.summary)).toEqual(["every 2h", JSON.stringify({ channel: "general" })]);
    expect(existsSync(path)).toBe(false);
    const text = readFileSync(routineFilePath(home, "alpha", "evening-digest"), "utf8");
    const parsed = parseRoutine(text, "evening-digest");
    expect(parsed.ok && parsed.routine).toMatchObject({ id: "r_brief001", name: "Evening digest", level: "ask", timezone: "Europe/London", missed: "skip", body: "Sum up the day.\n" });
    expect(readdirSync(join(path, ".."))).toEqual(["evening-digest.md"]);
    engine.stop();
  });

  test("a schedule that doesn't read, or empty instructions, are refused as the tool refuses them; the file is untouched", async () => {
    const home = tempHome();
    const path = write(home, "brief", "id: r_brief001\nname: Brief\ntriggers:\n  - schedule: every 1h");
    const { engine } = engineOn(home, new FakeClock());
    await engine.start();
    const before = readFileSync(path, "utf8");
    for (const patch of [{ schedule: "every fortnight" }, { schedule: "61 * * * *" }, { instructions: "   " }, { name: "  " }]) {
      const err = await engine.edit("r_brief001", "alpha", patch).catch((e: unknown) => e);
      expect(code(err)).toBe("invalid");
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    engine.stop();
  });

  test("a rename can't take another routine's name or file, and can't leave the bot's folder", async () => {
    const home = tempHome();
    write(home, "brief", "id: r_brief001\nname: Brief\ntriggers: []");
    write(home, "digest", "id: r_digest01\nname: Digest\ntriggers: []");
    const { engine } = engineOn(home, new FakeClock());
    await engine.start();
    expect(code(await engine.edit("r_brief001", "alpha", { name: "digest" }).catch((e: unknown) => e))).toBe("conflict");
    // Another name whose file name is the other routine's.
    expect(code(await engine.edit("r_brief001", "alpha", { name: "Digest!" }).catch((e: unknown) => e))).toBe("conflict");
    // Slashes and dots only make a file name inside the folder.
    const view = await engine.edit("r_brief001", "alpha", { name: "../../../settings/x" });
    expect(view.file).toBe("home/Studio/.moss/routines/alpha/settings-x.md");
    expect(readdirSync(join(routineFilePath(home, "alpha", "x"), "..")).sort()).toEqual(["digest.md", "settings-x.md"]);
    expect(readFileSync(routineFilePath(home, "alpha", "digest"), "utf8")).toContain("name: Digest");
    // A case-only change on the same file is no conflict.
    expect((await engine.edit("r_digest01", "alpha", { name: "DIGEST" })).name).toBe("DIGEST");
    engine.stop();
  });

  test("a routine of bot A is not found through bot B's id, and its file is untouched", async () => {
    const home = tempHome();
    const path = write(home, "brief", "id: r_brief001\nname: Brief\ntriggers: []");
    const { engine } = engineOn(home, new FakeClock());
    await engine.start();
    const before = readFileSync(path, "utf8");
    expect(code(await engine.edit("r_brief001", "luna", { paused: true }).catch((e: unknown) => e))).toBe("not_found");
    expect(code(await engine.edit("r_nosuch001", "alpha", { paused: true }).catch((e: unknown) => e))).toBe("not_found");
    expect(readFileSync(path, "utf8")).toBe(before);
    engine.stop();
  });

  test("a file swapped for a link since it was loaded is refused, and the link's target is untouched", async () => {
    const home = tempHome();
    const path = write(home, "brief", "id: r_brief001\nname: Brief\ntriggers: []");
    const { engine } = engineOn(home, new FakeClock());
    await engine.start();
    const target = join(home, "elsewhere.md");
    writeFileSync(target, readFileSync(path, "utf8"));
    unlinkSync(path);
    symlinkSync(target, path);
    expect(code(await engine.edit("r_brief001", "alpha", { instructions: "Leak." }).catch((e: unknown) => e))).toBe("refused");
    expect(readFileSync(target, "utf8")).not.toContain("Leak.");
    engine.stop();
  });

  test("a webhook routine keeps its trigger and its key: the key never goes into the file", async () => {
    const home = tempHome();
    const secrets = new MemorySecretStore();
    write(home, "hook", "id: r_hookhook\nname: Hook\ntriggers:\n  - webhook: true");
    const { engine } = engineOn(home, new FakeClock(), { secrets });
    await engine.start();
    const { key } = await engine.webhook("r_hookhook");
    await engine.edit("r_hookhook", "alpha", { instructions: "Deploy.", schedule: "every 1d" });
    const text = readFileSync(routineFilePath(home, "alpha", "hook"), "utf8");
    expect(text.includes(key)).toBe(false);
    expect(text).toContain("webhook: true");
    expect((await engine.webhook("r_hookhook")).key).toBe(key);
    engine.stop();
  });

  test("a hand edit since the last scan is what gets patched: no stale copy wins, and the last write wins", async () => {
    const home = tempHome();
    const path = write(home, "brief", "id: r_brief001\nname: Brief\ntriggers:\n  - schedule: every 1h");
    const { engine } = engineOn(home, new FakeClock());
    await engine.start();
    // The user (or the bot) edits the file by hand; the engine hasn't scanned it yet.
    writeFileSync(path, readFileSync(path, "utf8").replace("Do the thing.", "Hand-written."));
    const view = await engine.edit("r_brief001", "alpha", { schedule: "every 3h" });
    expect(view.triggers[0]!.summary).toBe("every 3h");
    expect(readFileSync(path, "utf8")).toContain("Hand-written.");
    // And a hand edit after it wins in turn.
    writeFileSync(path, readFileSync(path, "utf8").replace("every 3h", "every 5h"));
    await engine.rescan();
    expect(engine.get("r_brief001")!.triggers[0]!.summary).toBe("every 5h");
    engine.stop();
  });
});

describe("routine.edit: pause and resume", () => {
  test("a paused routine doesn't fire; resumed, it fires again", async () => {
    const home = tempHome();
    const clock = new FakeClock({ start: Date.parse("2026-11-06T07:00:00Z") });
    const path = write(home, "tick", "id: r_tick0001\nname: Tick\ntriggers:\n  - schedule: every 1h");
    const { engine, bots } = engineOn(home, clock);
    await engine.start();
    clock.advance(3_600_000);
    await flush();
    expect(bots.runs).toHaveLength(1);
    expect((await engine.edit("r_tick0001", "alpha", { paused: true })).state).toBe("paused");
    expect(readFileSync(path, "utf8")).toContain("paused: true");
    clock.advance(3 * 3_600_000);
    await flush();
    expect(bots.runs).toHaveLength(1);
    expect(code(await engine.runNow("r_tick0001").catch((e: unknown) => e))).toBe("refused");
    expect((await engine.edit("r_tick0001", "alpha", { paused: false })).state).toBe("active");
    expect(readFileSync(path, "utf8")).not.toContain("paused");
    clock.advance(3_600_000);
    await flush();
    expect(bots.runs.length).toBeGreaterThanOrEqual(2);
    engine.stop();
  });

  test("an edit to an approved raised level waits for a new OK, as a hand edit does", async () => {
    const home = tempHome();
    const asked: ApprovalRequest[] = [];
    let answer: ApprovalDecision = { allowed: true, by: "card", cardId: "card_1" };
    const approvals = { request: async (req: ApprovalRequest) => (asked.push(req), answer) };
    write(home, "deploy", "id: r_deploy01\nname: Deploy\nlevel: automatic\ntriggers: []");
    const { engine } = engineOn(home, new FakeClock(), { approvals });
    await engine.start();
    await flush();
    await flush();
    expect(engine.get("r_deploy01")).toMatchObject({ state: "active", level: "automatic" });
    answer = { allowed: false, by: "card", cardId: "card_2" };
    const view = await engine.edit("r_deploy01", "alpha", { instructions: "Deploy now." });
    await flush();
    expect(view).toMatchObject({ state: "waiting-for-ok", level: "ask-risky" });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ kind: "change", change: "routine-level" });
    engine.stop();
  });
});

describe("routine.edit: a generated sequence of hand writes and edits", () => {
  test("after each step the list is what's on disk, and the id never changes", async () => {
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 8; round++) {
      const home = tempHome();
      write(home, "r", "id: r_seqseq01\nname: Seq\ntriggers:\n  - schedule: every 1h");
      const { engine } = engineOn(home, new FakeClock());
      await engine.start();
      const fileOf = () => {
        const path = engine.get("r_seqseq01")!.file.replace("home/Studio/.moss/routines/", "");
        return join(home, "routines", path);
      };
      for (let step = 0; step < 25; step++) {
        const k = rand(5);
        const n = rand(50);
        if (k === 0) await engine.edit("r_seqseq01", "alpha", { name: `Seq ${n}` });
        else if (k === 1) await engine.edit("r_seqseq01", "alpha", { schedule: `every ${n + 1}m` });
        else if (k === 2) await engine.edit("r_seqseq01", "alpha", { paused: n % 2 === 0, instructions: `Edit ${n}.` });
        else if (k === 3) {
          // A hand write, then a scan, as the watcher would.
          const p = fileOf();
          writeFileSync(p, readFileSync(p, "utf8").replace(/^---\n[\s\S]*?\n---\n[\s\S]*$/, (t) => t.replace(/\n---\n[\s\S]*$/, `\n---\nHand ${n}.\n`)));
          await engine.rescan();
        } else {
          // A hand write the engine hasn't scanned, then an edit on top of it.
          const p = fileOf();
          writeFileSync(p, readFileSync(p, "utf8").replace(/\n---\n[\s\S]*$/, `\n---\nUnscanned ${n}.\n`));
          await engine.edit("r_seqseq01", "alpha", { schedule: `every ${n + 2}h` });
          expect(readFileSync(fileOf(), "utf8")).toContain(`Unscanned ${n}.`);
        }
        const views = engine.list("alpha");
        expect(views.map((v) => v.id)).toEqual(["r_seqseq01"]);
        const disk = parseRoutine(readFileSync(fileOf(), "utf8"), "x");
        expect(disk.ok).toBe(true);
        if (!disk.ok) continue;
        expect(disk.routine.id).toBe("r_seqseq01");
        expect(views[0]!.name).toBe(disk.routine.name);
        expect(views[0]!.state).toBe(disk.routine.paused ? "paused" : "active");
        expect(views[0]!.triggers[0]!.summary).toBe(disk.routine.triggers[0]!.type === "schedule" ? (disk.routine.triggers[0] as { spec: string }).spec : "");
        expect(readdirSync(join(home, "routines", "alpha")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
      }
      engine.stop();
    }
  });
});
