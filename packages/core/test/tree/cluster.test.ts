// J-M1 on the fake link with several computers (plan §4 J, M1; the owner's items 88 and 89): one folder tree across
// them, each call run by the computer that holds the files, behind that computer's fence and level, and an answer
// at once when a computer is offline.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { Cluster, until } from "./cluster-support";

const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

let cluster: Cluster;
afterEach(() => cluster?.close());

async function two(levels: { Studio?: "automatic" | "ask-risky" | "read-only"; Laptop1?: "automatic" | "ask-risky" | "read-only" } = {}) {
  cluster = new Cluster();
  const studio = cluster.add("Studio");
  const laptop = cluster.add("Laptop1");
  for (const [name, level] of Object.entries(levels)) {
    if (level) await cluster.get(name).node.registry.setLevel(name, level, { via: "terminal" });
  }
  await cluster.join();
  return { studio, laptop };
}

describe("one tree across computers", () => {
  test("each computer sees the others, online, with what they said in their hello", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const reg = studio.node.registry;
    expect(reg.list().map((c) => [c.name, c.state, c.link])).toEqual([["Studio", "online", "self"], ["Laptop1", "online", "lan"]]);
    expect(reg.get("Laptop1")!.level).toBe("automatic");
    expect(studio.node.tree.resolve("home/Laptop1/project/run.py")).toEqual({ computer: "Laptop1", path: join(laptop.home, "project/run.py"), area: "home" });
    expect(studio.node.tree.toTreePath("Laptop1", join(laptop.home, "a", "b.txt"))).toBe("home/Laptop1/a/b.txt");
    expect(studio.node.tree.toTreePath("Laptop1", "/usr/bin/git")).toBeNull();
    expect(studio.node.tree.computersFor(["home/Studio/a", "home/Laptop1/b"])).toEqual(["Studio", "Laptop1"]);
  });

  test("a bot on one computer reads, writes, lists, globs and greps another's files, on that computer's disk", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const tree = studio.node.tree;
    await tree.write("home/Laptop1/notes/a.md", { encoding: "utf8", text: "# Notes\ntoken here\n" }, { as: BOT });
    await tree.write("home/Laptop1/notes/run.sh", { encoding: "utf8", text: "#!/bin/sh\necho hi\n" }, { as: BOT, executable: true });
    expect(readFileSync(join(laptop.home, "notes/a.md"), "utf8")).toBe("# Notes\ntoken here\n");
    expect(existsSync(join(studio.home, "notes"))).toBe(false);
    expect(await tree.read("home/Laptop1/notes/a.md", { as: BOT })).toEqual({ encoding: "utf8", text: "# Notes\ntoken here\n" });
    expect((await tree.list("home/Laptop1/notes", { as: BOT })).map((s) => [s.path, s.type, s.executable])).toEqual([
      ["home/Laptop1/notes/a.md", "file", false],
      ["home/Laptop1/notes/run.sh", "file", true],
    ]);
    expect(await tree.glob("**/*.md", { cwd: "home/Laptop1/notes", as: BOT })).toEqual(["home/Laptop1/notes/a.md"]);
    expect(await tree.grep("TOKEN", { path: "home/Laptop1", ignoreCase: true, as: BOT })).toEqual([{ path: "home/Laptop1/notes/a.md", line: 2, text: "token here" }]);
    expect((await tree.stat("home/Laptop1/notes/a.md", { as: BOT }))?.size).toBe(19);
    expect(await tree.stat("home/Laptop1/nothing", { as: BOT })).toBeNull();
    await tree.remove("home/Laptop1/notes/a.md", { as: BOT });
    expect(existsSync(join(laptop.home, "notes/a.md"))).toBe(false);
  });

  test("bots/<bot>/ lives on the computer that runs the bot", async () => {
    cluster = new Cluster();
    const studio = cluster.add("Studio");
    const laptop = cluster.add("Laptop1");
    laptop.bots.push("alpha");
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await cluster.join();
    expect(studio.node.tree.resolve("bots/alpha/memory/MEMORY.md")).toMatchObject({ computer: "Laptop1", area: "bot", bot: "alpha" });
    await studio.node.tree.write("bots/alpha/memory/MEMORY.md", { encoding: "utf8", text: "# Memory\n" }, { as: BOT });
    expect(readFileSync(join(laptop.cloverHome, "bots/alpha/memory/MEMORY.md"), "utf8")).toBe("# Memory\n");
    expect(await code(studio.node.tree.read("bots/luna/x", { as: BOT }))).toBe("not_found");
  });
});

