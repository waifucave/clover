// A bot's memory in the tree (the owner's ruling for J-M3): `home/memory/` beside the computers, that bot's
// `<Clover home>/bots/<bot>/memory/` on every computer that runs the core, kept in sync by lane H. Only that bot's own
// sessions reach it, by any path; it never goes over the link; a write lands here even while another computer is off,
// and lane H's sync is told of every change.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  test("nobody else reaches it: not other bots, coding sessions, agents, plugins or another computer, by any path", async () => {
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
    // Nor by alpha's folder, or the home folder's own path to it, for anyone but alpha.
    for (const as of [LUNA, CODING, AGENT]) {
      expect(await code(t.read("bots/alpha/memory/secret.md", { as }))).toBe("not_found");
      expect(await code(t.write("bots/alpha/memory/secret.md", utf8("x"), { as }))).toBe("not_found");
      expect(await code(t.read("home/Studio/.clover/bots/alpha/memory/secret.md", { as }))).not.toBe("ok");
      expect((await t.list("bots/alpha", { as })).map((s) => s.path)).not.toContain("bots/alpha/memory");
      expect(await t.glob("**/*", { as, cwd: "bots/alpha" })).not.toContain("bots/alpha/memory/secret.md");
      expect((await t.grep("alpha", { as, path: "bots/alpha" })).map((m) => m.path)).not.toContain("bots/alpha/memory/secret.md");
    }
    expect(await code(t.remove("bots/alpha/memory", { as: LUNA, recursive: true }))).toBe("not_found");
    // The bot itself, from another computer: memory never goes over the link.
    expect(await code(laptop.node.tree.read("bots/alpha/memory/secret.md", { as: ALPHA }))).toBe("not_found");
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

  test("no computer can be called memory", () => {
    expect(computerNameProblem("memory")).toContain("home/memory");
    expect(computerNameProblem("Memory")).not.toBeNull();
    expect(computerNameProblem("Memory2")).toBeNull();
  });
});
