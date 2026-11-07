// Reads that never follow a link (F-M3's review), and the tree's one path to the Clover home. The user's own file
// viewers read with `noFollow`: a link a runner planted anywhere on the way, a folder swapped for one between two
// calls, or a handle whose real path isn't the path walked, is refused, here or on another computer.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPUTERS_METHODS } from "@waifucave/clover-protocol";
import { LocalHolder } from "../../src/tree/holder";
import { hostOs } from "../../src/tree/names";
import { CoreTree, type TreeComputer } from "../../src/tree/tree";
import { Cluster } from "./cluster-support";

const USER = { kind: "user", client: "app" } as const;
const utf8 = (text: string) => ({ encoding: "utf8" as const, text });
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code ?? "ok";
const win = process.platform === "win32";
/** A link to a folder: a junction on Windows, which needs no privilege. */
const linkDir = (target: string, path: string) => symlinkSync(target, path, win ? "junction" : "dir");

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function holder(o: { cloverHome?: (root: string) => string; fdRealPath?: (fd: number, path: string) => string | null; afterLstat?: (real: string) => void } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "lane-j-nofollow-")));
  temps.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cloverHome = o.cloverHome ? o.cloverHome(root) : join(home, ".clover");
  mkdirSync(cloverHome, { recursive: true });
  const h = new LocalHolder({
    clock: { now: () => Date.now() }, name: () => "Studio", home, cloverHome, botsRoot: join(cloverHome, "bots"), os: hostOs(),
    ...(o.fdRealPath ? { fdRealPath: o.fdRealPath } : {}),
    ...(o.afterLstat ? { afterLstat: o.afterLstat } : {}),
  });
  return { h, root, home, cloverHome };
}