describe("the holder's rules (review N2, S6 edits 5 and 6)", () => {
  test("another computer's call is a peer's: fenced there, and its changes judged at the stricter level", async () => {
    const { studio, laptop } = await two();
    const tree = studio.node.tree;
    // Laptop1 asks for risky actions (the default): a peer's edit needs the user's signed answer there.
    expect(await code(tree.write("home/Laptop1/a.txt", { encoding: "utf8", text: "a" }, { as: BOT }))).toBe("refused");
    expect(existsSync(join(laptop.home, "a.txt"))).toBe(false);
    // Reads are never asked about.
    writeFileSync(join(laptop.home, "b.txt"), "b");
    expect(await tree.read("home/Laptop1/b.txt", { as: BOT })).toEqual({ encoding: "utf8", text: "b" });
    // Even the user's own call from Studio is a peer's at Laptop1: never the user there (review N2).
    expect(await code(tree.write("home/Laptop1/a.txt", { encoding: "utf8", text: "a" }, { as: { kind: "user", client: "app" } }))).toBe("refused");
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await until(() => studio.node.registry.get("Laptop1")!.level === "automatic", 2000, "Laptop1's new level to reach Studio");
    await tree.write("home/Laptop1/a.txt", { encoding: "utf8", text: "a" }, { as: BOT });
    // Studio can't make Laptop1's level read anything else: a call at read-only stays read-only there.
    expect(await code(tree.write("home/Laptop1/a.txt", { encoding: "utf8", text: "z" }, { as: BOT, level: "read-only" }))).toBe("refused");
    expect(readFileSync(join(laptop.home, "a.txt"), "utf8")).toBe("a");
  });

  test("the fence of the computer that holds the files, whatever the spelling or the links", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const tree = studio.node.tree;
    mkdirSync(join(laptop.cloverHome, "settings"), { recursive: true });
    writeFileSync(join(laptop.cloverHome, "settings", "settings.json"), "{}");
    const err = await rejection(tree.write("home/Laptop1/.clover/settings/settings.json", { encoding: "utf8", text: "{\"x\":1}" }, { as: BOT }));
    expect(isContractError(err, "fenced")).toBe(true);
    expect((err as { detail: unknown }).detail).toEqual({ computer: "Laptop1", reason: "settings" });
    if (caseInsensitive) {
      // S6 review round 2: the disk's own spelling decides, not the one typed.
      expect(await code(tree.write("home/Laptop1/.CLOVER/Settings/settings.json", { encoding: "utf8", text: "{}" }, { as: BOT }))).toBe("fenced");
      expect(await code(tree.move("home/Laptop1/.CLOVER", "home/Laptop1/moved", { as: BOT }))).toBe("fenced");
      expect(await code(tree.remove("home/Laptop1/.Clover/settings", { as: BOT, recursive: true }))).toBe("fenced");
    }
    // A folder swapped for a link into the fence leads nowhere (a junction on Windows).
    const dirLink = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(join(laptop.cloverHome, "settings"), join(laptop.home, "d"), dirLink);
    expect(await code(tree.write("home/Laptop1/d/settings.json", { encoding: "utf8", text: "{}" }, { as: BOT }))).toBe("fenced");
    expect(await code(tree.list("home/Laptop1/d", { as: BOT }))).toBe("ok"); // settings are write-fenced, not hidden
    // A link that leaves the home isn't followed, and its target isn't told.
    const outside = mkdtempSync(join(tmpdir(), "lane-j-outside-"));
    writeFileSync(join(outside, "hosts"), "secret");
    symlinkSync(outside, join(laptop.home, "out"), dirLink);
    expect(await code(tree.read("home/Laptop1/out/hosts", { as: BOT }))).toBe("refused");
    expect(await code(tree.list("home/Laptop1/out", { as: BOT }))).toBe("refused");
    expect(readFileSync(join(laptop.cloverHome, "settings", "settings.json"), "utf8")).toBe("{}");
    // The user on Laptop1 itself never meets its fence.
    await laptop.node.tree.write("home/Laptop1/.clover/settings/settings.json", { encoding: "utf8", text: "{\"mine\":1}" }, { as: { kind: "user", client: "app" } });
  });
});

