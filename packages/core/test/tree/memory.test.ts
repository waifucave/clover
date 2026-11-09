// A bot's memory in the tree (the owner's ruling for J-M3): `home/memory/` beside the computers, that bot's
// `<Clover home>/bots/<bot>/memory/` on every computer that runs the core, kept in sync by lane H. Only that bot's own
// sessions reach it, by any path; it never goes over the link; a write lands here even while another computer is off,
// and lane H's sync is told of every change. For anyone else `home/memory` is no folder (not found), and the memory's
// real path is fenced (`bot-memory`, as lane B's fence says it).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHolder } from "../../src/tree/holder";
import { hostOs } from "../../src/tree/names";
import { computerNameProblem } from "../../src/computers/registry";
import { Cluster } from "./cluster-support";

const ALPHA = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const ALPHA_SIDE = { kind: "session", sessionId: "s_alpha2", sessionKind: "side-thread", bot: "alpha" } as const;
const LUNA = { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" } as const;
const CODING = { kind: "session", sessionId: "s_code", sessionKind: "coding" } as const;
const AGENT = { kind: "session", sessionId: "s_agent", sessionKind: "agent", bot: "alpha" } as const;
const PLUGIN = { kind: "plugin", pluginId: "clover/fish-audio" } as const;
const USER = { kind: "user", client: "app" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";

let cluster: Cluster;
afterEach(() => cluster?.close());

async function two() {
  cluster = new Cluster();
  const changed: string[] = [];
  const opts = { memoryChanged: (name: string) => (bot: string, rel: string) => { changed.push(`${name} ${bot} ${rel}`); } };
  const studio = await cluster.add("Studio", opts);
  const laptop = await cluster.add("Laptop1", opts);
  studio.bots.push("alpha", "luna");
  for (const c of [studio, laptop]) await c.node.registry.setLevel(c.name, "automatic", { via: "terminal" });
  await cluster.join();
  return { studio, laptop, changed };
}

describe("home/memory", () => {
  test("a bot's own sessions read and write its memory, on this computer, with their normal tools", async () => {
    const { studio, changed } = await two();
    const t = studio.node.tree;
    await t.write("home/memory/MEMORY.md", utf8("# Alpha\n"), { as: ALPHA });
    expect(readFileSync(join(studio.cloverHome, "bots", "alpha", "memory", "MEMORY.md"), "utf8")).toBe("# Alpha\n");
    expect(await t.read("home/memory/MEMORY.md", { as: ALPHA_SIDE })).toEqual(utf8("# Alpha\n"));
    expect((await t.list("home/memory", { as: ALPHA })).map((s) => s.path)).toEqual(["home/memory/MEMORY.md"]);
    expect(t.computersFor(["home/memory/MEMORY.md"])).toEqual(["Studio"]);
    // The tools: Write, Read and Bash with the memory as the working folder.
    const ctx = { session: "s_alpha", sessionKind: "bot" as const, bot: "alpha", callId: "c1", cwd: "home/memory" };
    expect((await studio.node.tools.run("Write", { file_path: "notes/today.md", content: "tea\n" }, ctx)).isError).toBe(false);
    expect((await studio.node.tools.run("Read", { file_path: "notes/today.md" }, ctx)).output).toBe("     1\ttea");
    const bash = await studio.node.tools.run("Bash", { command: process.platform === "win32" ? "type MEMORY.md" : "cat MEMORY.md" }, { ...ctx, callId: "c2" });
    expect(JSON.stringify(bash.output)).toContain("# Alpha");
    await t.move("home/memory/notes/today.md", "home/memory/notes/yesterday.md", { as: ALPHA });
    await t.remove("home/memory/notes/yesterday.md", { as: ALPHA });
    // Lane H's sync was told of each change, by the path in the memory folder.
    expect(changed).toEqual(expect.arrayContaining([
      "Studio alpha MEMORY.md", "Studio alpha notes/today.md", "Studio alpha notes/yesterday.md",
    ]));
    expect(changed.every((c) => c.startsWith("Studio alpha "))).toBe(true);
  });

  test("only the bots reach it (the owner's ruling of November 9, amended): not coding sessions, agents, plugins or another computer, by any path", async () => {
    const { studio, laptop } = await two();
    const t = studio.node.tree;
    await t.write("home/memory/secret.md", utf8("alpha's"), { as: ALPHA });
    // Another bot's `home/memory` is its own.
    await t.write("home/memory/secret.md", utf8("luna's"), { as: LUNA });
    expect(await t.read("home/memory/secret.md", { as: ALPHA })).toEqual(utf8("alpha's"));
    expect(readFileSync(join(studio.cloverHome, "bots", "luna", "memory", "secret.md"), "utf8")).toBe("luna's");
    // For a coding session, an agent, a plugin or the user, `home/memory` is no folder at all.
    for (const as of [CODING, AGENT, PLUGIN, USER]) {
      expect(await code(t.read("home/memory/secret.md", { as }))).toBe("not_found");
      expect(await code(t.write("home/memory/x.md", utf8("x"), { as }))).toBe("not_found");
    }
    // Another bot reads and writes alpha's memory by alpha's folder, and reads the rest of that folder.
    expect(await t.read("bots/alpha/memory/secret.md", { as: LUNA })).toEqual(utf8("alpha's"));
    await t.write("bots/alpha/memory/note.md", utf8("from luna"), { as: LUNA });
    expect(readFileSync(join(studio.cloverHome, "bots", "alpha", "memory", "note.md"), "utf8")).toBe("from luna");
    expect(await t.list("bots/alpha", { as: LUNA })).toBeDefined();
    // Not by alpha's folder, or the home folder's own path to it, for anyone but the bots.
    for (const as of [CODING, AGENT]) {
      expect(await code(t.read("bots/alpha/memory/secret.md", { as }))).toBe("fenced");
      expect(await code(t.write("bots/alpha/memory/secret.md", utf8("x"), { as }))).toBe("fenced");
      expect(await code(t.read("home/Studio/.clover/bots/alpha/memory/secret.md", { as }))).toBe("fenced");
      // The Clover home is default-deny (#234): another bot's whole folder is out of reach, not just its memory.
      expect(await code(t.list("bots/alpha", { as }))).toBe("fenced");
      expect(await code(t.glob("**/*", { as, cwd: "bots/alpha" }))).toBe("fenced");
      expect(await code(t.grep("alpha", { as, path: "bots/alpha" }))).toBe("fenced");
    }
    expect(await code(t.remove("bots/alpha/memory", { as: LUNA, recursive: true }))).toBe("fenced");
    // The real path is no way around it for any model-driven caller (the user's own coding sessions included): only the
    // user's own surfaces and the core reach it there.
    for (const as of [CODING, AGENT, PLUGIN]) {
      const real = "home/Studio/.clover/bots/alpha/memory";
      expect(await code(t.read(`${real}/secret.md`, { as }))).toBe("fenced");
      expect(await code(t.stat(`${real}/secret.md`, { as }))).toBe("fenced");
      expect(await code(t.list(real, { as }))).toBe("fenced");
      expect(await code(t.write(`${real}/planted.md`, utf8("x"), { as }))).toBe("fenced");
      const ctx = { session: "s_x", sessionKind: "coding" as const, callId: `c-${as.kind}`, cwd: "home/Studio" };
      expect((await studio.node.tools.run("Read", { file_path: ".clover/bots/alpha/memory/secret.md" }, ctx)).isError).toBe(true);
      expect(await t.glob("**/*", { as, cwd: "home/Studio" })).not.toContain(`${real}/secret.md`);
    }
    expect(existsSync(join(studio.cloverHome, "bots", "alpha", "memory", "planted.md"))).toBe(false);
    // The bot itself, from another computer: memory never goes over the link.
    expect(await code(laptop.node.tree.read("bots/alpha/memory/secret.md", { as: ALPHA }))).toBe("fenced");
    // The user on this computer still has their own files.
    expect(await t.read("home/Studio/.clover/bots/alpha/memory/secret.md", { as: USER })).toEqual(utf8("alpha's"));
    expect(readFileSync(join(studio.cloverHome, "bots", "alpha", "memory", "secret.md"), "utf8")).toBe("alpha's");
  });

  test("each computer keeps its own copy: a write lands while the other computer is off, and the sync is told", async () => {
    const { studio, laptop, changed } = await two();
    cluster.net.partition(studio.device);
    expect(laptop.node.registry.get("Studio")!.state).toBe("offline");
    await laptop.node.tree.write("home/memory/MEMORY.md", utf8("# From Laptop1\n"), { as: ALPHA });
    expect(readFileSync(join(laptop.cloverHome, "bots", "alpha", "memory", "MEMORY.md"), "utf8")).toBe("# From Laptop1\n");
    expect(existsSync(join(studio.cloverHome, "bots", "alpha", "memory", "MEMORY.md"))).toBe(false);
    expect(changed).toContain("Laptop1 alpha MEMORY.md");
  });

  test("files leave memory for another computer only by Read and Write; they come in from one by copy", async () => {
    const { studio, laptop } = await two();
    const t = studio.node.tree;
    await t.write("home/memory/a.md", utf8("a"), { as: ALPHA });
    expect(await code(t.copy("home/memory/a.md", "home/Laptop1/a.md", { as: ALPHA }))).toBe("invalid");
    mkdirSync(laptop.home, { recursive: true });
    writeFileSync(join(laptop.home, "b.md"), "b");
    await t.copy("home/Laptop1/b.md", "home/memory/b.md", { as: ALPHA });
    expect(readFileSync(join(studio.cloverHome, "bots", "alpha", "memory", "b.md"), "utf8")).toBe("b");
    await t.copy("home/memory/a.md", "home/Studio/a.md", { as: ALPHA });
    expect(readFileSync(join(studio.home, "a.md"), "utf8")).toBe("a");
  });

  test("the check goes by the folder's name, not the bot list: a bot not made yet, synced early, or removed", async () => {
    const { studio } = await two();
    const t = studio.node.tree;
    // `ghost` isn't in this computer's list (not made yet, synced before the list caught up, or removed and left
    // behind): its memory folder is still the bots' alone (the owner's ruling of November 9, amended: every bot's).
    const dir = join(studio.cloverHome, "bots", "ghost", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "ghost's");
    const GHOST = { kind: "session", sessionId: "s_ghost", sessionKind: "bot", bot: "ghost" } as const;
    const real = "home/Studio/.clover/bots/ghost/memory";
    for (const as of [ALPHA, LUNA]) {
      expect(await t.read(`${real}/MEMORY.md`, { as })).toEqual(utf8("ghost's"));
      expect(await code(t.remove("home/Studio/.clover/bots/ghost", { as, recursive: true }))).not.toBe("ok");
    }
    for (const as of [CODING, AGENT, PLUGIN]) {
      expect(await code(t.read(`${real}/MEMORY.md`, { as }))).toBe("fenced");
      expect(await code(t.write(`${real}/MEMORY.md`, utf8("x"), { as }))).toBe("fenced");
      expect(await code(t.remove("home/Studio/.clover/bots/ghost", { as, recursive: true }))).not.toBe("ok");
      expect(await t.glob("**/*", { as, cwd: "home/Studio" })).not.toContain(`${real}/MEMORY.md`);
    }
    // Only a valid bot id reaches a memory folder (#197's check 5, kept by #234): `GHOST` isn't one; a valid id that
    // doesn't fold equal, however close, is another bot, which reads it.
    const GHOST_UPPER = { kind: "session", sessionId: "s_GHOST", sessionKind: "bot", bot: "GHOST" } as const;
    const GHOSTS = { kind: "session", sessionId: "s_ghosts", sessionKind: "bot", bot: "ghosts" } as const;
    expect(await code(t.read(`${real}/MEMORY.md`, { as: GHOST_UPPER }))).toBe("fenced");
    expect(await t.read(`${real}/MEMORY.md`, { as: GHOSTS })).toEqual(utf8("ghost's"));
    // ghost itself, through its own `home/memory`, and the user's own surfaces at the real path.
    expect(await t.read("home/memory/MEMORY.md", { as: GHOST })).toEqual(utf8("ghost's"));
    expect(await t.read(`${real}/MEMORY.md`, { as: USER })).toEqual(utf8("ghost's"));
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("ghost's");
  });

  test("no computer can be called memory", () => {
    expect(computerNameProblem("memory")).toContain("home/memory");
    expect(computerNameProblem("Memory")).not.toBeNull();
    expect(computerNameProblem("Memory2")).toBeNull();
  });
});

describe("a Clover home behind a link (#254's review, should-fix 7)", () => {
  test("the bots' folder made after the first check is still fenced, by the link's path and the real one", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lane-j-linked-home-")));
    try {
      const home = join(root, "home");
      const elsewhere = join(root, "disk2", "clover");
      mkdirSync(home, { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      const cloverHome = join(home, ".clover");
      symlinkSync(elsewhere, cloverHome, process.platform === "win32" ? "junction" : "dir");
      const h = new LocalHolder({ clock: { now: () => Date.now() }, name: () => "Studio", home, cloverHome, botsRoot: join(cloverHome, "bots"), os: hostOs() });
      // The first check, while `bots/` isn't there yet.
      await h.write("home/Studio/.clover/notes.md", utf8("x"), { as: CODING });
      expect(await code(h.read("home/Studio/.clover/bots/alpha/memory/secret.md", { as: CODING }))).toBe("fenced");
      // Then the bot's memory is made.
      mkdirSync(join(elsewhere, "bots", "alpha", "memory"), { recursive: true });
      writeFileSync(join(elsewhere, "bots", "alpha", "memory", "secret.md"), "alpha's");
      expect(await h.read("home/Studio/.clover/bots/alpha/memory/secret.md", { as: LUNA })).toEqual(utf8("alpha's"));
      for (const as of [CODING, AGENT]) {
        expect(await code(h.read("home/Studio/.clover/bots/alpha/memory/secret.md", { as }))).toBe("fenced");
        expect(await code(h.write("home/Studio/.clover/bots/alpha/memory/secret.md", utf8("x"), { as }))).toBe("fenced");
      }
      expect(await h.read("home/memory/secret.md", { as: ALPHA })).toEqual(utf8("alpha's"));
      expect(readFileSync(join(elsewhere, "bots", "alpha", "memory", "secret.md"), "utf8")).toBe("alpha's");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
