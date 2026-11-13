// Each bot's memory, kept alike on the user's computers (H-M3): a write on one appears on the others, live and after a
// computer comes back (over a link, or as sealed mail when the writer is off by then); concurrent edits keep both
// copies; a revoked device gets nothing new after the content key's rotation; a forged writer, over-cap pushes and
// paths that leave the bot's memory are refused; nothing is written through a link.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { botPaths } from "../../bots/paths";
import { SystemClock } from "../../clock/system-clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { BoxKey } from "../../identity/box-key";
import { fromUtf8, toBase64 } from "../../identity/bytes";
import { type ClusterDevice, makeDeviceKey, makeLinkCluster, recordFor } from "../../links/testing";
import { MAIL_MAX_PIECE, MemoryMailRelay, type SyncMailbox } from "../mailbox";
import { keyCommit, keyStatement } from "../memory-keys";
import { COUNTER_STEP, type MemoryEntry, type MemoryLimits, MemorySync, type PushResult, type SkipReason, versionStatement } from "../memory";
import { memoryPath, readMemoryFile, removeMemoryFile, writeMemoryFile } from "../memory-files";

const clock = new SystemClock();
// A link cut and healed again re-dials with its backoff: give those tests room.
setDefaultTimeout(20_000);
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const BOT = "alpha";
const DAY = Date.UTC(2026, 10, 6, 12);

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

interface Computer {
  d: ClusterDevice;
  home: string;
  box: BoxKey;
  sync: MemorySync;
  write(rel: string, text: string): void;
  read(rel: string): string | undefined;
  remove(rel: string): void;
  restart(): Promise<void>;
}

async function world(names: string[], opts: { limits?: Record<string, Partial<MemoryLimits>>; mail?: boolean; mailbox?: (relay: MemoryMailRelay, device: string) => SyncMailbox; keyFor?: (name: string, key: ClusterDevice["key"]) => { sign(data: Uint8Array): Uint8Array } } = {}) {
  const c = await makeLinkCluster(names, { clock });
  stops.push(() => c.close());
  const relay = new MemoryMailRelay();
  // The shared clock, which a test moves on by hand so the later of two concurrent writes is known.
  let now = DAY;
  const tick = () => (now += 1_000);
  const computers = new Map<string, Computer>();
  for (const n of names) {
    const d = c.devices.get(n)!;
    const home = mkdtempSync(join(tmpdir(), "clover-h-memory-"));
    stops.push(() => rmSync(home, { recursive: true, force: true }));
    const box = BoxKey.generate();
    const store = new MemorySecretStore();
    const start = () => MemorySync.start({
      home, self: d.id, key: opts.keyFor?.(n, d.key) ?? d.key, boxKey: box, store, transport: d.transport, registry: d.registry, now: () => now,
      ...(opts.mail ? { mailbox: opts.mailbox?.(relay, d.id) ?? relay.for(d.id), mailDelayMs: 0, mailRetryMs: 100 } : {}),
      ...(opts.limits?.[n] ? { limits: opts.limits[n] } : {}),
    });
    const root = botPaths(home, BOT).memory;
    const me: Computer = {
      d, home, box, sync: await start(),
      write(rel, text) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
        tick();
        me.sync.changed(BOT, rel);
      },
      read(rel) {
        const p = join(root, rel);
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      },
      remove(rel) {
        unlinkSync(join(root, rel));
        tick();
        me.sync.changed(BOT, rel);
      },
      async restart() {
        me.sync.close();
        me.sync = await start();
      },
    };
    stops.push(() => me.sync.close());
    computers.set(n, me);
  }
  const at = (n: string) => computers.get(n)!;
  /** Brings a link up, again after a heal (a dial that just failed backs off, so this asks until one answers). */
  const link = async (a: string, b: string) => {
    const end = Date.now() + 5_000;
    for (;;) {
      try {
        await at(a).d.transport.connect(at(b).d.id);
        return;
      } catch (e) {
        if (Date.now() > end) throw e;
        at(a).d.transport.networkChanged();
        await Bun.sleep(20);
      }
    }
  };
  const linkAll = async () => {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) await link(names[i]!, names[j]!);
  };
  return { c, relay, at, link, linkAll, tick };
}

/** A version `signer` signs, saying `by` wrote it: a deletion, so it needs no content key. */
function deletion(signer: ClusterDevice, rel: string, o: { by?: string; bot?: string; n?: number } = {}): MemoryEntry {
  const by = o.by ?? signer.id;
  const v = { rel, vv: { [by]: o.n ?? 9 }, ts: DAY + 99_000, by, hash: null, size: 0, sig: "" };
  return { ...v, sig: toBase64(signer.key.sign(versionStatement(o.bot ?? BOT, v))) };
}

/** A push whose one entry was skipped for `reason` (the rest of a push is taken; #232's review, B3). */
const skipped = (reason: SkipReason): PushResult => ({ ok: true, took: 0, conflicts: 0, skipped: [{ rel: "MEMORY.md", reason }] });