describe("tools run where the files are (with lane A)", () => {
  test("Read, Write, Edit, Glob, Grep and LS on another computer's paths", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const tools = studio.node.tools;
    const ctx = { session: "s_alpha", sessionKind: "bot" as const, bot: "alpha", callId: "c1", cwd: "home/Laptop1" };
    expect(tools.owns("Read", { file_path: "home/Laptop1/x" })).toBe(true);
    expect(tools.owns("Read", { file_path: "/etc/hosts" })).toBe(false);
    expect((await tools.run("Write", { file_path: "home/Laptop1/src/a.ts", content: "const a = 1;\nexport {}\n" }, ctx)).isError).toBe(false);
    expect((await tools.run("Read", { file_path: "src/a.ts" }, ctx)).output).toBe("     1\tconst a = 1;\n     2\texport {}");
    const edit = await tools.run("Edit", { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }, ctx);
    expect(edit).toMatchObject({ isError: false, computer: "Laptop1" });
    expect(readFileSync(join(laptop.home, "src/a.ts"), "utf8")).toBe("const a = 2;\nexport {}\n");
    expect((await tools.run("Edit", { file_path: "src/a.ts", old_string: "nope", new_string: "x" }, ctx)).isError).toBe(true);
    expect((await tools.run("Glob", { pattern: "**/*.ts" }, ctx)).output).toEqual({ paths: ["home/Laptop1/src/a.ts"], truncated: false });
    expect((await tools.run("Grep", { pattern: "a = 2" }, ctx)).output).toEqual({ matches: [{ path: "home/Laptop1/src/a.ts", line: 1, text: "const a = 2;" }], truncated: false });
    expect((await tools.run("LS", { path: "src" }, ctx)).output).toEqual([{ name: "a.ts", type: "file", size: 23 }]);
  });

  test("Bash runs on the computer that holds its folder, and its output streams back", async () => {
    if (process.platform === "win32") return; // the test executor is /bin/sh
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    mkdirSync(join(laptop.home, "proj"));
    writeFileSync(join(laptop.home, "proj", "file.txt"), "on Laptop1\n");
    const chunks: string[] = [];
    const ctx = { session: "s_alpha", sessionKind: "bot" as const, bot: "alpha", callId: "c2", cwd: "home/Studio", onOutput: (c: string) => chunks.push(c) };
    const r = await studio.node.tools.run("Bash", { command: "cd home/Laptop1/proj && pwd && cat file.txt" }, ctx);
    expect(r).toMatchObject({ isError: false, computer: "Laptop1", cwd: "home/Laptop1/proj" });
    expect((r.output as { stdout: string }).stdout).toBe(`${join(laptop.home, "proj")}\non Laptop1\n`);
    expect(chunks.join("")).toBe(`${join(laptop.home, "proj")}\non Laptop1\n`);
    // Studio's own folder runs here.
    const here = await studio.node.tools.run("Bash", { command: "pwd" }, { ...ctx, callId: "c3", cwd: "home/Studio" });
    expect(here).toMatchObject({ computer: "Studio" });
    expect((here.output as { stdout: string }).stdout.trim()).toBe(studio.home);
    // Into the fence: refused at the holder before anything runs.
    expect((await studio.node.tools.run("Bash", { command: "cd home/Laptop1/.clover/run && ls" }, { ...ctx, callId: "c4" })).isError).toBe(true);
  });

  test("a command needs the holder's level: refused at ask-risky without the user's answer", async () => {
    if (process.platform === "win32") return;
    const { studio, laptop } = await two();
    const r = await studio.node.tools.run("Bash", { command: "cd home/Laptop1 && touch made" }, { session: "s_alpha", sessionKind: "bot", callId: "c5", cwd: "home/Studio" });
    expect(r.isError).toBe(true);
    expect((r.output as { error: string }).error).toBe("refused");
    expect(existsSync(join(laptop.home, "made"))).toBe(false);
  });

  test("cancelling a running command stops it on the holder", async () => {
    if (process.platform === "win32") return;
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const abort = new AbortController();
    const started = Date.now();
    const run = studio.node.tools.run("Bash", { command: "cd home/Laptop1 && sleep 20" }, { session: "s_alpha", sessionKind: "bot", callId: "c6", cwd: "home/Studio", signal: abort.signal });
    await until(() => laptop.node.service.counts.running === 1, 3000, "the command to start on Laptop1");
    abort.abort();
    const r = await run;
    expect(Date.now() - started).toBeLessThan(5000);
    expect((r.output as { aborted: boolean }).aborted).toBe(true);
    expect(laptop.node.service.counts.running).toBe(0);
  });
});