describe("noFollow", () => {
  test("a plain file reads; a link planted at the file, or at a folder on the way, is refused, and stat says so too", async () => {
    const { h, root, home } = holder();
    mkdirSync(join(home, "out"));
    writeFileSync(join(home, "out", "plain.md"), "plain");
    writeFileSync(join(root, "secret.txt"), "secret");
    expect(await h.read("home/Studio/out/plain.md", { as: USER, noFollow: true })).toEqual(utf8("plain"));
    expect((await h.stat("home/Studio/out/plain.md", { as: USER, noFollow: true }))?.type).toBe("file");
    expect(await h.stat("home/Studio/out/missing.md", { as: USER, noFollow: true })).toBeNull();
    expect(await code(h.read("home/Studio/out/missing.md", { as: USER, noFollow: true }))).toBe("not_found");
    expect(await code(h.read("home/Studio/out", { as: USER, noFollow: true }))).toBe("invalid");
    // A file link (here leading out of the home folder entirely).
    symlinkSync(join(root, "secret.txt"), join(home, "out", "notes.md"), "file");
    expect(await code(h.read("home/Studio/out/notes.md", { as: USER, noFollow: true }))).toBe("refused");
    expect(await code(h.stat("home/Studio/out/notes.md", { as: USER, noFollow: true }))).toBe("refused");
    // A folder link in the middle of the path, to a folder inside the home folder.
    mkdirSync(join(home, "real-dir"));
    writeFileSync(join(home, "real-dir", "a.md"), "a");
    linkDir(join(home, "real-dir"), join(home, "linked"));
    expect(await code(h.read("home/Studio/linked/a.md", { as: USER, noFollow: true }))).toBe("refused");
    expect(await code(h.stat("home/Studio/linked/a.md", { as: USER, noFollow: true }))).toBe("refused");
    // Without `noFollow`, the user's read follows a link inside the area as before.
    expect(await h.read("home/Studio/linked/a.md", { as: USER })).toEqual(utf8("a"));
  });

  test("a swap between two calls: the file a stat saw is a link by the read, and the read refuses it", async () => {
    const { h, root, home } = holder();
    mkdirSync(join(home, "out"));
    writeFileSync(join(home, "out", "page.md"), "mine");
    writeFileSync(join(root, "secret.txt"), "secret");
    expect((await h.stat("home/Studio/out/page.md", { as: USER, noFollow: true }))?.type).toBe("file");
    unlinkSync(join(home, "out", "page.md"));
    symlinkSync(join(root, "secret.txt"), join(home, "out", "page.md"), "file");
    expect(await code(h.read("home/Studio/out/page.md", { as: USER, noFollow: true }))).toBe("refused");
    // A folder on the way swapped for a link the same way.
    mkdirSync(join(home, "dir"));
    writeFileSync(join(home, "dir", "b.md"), "b");
    expect((await h.stat("home/Studio/dir/b.md", { as: USER, noFollow: true }))?.type).toBe("file");
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "b.md"), "elsewhere");
    rmSync(join(home, "dir"), { recursive: true });
    linkDir(join(root, "elsewhere"), join(home, "dir"));
    expect(await code(h.read("home/Studio/dir/b.md", { as: USER, noFollow: true }))).toBe("refused");
  });

  test("a folder swapped for a link mid-walk: the stat it gave isn't believed", async () => {
    let swap: (() => void) | undefined;
    const { h, root, home } = holder({ afterLstat: (real) => { if (real.endsWith(`${win ? "\\" : "/"}dir`) && swap) { const f = swap; swap = undefined; f(); } } });
    mkdirSync(join(home, "dir"));
    writeFileSync(join(home, "dir", "b.md"), "b");
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "b.md"), "elsewhere, longer");
    // Right after the walk looked at `dir`, it becomes a link to another folder.
    swap = () => {
      rmSync(join(home, "dir"), { recursive: true });
      linkDir(join(root, "elsewhere"), join(home, "dir"));
    };
    expect(await code(h.stat("home/Studio/dir/b.md", { as: USER, noFollow: true }))).toBe("refused");
    expect(swap).toBeUndefined();
  });

  test("the opened file's real path, from its handle, must be the path walked; an OS that won't say refuses", async () => {
    // A swap inside the call itself (between the walk and the open) shows as a handle whose real path is elsewhere.
    const elsewhere = holder({ fdRealPath: () => "/somewhere/else.md" });
    mkdirSync(join(elsewhere.home, "out"));
    writeFileSync(join(elsewhere.home, "out", "a.md"), "a");
    expect(await code(elsewhere.h.read("home/Studio/out/a.md", { as: USER, noFollow: true }))).toBe("refused");
    const silent = holder({ fdRealPath: () => null });
    mkdirSync(join(silent.home, "out"));
    writeFileSync(join(silent.home, "out", "a.md"), "a");
    expect(await code(silent.h.read("home/Studio/out/a.md", { as: USER, noFollow: true }))).toBe("refused");
    // The real primitive, on this OS: the handle names the file.
    const real = holder();
    mkdirSync(join(real.home, "out"));
    writeFileSync(join(real.home, "out", "a.md"), "a");
    expect(await real.h.read("home/Studio/out/a.md", { as: USER, noFollow: true })).toEqual(utf8("a"));
  });

  test("on another computer too: the holder there walks it", async () => {
    const cluster = new Cluster();
    try {
      const studio = await cluster.add("Studio");
      const laptop = await cluster.add("Laptop1");
      await cluster.join();
      mkdirSync(join(laptop.home, "out"), { recursive: true });
      writeFileSync(join(laptop.home, "out", "plain.md"), "plain");
      writeFileSync(join(laptop.home, "secret.txt"), "secret");
      symlinkSync(join(laptop.home, "secret.txt"), join(laptop.home, "out", "notes.md"), "file");
      const t = studio.node.tree;
      expect(await t.read("home/Laptop1/out/plain.md", { as: USER, noFollow: true })).toEqual(utf8("plain"));
      expect(await code(t.read("home/Laptop1/out/notes.md", { as: USER, noFollow: true }))).toBe("refused");
      expect(await code(t.stat("home/Laptop1/out/notes.md", { as: USER, noFollow: true }))).toBe("refused");
      expect(await code(t.readPart("home/Laptop1/out/notes.md", { as: USER, noFollow: true, encoding: "base64" }))).toBe("refused");
    } finally {
      cluster.close();
    }
  });
});

describe("a computer whose build drops noFollow", () => {
  test("its answer doesn't confirm it, so the calling computer refuses it instead of believing it", async () => {
    const cluster = new Cluster();
    try {
      const studio = await cluster.add("Studio");
      const laptop = await cluster.add("Laptop1");
      await cluster.join();
      mkdirSync(join(laptop.home, "out"), { recursive: true });
      writeFileSync(join(laptop.home, "elsewhere.md"), "elsewhere");
      symlinkSync(join(laptop.home, "elsewhere.md"), join(laptop.home, "out", "notes.md"), "file");
      // Laptop1 as an older build: lane B's schemas, which drop the key, and a read that follows links.
      const old = cluster.net.endpoint(laptop.device);
      const as = { kind: "peer" as const, device: studio.device };
      old.handle("tree.read", async (raw) => {
        const p = COMPUTERS_METHODS.treeRead.params.parse(raw);
        return laptop.node.holder.read(p.path, { as, level: "automatic", ...(p.encoding ? { encoding: p.encoding } : {}) });
      });
      old.handle("tree.stat", async (raw) => {
        const p = COMPUTERS_METHODS.treeStat.params.parse(raw);
        return { stat: await laptop.node.holder.stat(p.path, { as, level: "automatic" }) };
      });
      const t = studio.node.tree;
      const read = await t.read("home/Laptop1/out/notes.md", { as: USER, noFollow: true }).then(() => undefined, (e: unknown) => e);
      expect(read).toMatchObject({ code: "refused", detail: { reason: "unsupported" } });
      expect(await code(t.stat("home/Laptop1/out/notes.md", { as: USER, noFollow: true }))).toBe("refused");
      // A read that didn't ask for it is answered as before.
      expect(await t.read("home/Laptop1/out/notes.md", { as: USER })).toEqual(utf8("elsewhere"));
    } finally {
      cluster.close();
    }
  });
});

