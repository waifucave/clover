// The MOSS home is open to bots through the tree (the owner's ruling of November 9, which supersedes the first one,
// and its amendment): they read everything, and write any bot's memory and scratch and their own routines and outputs;
// secrets, `run/` and writes to permission, trust, settings and plugin files stay blocked. The fence decides all of it
// (lane C's `homeAllows`): the tree adds no deny of its own for a bot.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { fenceContextFor, type FenceOp } from "../../src/contracts/fence";
import { LocalHolder } from "../../src/tree/holder";
import { hostOs } from "../../src/tree/names";
import { Cluster } from "./cluster-support";

const ALPHA = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const LUNA = { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" } as const;
const LUNA_SIDE = { kind: "session", sessionId: "s_luna2", sessionKind: "side-thread", bot: "luna" } as const;
const CODING = { kind: "session", sessionId: "s_code", sessionKind: "coding" } as const;
const AGENT = { kind: "session", sessionId: "s_agent", sessionKind: "agent", bot: "alpha" } as const;
const PLUGIN = { kind: "plugin", pluginId: "moss/fish-audio" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";

describe("the tree adds no deny of its own to what the MOSS home opens to bots", () => {
  /** A holder over a fence that allows everything, as C's `homeAllows` allows these: what's refused is the tree's. */
  function holder() {
    const mossHome = realpathSync(mkdtempSync(join(tmpdir(), "lane-j-bot-reads-")));
    const home = join(mossHome, "..", `${mossHome.split(/[\\/]/).pop()}-home`);
    mkdirSync(home, { recursive: true });
    mkdirSync(join(mossHome, "bots", "alpha", "memory"), { recursive: true });
    writeFileSync(join(mossHome, "bots", "alpha", "memory", "MEMORY.md"), "alpha's");
    mkdirSync(join(mossHome, "sessions", "s_alpha"), { recursive: true });
    writeFileSync(join(mossHome, "sessions", "s_alpha", "transcript.jsonl"), "{\"said\":\"hi\"}\n");
    mkdirSync(join(mossHome, "sessions", "s_code"), { recursive: true });
    writeFileSync(join(mossHome, "sessions", "s_code", "transcript.jsonl"), "{\"said\":\"fix the build\"}\n");
    mkdirSync(join(mossHome, "scratch", "alpha"), { recursive: true });
    writeFileSync(join(mossHome, "scratch", "alpha", "draft.md"), "alpha's draft");
    const allowAll = { check: () => ({ allowed: true as const }), fencedSet: () => [] };
    const h = new LocalHolder({
      clock: { now: () => Date.now() }, name: () => "Studio", home, os: hostOs(), mossHome, botsRoot: join(mossHome, "bots"),
      runsBot: (b) => b === "alpha" || b === "luna", fence: allowAll,
    });
    return { h, mossHome };
  }

  test("another bot reads and writes a bot's memory, by the bot's folder and by the MOSS home's path", async () => {
    const { h, mossHome } = holder();
    for (const as of [LUNA, LUNA_SIDE]) {
      expect(await h.read("bots/alpha/memory/MEMORY.md", { as })).toEqual(utf8("alpha's"));
      expect(await h.read("home/Studio/.moss/bots/alpha/memory/MEMORY.md", { as })).toEqual(utf8("alpha's"));
      expect((await h.list("bots/alpha/memory", { as })).map((s) => s.path)).toEqual(["bots/alpha/memory/MEMORY.md"]);
      expect(await h.stat("bots/alpha/memory/MEMORY.md", { as })).toMatchObject({ type: "file" });
      // Its transcripts, the same.
      expect(await h.read("home/Studio/.moss/sessions/s_alpha/transcript.jsonl", { as })).toEqual(utf8("{\"said\":\"hi\"}\n"));
    }
    // Writes, removes and moves in alpha's memory: the fence's to judge, and this one allows them.
    await h.write("bots/alpha/memory/MEMORY.md", utf8("luna was here"), { as: LUNA });
    expect(readFileSync(join(mossHome, "bots", "alpha", "memory", "MEMORY.md"), "utf8")).toBe("luna was here");
    await h.write("home/Studio/.moss/bots/alpha/memory/new.md", utf8("from luna's side thread"), { as: LUNA_SIDE });
    expect(readFileSync(join(mossHome, "bots", "alpha", "memory", "new.md"), "utf8")).toBe("from luna's side thread");
    await h.move("bots/alpha/memory/new.md", "bots/alpha/memory/moved.md", { as: LUNA });
    await h.remove("bots/alpha/memory/moved.md", { as: LUNA });
    expect(existsSync(join(mossHome, "bots", "alpha", "memory", "moved.md"))).toBe(false);
    // Alpha itself still changes its own.
    await h.write("bots/alpha/memory/MEMORY.md", utf8("alpha again"), { as: ALPHA });
    expect(readFileSync(join(mossHome, "bots", "alpha", "memory", "MEMORY.md"), "utf8")).toBe("alpha again");
  });

  test("a bot reads another bot's scratch and a coding session's transcript, and writes another bot's scratch", async () => {
    const { h, mossHome } = holder();
    for (const as of [LUNA, LUNA_SIDE]) {
      expect(await h.read("home/Studio/.moss/scratch/alpha/draft.md", { as })).toEqual(utf8("alpha's draft"));
      expect((await h.list("home/Studio/.moss/scratch/alpha", { as })).map((s) => s.path)).toContain("home/Studio/.moss/scratch/alpha/draft.md");
      expect(await h.read("home/Studio/.moss/sessions/s_code/transcript.jsonl", { as })).toEqual(utf8("{\"said\":\"fix the build\"}\n"));
      const hits = await h.grep("fix the build", { as, cwd: "home/Studio/.moss/sessions" });
      expect(hits.matches.map((m) => m.path)).toEqual(["home/Studio/.moss/sessions/s_code/transcript.jsonl"]);
    }
    await h.write("home/Studio/.moss/scratch/alpha/from-luna.md", utf8("luna's note"), { as: LUNA });
    expect(readFileSync(join(mossHome, "scratch", "alpha", "from-luna.md"), "utf8")).toBe("luna's note");
    await h.write("home/Studio/.moss/scratch/alpha/draft.md", utf8("edited by luna"), { as: LUNA_SIDE });
    expect(readFileSync(join(mossHome, "scratch", "alpha", "draft.md"), "utf8")).toBe("edited by luna");
  });

  test("callers that aren't bots still don't read or write a bot's memory", async () => {
    const { h } = holder();
    for (const as of [CODING, AGENT, PLUGIN] as Caller[]) {
      expect(await code(h.read("bots/alpha/memory/MEMORY.md", { as }))).toBe("fenced");
      expect(await code(h.read("home/Studio/.moss/bots/alpha/memory/MEMORY.md", { as }))).toBe("fenced");
      expect(await code(h.write("bots/alpha/memory/MEMORY.md", utf8("x"), { as }))).toBe("fenced");
    }
  });
});

describe("through the node's tree, a bot's reach into the MOSS home follows the fence", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("each read and write gives exactly the fence's verdict for that bot", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    studio.bots.push("alpha", "luna");
    await studio.node.registry.setLevel("Studio", "automatic", { via: "terminal" });
    const t = studio.node.tree;
    await t.write("home/memory/MEMORY.md", utf8("alpha's"), { as: ALPHA });
    const real = realpathSync(join(studio.mossHome, "bots", "alpha", "memory", "MEMORY.md"));
    const says = (o: FenceOp) => (studio.fence.check(o, fenceContextFor(LUNA)).allowed ? "ok" : "fenced");
    const reads = says({ op: "read", path: real });
    const writes = says({ op: "write", path: real });
    for (const path of ["bots/alpha/memory/MEMORY.md", "home/Studio/.moss/bots/alpha/memory/MEMORY.md"]) {
      expect(await code(t.read(path, { as: LUNA }))).toBe(reads);
      expect(await code(t.write(path, utf8("luna was here"), { as: LUNA }))).toBe(writes);
    }
    expect(readFileSync(real, "utf8")).toBe(writes === "ok" ? "luna was here" : "alpha's");
    // Another bot's scratch and a coding session's transcript: read, and the scratch written, as the fence says.
    const scratch = join(studio.mossHome, "scratch", "alpha");
    const transcript = join(studio.mossHome, "sessions", "s_code");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(transcript, { recursive: true });
    writeFileSync(join(scratch, "draft.md"), "alpha's draft");
    writeFileSync(join(transcript, "transcript.jsonl"), "{}\n");
    const scratchReal = realpathSync(join(scratch, "draft.md"));
    expect(await code(t.read("home/Studio/.moss/scratch/alpha/draft.md", { as: LUNA }))).toBe(says({ op: "read", path: scratchReal }));
    expect(await code(t.read("home/Studio/.moss/sessions/s_code/transcript.jsonl", { as: LUNA })))
      .toBe(says({ op: "read", path: realpathSync(join(transcript, "transcript.jsonl")) }));
    expect(await code(t.write("home/Studio/.moss/scratch/alpha/draft.md", utf8("luna's"), { as: LUNA }))).toBe(says({ op: "write", path: scratchReal }));
  });
});
