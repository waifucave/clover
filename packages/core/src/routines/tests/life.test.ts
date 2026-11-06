// D-M3 on the bot side: the `Routine` tool writes a file the engine runs in a side thread whose result posts into the
// bot's conversation; the routine methods; Winter's routines and memories carried over; sessions' ends reach lane J.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOVER_ERR, SESSIONS_METHODS as M, type Caller } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { MethodError } from "../../bots/rpc";
import { botPaths } from "../../bots/paths";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { routineFilePath } from "../engine";
import { migrateWinter } from "../migrate-winter";

afterEach(() => removeTemps());

const theUser: Caller = { kind: "user", client: "app" };

async function side(opts: { clock?: FakeClock; levelOf?: (c: string) => "ask-risky" | "ask" | "automatic" | undefined } = {}) {
  const clock = opts.clock ?? new FakeClock({ start: Date.parse("2026-11-06T07:59:00Z") });
  const secrets = new MemorySecretStore();
  const b = await boot({
    home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, clock,
    routines: { secrets, userTimeZone: () => "Europe/London", watchFiles: false, computers: () => [{ name: "Studio", level: "ask-risky" }, { name: "Box", level: "ask" }] },
    ...(opts.levelOf === undefined ? {} : { levelOf: opts.levelOf }),
  });
  const routine = () => b.side.tools("b_alpha").find((t) => t.name === "Routine")!;
  return { b, clock, secrets, routine };
}

