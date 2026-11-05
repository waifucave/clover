// The Tree conformance suite (review S15). `runTreeConformance(make)` registers every case against the
// implementation `make` builds; `tests/tree.test.ts` runs it against FakeTree, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// where tree paths live, files on each computer, fast failure when one is
// off, the fence of the computer that holds the files, moves across computers, glob and grep.
import { describe, expect, test } from "bun:test";
import type { Caller } from "@waifucave/clover-protocol";
import { isContractError } from "../common";
import { FakeClock } from "../fakes/clock";
import { FakeFence } from "../fakes/fence";
import { type FakeTree } from "../fakes/tree";
import { splitTreePath } from "../tree";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type TreeHarness = Pick<FakeTree, keyof FakeTree>;
/** Builds the implementation under test from the options the fake takes. */
export type TreeFactory = (...args: ConstructorParameters<typeof FakeTree>) => TreeHarness;

export function runTreeConformance(make: TreeFactory): void {
  const BOT: Caller = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" };
  const USER: Caller = { kind: "user", client: "app" };
  const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
  const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

  function setup() {
    let runsAlpha = "Studio";
    const tree = make({
      clock: new FakeClock(),
      computers: {
        Studio: { home: "/Users/me", botsRoot: "/Users/me/.clover/bots", fence: new FakeFence({ home: "/Users/me", cloverHome: "/Users/me/.clover" }) },
        Laptop1: { home: "/home/me", botsRoot: "/home/me/.clover/bots", aliases: ["OldLaptop"], fence: new FakeFence({ os: "linux", home: "/home/me", cloverHome: "/home/me/.clover" }) },
      },
      botComputer: (bot) => (bot === "alpha" || bot === "pack/luna" ? runsAlpha : undefined),
    });
    return { tree, moveAlpha: (to: string) => (runsAlpha = to) };
  }

  describe("Tree", () => {
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

    test("a path never climbs out of its area, and every call says whom it is for", async () => {
      const { tree } = setup();
      const invalid = (path: string) => isContractError((() => { try { tree.resolve(path); } catch (e) { return e; } })(), "invalid");
      for (const path of ["home/Studio/../../etc/passwd", "bots/alpha/../../settings/x.json", "home/Studio/./a", "home/Studio//a", "home/..", "bots/alpha/a\\..\\b", "home/Studio/a\0b"]) {
        expect([path, invalid(path)]).toEqual([path, true]);
      }
      expect(splitTreePath("home/Studio/../x")).toBeNull();
      // A call that doesn't say whom it is for is refused, never run unfenced.
      expect(isContractError(await rejection(tree.write("home/Laptop1/.clover/settings/settings.json", utf8("{}"), {} as never)), "invalid")).toBe(true);
      expect(isContractError(await rejection(tree.write("bots/alpha/../../settings/x.json", utf8("{}"), { as: BOT })), "invalid")).toBe(true);
    });

    test("files are read, written, listed, stat'ed and removed on the computer that holds them", async () => {
      const { tree } = setup();
      await tree.write("home/Laptop1/data/a.csv", utf8("x,y\n1,2\n"), { as: USER });
      await tree.write("home/Laptop1/data/run.sh", { encoding: "base64", data: btoa("#!/bin/sh\necho hi\n") }, { executable: true, as: USER });
      expect(await tree.read("home/Laptop1/data/a.csv", { as: USER })).toEqual(utf8("x,y\n1,2\n"));
      expect(await tree.read("home/Laptop1/data/run.sh", { encoding: "base64", as: USER })).toEqual({ encoding: "base64", data: btoa("#!/bin/sh\necho hi\n") });
      expect((await tree.list("home/Laptop1/data", { as: USER })).map((s) => [s.path, s.type, s.executable])).toEqual([
        ["home/Laptop1/data/a.csv", "file", false],
        ["home/Laptop1/data/run.sh", "file", true],
      ]);
      expect(await tree.stat("home/Studio/data/a.csv", { as: USER })).toBeNull();
      expect(isContractError(await rejection(tree.remove("home/Laptop1/data", { as: USER })), "invalid")).toBe(true);
      await tree.remove("home/Laptop1/data", { recursive: true, as: USER });
      expect(await tree.stat("home/Laptop1/data", { as: USER })).toBeNull();
    });

    test("a computer that is off answers computer_offline at once", async () => {
      const { tree } = setup();
      tree.setOnline("Laptop1", false);
      const err = await rejection(tree.read("home/Laptop1/a.txt", { as: USER }));
      expect(isContractError(err, "computer_offline")).toBe(true);
      expect((err as { detail: unknown }).detail).toEqual({ computer: "Laptop1" });
      expect(isContractError(await rejection(tree.move("home/Studio/a", "home/Laptop1/a", { as: USER })), "computer_offline")).toBe(true);
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
      await tree.write("home/Studio/project1/README.md", utf8("hello"), { as: USER });
      await tree.write("home/Studio/project1/src/a.ts", utf8("export {}"), { as: USER });
      await tree.move("home/Studio/project1", "home/Laptop1/project1", { as: USER });
      expect(await tree.stat("home/Studio/project1", { as: USER })).toBeNull();
      expect(await tree.read("home/Laptop1/project1/src/a.ts", { as: USER })).toEqual(utf8("export {}"));
      await tree.write("home/Studio/b.txt", utf8("b"), { as: USER });
      await tree.move("home/Studio/b.txt", "home/Studio/c.txt", { as: USER });
      await tree.write("home/Studio/d.txt", utf8("d"), { as: USER });
      expect(isContractError(await rejection(tree.move("home/Studio/d.txt", "home/Studio/c.txt", { as: USER })), "conflict")).toBe(true);
      expect(isContractError(await rejection(tree.move("home/Studio/c.txt", "home/Laptop1/.clover/levels/c.txt", { as: BOT })), "fenced")).toBe(true);
    });

    test("glob and grep run where the files are and return tree paths", async () => {
      const { tree } = setup();
      await tree.write("home/Laptop1/p/src/a.ts", utf8("const token = 1;\nexport {}\n"), { as: USER });
      await tree.write("home/Laptop1/p/src/b.md", utf8("TOKEN here\n"), { as: USER });
      await tree.write("home/Laptop1/p/README.md", utf8("nothing\n"), { as: USER });
      expect(await tree.glob("**/*.ts", { cwd: "home/Laptop1/p", as: USER })).toEqual(["home/Laptop1/p/src/a.ts"]);
      expect(await tree.grep("token", { path: "home/Laptop1/p", ignoreCase: true, as: USER })).toEqual([
        { path: "home/Laptop1/p/src/a.ts", line: 1, text: "const token = 1;" },
        { path: "home/Laptop1/p/src/b.md", line: 1, text: "TOKEN here" },
      ]);
      expect(await tree.grep("token", { path: "home/Laptop1/p", glob: "**/*.md", as: USER })).toEqual([]);
      expect(await tree.grep("o", { path: "home/Laptop1/p", limit: 1, as: USER })).toHaveLength(1);
    });

    test("computersFor lists the computers an action touches", () => {
      const { tree } = setup();
      expect(tree.computersFor(["home/Studio/a", "home/Laptop1/b", "bots/alpha/memory", "home/OldLaptop/c"])).toEqual(["Studio", "Laptop1"]);
    });
  });
}
