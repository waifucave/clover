// Bots read each other's memories and transcripts; writes stay their own (the owner's ruling of November 9). The fence
// decides a bot's read (lane C's `homeAllows`): the tree adds no deny of its own that would still block it, and keeps
// its own refusal of a change to another bot's memory whatever the fence says.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { fenceContextFor, type FenceOp } from "../../src/contracts/fence";
import { LocalHolder } from "../../src/tree/holder";
import { hostOs } from "../../src/tree/names";
import { Cluster } from "./cluster-support";

const ALPHA = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const LUNA = { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" } as const;
const LUNA_SIDE = { kind: "session", sessionId: "s_luna2", sessionKind: "side-thread", bot: "luna" } as const;
const CODING = { kind: "session", sessionId: "s_code", sessionKind: "coding" } as const;
const AGENT = { kind: "session", sessionId: "s_agent", sessionKind: "agent", bot: "alpha" } as const;
const PLUGIN = { kind: "plugin", pluginId: "clover/fish-audio" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";

describe("the tree adds no deny of its own to a bot's read of another bot's memory or transcript", () => {
  /** A holder over a fence that allows everything, as C's `homeAllows` allows a bot's read: what's refused is the tree's. */
  function holder() {
    const cloverHome = realpathSync(mkdtempSync(join(tmpdir(), "lane-j-bot-reads-")));
    const home = join(cloverHome, "..", `${cloverHome.split(/[\\/]/).pop()}-home`);
    mkdirSync(home, { recursive: true });
    mkdirSync(join(cloverHome, "bots", "alpha", "memory"), { recursive: true });
    writeFileSync(join(cloverHome, "bots", "alpha", "memory", "MEMORY.md"), "alpha's");
    mkdirSync(join(cloverHome, "sessions", "s_alpha"), { recursive: true });
    writeFileSync(join(cloverHome, "sessions", "s_alpha", "transcript.jsonl"), "{\"said\":\"hi\"}\n");
    const allowAll = { check: () => ({ allowed: true as const }), fencedSet: () => [] };
    const h = new LocalHolder({
      clock: { now: () => Date.now() }, name: () => "Studio", home, os: hostOs(), cloverHome, botsRoot: join(cloverHome, "bots"),
      runsBot: (b) => b === "alpha" || b === "luna", fence: allowAll,
    });
    return { h, cloverHome };
  }

  test("another bot reads it, by the bot's folder and by the Clover home's path; it can't change it", async () => {
    const { h, cloverHome } = holder();
    for (const as of [LUNA, LUNA_SIDE]) {
      expect(await h.read("bots/alpha/memory/MEMORY.md", { as })).toEqual(utf8("alpha's"));
      expect(await h.read("home/Studio/.clover/bots/alpha/memory/MEMORY.md", { as })).toEqual(utf8("alpha's"));
      expect((await h.list("bots/alpha/memory", { as })).map((s) => s.path)).toEqual(["bots/alpha/memory/MEMORY.md"]);
      expect(await h.stat("bots/alpha/memory/MEMORY.md", { as })).toMatchObject({ type: "file" });
      // Its transcripts, the same.
      expect(await h.read("home/Studio/.clover/sessions/s_alpha/transcript.jsonl", { as })).toEqual(utf8("{\"said\":\"hi\"}\n"));
      // Writes stay alpha's own, whatever the fence says.
      expect(await code(h.write("bots/alpha/memory/MEMORY.md", utf8("luna was here"), { as }))).toBe("fenced");
      expect(await code(h.write("bots/alpha/memory/new.md", utf8("x"), { as }))).toBe("fenced");
      expect(await code(h.remove("bots/alpha/memory/MEMORY.md", { as }))).toBe("fenced");
      expect(await code(h.move("bots/alpha/memory/MEMORY.md", "bots/alpha/memory/gone.md", { as }))).toBe("fenced");
      expect(await code(h.write("home/Studio/.clover/bots/alpha/memory/MEMORY.md", utf8("x"), { as }))).toBe("fenced");
    }
    expect(readFileSync(join(cloverHome, "bots", "alpha", "memory", "MEMORY.md"), "utf8")).toBe("alpha's");
    expect(existsSync(join(cloverHome, "bots", "alpha", "memory", "new.md"))).toBe(false);
    // Alpha itself still changes its own.
    await h.write("bots/alpha/memory/MEMORY.md", utf8("alpha again"), { as: ALPHA });
    expect(readFileSync(join(cloverHome, "bots", "alpha", "memory", "MEMORY.md"), "utf8")).toBe("alpha again");
  });

  test("callers that aren't bots still don't read a bot's memory", async () => {
    const { h } = holder();
    for (const as of [CODING, AGENT, PLUGIN] as Caller[]) {
      expect(await code(h.read("bots/alpha/memory/MEMORY.md", { as }))).toBe("fenced");
      expect(await code(h.read("home/Studio/.clover/bots/alpha/memory/MEMORY.md", { as }))).toBe("fenced");
    }
  });
});

describe("through the tree, a bot's read of another bot's memory follows the fence", () => {
  let cluster: Cluster | undefined;
  afterEach(() => cluster?.close());

  test("each read gives exactly the fence's verdict for that bot; a write is refused whatever it says", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    studio.bots.push("alpha", "luna");
    await studio.node.registry.setLevel("Studio", "automatic", { via: "terminal" });
    const t = studio.node.tree;
    await t.write("home/memory/MEMORY.md", utf8("alpha's"), { as: ALPHA });
    const real = realpathSync(join(studio.cloverHome, "bots", "alpha", "memory", "MEMORY.md"));
    const op: FenceOp = { op: "read", path: real };
    const verdict = studio.fence.check(op, fenceContextFor(LUNA)).allowed ? "ok" : "fenced";
    for (const path of ["bots/alpha/memory/MEMORY.md", "home/Studio/.clover/bots/alpha/memory/MEMORY.md"]) {
      expect(await code(t.read(path, { as: LUNA }))).toBe(verdict);
      if (verdict === "ok") expect(await t.read(path, { as: LUNA })).toEqual(utf8("alpha's"));
      expect(await code(t.write(path, utf8("luna was here"), { as: LUNA }))).toBe("fenced");
    }
    expect(readFileSync(real, "utf8")).toBe("alpha's");
  });
});