describe("the Routine tool and the engine on the bot side", () => {
  test("a routine the bot writes runs on its schedule in a side thread, and its result posts into the conversation", async () => {
    const { b, clock, routine } = await side();
    const r = await routine().run({ name: "Morning brief", instructions: "Summarize the overnight issues.", schedule: "0 8 * * *" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Created the routine r_[a-z0-9]+ in home\/Studio\/\.clover\/routines\/alpha\/morning-brief\.md, run by Studio\./);
    const file = routineFilePath(b.home, "alpha", "morning-brief");
    expect(readFileSync(file, "utf8")).toContain("schedule: \"0 8 * * *\"");
    const [view] = b.side.routines!.list("alpha");
    expect(view).toMatchObject({ name: "Morning brief", state: "active", nextRunAt: Date.parse("2026-11-06T08:00:00Z") });
    clock.advance(60_000);
    await flush();
    const thread = b.host.list({ kind: "side-thread" })[0]!;
    expect(thread).toMatchObject({ bot: "alpha", routine: view!.id, title: "Morning brief" });
    const ctx = b.drivers.made.find((m) => m.ctx.sessionId === thread.id)!.ctx;
    expect(ctx.level).toBe("ask-risky");
    expect(ctx.mayWriteMemory()).toBe(true);
    b.drivers.for(thread.id).end({ text: "Two new issues, nothing urgent." });
    await flush();
    const posted = b.host.history("b_alpha").filter((r) => r.type === "input" && r.input.from === "routine");
    expect(posted.map((r) => (r.type === "input" && r.input.from === "routine" ? r.input.text : ""))).toEqual(["Two new issues, nothing urgent."]);
    expect(b.side.routines!.runs(view!.id).runs[0]).toMatchObject({ outcome: "done", summary: "Two new issues, nothing urgent." });
    await b.shutdown();
  });

  test("a webhook routine hands back its URL, never its key; a raised level says it waits for the user's OK", async () => {
    const { b, secrets, routine } = await side();
    const r = await routine().run({ name: "Deploys", instructions: "Check the deploy.", webhook: true, level: "automatic" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Its webhook URL is https://hooks.waifucave.com/r_");
    expect(r.text).toContain("waits for the user's OK");
    const [meta] = await secrets.list({ kind: "core" });
    const key = (await secrets.get(meta!.ref))!.value.reveal();
    expect(r.text).not.toContain(key);
    expect(b.side.routines!.list()[0]!.state).toBe("waiting-for-ok");
    await b.shutdown();
  });

  test("refused: no trigger, a bad schedule or zone, an unknown computer, a name taken; another computer needs the tree", async () => {
    const { b, routine } = await side();
    expect((await routine().run({ name: "x", instructions: "y" })).text).toContain("needs a trigger");
    expect((await routine().run({ name: "x", instructions: "y", schedule: "every week" })).text).toContain("doesn't read");
    expect((await routine().run({ name: "x", instructions: "y", schedule: "every 1h", timezone: "Mars/Olympus" })).text).toContain("isn't a time zone");
    expect((await routine().run({ name: "x", instructions: "y", schedule: "every 1h", computer: "Nowhere" })).text).toContain("no computer Nowhere");
    expect((await routine().run({ name: "Dup", instructions: "y", schedule: "every 1h" })).isError).toBe(false);
    expect((await routine().run({ name: "Dup", instructions: "z", schedule: "every 1h" })).text).toContain("exists already");
    expect((await routine().run({ name: "Remote", instructions: "y", schedule: "every 1h", computer: "Box" })).text).toContain("can't reach Box's files");
    // Agents don't get the tool; bots' sessions do.
    b.host.open({ id: "s_agent", kind: "agent", bot: "alpha", parent: "b_alpha", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    expect(b.side.tools("s_agent").map((t) => t.name)).not.toContain("Routine");
    await b.shutdown();
  });

  test("the routine methods: the list, its runs, and runNow for the user only", async () => {
    const { b, routine } = await side();
    await routine().run({ name: "Tidy", instructions: "Tidy the downloads.", schedule: "every 1d" });
    const methods = b.side.methods({ localDevice: "studio" });
    const { routines } = (await methods[M.routineList.name]!({ bot: "alpha" }, { caller: theUser })) as { routines: { id: string }[] };
    expect(routines).toHaveLength(1);
    const plugin = await methods[M.routineRunNow.name]!({ id: routines[0]!.id }, { caller: { kind: "plugin", pluginId: "clover/sidebar" } }).catch((e: unknown) => e);
    expect(plugin instanceof MethodError && plugin.code).toBe(CLOVER_ERR.NOT_THE_USER);
    const { session } = (await methods[M.routineRunNow.name]!({ id: routines[0]!.id }, { caller: theUser })) as { session: string };
    expect(b.host.get(session)!.kind).toBe("side-thread");
    b.drivers.for(session).end({ text: "Tidied." });
    await flush();
    const runs = (await methods[M.routineRuns.name]!({ id: routines[0]!.id }, { caller: theUser })) as { runs: { outcome: string }[] };
    expect(runs.runs.map((r) => r.outcome)).toEqual(["done"]);
    await b.shutdown();
  });

  test("a session's end reaches lane J's terminals once", async () => {
    const ended: string[] = [];
    const b = await boot({ home: tempDir(), plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, onSessionEnded: (id) => ended.push(id) });
    b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "codex" }, new FakeSessionDriver({ canFold: false }));
    await b.host.stop("s_code");
    await b.host.stop("s_code");
    expect(ended).toEqual(["s_code"]);
    await b.shutdown();
  });
});

describe("Winter's routines and memories, carried over", () => {
  function winterHome(): string {
    const home = tempDir();
    const db = new Database(join(home, "routines.db"));
    db.run(`CREATE TABLE routines (id TEXT PRIMARY KEY, spec TEXT NOT NULL, prompt TEXT NOT NULL, policy TEXT NOT NULL, cwd TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, nextRunAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, lastResult TEXT, deferAttempts INTEGER NOT NULL DEFAULT 0)`);
    const add = db.prepare("INSERT INTO routines (id, spec, prompt, policy, cwd, enabled, nextRunAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, 0, ?)");
    add.run("rt_1", "0 9 * * 1-5", "Check my email\nand summarize it.", "ask", "/Users/someone/work", 1, 1);
    add.run("rt_2", "every 30m", "Watch the build.", "bypass", "/Users/someone/app", 0, 2);
    add.run("rt_3", "not a schedule", "Broken.", "ask", "/", 1, 3);
    db.close();
    const mem = join(home, "sdk", "projects", "_assistant", "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), "- [likes tea](likes-tea.md)\n");
    writeFileSync(join(mem, "likes-tea.md"), "The user likes green tea.\n");
    return home;
  }
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  test("each routine becomes a paused file for review; memories are copied into Alpha's; Winter's files are untouched; once only", async () => {
    const winter = winterHome();
    const before = hash(join(winter, "routines.db"));
    const clover = tempDir();
    const result = migrateWinter({ winterHome: winter, cloverHome: clover });
    expect(result.routines.map((r) => r.winterId)).toEqual(["rt_1", "rt_2"]);
    expect(result.skipped).toMatchObject([{ winterId: "rt_3" }]);
    expect(result.memories).toBe(2);
    const files = readdirSync(join(clover, "routines", "alpha")).sort();
    expect(files).toEqual(["winter-check-my-email.md", "winter-watch-the-build.md"]);
    const first = readFileSync(join(clover, "routines", "alpha", "winter-check-my-email.md"), "utf8");
    expect(first).toContain("paused: true");
    expect(first).toContain("schedule: \"0 9 * * 1-5\"");
    expect(first).toContain("level: ask");
    expect(first).toContain("Carried over from Winter (its routine rt_1). It ran in `/Users/someone/work`.");
    expect(readFileSync(join(clover, "routines", "alpha", "winter-watch-the-build.md"), "utf8")).toContain("which was switched off there");
    expect(readFileSync(join(botPaths(clover, "alpha").memory, "likes-tea.md"), "utf8")).toBe("The user likes green tea.\n");
    expect(hash(join(winter, "routines.db"))).toBe(before);
    // Again: nothing new, nothing written twice, no memory overwritten.
    writeFileSync(join(botPaths(clover, "alpha").memory, "likes-tea.md"), "Edited by Alpha.\n");
    const again = migrateWinter({ winterHome: winter, cloverHome: clover });
    expect(again.routines).toEqual([]);
    expect(readFileSync(join(botPaths(clover, "alpha").memory, "likes-tea.md"), "utf8")).toBe("Edited by Alpha.\n");
    // The engine loads them paused.
    const b = await boot({ home: clover, plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs, routines: { watchFiles: false } });
    expect(b.side.routines!.list().map((v) => v.state)).toEqual(["paused", "paused"]);
    await b.shutdown();
  });

  test("a Winter home with neither routines nor memories carries nothing", () => {
    const result = migrateWinter({ winterHome: tempDir(), cloverHome: tempDir() });
    expect(result).toEqual({ routines: [], skipped: [], memories: 0 });
    expect(existsSync(join(tempDir(), "routines"))).toBe(false);
  });
});