describe("an answer at once when a computer is offline", () => {
  test("calls to a computer that is off fail computer_offline at once, and work again when it's back", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    writeFileSync(join(laptop.home, "x.txt"), "x");
    cluster.net.partition(laptop.device);
    expect(studio.node.registry.get("Laptop1")!.state).toBe("offline");
    const t0 = performance.now();
    const err = await rejection(studio.node.tree.read("home/Laptop1/x.txt", { as: BOT }));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(isContractError(err, "computer_offline")).toBe(true);
    expect((err as { detail: unknown }).detail).toEqual({ computer: "Laptop1" });
    const bash = await studio.node.tools.run("Bash", { command: "cd home/Laptop1 && ls" }, { session: "s_a", sessionKind: "bot", callId: "c7", cwd: "home/Studio" });
    expect((bash.output as { error: string }).error).toBe("computer_offline");
    // The user's own computer still answers.
    expect(await studio.node.tree.stat("home/Studio", { as: BOT })).not.toBeNull();
    cluster.net.heal(laptop.device);
    await until(() => studio.node.registry.get("Laptop1")!.state === "online", 2000, "Laptop1 back online");
    expect(await studio.node.tree.read("home/Laptop1/x.txt", { as: BOT })).toEqual({ encoding: "utf8", text: "x" });
  });

  test("a call in flight when the link drops fails computer_offline, never hangs", async () => {
    if (process.platform === "win32") return;
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const run = studio.node.tools.run("Bash", { command: "cd home/Laptop1 && sleep 5" }, { session: "s_a", sessionKind: "bot", callId: "c8", cwd: "home/Studio" });
    await until(() => laptop.node.service.counts.running === 1, 3000, "the command to start");
    const t0 = performance.now();
    cluster.net.partition(laptop.device);
    const r = await run;
    expect(performance.now() - t0).toBeLessThan(200);
    expect((r.output as { error: string }).error).toBe("computer_offline");
  });
});

describe("moves between computers", () => {
  test("a folder moves to another computer with its files, empty folders and links, and leaves the source", async () => {
    const { studio, laptop } = await two({ Studio: "automatic", Laptop1: "automatic" });
    const src = join(studio.home, "project1");
    mkdirSync(join(src, "src"), { recursive: true });
    mkdirSync(join(src, "empty"));
    writeFileSync(join(src, "README.md"), "hello");
    writeFileSync(join(src, "src", "a.ts"), "export {}");
    writeFileSync(join(src, "run.sh"), "#!/bin/sh\n");
    if (process.platform !== "win32") symlinkSync("src/a.ts", join(src, "link.ts"));
    if (process.platform !== "win32") (await import("node:fs")).chmodSync(join(src, "run.sh"), 0o755);
    await studio.node.tree.move("home/Studio/project1", "home/Laptop1/project1", { as: BOT });
    expect(existsSync(src)).toBe(false);
    const dst = join(laptop.home, "project1");
    expect(readFileSync(join(dst, "src", "a.ts"), "utf8")).toBe("export {}");
    expect(statSync(join(dst, "empty")).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(readFileSync(join(dst, "link.ts"), "utf8")).toBe("export {}");
      expect(statSync(join(dst, "run.sh")).mode & 0o100).toBe(0o100);
    }
    // Never over something that's there.
    mkdirSync(join(studio.home, "project1"));
    expect(await code(studio.node.tree.move("home/Studio/project1", "home/Laptop1/project1", { as: BOT }))).toBe("conflict");
  });
});

