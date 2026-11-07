// The Tree conformance suite (review S15). `runTreeConformance(make)` registers every case against the
// implementation `make` builds; `tests/tree.test.ts` runs it against FakeTree, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// where tree paths live, files on each computer, fast failure when one is
// off, the fence of the computer that holds the files, moves across computers, glob and grep, and a peer's calls:
// always fenced, its changes judged at the stricter level with a bound signed answer where that level asks (N2).
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  TREE_TRANSFER, callBindingInput, cardAnswerSigningInput, cardHashInput, type Caller, type Card, type CardOption, type SignedCardAnswer,
  type TreeTransferParams,
} from "@waifucave/clover-protocol";
import type { CallCardRenderer } from "../approval-broker";
import { isContractError } from "../common";
import { MemoryAnswerLedger } from "../fakes/approval-broker";
import { FakeClock } from "../fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, makeFakePhone, toBase64 } from "../fakes/device-registry";
import { FakeFence } from "../fakes/fence";
import { type FakeTree } from "../fakes/tree";
import { RESERVED_COMPUTER_NAMES, isReservedComputerName, memoryTreeRest, splitTreePath, transferBinding, transferChange, transferEndsHold, treeCallBinding, type TreeWatchEvent } from "../tree";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type TreeHarness = Pick<FakeTree, keyof FakeTree>;
/** Builds the implementation under test from the options the fake takes. */
export type TreeFactory = (...args: ConstructorParameters<typeof FakeTree>) => TreeHarness;

/** Cases a lane's implementation meets only in a later milestone, run as `todo` there until it does: `r1` (the
 *  holder's reviewer, J-M2) and `r15` (one answer for a move between computers, J-M2). The fake meets them all. */
export type TreePendingCase = "r1" | "r15";