async function push(from: Computer, to: Computer, entries: unknown[], bot = BOT): Promise<PushResult> {
  const link = await from.d.transport.connect(to.d.id);
  return link.request<PushResult>("sync.push", { stream: `memory:${bot}`, entries });
}

describe("a bot's memory across computers", () => {
  test("a write on one computer appears on the others, two and three computers, edits and removals alike", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "# Memory\n- [likes](likes.md)\n");
    w.at("Studio").write("likes.md", "tea\n");
    for (const n of ["Laptop", "Server"]) await waitFor(() => w.at(n).read("MEMORY.md") === "# Memory\n- [likes](likes.md)\n" && w.at(n).read("likes.md") === "tea\n");
    // The bot moves to the laptop and edits there; a nested folder comes along.
    w.at("Laptop").write("likes.md", "tea, green\n");
    w.at("Laptop").write("people/sam.md", "a friend\n");
    for (const n of ["Studio", "Server"]) await waitFor(() => w.at(n).read("likes.md") === "tea, green\n" && w.at(n).read("people/sam.md") === "a friend\n");
    w.at("Server").remove("likes.md");
    for (const n of ["Studio", "Laptop"]) await waitFor(() => w.at(n).read("likes.md") === undefined);
    // No conflict copies, and every computer knows the same versions.
    for (const n of ["Studio", "Laptop", "Server"]) expect(readdirSync(botPaths(w.at(n).home, BOT).memory).sort()).toEqual(["MEMORY.md", "people"]);
    expect(w.at("Server").sync.versions(BOT)).toEqual(w.at("Studio").sync.versions(BOT));
    // What a computer knows survives a restart: nothing on disk changed, so no new version is made.
    const before = w.at("Laptop").sync.versions(BOT);
    await w.at("Laptop").restart();
    w.at("Laptop").sync.scanAll();
    expect(w.at("Laptop").sync.versions(BOT)).toEqual(before);
  });

  test("a write while a computer is off reaches it when it comes back, from the writer or from another computer", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    const key = (n: string) => w.at(n).d.key.publicKey;
    w.c.net.partition(key("Server"));
    w.at("Studio").write("MEMORY.md", "written while the server was off\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "written while the server was off\n");
    expect(w.at("Server").read("MEMORY.md")).toBeUndefined();
    // The server comes back while the studio is off: the laptop carries the studio's write to it.
    w.c.net.partition(key("Studio"));
    w.c.net.heal(key("Server"));
    await w.link("Server", "Laptop");
    await waitFor(() => w.at("Server").read("MEMORY.md") === "written while the server was off\n");
    // And a later write from the studio, once it's back, reaches it straight.
    w.c.net.heal(key("Studio"));
    await w.link("Studio", "Server");
    w.at("Studio").write("MEMORY.md", "and again\n");
    await waitFor(() => w.at("Server").read("MEMORY.md") === "and again\n");
  });

  test("sealed mail carries a write to a computer that is off, when the writer is off by the time it's back", async () => {
    const w = await world(["Studio", "Laptop"], { mail: true });
    await w.linkAll();
    // Account-less computers trade their box keys as the link comes up.
    w.at("Studio").write("MEMORY.md", "first\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "first\n");
    w.c.net.partition(w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    w.at("Studio").write("MEMORY.md", "a secret only the laptop may read\n");
    await waitFor(() => w.relay.held(w.at("Laptop").d.id).length === 1);
    // The relay holds it sealed: neither the content nor the file's name is in it.
    const held = fromUtf8(w.relay.held(w.at("Laptop").d.id)[0]!);
    expect(held).not.toContain("a secret");
    expect(held).not.toContain("MEMORY");
    // The studio goes off; the laptop comes back and reads its mail.
    w.c.net.partition(w.at("Studio").d.key.publicKey);
    w.c.net.heal(w.at("Laptop").d.key.publicKey);
    expect(await w.at("Laptop").sync.takeMail()).toBe(1);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("a secret only the laptop may read\n");
    expect(w.relay.held(w.at("Laptop").d.id)).toEqual([]);
  });

  test("a peer's box key that isn't usable counts as none: its mail waits, and the others' still goes", async () => {
    const w = await world(["Studio", "Laptop", "Server"], { mail: true });
    await w.linkAll();
    w.at("Studio").write("seed.md", "x\n");
    await waitFor(() => w.at("Laptop").read("seed.md") === "x\n" && w.at("Server").read("seed.md") === "x\n");
    // A key kept before keys were checked: the laptop's is a low-order point in the studio's peers file.
    const peersFile = join(w.at("Studio").home, "sync", "memory-peers.json");
    const peers = JSON.parse(readFileSync(peersFile, "utf8")) as { v: 1; boxKeys: Record<string, string> };
    peers.boxKeys[w.at("Laptop").d.id] = Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex").toString("base64url");
    writeFileSync(peersFile, JSON.stringify(peers));
    for (const n of ["Laptop", "Server"]) w.c.net.partition(w.at(n).d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    await w.at("Studio").restart();
    w.at("Studio").write("MEMORY.md", "for the server\n");
    await waitFor(() => w.relay.held(w.at("Server").d.id).length === 1);
    expect(w.relay.held(w.at("Laptop").d.id)).toEqual([]);
  });

  test("mail that can't be sealed for one peer goes again, and the other peer's goes at once", async () => {
    const fail = { next: false };
    const w = await world(["Studio", "Laptop", "Server"], {
      mail: true,
      keyFor: (n, key) => n !== "Studio" ? key : {
        sign: (data) => {
          if (fail.next && fromUtf8(data).startsWith("clover-memory-v1 mail")) {
            fail.next = false;
            throw new Error("the signer is busy");
          }
          return key.sign(data);
        },
      },
    });
    await w.linkAll();
    w.at("Studio").write("seed.md", "x\n");
    await waitFor(() => w.at("Laptop").read("seed.md") === "x\n" && w.at("Server").read("seed.md") === "x\n");
    for (const n of ["Laptop", "Server"]) w.c.net.partition(w.at(n).d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    fail.next = true;
    w.at("Studio").write("MEMORY.md", "for both\n");
    // The first peer's piece fails to seal: re-queued, it goes on the retry timer; the other's isn't held back.
    await waitFor(() => w.relay.held(w.at("Laptop").d.id).length === 1 && w.relay.held(w.at("Server").d.id).length === 1);
    expect(fail.next).toBe(false);
    w.c.net.partition(w.at("Studio").d.key.publicKey);
    for (const n of ["Laptop", "Server"]) {
      w.c.net.heal(w.at(n).d.key.publicKey);
      expect(await w.at(n).sync.takeMail()).toBe(1);
      expect(w.at(n).read("MEMORY.md")).toBe("for both\n");
    }
  });

  test("mail its sender's key didn't sign is dropped", async () => {
    const w = await world(["Studio", "Laptop", "Server"], { mail: true });
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "first\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "first\n" && w.at("Server").read("MEMORY.md") === "first\n");
    w.c.net.partition(w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up && l.peer === w.at("Laptop").d.id));
    w.at("Studio").write("MEMORY.md", "second\n");
    await waitFor(() => w.relay.held(w.at("Laptop").d.id).length === 1);
    // The server, a computer of the user's too, passes the studio's piece off as its own.
    const piece = JSON.parse(fromUtf8(w.relay.held(w.at("Laptop").d.id)[0]!)) as Record<string, unknown>;
    const laptopBox = w.relay.for(w.at("Laptop").d.id);
    await laptopBox.ack((await laptopBox.take()).map((m) => m.id));
    await w.relay.for(w.at("Server").d.id).put({ to: w.at("Laptop").d.id, id: "forged", sealed: new TextEncoder().encode(JSON.stringify({ ...piece, from: w.at("Server").d.id })), expiresAt: Date.now() + 60_000 });
    w.c.net.partition(w.at("Studio").d.key.publicKey);
    w.c.net.partition(w.at("Server").d.key.publicKey);
    w.c.net.heal(w.at("Laptop").d.key.publicKey);
    expect(await w.at("Laptop").sync.takeMail()).toBe(0);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("first\n");
  });

  test("concurrent edits keep both: the later stays, the other is a conflict copy beside it, alike on both computers", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "base\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "base\n");
    w.c.net.partition(w.at("Studio").d.key.publicKey, w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    w.at("Studio").write("MEMORY.md", "the studio's edit\n");
    // A version's time is the shared clock's when the change is seen: the laptop's is the later.
    await Bun.sleep(5);
    w.at("Laptop").write("MEMORY.md", "the laptop's later edit\n");
    w.c.net.heal(w.at("Studio").d.key.publicKey, w.at("Laptop").d.key.publicKey);
    await w.link("Studio", "Laptop");
    // Named from what the loser's writer signed alone: its id, its date and its content's hash (the same everywhere).
    const copy = `MEMORY (conflict ${w.at("Studio").d.id.slice(0, 8)} 2026-11-06 ${createHash("sha256").update("the studio's edit\n").digest("hex").slice(0, 8)}).md`;
    for (const n of ["Studio", "Laptop"]) {
      await waitFor(() => w.at(n).read(copy) === "the studio's edit\n");
      expect(w.at(n).read("MEMORY.md")).toBe("the laptop's later edit\n");
    }
    await waitFor(() => Bun.deepEquals(w.at("Studio").sync.versions(BOT), w.at("Laptop").sync.versions(BOT)));
    expect(readdirSync(botPaths(w.at("Studio").home, BOT).memory).sort()).toEqual([copy, "MEMORY.md"]);
    // The bot merges the two and removes the copy; that goes everywhere as usual.
    w.at("Laptop").write("MEMORY.md", "both edits, merged\n");
    w.at("Laptop").remove(copy);
    await waitFor(() => w.at("Studio").read("MEMORY.md") === "both edits, merged\n" && w.at("Studio").read(copy) === undefined);
  });

  test("an edit beats a concurrent removal", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.linkAll();
    w.at("Studio").write("likes.md", "tea\n");
    await waitFor(() => w.at("Laptop").read("likes.md") === "tea\n");
    w.c.net.partition(w.at("Studio").d.key.publicKey, w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    w.at("Laptop").write("likes.md", "tea, green\n");
    await Bun.sleep(5);
    // The removal is the later, and still loses.
    w.at("Studio").remove("likes.md");
    w.c.net.heal(w.at("Studio").d.key.publicKey, w.at("Laptop").d.key.publicKey);
    await w.link("Studio", "Laptop");
    await waitFor(() => w.at("Studio").read("likes.md") === "tea, green\n");
    expect(w.at("Laptop").read("likes.md")).toBe("tea, green\n");
  });

  test("a revoked device gets nothing new: its links are cut, and what's sent after is sealed under a key it never held", async () => {
    const w = await world(["Studio", "Laptop", "Old"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "before\n");
    for (const n of ["Laptop", "Old"]) await waitFor(() => w.at(n).read("MEMORY.md") === "before\n");
    const oldId = w.at("Old").d.id;
    expect(w.at("Old").sync.keys().length).toBeGreaterThan(0);
    const keysBefore = w.at("Studio").sync.keys().length;
    await w.at("Studio").d.registry.revoke(oldId);
    await w.at("Laptop").d.registry.revoke(oldId);
    // The revocation rotates the key.
    await waitFor(() => w.at("Studio").sync.keys().length > keysBefore);
    w.at("Studio").write("MEMORY.md", "after\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "after\n");
    await Bun.sleep(100);
    expect(w.at("Old").read("MEMORY.md")).toBe("before\n");
    // What the studio sends now is sealed under a key made without the old device: its keys don't open it.
    const link = await w.at("Laptop").d.transport.connect(w.at("Studio").d.id);
    const page = await link.request<{ entries: MemoryEntry[] }>("sync.pull", { stream: `memory:${BOT}`, have: {}, after: "", limit: 64 });
    const e = page.entries.find((x) => x.rel === "MEMORY.md")!;
    const used = w.at("Studio").sync.keys().find((k) => k.kid === e.kid)!;
    expect(used.members).not.toContain(oldId);
    expect(w.at("Old").sync.keys().map((k) => k.kid)).not.toContain(e.kid);
    expect(w.at("Old").sync.openContent(BOT, e)).toBeUndefined();
    expect(fromUtf8(w.at("Laptop").sync.openContent(BOT, e)!)).toBe("after\n");
    // And it can't reach either computer to ask.
    expect(await w.at("Old").d.transport.connect(w.at("Studio").d.id).then(() => "linked", () => "refused")).toBe("refused");
  });

  test("a forged writer's entry is skipped: a version another computer signed, an unknown or revoked writer, another bot's version", async () => {
    const w = await world(["Studio", "Laptop", "Server", "Gone"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "kept\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "kept\n");
    const studio = w.at("Studio").d;
    const server = w.at("Server");
    const laptop = w.at("Laptop");
    // The server signs a removal and says the studio wrote it.
    expect(await push(server, laptop, [deletion(server.d, "MEMORY.md", { by: studio.id })])).toEqual(skipped("not_writer"));
    // No signature that checks.
    expect(await push(server, laptop, [{ ...deletion(server.d, "MEMORY.md"), sig: toBase64(new Uint8Array(64)) }])).toEqual(skipped("not_writer"));
    // A writer this computer doesn't know.
    expect(await push(server, laptop, [deletion(server.d, "MEMORY.md", { by: "z".repeat(32) })])).toEqual(skipped("not_writer"));
    // A revoked writer's own signature.
    const gone = w.at("Gone").d;
    await laptop.d.registry.revoke(gone.id);
    expect(await push(server, laptop, [deletion(gone, "MEMORY.md")])).toEqual(skipped("not_writer"));
    // The studio's own version for another bot, replayed into this one.
    expect(await push(server, laptop, [deletion(studio, "MEMORY.md", { bot: "luna" })])).toEqual(skipped("not_writer"));
    expect(laptop.read("MEMORY.md")).toBe("kept\n");
    // A real one from the server, which is a computer of the user's, is taken.
    expect(await push(server, laptop, [deletion(server.d, "MEMORY.md", { n: 1 })])).toMatchObject({ ok: true });
  });

  test("paths that leave the bot's memory, or name another bot's, are refused", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.linkAll();
    const studio = w.at("Studio");
    const laptop = w.at("Laptop");
    for (const rel of ["../luna/memory/MEMORY.md", "/etc/passwd", "a/../../b.md", "C:/x.md", "a\\b.md", "./x.md", "a//b.md", "", "x\n.md"]) {
      expect(await push(studio, laptop, [deletion(studio.d, rel)])).toMatchObject({ ok: false, reason: "bad_path" });
    }
    // Not a bot's id: no stream at all.
    expect(await push(studio, laptop, [deletion(studio.d, "x.md")], "../luna").catch((e: Error) => e.message)).toContain("bad params");
    expect(existsSync(join(laptop.home, "bots", "luna"))).toBe(false);
  });

  test("over-cap pushes are refused whole, never cut short", async () => {
    const limits: Partial<MemoryLimits> = { pushEntries: 4, fileBytes: 64, botBytes: 200 };
    const w = await world(["Studio", "Laptop"], { limits: { Laptop: limits } });
    await w.linkAll();
    const studio = w.at("Studio");
    const laptop = w.at("Laptop");
    expect(await push(studio, laptop, [{}, {}, {}, {}, {}])).toMatchObject({ ok: false, reason: "too_many" });
    // A file over the laptop's 64 bytes.
    studio.write("big.md", "x".repeat(100));
    await Bun.sleep(150);
    expect(laptop.read("big.md")).toBeUndefined();
    studio.remove("big.md");
    await Bun.sleep(100);
    // Four files of 60 bytes go in one push: 240 bytes is over the laptop's 200 for the bot, so none of them lands.
    for (let i = 0; i < 4; i++) writeFileSync(join(botPaths(studio.home, BOT).memory, `f${i}.md`), "y".repeat(60));
    studio.sync.changed(BOT);
    await Bun.sleep(150);
    for (let i = 0; i < 4; i++) expect(laptop.read(`f${i}.md`)).toBeUndefined();
    // Three fit: the laptop takes them when it next catches up, a page of four at most at a time.
    studio.remove("f3.md");
    await laptop.sync.catchUpFrom(studio.d.id);
    for (let i = 0; i < 3; i++) expect(laptop.read(`f${i}.md`)).toBe("y".repeat(60));
    expect(laptop.read("f3.md")).toBeUndefined();
  });

  test("nothing is written through a link in the memory folder", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.linkAll();
    const laptop = w.at("Laptop");
    const outside = mkdtempSync(join(tmpdir(), "clover-h-outside-"));
    stops.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "target.md"), "not memory\n");
    const root = botPaths(laptop.home, BOT).memory;
    mkdirSync(root, { recursive: true });
    symlinkSync(join(outside, "target.md"), join(root, "notes.md"));
    symlinkSync(outside, join(root, "sub"));
    w.at("Studio").write("notes.md", "a note\n");
    w.at("Studio").write("sub/target.md", "through the folder link\n");
    await waitFor(() => laptop.read("notes.md") === "a note\n");
    await Bun.sleep(100);
    // The link was replaced by a file of its own; the folder link was never written through.
    expect(lstatSync(join(root, "notes.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("not memory\n");
    expect(lstatSync(join(root, "sub")).isSymbolicLink()).toBe(true);
  });

  test("a link the bot left in its own memory to another bot's is never followed: nothing of the other bot's is sent", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.linkAll();
    const studio = w.at("Studio");
    const luna = botPaths(studio.home, "luna").memory;
    mkdirSync(join(luna, "private"), { recursive: true });
    writeFileSync(join(luna, "MEMORY.md"), "luna's secret\n");
    writeFileSync(join(luna, "private", "diary.md"), "luna's diary\n");
    const root = botPaths(studio.home, BOT).memory;
    mkdirSync(root, { recursive: true });
    // Alpha's runner plants a file link, a folder link and a hard link to luna's memory in its own.
    symlinkSync(join(luna, "MEMORY.md"), join(root, "stolen.md"));
    symlinkSync(join(luna, "private"), join(root, "private"));
    linkSync(join(luna, "MEMORY.md"), join(root, "hard.md"));
    studio.write("MEMORY.md", "alpha's own\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "alpha's own\n");
    await Bun.sleep(100);
    expect(readdirSync(botPaths(w.at("Laptop").home, BOT).memory)).toEqual(["MEMORY.md"]);
    expect(Object.keys(studio.sync.versions(BOT))).toEqual(["memory.md"]);
    // Read straight, by name: nothing comes back through any of them.
    for (const rel of ["stolen.md", "private/diary.md", "hard.md"]) expect(readMemoryFile(studio.home, root, rel, 1 << 20)).toBeUndefined();
    // Luna's memory goes on as luna's own, under its own stream, and nowhere in alpha's; its MEMORY.md, which now has
    // a second link, doesn't go at all, as a file with two names is never read.
    await waitFor(() => w.at("Laptop").sync.versions("luna")["private/diary.md"] !== undefined);
    expect(readdirSync(botPaths(w.at("Laptop").home, "luna").memory)).toEqual(["private"]);
  });

  test("the sync methods carry sessions' records and memory side by side", async () => {
    const w = await world(["Studio", "Laptop"]);
    const { SessionRecordSync } = await import("../session-records");
    const host = { tap: () => () => {}, history: () => [], list: () => [], get: () => undefined, head: () => 0, ingest: () => {}, setAside: () => [], appendLate: () => {}, earlier: () => [], readEarlier: () => [], ackEarlier: () => {} };
    for (const n of ["Studio", "Laptop"]) {
      const d = w.at(n).d;
      const s = new SessionRecordSync({ self: d.id, computer: () => n, transport: d.transport, registry: d.registry, host });
      stops.push(() => s.close());
    }
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "side by side\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "side by side\n");
    const link = await w.at("Laptop").d.transport.connect(w.at("Studio").d.id);
    const { heads } = await link.request<{ heads: Record<string, unknown> }>("sync.heads", {});
    expect(Object.keys(heads)).toEqual([`memory:${BOT}`]);
  });
});

describe("#232's review: poisoned keys, pinned vectors, a revoked writer's entries, mail sizes", () => {
  /** A key record `signer` signs, made as `o` says. */
  const keyRecord = (signer: ClusterDevice, o: { epoch: number; creator?: string; members: string[] }) => {
    const bytes = new Uint8Array(32).fill(7);
    const creator = o.creator ?? signer.id;
    const unsigned = { kid: `${o.epoch}.${creator}`, epoch: o.epoch, creator, members: o.members, createdAt: DAY, commit: keyCommit(bytes) };
    return { ...unsigned, sig: toBase64(signer.key.sign(keyStatement(unsigned))), key: toBase64(bytes) };
  };

  test("B1: keys come in only signed by their creator, for the kids a push's entries use, within the epoch step", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "one\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "one\n");
    const [studio, laptop, server] = ["Studio", "Laptop", "Server"].map((n) => w.at(n).d);
    const before = w.at("Laptop").sync.keys().map((k) => k.kid).sort();
    const send = async (keys: unknown[], entries: unknown[] = []) => {
      const link = await server!.transport.connect(laptop!.id);
      return link.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries, keys });
    };
    const all = [studio!.id, laptop!.id, server!.id];
    // A good record, but no entry uses it: not taken.
    await send([keyRecord(server!, { epoch: 3, members: all })]);
    // Signed by the server in the laptop's name (claiming its next kid), and one whose members leave its creator out.
    await send([keyRecord(server!, { epoch: 3, creator: laptop!.id, members: all }), keyRecord(server!, { epoch: 4, members: [studio!.id, laptop!.id] })]);
    // An epoch far past the newest known.
    await send([keyRecord(server!, { epoch: 999_999_999, members: all })]);
    expect(w.at("Laptop").sync.keys().map((k) => k.kid).sort()).toEqual(before);
    // The laptop still makes and takes keys as before: a revocation rotates, and the studio's next write arrives.
    await w.at("Studio").d.registry.revoke(server!.id);
    await w.at("Laptop").d.registry.revoke(server!.id);
    await Bun.sleep(100);
    w.at("Studio").write("MEMORY.md", "two\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "two\n");
    expect(Math.max(...w.at("Laptop").sync.keys().map((k) => k.epoch))).toBeLessThan(10);
  });

  test("B2, C1 and S5: another writer's counter past the step, and a time ahead of the shared clock, are skipped; the rest is taken", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "kept\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "kept\n");
    const server = w.at("Server");
    const signed = (rel: string, vv: Record<string, number>, ts = DAY + 5_000) => {
      const v = { rel, vv, ts, by: server.d.id, hash: null, size: 0, sig: "" };
      return { ...v, sig: toBase64(server.d.key.sign(versionStatement(BOT, v))) };
    };
    const r = await push(server, w.at("Laptop"), [
      // The studio's counter, raised past what the studio itself signed: skipped.
      signed("MEMORY.md", { [server.d.id]: 1, [w.at("Studio").d.id]: COUNTER_STEP + 10 }),
      signed("MEMORY.md", { [server.d.id]: 2 }, DAY + 3_600_000),
      // Its own counter is its own (C1): only the cap holds it. A removal loses to the studio's concurrent edit.
      signed("MEMORY.md", { [server.d.id]: COUNTER_STEP + 10 }),
      signed("gone.md", { [server.d.id]: 3 }),
    ]);
    expect(r).toMatchObject({ ok: true, took: 2, skipped: [{ rel: "MEMORY.md", reason: "counters" }, { rel: "MEMORY.md", reason: "ahead" }] });
    expect(w.at("Laptop").read("MEMORY.md")).toBe("kept\n");
  });

  test("C2: epochs count per creator, kids never repeat, and a revoked creator's keys leave the ring", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "one\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "one\n" && w.at("Server").read("MEMORY.md") === "one\n");
    const [studio, laptop, server] = ["Studio", "Laptop", "Server"].map((n) => w.at(n).d);
    const own = () => w.at("Laptop").sync.keys().filter((k) => k.creator === laptop!.id).map((k) => k.epoch);
    const before = Math.max(0, ...own());
    // Rotations on the laptop: each kid new, each epoch its own newest + 1.
    const kids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const spare = await makeDeviceKey();
      await w.at("Laptop").d.registry.add(recordFor(spare, `Spare${i}`), { via: "terminal" });
      await w.at("Laptop").d.registry.revoke(spare.id);
      await waitFor(() => Math.max(0, ...own()) >= before + i + 1);
    }
    await waitFor(() => Math.max(0, ...own()) >= before + 5);
    for (const k of w.at("Laptop").sync.keys()) {
      expect(kids.has(k.kid)).toBe(false);
      kids.add(k.kid);
    }
    expect(Math.max(...own())).toBe(before + 5);
    // The server's keys the laptop holds go at its revoke.
    await w.at("Laptop").d.registry.revoke(server!.id);
    expect(w.at("Laptop").sync.keys().some((k) => k.creator === server!.id)).toBe(false);
    // And memory still flows between the two left.
    w.at("Studio").write("MEMORY.md", "two\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "two\n");
    void studio;
  });

  test("a computer that holds nothing from a creator yet takes its key at any epoch (a computer paired late, after 4,096 rotations)", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock });
    stops.push(() => c.close());
    const [studio, laptop] = [c.devices.get("Studio")!, c.devices.get("Laptop")!];
    const start = async (d: ClusterDevice, seed?: (home: string, store: MemorySecretStore) => Promise<void>) => {
      const home = mkdtempSync(join(tmpdir(), "clover-h-late-"));
      stops.push(() => rmSync(home, { recursive: true, force: true }));
      const store = new MemorySecretStore();
      await seed?.(home, store);
      const sync = await MemorySync.start({ home, self: d.id, key: d.key, store, transport: d.transport, registry: d.registry, now: () => DAY });
      stops.push(() => sync.close());
      return { home, sync };
    };
    // The studio has made 5,000 keys before the laptop ever sees one: its newest, for itself alone, is on its ring.
    const s = await start(studio, async (home, store) => {
      const bytes = new Uint8Array(32).fill(9);
      const unsigned = { kid: `5000.${studio.id}.abcdefghij`, epoch: 5000, creator: studio.id, members: [studio.id], createdAt: DAY, commit: keyCommit(bytes) };
      const info = { ...unsigned, sig: toBase64(studio.key.sign(keyStatement(unsigned))) };
      mkdirSync(join(home, "sync"), { recursive: true });
      writeFileSync(join(home, "sync", "memory-keys.json"), JSON.stringify({ v: 2, keys: [info] }));
      await store.set({ owner: { kind: "device" }, name: `memory-key:${unsigned.kid}` }, toBase64(bytes), { synced: false });
    });
    const l = await start(laptop);
    expect(s.sync.keys().map((k) => k.epoch)).toEqual([5000]);
    mkdirSync(botPaths(s.home, BOT).memory, { recursive: true });
    writeFileSync(join(botPaths(s.home, BOT).memory, "MEMORY.md"), "late\n");
    s.sync.changed(BOT);
    await studio.transport.connect(laptop.id);
    await waitFor(() => existsSync(join(botPaths(l.home, BOT).memory, "MEMORY.md")));
    expect(readFileSync(join(botPaths(l.home, BOT).memory, "MEMORY.md"), "utf8")).toBe("late\n");
    // The key it took is the studio's 5,001st, made for both.
    expect(l.sync.keys().map((k) => k.epoch)).toEqual([5001]);
  });

  test("B4: mail at the full per-file cap and a full page goes in pieces the relay takes; one it refuses goes again", async () => {
    let refuseOnce = true;
    const w = await world(["Studio", "Laptop"], {
      mail: true,
      mailbox: (relay, device) => {
        const box = relay.for(device);
        return {
          ...box,
          put: async (a) => {
            if (refuseOnce) {
              refuseOnce = false;
              throw new Error("full");
            }
            await box.put(a);
          },
        };
      },
    });
    await w.linkAll();
    w.at("Studio").write("seed.md", "x\n");
    await waitFor(() => w.at("Laptop").read("seed.md") === "x\n");
    w.c.net.partition(w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    const cap = 512 * 1024;
    const files: Record<string, string> = { "a.md": "a".repeat(cap), "b.md": "b".repeat(cap), "c.md": "c".repeat(300 * 1024) };
    for (let i = 0; i < 40; i++) files[`small/${i}.md`] = `note ${i}\n`;
    for (const [rel, text] of Object.entries(files)) w.at("Studio").write(rel, text);
    // The first piece is refused and queued; it goes again on the retry timer.
    await waitFor(() => w.relay.held(w.at("Laptop").d.id).length >= 3, 10_000);
    for (const piece of w.relay.held(w.at("Laptop").d.id)) expect(piece.length).toBeLessThanOrEqual(MAIL_MAX_PIECE);
    w.c.net.partition(w.at("Studio").d.key.publicKey);
    w.c.net.heal(w.at("Laptop").d.key.publicKey);
    await w.at("Laptop").sync.takeMail();
    for (const [rel, text] of Object.entries(files)) expect(w.at("Laptop").read(rel)).toBe(text);
  });

  test("S5: a box longer than its size is refused before it's decoded; mail too big or seen before isn't parsed", async () => {
    const w = await world(["Studio", "Laptop"], { mail: true });
    await w.linkAll();
    const studio = w.at("Studio");
    const v = { rel: "x.md", vv: { [studio.d.id]: 1 }, ts: DAY, by: studio.d.id, hash: "0".repeat(64), size: 4, sig: "" };
    const e = { ...v, sig: toBase64(studio.d.key.sign(versionStatement(BOT, v))), kid: `1.${studio.d.id}`, box: "A".repeat(10_000) };
    expect(await push(studio, w.at("Laptop"), [e])).toMatchObject({ ok: false, reason: "refused", detail: "x.md's box is longer than its size" });
    const relay = w.relay.for(studio.d.id);
    await relay.put({ to: w.at("Laptop").d.id, id: "huge", sealed: new Uint8Array(MAIL_MAX_PIECE), expiresAt: Date.now() + 60_000 });
    expect(await w.at("Laptop").sync.takeMail()).toBe(0);
  });

  test("S1: a folder swapped for a link right before a write's rename or a removal's unlink is caught", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-h-swap-"));
    stops.push(() => rmSync(home, { recursive: true, force: true }));
    const outside = mkdtempSync(join(tmpdir(), "clover-h-swap-out-"));
    stops.push(() => rmSync(outside, { recursive: true, force: true }));
    const root = botPaths(home, BOT).memory;
    writeMemoryFile(home, root, ["sub", "keep.md"], new TextEncoder().encode("mine"));
    writeFileSync(join(outside, "keep.md"), "not memory");
    const swap = () => {
      rmSync(join(root, "sub"), { recursive: true });
      symlinkSync(outside, join(root, "sub"));
    };
    expect(() => removeMemoryFile(home, root, ["sub", "keep.md"], { beforeChange: swap })).toThrow("a folder changed");
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("not memory");
    unlinkSync(join(root, "sub"));
    writeMemoryFile(home, root, ["sub", "keep.md"], new TextEncoder().encode("mine"));
    expect(() => writeMemoryFile(home, root, ["sub", "keep.md"], new TextEncoder().encode("through"), { beforeChange: swap })).toThrow("a folder changed");
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("not memory");
  });

  // A case-sensitive disk only (APFS and NTFS fold case by default, so the two names can't both be made there).
  const caseSensitive = (() => {
    const d = mkdtempSync(join(tmpdir(), "clover-h-case-"));
    try {
      writeFileSync(join(d, "a"), "");
      return !existsSync(join(d, "A"));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })();
  test.skipIf(!caseSensitive)("S2: two names that fold alike: the second is kept as a conflict copy, never undoing the first", async () => {
    const w = await world(["Studio", "Laptop"]);
    await w.linkAll();
    w.at("Studio").write("Notes.md", "the studio's notes\n");
    await waitFor(() => w.at("Laptop").read("Notes.md") === "the studio's notes\n");
    w.at("Laptop").write("notes.md", "another file\n");
    await waitFor(() => readdirSync(botPaths(w.at("Studio").home, BOT).memory).some((n) => n.startsWith("notes (conflict ")));
    expect(w.at("Studio").read("Notes.md")).toBe("the studio's notes\n");
    expect(w.at("Laptop").read("notes.md")).toBeUndefined();
  });
});

describe("memory paths and files", () => {
  test("names fold (NFC, case) to one key; nothing outside the folder is a path", () => {
    const a = memoryPath("People/Zoë.md");
    const b = memoryPath("people/zoe\u0308.MD");
    expect("key" in a && "key" in b && a.key === b.key).toBe(true);
    for (const bad of ["..", "a/..", "/x", "C:x", "a\\b", "a/./b", "x.md.", "x ", ".clover-sync-abc", ".DS_Store"]) expect(memoryPath(bad)).toHaveProperty("refused");
  });

  test("a write lands on the name the disk already has, and removing never follows a link", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-h-memfiles-"));
    stops.push(() => rmSync(home, { recursive: true, force: true }));
    const root = botPaths(home, BOT).memory;
    writeMemoryFile(home, root, ["MEMORY.md"], new TextEncoder().encode("one"));
    const r = writeMemoryFile(home, root, ["memory.md"], new TextEncoder().encode("two"));
    expect(r.rel).toBe("MEMORY.md");
    expect(readdirSync(root)).toEqual(["MEMORY.md"]);
    expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe("two");
    const outside = join(home, "outside.md");
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(root, "link.md"));
    expect(removeMemoryFile(home, root, ["link.md"])).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });
});
