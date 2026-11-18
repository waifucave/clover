// A generated-sequence test of the move's journal (lane BT, round 4; lane-common's "sequences get a property test"):
// on a home copied from the plugin era, after ANY order of starts, OKs, switches, uninstalls, later installs, the
// person's archives and restores, and files they delete by hand, every pre-split bot is in exactly one of: a record
// (moved), the archive (moved there, or archived by the person), or removed (the person deleted its files) — never two,
// never none once its plugin has been listed or found gone at a start; the journal names each once; a bot plugin
// installed after the first completion never becomes a bot; the journal's `at` never moves; and a bot the person
// archived is never brought back by a start. Each start is a fresh store over the same home, as a fresh engine is,
// and takes what the bot service takes (move.ts `moveInputs`).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../contracts/fakes/clock";
import { moveInputs } from "../move";
import { BotRecordStore } from "../records";
import { removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

/** A small seeded generator (mulberry32): the same seed, the same sequence. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "ok" | "waiting" | "off" | "gone" | "unlisted";
interface Plugin { id: string; okHash?: string; enabled: boolean; listed: boolean; folder: string }

const PRE = ["pa", "pb", "pc", "pd", "pe", "pack/pf"] as const;
const seg = (id: string) => id.replace("/", "--");

function writeFolder(home: string, id: string): string {
  const dir = join(home, "plugins", ...id.split("/").flatMap((p, i) => (i === 0 ? [p] : ["plugins", p])));
  mkdirSync(join(dir, "bot"), { recursive: true });
  writeFileSync(join(dir, "bot", "instructions.md"), `You are ${id}.`);
  return dir;
}

function registryOf(plugins: Map<string, Plugin>) {
  const recordOf = (p: Plugin) => ({
    id: p.id, folder: p.folder, source: "local", ...(p.okHash === undefined ? {} : { okHash: p.okHash }),
    state: !p.enabled ? "off" : p.okHash === undefined ? "found" : "running", enabled: p.enabled,
    manifest: { contributes: { bot: { name: p.id, instructions: "bot/instructions.md" } } },
  });
  const listed = () => [...plugins.values()].filter((p) => p.listed).map(recordOf);
  return { list: listed, entries: () => [], get: (id: string) => listed().find((r) => r.id === id) } as never;
}

describe("the move's journal over generated sequences", () => {
  for (let seed = 1; seed <= 60; seed++) {
    test(`seed ${seed}`, async () => {
      const next = rng(seed * 7919);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
      const home = tempDir();
      const clock = new FakeClock({ start: 1_794_900_000_000 });
      const plugins = new Map<string, Plugin>();
      // The plugin era: each pre-split bot ran here (its state file and its conversation's meta), and its plugin is
      // whatever the copy left it as.
      for (const [i, id] of PRE.entries()) {
        mkdirSync(join(home, "transcripts", seg(id)), { recursive: true });
        writeFileSync(join(home, "transcripts", seg(id), "bot.json"), JSON.stringify({ bot: id, firstSeen: clock.now() + i, seededMemory: true }));
        writeFileSync(join(home, "transcripts", seg(id), `b_${seg(id)}.meta.json`), JSON.stringify({ meta: 1, id: `b_${seg(id)}`, kind: "bot", startedAt: clock.now() + i, title: `Bot ${id}`, bot: id }));
        mkdirSync(join(home, "bots", seg(id), "memory"), { recursive: true });
        const kind = pick<Kind>(["ok", "waiting", "off", "gone", "unlisted"]);
        if (kind === "gone") continue;
        if (id.includes("/")) writeFileSync(join(writeFolder(home, id.split("/")[0]!), "moss.json"), "{}");
        plugins.set(id, { id, folder: writeFolder(home, id), enabled: kind !== "off", listed: kind !== "unlisted", ...(kind === "ok" || kind === "off" ? { okHash: "h" } : {}) });
      }
      clock.advance(3_600_000);

      const later: string[] = [];
      const archivedByPerson = new Set<string>();
      const deleted = new Set<string>();
      let firstAt: number | undefined;
      let starts = 0;
      let store: BotRecordStore | undefined;
      const log: string[] = [];
      const ops = ["start", "start", "start", "ok", "switch", "uninstall", "install", "archive", "restore", "delete"] as const;
      const sequence = [...Array.from({ length: 24 }, () => pick(ops)), "start", "start"] as const;

      const where = (s: BotRecordStore, id: string) => [s.get(id) !== undefined ? "record" : "", s.archived().some((a) => a.id === id) ? "archive" : "", deleted.has(id) && s.get(id) === undefined && !s.archived().some((a) => a.id === id) ? "removed" : ""].filter(Boolean);

      for (const op of sequence) {
        clock.advance(1000);
        log.push(op);
        const why = () => `seed ${seed * 7919}: ${log.join(" ")}`;
        if (op === "start") {
          store = new BotRecordStore({ home, clock });
          const journal = await store.move(moveInputs(registryOf(plugins), home, store.journal()));
          starts++;
          firstAt ??= journal.at;
          expect(journal.at, why()).toBe(firstAt);
          // The registry finds a folder it didn't list at a start by the next one.
          for (const p of plugins.values()) p.listed = true;
          const ids = journal.bots.map((b) => b.id);
          expect(new Set(ids).size, why()).toBe(ids.length);
          for (const id of later) {
            expect(ids, why()).not.toContain(id);
            expect(store.get(id), why()).toBeUndefined();
          }
          for (const id of PRE) {
            const at = where(store, id);
            const failed = journal.bots.find((b) => b.id === id)?.outcome === "failed";
            // Only a plugin that wasn't listed at this start (its first) may leave a bot waiting for the next, or one
            // whose files the person deleted before it moved (removed).
            const failure = journal.bots.find((b) => b.id === id && b.outcome === "failed") as { why?: string } | undefined;
            if (failed && !deleted.has(id)) expect(starts, `${why()} ${id} failed: ${failure?.why}`).toBe(1);
            if (!failed || deleted.has(id)) expect(at, `${why()} ${id}`).toHaveLength(1);
            expect(ids, why()).toContain(id);
          }
          for (const id of archivedByPerson) expect(store.archived().some((a) => a.id === id), `${why()} ${id} brought back`).toBe(true);
          continue;
        }
        const id = pick(PRE);
        if (op === "ok") { const p = plugins.get(id); if (p !== undefined) p.okHash = "h"; }
        if (op === "switch") { const p = plugins.get(id); if (p !== undefined) p.enabled = !p.enabled; }
        if (op === "uninstall" && plugins.has(id)) {
          rmSync(plugins.get(id)!.folder, { recursive: true, force: true });
          plugins.delete(id);
        }
        if (op === "install" && starts > 0) {
          const nid = `later-${later.length + 1}`;
          later.push(nid);
          plugins.set(nid, { id: nid, folder: writeFolder(home, nid), enabled: true, listed: true, okHash: "h" });
        }
        if (store === undefined) continue;
        if (op === "archive" && store.get(id) !== undefined) {
          await store.remove(id);
          archivedByPerson.add(id);
        }
        if (op === "restore" && store.archived().some((a) => a.id === id)) {
          await store.restore(id);
          archivedByPerson.delete(id);
        }
        if (op === "delete" && starts > 0 && !deleted.has(id)) {
          for (const dir of [join(home, "bots", seg(id)), join(home, "transcripts", seg(id)), join(home, "routines", seg(id)), join(home, "archive", "bots", seg(id))]) {
            if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          }
          deleted.add(id);
          archivedByPerson.delete(id);
          store = new BotRecordStore({ home, clock });
        }
      }
    });
  }
});