describe("the Files panel's data: change events from the holder", () => {
  test("a watch on another computer's folder reports changes there, and never the fenced ones", async () => {
    const { studio, laptop } = await two();
    mkdirSync(join(laptop.home, "proj"));
    const events: unknown[] = [];
    const stop = await studio.node.tree.watch("home/Laptop1/proj", { as: BOT }, (e) => events.push(e));
    expect(laptop.node.service.counts.watches).toBe(1);
    await Bun.sleep(100);
    writeFileSync(join(laptop.home, "proj", "new.txt"), "x");
    await until(() => events.some((e) => JSON.stringify(e).includes("home/Laptop1/proj/new.txt")), 3000, "the change event");
    // A watch on the fence is refused.
    expect(await code(studio.node.tree.watch("home/Laptop1/.clover/run", { as: BOT }, () => {}))).toBe("fenced");
    stop();
    await until(() => laptop.node.service.counts.watches === 0, 2000, "the watch to stop on Laptop1");
  });

  test("a watch says resync after the link was down, and keeps going", async () => {
    const { studio, laptop } = await two();
    mkdirSync(join(laptop.home, "proj"));
    const events: { type: string; paths?: string[] }[] = [];
    const stop = await studio.node.tree.watch("home/Laptop1/proj", { as: BOT }, (e) => events.push(e));
    cluster.net.partition(laptop.device);
    await until(() => laptop.node.service.counts.watches === 0, 2000, "Laptop1 to drop the watch");
    cluster.net.heal(laptop.device);
    await until(() => events.some((e) => e.type === "resync"), 3000, "the resync");
    await Bun.sleep(100);
    writeFileSync(join(laptop.home, "proj", "after.txt"), "x");
    await until(() => events.some((e) => e.paths?.includes("home/Laptop1/proj/after.txt") ?? false), 3000, "a change after the resync");
    stop();
  });
});

describe("the registry over the link", () => {
  test("a computer's level is its own: it changes there, and the others hold a copy", async () => {
    const { studio, laptop } = await two();
    expect(await code(studio.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" }))).toBe("refused");
    await laptop.node.registry.setLevel("Laptop1", "read-only");
    await until(() => studio.node.registry.get("Laptop1")!.level === "read-only", 2000, "the copy to update");
    // Kept across a restart of Laptop1's registry (its own entry is on its own disk).
    expect(JSON.parse(readFileSync(join(laptop.cloverHome, "levels", "computer.json"), "utf8"))).toMatchObject({ name: "Laptop1", level: "read-only" });
  });

  test("a renamed computer keeps its old name as an alias in every computer's tree", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    await laptop.node.registry.rename("Laptop1", "Laptop-2");
    await until(() => studio.node.registry.get("Laptop-2") !== undefined, 2000, "the new name to reach Studio");
    expect(studio.node.registry.get("Laptop1")!.name).toBe("Laptop-2");
    writeFileSync(join(laptop.home, "n.txt"), "n");
    expect(await studio.node.tree.read("home/Laptop1/n.txt", { as: BOT })).toEqual({ encoding: "utf8", text: "n" });
    expect(await studio.node.tree.read("home/Laptop-2/n.txt", { as: BOT })).toEqual({ encoding: "utf8", text: "n" });
  });

  test("holds and the user-working mark are kept for opensky", async () => {
    const { studio } = await two();
    const reg = studio.node.registry;
    const h = reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Figma" }, session: "s_a", pluginId: "opensky" });
    expect(reg.holds("Studio")).toEqual([h]);
    reg.markUserWorking("Studio", "Mail");
    expect(isContractError((() => { try { reg.takeHold({ computer: "Studio", target: { kind: "app", app: "Mail" }, session: "s_b", pluginId: "opensky" }); } catch (e) { return e; } })(), "user_working")).toBe(true);
    reg.liftUserWorking("Studio");
    expect(reg.releaseSession("s_a")).toBe(1);
    cluster.net.partition(cluster.get("Laptop1").device);
    expect(isContractError((() => { try { reg.takeHold({ computer: "Laptop1", target: { kind: "app", app: "Excel" }, pluginId: "opensky" }); } catch (e) { return e; } })(), "computer_offline")).toBe(true);
  });
});
