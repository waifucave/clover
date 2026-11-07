// Each bot's memory, kept alike on the user's computers (H-M3): a write on one appears on the others, live and after a
// computer comes back (over a link, or as sealed mail when the writer is off by then); concurrent edits keep both
// copies; a revoked device gets nothing new after the content key's rotation; a forged writer, over-cap pushes and
// paths that leave the bot's memory are refused; nothing is written through a link.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { botPaths } from "../../bots/paths";
import { SystemClock } from "../../clock/system-clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { BoxKey } from "../../identity/box-key";
import { fromUtf8, toBase64 } from "../../identity/bytes";
import { type ClusterDevice, makeLinkCluster } from "../../links/testing";
import { MemoryMailRelay } from "../mailbox";
import { type MemoryEntry, type MemoryLimits, MemorySync, type PushResult, versionStatement } from "../memory";
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

async function world(names: string[], opts: { limits?: Record<string, Partial<MemoryLimits>>; mail?: boolean } = {}) {
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
      home, self: d.id, key: d.key, boxKey: box, store, transport: d.transport, registry: d.registry, now: () => now,
      ...(opts.mail ? { mailbox: relay.for(d.id), mailDelayMs: 0 } : {}),
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

async function push(from: Computer, to: Computer, entries: unknown[], bot = BOT): Promise<PushResult> {
  const link = await from.d.transport.connect(to.d.id);
  return link.request<PushResult>("sync.push", { stream: `memory:${bot}`, entries });
}

describe("review-h H-M3 probes", () => {
  test("M1: a file last written by a since-revoked computer jams a whole page for a computer that was off", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    const key = (n: string) => w.at(n).d.key.publicKey;
    w.c.net.partition(key("Server"));
    w.at("Studio").write("a.md", "by the studio\n");
    await waitFor(() => w.at("Laptop").read("a.md") === "by the studio\n");
    w.at("Laptop").write("z.md", "by the laptop\n");
    // The studio is lost and revoked on both remaining computers.
    w.c.net.partition(key("Studio"));
    await w.at("Laptop").d.registry.revoke(w.at("Studio").d.id);
    await w.at("Server").d.registry.revoke(w.at("Studio").d.id);
    w.c.net.heal(key("Server"));
    await w.link("Server", "Laptop");
    await Bun.sleep(1500);
    console.error(`M1 server has a.md: ${w.at("Server").read("a.md") !== undefined}, z.md: ${w.at("Server").read("z.md") !== undefined}`);
    // A later write by the laptop to another file: does it get through?
    w.at("Laptop").write("b.md", "later\n");
    await Bun.sleep(1000);
    console.error(`M1 after a later write: server has b.md: ${w.at("Server").read("b.md") !== undefined}`);
    expect(w.at("Server").read("z.md")).toBe("by the laptop\n");
  });

  test("M2: a paired computer fills another's key ring (256 junk keys) and squats a far epoch", async () => {
    const w = await world(["Studio", "Laptop", "Server", "Old"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "one\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "one\n");
    const [laptop, server] = [w.at("Laptop").d.id, w.at("Server").d.id];
    const junk = Array.from({ length: 256 }, (_, i) => ({ kid: `${999_999_999 - i}.${server}`, epoch: 999_999_999 - i, creator: server, members: [laptop, server], createdAt: 0, key: toBase64(new Uint8Array(32).fill(i % 255)) }));
    const link = await w.at("Server").d.transport.connect(laptop);
    const r = await link.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries: [], keys: junk });
    console.error(`M2 junk push answered ${JSON.stringify(r)}; the laptop now holds ${w.at("Laptop").sync.keys().length} keys`);
    // A revocation makes the studio rotate; its next write goes under a key the laptop can't take any more.
    await w.at("Studio").d.registry.revoke(w.at("Old").d.id);
    await w.at("Laptop").d.registry.revoke(w.at("Old").d.id);
    await Bun.sleep(300);
    w.at("Studio").write("MEMORY.md", "two\n");
    await Bun.sleep(1500);
    console.error(`M2 laptop reads ${JSON.stringify(w.at("Laptop").read("MEMORY.md"))}; laptop's highest epoch ${Math.max(...w.at("Laptop").sync.keys().map((k) => k.epoch))}`);
    // And the laptop's own writes, under a key it made past the 9-digit epoch, at the studio?
    w.at("Laptop").write("MEMORY.md", "three\n");
    await Bun.sleep(1500);
    console.error(`M2 studio reads ${JSON.stringify(w.at("Studio").read("MEMORY.md"))}`);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("three\n");
    expect(w.at("Studio").read("MEMORY.md")).toBe("three\n");
  });

  test("M3: a paired computer pins a file with a maxed version vector, then is revoked", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "real\n");
    await waitFor(() => w.at("Laptop").read("MEMORY.md") === "real\n" && w.at("Server").read("MEMORY.md") === "real\n");
    const s = w.at("Server").d;
    const ids = ["Studio", "Laptop", "Server"].map((n) => w.at(n).d.id);
    const vv = Object.fromEntries(ids.map((id) => [id, Number.MAX_SAFE_INTEGER]));
    const v = { rel: "MEMORY.md", vv, ts: DAY + 1e9, by: s.id, hash: null, size: 0, sig: "" };
    const e = { ...v, sig: toBase64(s.key.sign(versionStatement(BOT, v))) };
    for (const n of ["Studio", "Laptop"]) console.error(`M3 pin to ${n}: ${JSON.stringify(await push(w.at("Server"), w.at(n), [e]))}`);
    await w.at("Studio").d.registry.revoke(s.id);
    await w.at("Laptop").d.registry.revoke(s.id);
    w.at("Studio").write("MEMORY.md", "the user writes again\n");
    await Bun.sleep(1500);
    console.error(`M3 laptop reads ${JSON.stringify(w.at("Laptop").read("MEMORY.md"))}`);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("the user writes again\n");
  });

  test("M4: mail for two 300 KiB files, sealed, fits the relay's 1 MiB a piece?", async () => {
    const w = await world(["Studio", "Laptop"], { mail: true });
    await w.linkAll();
    w.at("Studio").write("seed.md", "x\n");
    await waitFor(() => w.at("Laptop").read("seed.md") === "x\n");
    w.c.net.partition(w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    const logs: string[] = [];
    const big = (c: string) => c.repeat(300 * 1024);
    w.at("Studio").write("a.md", big("a"));
    w.at("Studio").write("b.md", big("b"));
    await Bun.sleep(500);
    await w.at("Studio").sync.flushMail();
    const held = w.relay.held(w.at("Laptop").d.id);
    console.error(`M4 relay holds ${held.length} piece(s) of ${held.map((h) => h.length).join(", ")} bytes`);
    w.c.net.partition(w.at("Studio").d.key.publicKey);
    w.c.net.heal(w.at("Laptop").d.key.publicKey);
    await w.at("Laptop").sync.takeMail();
    console.error(`M4 laptop has a.md ${w.at("Laptop").read("a.md")?.length ?? 0} bytes, b.md ${w.at("Laptop").read("b.md")?.length ?? 0} bytes`);
    void logs;
    expect(w.at("Laptop").read("b.md")?.length).toBe(300 * 1024);
  });
  test("M4b: mail for two 300 KiB files, sealed, fits the relay's 1 MiB a piece?", async () => {
    const w = await world(["Studio", "Laptop"], { mail: true });
    await w.linkAll();
    w.at("Studio").write("seed.md", "x\n");
    await waitFor(() => w.at("Laptop").read("seed.md") === "x\n");
    w.c.net.partition(w.at("Laptop").d.key.publicKey);
    await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up));
    const logs: string[] = [];
    const big = (c: string) => c.repeat(300 * 1024);
    w.at("Studio").write("a.md", big("a"));
    await Bun.sleep(500);
    await w.at("Studio").sync.flushMail();
    const held = w.relay.held(w.at("Laptop").d.id);
    console.error(`M4b relay holds ${held.length} piece(s) of ${held.map((h) => h.length).join(", ")} bytes`);
    w.c.net.partition(w.at("Studio").d.key.publicKey);
    w.c.net.heal(w.at("Laptop").d.key.publicKey);
    await w.at("Laptop").sync.takeMail();
    console.error(`M4b laptop has a.md ${w.at("Laptop").read("a.md")?.length ?? 0} bytes, b.md ${w.at("Laptop").read("b.md")?.length ?? 0} bytes`);
    void logs;
    expect(w.at("Laptop").read("a.md")?.length).toBe(300 * 1024);
  });
});
