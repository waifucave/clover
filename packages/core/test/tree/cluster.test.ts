// J-M1 on the fake link with several computers (plan §4 J, M1; the owner's items 88 and 89): one folder tree across
// them, each call run by the computer that holds the files, behind that computer's fence and level, and an answer
// at once when a computer is offline.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { FileSelfStateStore, selfStatePath } from "../../src/computers/store";
import { BULK_PER_DEVICE, BulkSlots } from "../../src/tree/service";
import { FolderWatches } from "../../src/tree/watch";
import { answersFor, makePhone } from "./answer-support";
import { Cluster, until } from "./cluster-support";

const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

let cluster: Cluster;
afterEach(() => cluster?.close());

async function two(levels: { Studio?: "automatic" | "ask-risky" | "read-only"; Laptop1?: "automatic" | "ask-risky" | "read-only" } = {}) {
  cluster = new Cluster();
  const studio = await cluster.add("Studio");
  const laptop = await cluster.add("Laptop1");
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
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1");
    laptop.bots.push("alpha");
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await cluster.join();
    expect(studio.node.tree.resolve("bots/alpha/memory/MEMORY.md")).toMatchObject({ computer: "Laptop1", area: "bot", bot: "alpha" });
    // A bot's memory is its own sessions' alone (the owner's decision, #197): another computer's call is a peer's, so the
    // holder refuses it there. The rest of the bot's folder is the Clover home's too, default-deny: fenced as well.
    expect(await code(studio.node.tree.write("bots/alpha/memory/MEMORY.md", { encoding: "utf8", text: "# Memory\n" }, { as: BOT }))).toBe("fenced");
    expect(await code(studio.node.tree.write("bots/alpha/agents/a_1.md", { encoding: "utf8", text: "# Agent\n" }, { as: BOT }))).toBe("fenced");
    expect(existsSync(join(laptop.cloverHome, "bots/alpha/agents/a_1.md"))).toBe(false);
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
    expect(await code(tree.list("home/Laptop1/d", { as: BOT }))).toBe("fenced"); // the Clover home is default-deny, reads too
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

describe("a fenced name in another case (review B1)", () => {
  const utf8 = (text: string) => ({ encoding: "utf8" as const, text });

  test("a name that isn't on disk yet can't reach a fenced item in another case, for a peer or a bot here", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const t = studio.node.tree;
    const ch = laptop.cloverHome;
    expect(await code(t.write("home/Laptop1/.clover/rules/allow.json", utf8("{}"), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/RULES/allow.json", utf8('{"allow":["*"]}'), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/plugins-state/INSTALLED.json", utf8('["evil"]'), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/Trust/x.json", utf8("{}"), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/levels/COMPUTER.JSON", utf8("{}"), { as: BOT }))).toBe("fenced");
    await t.write("home/Laptop1/stage/x.json", utf8("{}"), { as: BOT });
    expect(await code(t.move("home/Laptop1/stage", "home/Laptop1/.clover/CONNECTORS", { as: BOT }))).toBe("fenced");
    // The long s and the Kelvin sign fold too, and a name that isn't ASCII where Clover names things under its home is
    // refused (lane B's `nonAsciiAlias`): its top level, and a folder that holds a fenced item.
    expect(await code(t.write("home/Laptop1/.clover/\u017Fettings/settings.json", utf8("{}"), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/secrets.\u212Aey", utf8("x"), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/caf\u00E9/clover.json", utf8("{}"), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/.clover/plugins-state/caf\u00E9.json", utf8("{}"), { as: BOT }))).toBe("fenced");
    expect(await code(t.write("home/Laptop1/caf\u00E9.txt", utf8("ok"), { as: BOT }))).toBe("ok");
    // A bot on Laptop1 itself, through its own tree.
    expect(await code(laptop.node.tree.write("home/Laptop1/.clover/Settings/settings.json", utf8('{"evil":1}'), { as: BOT }))).toBe("fenced");
    expect(existsSync(join(ch, "rules", "allow.json"))).toBe(false);
    expect(existsSync(join(ch, "plugins-state", "installed.json"))).toBe(false);
    expect(existsSync(join(ch, "connectors", "x.json"))).toBe(false);
    expect(existsSync(join(ch, "settings", "settings.json"))).toBe(false);
  });

  test("the levels file can't be planted in another case, so a restart doesn't raise the level", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1");
    await cluster.join();
    const raise = utf8(JSON.stringify({ level: "automatic", name: "Laptop1" }));
    expect(await code(studio.node.tree.write("home/Laptop1/.clover/LEVELS/computer.json", raise, { as: BOT, level: "automatic" }))).toBe("fenced");
    expect(await code(laptop.node.tree.write("home/Laptop1/.clover/LEVELS/computer.json", raise, { as: BOT }))).toBe("fenced");
    expect(await code(laptop.node.tree.write("home/Laptop1/.clover/levels/computer.json", raise, { as: BOT }))).toBe("fenced");
    expect(new FileSelfStateStore(selfStatePath(laptop.cloverHome)).load()?.level).not.toBe("automatic");
    expect(readdirSync(laptop.cloverHome).filter((n) => n.toLowerCase() === "levels")).toEqual(["levels"]);
  });

  test("Clover's fenced folders are made at start", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    for (const name of ["settings", "levels", "rules", "connectors", "trust", "user-layers", "plugin-data", "run", "plugins-state/oks"]) {
      expect(statSync(join(studio.cloverHome, ...name.split("/"))).isDirectory()).toBe(true);
    }
    if (process.platform !== "win32") expect(statSync(join(studio.cloverHome, "levels")).mode & 0o077).toBe(0);
  });
});

describe("hard links (review S4)", () => {
  test("a file with other names is refused to anyone the fence judges, untouched", async () => {
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    writeFileSync(join(laptop.cloverHome, "rules", "allow.json"), "{}");
    linkSync(join(laptop.cloverHome, "rules", "allow.json"), join(laptop.home, "innocent.json"));
    expect(await code(studio.node.tree.write("home/Laptop1/innocent.json", { encoding: "utf8", text: '{"allow":["*"]}' }, { as: BOT }))).toBe("refused");
    expect(await code(studio.node.tree.read("home/Laptop1/innocent.json", { as: BOT }))).toBe("refused");
    expect(await code(laptop.node.tree.read("home/Laptop1/innocent.json", { as: BOT }))).toBe("refused");
    // Nor through grep, nor any other content read (check 2's N1).
    writeFileSync(join(laptop.cloverHome, "rules", "allow.json"), '{"note":"only-in-the-fenced-file"}');
    const found = await studio.node.tree.grep("only-in-the-fenced-file", { as: BOT, path: "home/Laptop1" });
    expect(found.map((m) => m.path)).not.toContain("home/Laptop1/innocent.json");
    writeFileSync(join(laptop.cloverHome, "rules", "allow.json"), "{}");
    expect(readFileSync(join(laptop.cloverHome, "rules", "allow.json"), "utf8")).toBe("{}");
    // The user's own call isn't fenced.
    expect(await laptop.node.tree.read("home/Laptop1/innocent.json", { as: { kind: "user", client: "app" } })).toEqual({ encoding: "utf8", text: "{}" });
  });
});

describe("a bot two computers claim (review S2)", () => {
  test("its folder is refused rather than guessed", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1");
    studio.bots.push("alpha");
    laptop.bots.push("alpha");
    await cluster.join();
    expect(isContractError((() => { try { studio.node.tree.resolve("bots/alpha/x"); } catch (e) { return e; } })(), "conflict")).toBe(true);
    expect(await code(studio.node.tree.read("bots/alpha/x", { as: BOT }))).toBe("conflict");
  });
});

