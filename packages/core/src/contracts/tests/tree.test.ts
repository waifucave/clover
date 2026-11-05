// Pins the Tree contract through FakeTree: where tree paths live, files on each computer, fast failure when one is
// off, the fence of the computer that holds the files, moves across computers, glob and grep.
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import { FakeFence } from "../fakes/fence";
import { FakeTree } from "../fakes/tree";
import { splitTreePath } from "../tree";

const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
const USER: Caller = { kind: "user", client: "app" };
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

function setup() {
  let runsAlpha = "Studio";
  const tree = new FakeTree({
    clock: new FakeClock(),
    computers: {
      Studio: { home: "/Users/me", botsRoot: "/Users/me/.clover/bots", fence: new FakeFence({ home: "/Users/me", cloverHome: "/Users/me/.clover" }) },
      Laptop1: { home: "/home/me", botsRoot: "/home/me/.clover/bots", aliases: ["OldLaptop"], fence: new FakeFence({ os: "linux", home: "/home/me", cloverHome: "/home/me/.clover" }) },
    },
    botComputer: (bot) => (bot === "alpha" || bot === "pack/luna" ? runsAlpha : undefined),
  });
  return { tree, moveAlpha: (to: string) => (runsAlpha = to) };
}

describe("FakeTree", () => {
  test("home/<Computer>/ is that computer's home; bots/<bot>/ is on the computer running the bot", () => {
    const { tree, moveAlpha } = setup();
    expect(tree.resolve("home/Laptop1/project/run.py")).toEqual({ computer: "Laptop1", path: "/home/me/project/run.py", area: "home" });
    expect(tree.resolve("home/OldLaptop")).toMatchObject({ computer: "Laptop1", path: "/home/me" });
    expect(tree.resolve("bots/alpha/memory/MEMORY.md")).toEqual({ computer: "Studio", path: "/Users/me/.clover/bots/alpha/memory/MEMORY.md", area: "bot", bot: "alpha" });
    expect(tree.resolve("bots/pack--luna/memory")).toMatchObject({ bot: "pack/luna", path: "/Users/me/.clover/bots/pack--luna/memory" });
    moveAlpha("Laptop1");
    expect(tree.resolve("bots/alpha/memory")).toMatchObject({ computer: "Laptop1", path: "/home/me/.clover/bots/alpha/memory" });
    expect(isContractError((() => { try { tree.resolve("home/Nowhere/x"); } catch (e) { return e; } })(), "not_found")).toBe(true);
    expect(isContractError((() => { try { tree.resolve("/etc/passwd"); } catch (e) { return e; } })(), "invalid")).toBe(true);
    expect(tree.toTreePath("Studio", "/Users/me/project/a.ts")).toBe("home/Studio/project/a.ts");
    expect(tree.toTreePath("Studio", "/usr/bin/git")).toBeNull();
    expect(splitTreePath("home/Studio/")).toEqual({ area: "home", name: "Studio", rest: "" });
  });

  test("files are read, written, listed, stat'ed and removed on the computer that holds them", async () => {
    const { tree } = setup();
    await tree.write("home/Laptop1/data/a.csv", utf8("x,y\n1,2\n"));
    await tree.write("home/Laptop1/data/run.sh", { encoding: "base64", data: btoa("#!/bin/sh\necho hi\n") }, { executable: true });
    expect(await tree.read("home/Laptop1/data/a.csv")).toEqual(utf8("x,y\n1,2\n"));
    expect(await tree.read("home/Laptop1/data/run.sh", { encoding: "base64" })).toEqual({ encoding: "base64", data: btoa("#!/bin/sh\necho hi\n") });
    expect((await tree.list("home/Laptop1/data")).map((s) => [s.path, s.type, s.executable])).toEqual([
      ["home/Laptop1/data/a.csv", "file", false],
      ["home/Laptop1/data/run.sh", "file", true],
    ]);
    expect(await tree.stat("home/Studio/data/a.csv")).toBeNull();
    expect(isContractError(await rejection(tree.remove("home/Laptop1/data")), "invalid")).toBe(true);
    await tree.remove("home/Laptop1/data", { recursive: true });
    expect(await tree.stat("home/Laptop1/data")).toBeNull();
  });

  test("a computer that is off answers computer_offline at once", async () => {
    const { tree } = setup();
    tree.setOnline("Laptop1", false);
    const err = await rejection(tree.read("home/Laptop1/a.txt"));
    expect(isContractError(err, "computer_offline")).toBe(true);
    expect((err as { detail: unknown }).detail).toEqual({ computer: "Laptop1" });
    expect(isContractError(await rejection(tree.move("home/Studio/a", "home/Laptop1/a")), "computer_offline")).toBe(true);
  });

  test("a bot's call meets the fence of the computer that holds the files; the user's doesn't", async () => {
    const { tree } = setup();
    const err = await rejection(tree.write("home/Laptop1/.clover/settings/settings.json", utf8("{}"), { as: BOT }));
    expect(isContractError(err, "fenced")).toBe(true);
    expect((err as { detail: unknown }).detail).toEqual({ computer: "Laptop1", reason: "settings" });
    expect(isContractError(await rejection(tree.read("home/Laptop1/.clover/secrets.enc", { as: BOT })), "fenced")).toBe(true);
    await tree.write("home/Laptop1/.clover/settings/settings.json", utf8("{}"), { as: USER });
    await tree.write("home/Laptop1/.clover/plugins/luna/clover.json", utf8("{}"), { as: BOT });
    await tree.write("bots/alpha/memory/MEMORY.md", utf8("# Memory\n"), { as: BOT });
  });

  test("move works across computers, and refuses to clobber", async () => {
    const { tree } = setup();
    await tree.write("home/Studio/project1/README.md", utf8("hello"));
    await tree.write("home/Studio/project1/src/a.ts", utf8("export {}"));
    await tree.move("home/Studio/project1", "home/Laptop1/project1");
    expect(await tree.stat("home/Studio/project1")).toBeNull();
    expect(await tree.read("home/Laptop1/project1/src/a.ts")).toEqual(utf8("export {}"));
    await tree.write("home/Studio/b.txt", utf8("b"));
    await tree.move("home/Studio/b.txt", "home/Studio/c.txt");
    await tree.write("home/Studio/d.txt", utf8("d"));
    expect(isContractError(await rejection(tree.move("home/Studio/d.txt", "home/Studio/c.txt")), "conflict")).toBe(true);
    expect(isContractError(await rejection(tree.move("home/Studio/c.txt", "home/Laptop1/.clover/levels/c.txt", { as: BOT })), "fenced")).toBe(true);
  });

  test("glob and grep run where the files are and return tree paths", async () => {
    const { tree } = setup();
    await tree.write("home/Laptop1/p/src/a.ts", utf8("const token = 1;\nexport {}\n"));
    await tree.write("home/Laptop1/p/src/b.md", utf8("TOKEN here\n"));
    await tree.write("home/Laptop1/p/README.md", utf8("nothing\n"));
    expect(await tree.glob("**/*.ts", { cwd: "home/Laptop1/p" })).toEqual(["home/Laptop1/p/src/a.ts"]);
    expect(await tree.grep("token", { path: "home/Laptop1/p", ignoreCase: true })).toEqual([
      { path: "home/Laptop1/p/src/a.ts", line: 1, text: "const token = 1;" },
      { path: "home/Laptop1/p/src/b.md", line: 1, text: "TOKEN here" },
    ]);
    expect(await tree.grep("token", { path: "home/Laptop1/p", glob: "**/*.md" })).toEqual([]);
    expect(await tree.grep("o", { path: "home/Laptop1/p", limit: 1 })).toHaveLength(1);
  });

  test("computersFor lists the computers an action touches", () => {
    const { tree } = setup();
    expect(tree.computersFor(["home/Studio/a", "home/Laptop1/b", "bots/alpha/memory", "home/OldLaptop/c"])).toEqual(["Studio", "Laptop1"]);
  });
});