describe("the read-denied items", () => {
  test("are no one's through the tree, the user's surfaces included, here and from another computer", async () => {
    const cluster = new Cluster();
    try {
      const studio = await cluster.add("Studio");
      const laptop = await cluster.add("Laptop1");
      await cluster.join();
      mkdirSync(join(laptop.cloverHome, "run"), { recursive: true });
      writeFileSync(join(laptop.cloverHome, "run", "core.json"), "{\"token\":\"not-a-secret\"}");
      writeFileSync(join(laptop.cloverHome, "notes.md"), "fine");
      const CORE = { kind: "core" } as const;
      for (const [tree, as] of [[laptop.node.tree, USER], [laptop.node.tree, CORE], [studio.node.tree, USER]] as const) {
        expect(await code(tree.read("home/Laptop1/.clover/run/core.json", { as }))).toBe("fenced");
        expect(await code(tree.read("home/Laptop1/.clover/run/core.json", { as, noFollow: true }))).toBe("fenced");
        expect(await code(tree.stat("home/Laptop1/.clover/run/core.json", { as }))).toBe("fenced");
        expect(await code(tree.list("home/Laptop1/.clover/run", { as }))).toBe("fenced");
        if (tree === laptop.node.tree) {
          expect((await tree.list("home/Laptop1/.clover", { as })).map((e) => e.path)).not.toContain("home/Laptop1/.clover/run");
          expect(await tree.glob("**/*", { as, cwd: "home/Laptop1/.clover" })).not.toContain("home/Laptop1/.clover/run/core.json");
          expect(await tree.read("home/Laptop1/.clover/notes.md", { as })).toEqual(utf8("fine"));
        } else {
          // Through another computer the call is a peer's, and #234's home default-deny refuses a peer the whole Clover
          // home, its listing and the rest of it included.
          expect(await code(tree.list("home/Laptop1/.clover", { as }))).toBe("fenced");
          expect(await code(tree.read("home/Laptop1/.clover/notes.md", { as }))).toBe("fenced");
        }
      }
    } finally {
      cluster.close();
    }
  });
});

describe("home/<Computer>/.clover", () => {
  test("is this computer's Clover home wherever it is on disk (the dev profile's ~/.clover-dev, CLOVER_HOME)", async () => {
    const { h, home, cloverHome } = holder({ cloverHome: (root) => join(root, "elsewhere", ".clover-dev") });
    await h.write("home/Studio/.clover/outputs/s_1/week.md", utf8("# Week\n"), { as: USER });
    expect(await h.read("home/Studio/.clover/outputs/s_1/week.md", { as: USER, noFollow: true })).toEqual(utf8("# Week\n"));
    expect((await h.list("home/Studio/.clover/outputs/s_1", { as: USER })).map((s) => s.path)).toEqual(["home/Studio/.clover/outputs/s_1/week.md"]);
    expect(Bun.file(join(cloverHome, "outputs", "s_1", "week.md")).size).toBeGreaterThan(0);
    // Nothing went to `<home>/.clover`.
    expect(await Bun.file(join(home, ".clover", "outputs", "s_1", "week.md")).exists()).toBe(false);
  });

  test("the tree resolves it, and names a real path in it, from the computer's own Clover home", () => {
    const c: TreeComputer = { name: "Studio", aliases: [], online: true, level: "automatic", home: "/Users/me", os: "macos", botsRoot: "/Users/me/.clover-dev/bots" };
    const tree = new CoreTree({ directory: { self: () => "Studio", get: (n) => (n === "Studio" ? c : undefined) }, holder: () => { throw new Error("unused"); }, botComputer: () => undefined });
    expect(tree.resolve("home/Studio/.clover/outputs/s_1/week.md").path).toBe("/Users/me/.clover-dev/outputs/s_1/week.md");
    expect(tree.resolve("home/Studio/notes.md").path).toBe("/Users/me/notes.md");
    expect(tree.toTreePath("Studio", "/Users/me/.clover-dev/outputs/s_1/week.md")).toBe("home/Studio/.clover/outputs/s_1/week.md");
    expect(tree.toTreePath("Studio", "/Users/me/notes.md")).toBe("home/Studio/notes.md");
  });
});