describe("limits (review minors 2, 5 and 7)", () => {
  test("a watch is a project's folder, never a whole home, and each watcher has its own budget", async () => {
    const { studio } = await two();
    expect(await code(studio.node.tree.watch("home/Laptop1", { as: BOT }, () => {}))).toBe("invalid");
    const fake = (() => ({ on: () => {}, close: () => {} })) as unknown as typeof import("node:fs").watch;
    const w = new FolderWatches({ budget: 2, total: 3, watch: fake });
    w.subscribe("/a", "home/X/a", () => true, () => {}, "peer:one");
    w.subscribe("/b", "home/X/b", () => true, () => {}, "peer:one");
    expect(() => w.subscribe("/c", "home/X/c", () => true, () => {}, "peer:one")).toThrow();
    const stop = w.subscribe("/c", "home/X/c", () => true, () => {}, "peer:two");
    expect(() => w.subscribe("/d", "home/X/d", () => true, () => {}, "peer:two")).toThrow(); // this computer's total
    stop();
    w.subscribe("/d", "home/X/d", () => true, () => {}, "peer:two");
    w.close();
  });

  test("one write carries at most 16 MiB, and one computer's bulk calls queue behind a few slots", async () => {
    const { studio } = await two({ Laptop1: "automatic" });
    const big = Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64");
    expect(await code(studio.node.tree.write("home/Laptop1/big.bin", { encoding: "base64", data: big }, { as: BOT }))).toBe("invalid");
    const slots = new BulkSlots();
    const gates: (() => void)[] = [];
    const hold = () => new Promise<void>((r) => gates.push(r));
    const running = Array.from({ length: BULK_PER_DEVICE + 32 }, () => slots.run("dev", hold));
    await Bun.sleep(5);
    expect(gates.length).toBe(BULK_PER_DEVICE);
    expect(await code(slots.run("dev", async () => {}))).toBe("refused");
    await slots.run("other", async () => {}); // another computer has its own slots
    gates.shift()!();
    await until(() => gates.length === BULK_PER_DEVICE, 1000, "a queued call to take the freed slot");
    while (gates.length) gates.shift()!(), await Bun.sleep(1);
    await Promise.all(running);
  });

  test("a running call is known by its session too: two sessions may use the same call id", async () => {
    if (process.platform === "win32") return;
    const { studio, laptop } = await two({ Laptop1: "automatic" });
    const run = (session: string) => studio.node.tools.run("Bash", { command: "cd home/Laptop1 && sleep 0.3 && echo done" }, { session, sessionKind: "bot", callId: "same", cwd: "home/Studio" });
    const [a, b] = await Promise.all([run("s_a"), run("s_b")]);
    expect([a.isError, b.isError]).toEqual([false, false]);
    expect(laptop.node.service.counts.running).toBe(0);
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

describe("moves between computers take the direct path (review S1)", () => {
  test("a big file moves in one piece, holder to holder, with no cap per file", async () => {
    const { studio, laptop } = await two({ Studio: "automatic", Laptop1: "automatic" });
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 7);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    writeFileSync(join(studio.home, "big.bin"), bytes);
    await studio.node.tree.move("home/Studio/big.bin", "home/Laptop1/big.bin", { as: BOT });
    expect(existsSync(join(studio.home, "big.bin"))).toBe(false);
    expect(readFileSync(join(laptop.home, "big.bin")).equals(bytes)).toBe(true);
    expect(readdirSync(laptop.home).some((n) => n.startsWith(".clover-receiving-"))).toBe(false);
  });

  test("each holder judges the whole move once, and a refusal leaves both sides as they were", async () => {
    const { studio, laptop } = await two({ Studio: "automatic" });
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    writeFileSync(join(studio.home, "proj", "b.txt"), "b");
    // Laptop1 asks for risky actions: a move into it from another computer needs the user's answer there.
    expect(await code(studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT }))).toBe("refused");
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(true);
    expect(existsSync(join(laptop.home, "proj"))).toBe(false);
    // Refused at the source (Studio, judged at the call's stricter level) after Laptop1 made the folders for it:
    // they go too.
    await laptop.node.registry.setLevel("Laptop1", "automatic", { via: "terminal" });
    await until(() => studio.node.registry.get("Laptop1")!.level === "automatic", 2000, "Laptop1's level to reach Studio");
    await studio.node.registry.setLevel("Studio", "ask-risky");
    expect(await code(laptop.node.tree.move("home/Studio/proj", "home/Laptop1/deep/er/proj", { as: BOT }))).toBe("refused");
    expect(existsSync(join(laptop.home, "deep"))).toBe(false);
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(true);
    await studio.node.registry.setLevel("Studio", "automatic", { via: "terminal" });
    expect(readdirSync(laptop.home).some((n) => n.startsWith(".clover-receiving-"))).toBe(false);
    // At accept-edits a move is allowed whole: no answer for each file and none for the delete at the source.
    await laptop.node.registry.setLevel("Laptop1", "accept-edits", { via: "terminal" });
    await until(() => studio.node.registry.get("Laptop1")!.level === "accept-edits", 2000, "Laptop1's level to reach Studio");
    await studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT });
    expect(readFileSync(join(laptop.home, "proj", "b.txt"), "utf8")).toBe("b");
    expect(existsSync(join(studio.home, "proj"))).toBe(false);
  });

  test("one card for the whole move: one signed answer that both holders check against their own card", async () => {
    const phone = await makePhone();
    cluster = new Cluster();
    const studio = await cluster.add("Studio", { answers: () => answersFor(phone) });
    const laptop = await cluster.add("Laptop1", { answers: () => answersFor(phone) });
    await studio.node.registry.setLevel("Studio", "automatic", { via: "terminal" });
    await cluster.join();
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    const whole = { operation: "move", from: "home/Studio/proj", to: "home/Laptop1/proj", source: "Studio", destination: "Laptop1" };
    // An answer for another operation, or for one holder's own call, doesn't carry it.
    const elsewhere = await phone.approve("Laptop1", "tree.transfer", { ...whole, to: "home/Laptop1/elsewhere" });
    const wrongTo = await rejection(studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT, answer: elsewhere }));
    expect(isContractError(wrongTo, "refused")).toBe(true);
    expect((wrongTo as { detail?: { verdict?: string } }).detail?.verdict).toBe("unbound");
    const perHolder = await phone.approve("Laptop1", "tree.move", { from: whole.from, to: whole.to });
    expect(await code(studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT, answer: perHolder }))).toBe("refused");
    expect(existsSync(join(laptop.home, "proj"))).toBe(false);
    // The call carries the stricter of both levels, so both holders ask; one answer, bound to the whole move, for both.
    await studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT, answer: await phone.approve("Laptop1", "tree.transfer", whole) });
    expect(readFileSync(join(laptop.home, "proj", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(studio.home, "proj"))).toBe(false);
  });

  test("what changed at the source while it moved stays there too; the rest is removed", async () => {
    const { studio, laptop } = await two({ Studio: "automatic", Laptop1: "automatic" });
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    writeFileSync(join(studio.home, "proj", "b.txt"), "b");
    // Just before the destination tells the source it has the files, b.txt changes at the source.
    const link = await cluster.net.endpoint(laptop.device).connect(studio.device);
    const request = link.request.bind(link);
    (link as { request: typeof link.request }).request = (async (method: string, params: unknown, opts?: Parameters<typeof link.request>[2]) => {
      if (method === "tree.sent") appendFileSync(join(studio.home, "proj", "b.txt"), " and more");
      return request(method, params, opts);
    }) as typeof link.request;
    const err = await rejection(studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT }));
    expect(isContractError(err, "conflict")).toBe(true);
    expect(readFileSync(join(laptop.home, "proj", "b.txt"), "utf8")).toBe("b");
    expect(readFileSync(join(studio.home, "proj", "b.txt"), "utf8")).toBe("b and more");
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(false);
  });

  test("a link out of what moves refuses the whole move before anything lands", async () => {
    if (process.platform === "win32") return;
    const { studio, laptop } = await two({ Studio: "automatic", Laptop1: "automatic" });
    mkdirSync(join(studio.home, "proj"));
    writeFileSync(join(studio.home, "proj", "a.txt"), "a");
    symlinkSync("../secret.txt", join(studio.home, "proj", "out"));
    expect(await code(studio.node.tree.move("home/Studio/proj", "home/Laptop1/proj", { as: BOT }))).toBe("invalid");
    expect(existsSync(join(laptop.home, "proj"))).toBe(false);
    expect(existsSync(join(studio.home, "proj", "a.txt"))).toBe(true);
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
    // A hello never renames (names come from the device list); lane H's list carries the new name to every computer.
    await Bun.sleep(50);
    expect(studio.node.registry.get("Laptop-2")).toBeUndefined();
    cluster.renameComputer(laptop.device, "Laptop-2");
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