export function runTreeConformance(make: TreeFactory, opts: { pending?: readonly TreePendingCase[] } = {}): void {
  const pendingOr = (key: TreePendingCase) => (opts.pending?.includes(key) ? test.todo : test);
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

  /** Two computers, a phone that answers cards, and the holders' own cards, for a peer's calls. */
  async function peerSetup() {
    const clock = new FakeClock();
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
    const phone = await makeFakePhone();
    await registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "account", account: "acct_1" });
    const options: CardOption[] = [{ id: "approve", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }];
    const binds = (computer: string, method: string, params: unknown) => ({ computer, method, params: sha256(callBindingInput(method, params)) });
    // The holder's own card for a tree change, from its built-in tables.
    const render: CallCardRenderer = (call) => {
      if (call.method === TREE_TRANSFER) {
        // R15: both ends render the same card, its text and binding from the params alone.
        const p = call.params as TreeTransferParams;
        return { kind: "tool", fields: { title: { type: "text", text: `Move ${p.from} to ${p.to}` } }, options, binds: transferBinding(p, sha256) };
      }
      return call.method.startsWith("tree.")
        ? { kind: "tool", fields: { title: { type: "text", text: `${call.method} on ${call.computer}` } }, options, binds: binds(call.computer, call.method, call.params) }
        : undefined;
    };
    const tree = make({
      clock,
      computers: {
        Studio: { home: "/Users/me", fence: new FakeFence({ home: "/Users/me", cloverHome: "/Users/me/.clover" }), level: "ask-risky" },
        Laptop1: { home: "/home/me", fence: new FakeFence({ os: "linux", home: "/home/me", cloverHome: "/home/me/.clover" }), level: "automatic" },
      },
      botComputer: () => undefined,
      devices: registry,
      // Each holder keeps its own ledger of used answers (R15: one answer counts once at each end).
      ledgers: { Studio: new MemoryAnswerLedger(), Laptop1: new MemoryAnswerLedger() },
      render,
    });
    const PEER: Caller = { kind: "peer", device: "desk0000000000000001", sessionId: "s_remote" };
    let n = 0;
    const answer = async (computer: string, method: string, params: unknown, title = `${method} on ${computer}`, bound = binds(computer, method, params)): Promise<SignedCardAnswer> => {
      const unhashed = {
        id: `card_0011223344556677889900${String(++n).padStart(2, "0")}`, kind: "tool" as const, computer, origin: "user" as const,
        issuedAt: clock.now(), expiresAt: null, fields: { title: { type: "text" as const, text: title } }, options, binds: bound,
      };
      const card = { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card;
      const at = clock.now();
      return { card, option: "approve", device: phone.id, at, signature: toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at })))) };
    };
    const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";
    return { clock, sha256, tree, PEER, answer, code };
  }

  describe("Tree", () => {
    test("home/memory/ names the caller's bot's memory, and no computer may be called memory", () => {
      expect(memoryTreeRest("home/memory/MEMORY.md")).toBe("MEMORY.md");
      expect(memoryTreeRest("home/memory")).toBe("");
      expect(memoryTreeRest("home/Studio/memory/x")).toBeUndefined();
      expect(memoryTreeRest("home/memory/../settings")).toBeUndefined();
      expect(RESERVED_COMPUTER_NAMES).toContain("memory");
      expect(memoryTreeRest("home/Memory/MEMORY.md")).toBe("MEMORY.md");
      expect(memoryTreeRest("home/MEMORY")).toBe("");
      expect([isReservedComputerName("Memory"), isReservedComputerName("Studio")]).toEqual([true, false]);
    });

    // Lane J builds home/memory/ (synced, H): it resolves for the caller's bot, and only that bot's main conversation and
    // side threads read or write it; until then the case runs as todo.
    test.todo("home/memory/ resolves to the caller's bot's memory, synced, and only its own sessions reach it");

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

    test("noFollow is refused (unsupported) until the holder honours it, never dropped (#234's review, F1)", async () => {
      const { tree } = setup();
      await tree.write("home/Laptop1/data/a.csv", utf8("x"), { as: USER });
      // Lane J's #225 replaces this case with the real walk: a plain file reached without a link is read, a link refused.
      for (const call of [
        () => tree.stat("home/Laptop1/data/a.csv", { as: USER, noFollow: true }),
        () => tree.read("home/Laptop1/data/a.csv", { as: USER, noFollow: true }),
        () => tree.stat("home/Laptop1/data/a.csv", { as: BOT, noFollow: true }),
      ]) expect(isContractError(await rejection(call()), "unsupported")).toBe(true);
      // Without it, or with it false, reads go on as before.
      expect(await tree.read("home/Laptop1/data/a.csv", { as: USER, noFollow: false })).toEqual(utf8("x"));
      expect((await tree.stat("home/Laptop1/data/a.csv", { as: USER }))?.type).toBe("file");
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
      // The installed plugins folder is fenced too (#197's check 2), and the rest of the Clover home with it (the home
      // default-deny), but for the bot's own ways in: its own routines are its to write, another bot's aren't.
      expect(isContractError(await rejection(tree.write("home/Laptop1/.clover/plugins/luna/clover.json", utf8("{}"), { as: BOT })), "fenced")).toBe(true);
      await tree.write("home/Laptop1/.clover/routines/alpha/morning.md", utf8("# Morning\n"), { as: BOT });
      expect(isContractError(await rejection(tree.write("home/Laptop1/.clover/routines/luna/morning.md", utf8("# Morning\n"), { as: BOT })), "fenced")).toBe(true);
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

    test("a peer's call is always fenced, and its changes are judged at the stricter level, with a bound signed answer where it asks (N2)", async () => {
      const { tree, PEER, answer, code } = await peerSetup();

      // Always fenced: a peer never passes as the user, whatever its level.
      expect(await code(tree.write("home/Laptop1/.clover/settings/settings.json", utf8("{}"), { as: PEER, level: "automatic" }))).toBe("fenced");
      expect(await code(tree.read("home/Laptop1/.clover/secrets.enc", { as: PEER }))).toBe("fenced");
      // Reads are never asked about; a change says its level.
      expect(await code(tree.stat("home/Studio/a.txt", { as: PEER }))).toBe("ok");
      expect(await code(tree.write("home/Laptop1/a.txt", utf8("a"), { as: PEER }))).toBe("invalid");
      // The stricter level: Laptop1 is automatic, but a call at read-only from its own computer stays read-only.
      expect(await code(tree.write("home/Laptop1/a.txt", utf8("a"), { as: PEER, level: "read-only" }))).toBe("refused");
      expect(await code(tree.write("home/Laptop1/a.txt", utf8("a"), { as: PEER, level: "automatic" }))).toBe("ok");
      // A read-only holder refuses a peer's change however the caller's level reads, signed answer or not.
      tree.setLevel("Laptop1", "read-only");
      const w = treeCallBinding("tree.write", { path: "home/Laptop1/b.txt", data: utf8("b"), session: "s_remote", level: "automatic" });
      expect(w.params).toEqual({ path: "home/Laptop1/b.txt", data: utf8("b") });
      expect(await code(tree.write("home/Laptop1/b.txt", utf8("b"), { as: PEER, level: "automatic", answer: await answer("Laptop1", w.method, w.params) }))).toBe("refused");
      expect(await tree.stat("home/Laptop1/b.txt", { as: USER })).toBeNull();
      // Studio asks for risky actions: a peer's delete there needs the user's answer bound to exactly this call.
      await tree.write("home/Studio/old.log", utf8("x"), { as: USER });
      const rm = treeCallBinding("tree.remove", { path: "home/Studio/old.log" });
      expect(await code(tree.remove("home/Studio/old.log", { as: PEER, level: "automatic" }))).toBe("refused");
      const other = treeCallBinding("tree.remove", { path: "home/Studio/keep.log" });
      expect(await code(tree.remove("home/Studio/old.log", { as: PEER, level: "automatic", answer: await answer("Studio", other.method, other.params) }))).toBe("refused");
      expect(await code(tree.remove("home/Studio/old.log", { as: PEER, level: "automatic", answer: await answer("Laptop1", rm.method, rm.params) }))).toBe("refused");
      // A card that reads something else can't carry it, however well it is signed.
      expect(await code(tree.remove("home/Studio/old.log", { as: PEER, level: "automatic", answer: await answer("Studio", rm.method, rm.params, "Show the weather") }))).toBe("refused");
      expect(await tree.stat("home/Studio/old.log", { as: USER })).not.toBeNull();
      const good = await answer("Studio", rm.method, rm.params);
      expect(await code(tree.remove("home/Studio/old.log", { as: PEER, level: "automatic", answer: good }))).toBe("ok");
      expect(await tree.stat("home/Studio/old.log", { as: USER })).toBeNull();
      // The same answer counts once.
      await tree.write("home/Studio/old.log", utf8("x"), { as: USER });
      expect(await code(tree.remove("home/Studio/old.log", { as: PEER, level: "automatic", answer: good }))).toBe("refused");
      // A move between computers is judged at the strictest of both computers' levels and the call's.
      tree.setLevel("Laptop1", "automatic");
      tree.setLevel("Studio", "automatic");
      expect(await code(tree.move("home/Studio/old.log", "home/Laptop1/old.log", { as: PEER, level: "automatic" }))).toBe("ok");
      tree.setLevel("Studio", "read-only");
      expect(await code(tree.move("home/Laptop1/old.log", "home/Studio/old.log", { as: PEER, level: "automatic" }))).toBe("refused");
      expect(await tree.stat("home/Laptop1/old.log", { as: USER })).not.toBeNull();
    });

    pendingOr("r15")("R15: a peer's move between computers is one answer both ends check against `transferBinding`'s card (`bindsComputer`), with their own ledgers; a swapped one moves nothing (`transferEndsHold`)", async () => {
      const { sha256, tree, PEER, answer, code } = await peerSetup();
      await tree.write("home/Laptop1/old.log", utf8("x"), { as: USER });
      // Studio asks for risky actions; each holder checks the one answer against its own card, with its own ledger.
      const t = transferChange(true, "home/Laptop1/old.log", "home/Studio/old.log", "Laptop1", "Studio");
      let one = await answer("Studio", t.method, t.params, "Move home/Laptop1/old.log to home/Studio/old.log");
      const move = () => tree.move("home/Laptop1/old.log", "home/Studio/old.log", { as: PEER, level: "automatic", answer: one });
      expect(await code(move())).toBe("refused"); // bound to the destination alone, as a one-computer call: neither end takes it
      one = await answer("Laptop1", t.method, t.params, "Move home/Laptop1/old.log to home/Studio/old.log", transferBinding(t.params as TreeTransferParams, sha256));
      expect(await code(move())).toBe("ok");
      expect(await tree.stat("home/Studio/old.log", { as: USER })).not.toBeNull();
      await tree.move("home/Studio/old.log", "home/Laptop1/old.log", { as: USER });
      expect(await code(move())).toBe("refused"); // used, at both ends
      // An answer for a transfer between the computers the other way round moves nothing (#179's review, check 2).
      const swapped = transferChange(true, "home/Laptop1/old.log", "home/Studio/old.log", "Studio", "Laptop1");
      expect(transferEndsHold(swapped.params as TreeTransferParams, (p) => tree.resolve(p))).toBe(false);
      expect(transferEndsHold(t.params as TreeTransferParams, (p) => tree.resolve(p))).toBe(true);
      one = await answer("Studio", swapped.method, swapped.params, "Move home/Laptop1/old.log to home/Studio/old.log", transferBinding(swapped.params as TreeTransferParams, sha256));
      expect(await code(move())).toBe("refused");
      expect(await tree.stat("home/Laptop1/old.log", { as: USER })).not.toBeNull();
    });

    pendingOr("r1")("at ask-risky the holder's own reviewer judges a peer's change: safe runs, risky needs a bound answer (ruling R1)", async () => {
      const clock = new FakeClock();
      const judged: string[] = [];
      const tree = make({
        clock,
        computers: { Studio: { home: "/Users/me", fence: new FakeFence({ home: "/Users/me", cloverHome: "/Users/me/.clover" }), level: "ask-risky" } },
        botComputer: () => undefined,
        reviewer: async (change) => {
          judged.push(`${change.method} ${change.computer} ${change.as.kind}`);
          return change.method === "tree.write" && change.params.path.endsWith(".md") ? "safe" : "risky";
        },
      });
      const PEER: Caller = { kind: "peer", device: "desk0000000000000001", sessionId: "s_remote" };
      const code = async (p: Promise<unknown>) => ((await rejection(p)) as { code?: string } | undefined)?.code ?? "ok";
      expect(await code(tree.write("home/Studio/notes.md", utf8("hi"), { as: PEER, level: "automatic" }))).toBe("ok");
      expect(await code(tree.write("home/Studio/run.sh", utf8("rm -rf ~"), { as: PEER, level: "automatic" }))).toBe("refused");
      expect(judged).toEqual(["tree.write Studio peer", "tree.write Studio peer"]);
      // A delete at ask-risky still asks, reviewer or not; and the holder's own sessions never meet the peer rule.
      expect(await code(tree.remove("home/Studio/notes.md", { as: PEER, level: "automatic" }))).toBe("refused");
      expect(await code(tree.write("home/Studio/run.sh", utf8("x"), { as: BOT }))).toBe("ok");
      expect(judged).toHaveLength(2);
    });

    test("watch follows a folder on the computer that holds it, fenced as a listing (lane J's ask)", async () => {
      const { tree } = setup();
      await tree.write("home/Laptop1/p/a.txt", utf8("a"), { as: USER });
      const seen: TreeWatchEvent[] = [];
      const changed = () => new Set(seen.flatMap((e) => (e.type === "changed" ? e.paths : [])));
      // A real holder's news comes later and coalesced; the fake's at once.
      const settle = async (done: () => boolean, ms = 3000) => {
        for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
      };
      const stop = await tree.watch("home/Laptop1/p", { as: BOT }, (e) => seen.push(e));
      await tree.write("home/Laptop1/p/b.txt", utf8("b"), { as: USER });
      await tree.write("home/Laptop1/elsewhere.txt", utf8("c"), { as: USER });
      await tree.remove("home/Laptop1/p/a.txt", { as: USER });
      await settle(() => changed().has("home/Laptop1/p/b.txt") && changed().has("home/Laptop1/p/a.txt"));
      stop();
      expect([...changed()].sort()).toEqual(["home/Laptop1/p/a.txt", "home/Laptop1/p/b.txt"]);
      const before = seen.length;
      await tree.write("home/Laptop1/p/c.txt", utf8("c"), { as: USER });
      await settle(() => false, 200);
      expect(seen.length).toBe(before);
      expect(isContractError(await rejection(tree.watch("home/Laptop1/.clover/run", { as: BOT }, () => {})), "fenced")).toBe(true);
      expect(isContractError(await rejection(tree.watch("home/Laptop1/nowhere", { as: BOT }, () => {})), "not_found")).toBe(true);
      // Never a whole home, for anyone (#179's review).
      for (const whole of ["home/Laptop1", "home/Laptop1/", "home/OldLaptop"]) {
        expect([whole, isContractError(await rejection(tree.watch(whole, { as: USER }, () => {})), "invalid")]).toEqual([whole, true]);
      }
    });

    test("a fenced name in another case or a folded spelling is refused on every computer (J-M1's review B1, #179's F1)", async () => {
      const { tree } = setup();
      // Studio runs macOS and Laptop1 Linux; the fence folds on both (a Linux home can be case-folding ext4 or APFS).
      for (const computer of ["Studio", "Laptop1"]) {
        for (const rel of [".clover/RULES/allow.json", ".clover/Settings/settings.json", ".clover/LEVELS/computer.json",
          ".clover/\u017Fettings/settings.json", ".clover/tru\u017Ft/x.json", ".clover/plugins-state/o\u212As/x.json", ".clover/\u00DFettings/x.json"]) {
          const path = `home/${computer}/${rel}`;
          expect([path, isContractError(await rejection(tree.write(path, utf8("{}"), { as: BOT })), "fenced")]).toEqual([path, true]);
        }
      }
      await tree.write("home/Studio/.clover/bots/alpha/memory/\u65E5\u8A18.md", utf8("x"), { as: BOT });
    });

    test("computersFor lists the computers an action touches", () => {
      const { tree } = setup();
      expect(tree.computersFor(["home/Studio/a", "home/Laptop1/b", "bots/alpha/memory", "home/OldLaptop/c"])).toEqual(["Studio", "Laptop1"]);
    });
  });
}
