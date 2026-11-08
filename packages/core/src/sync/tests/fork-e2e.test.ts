// A fork end to end (the controller's ruling; D's reviewer's A10, A11, B12 case): lane D's real `DurableSessionHost` on
// two computers, lane H's sync between them over the in-memory links, through the daemon's copied-grant guard. The
// laptop ran the bot; the lease moved to the studio while they were apart, and both wrote. Once they meet again the
// laptop's copy is the studio's log, never a mix; its own records were set aside, reached the studio and stand after
// the studio's own there, marked late behind an "Earlier on Laptop" note; and a grant the laptop recorded grants
// nothing on either computer.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { SessionRecord } from "../../contracts/session-host";
import { hostForSync } from "../../daemon-session-sync";
import { makeLinkCluster } from "../../links/testing";
import { DurableSessionHost } from "../../sessions/durable-host";
import { SessionGrants, USER_BROWSER_PARTITION_GRANT } from "../../sessions/grants";
import { projectRecords } from "../../sessions/wire";
import { SessionRecordSync } from "../session-records";

let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});
const temp = () => {
  const h = mkdtempSync(join(tmpdir(), "clover-int-fork-"));
  stops.push(() => rmSync(h, { recursive: true, force: true }));
  return h;
};

async function waitFor(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Records as their computer wrote them: a copy's marks left out, and a grant read as its copy. */
const bare = (rs: SessionRecord[]) => rs.map((r) => {
  const { copiedFrom: _c, late: _l, ...rest } = r as SessionRecord & { copiedFrom?: string; late?: boolean };
  if (rest.type === "driver" && (rest.event.type === "session_grant" || rest.event.type === "session_grant_copied")) return { ...rest, event: { type: "grant", key: rest.event["key"] } };
  return rest;
});
const user = (text: string, device: string, sentAt: number) => ({ text, device, sentAt, clientMessageId: `m-${text}` });
const texts = (host: DurableSessionHost) => projectRecords(host.history("b_alpha"), { kind: "bot" })
  .filter((e) => e.type === "user_message" || e.type === "note")
  .map((e) => (e.type === "note" ? `note:${String(e.label)}` : String(e.text)));
const grantsOn = (host: DurableSessionHost) => host.history("b_alpha").filter((r) => r.type === "driver" && (r.event.type === "session_grant" || r.event.type === "session_grant_copied")).length;

/** Two computers with lane D's real host and the sync between them; the laptop runs the bot and has written its first
 *  turn, which the studio holds. */
async function together() {
  const c = await makeLinkCluster(["Laptop", "Studio"], { clock: new SystemClock() });
  stops.push(() => c.close());
  const laptopDev = c.devices.get("Laptop")!;
  const studioDev = c.devices.get("Studio")!;
  const clock = new FakeClock();
  const runs = { Laptop: true, Studio: false };
  let holder = laptopDev.id;
  const logs: string[] = [];
  const hosts = new Map<string, DurableSessionHost>();
  const drivers = new Map<string, FakeSessionDriver>();
  for (const [name, dev] of [["Laptop", laptopDev], ["Studio", studioDev]] as const) {
    const host = new DurableSessionHost({ home: temp(), clock, computer: name, runsHere: () => runs[name], mayStart: () => runs[name] });
    hosts.set(name, host);
    const sync = new SessionRecordSync({
      self: dev.id, computer: () => name, transport: dev.transport, registry: dev.registry, host: hostForSync(host),
      holder: () => holder, lateRetryMs: 50, log: (l) => void logs.push(`${name} ${l}`),
    });
    stops.push(() => sync.close());
    // Each computer opens the bot's conversation, as its bot side does; the laptop runs it.
    const driver = new FakeSessionDriver({ canFold: true });
    drivers.set(name, driver);
    host.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Laptop" }, driver);
  }
  const laptop = hosts.get("Laptop")!;
  const studio = hosts.get("Studio")!;
  await laptopDev.transport.connect(studioDev.id);
  const turn = async (host: DurableSessionHost, name: "Laptop" | "Studio", text: string, sentAt: number) => {
    await host.sendUser("b_alpha", user(text, name.toLowerCase(), sentAt));
    await flush();
    drivers.get(name)!.end({ text: `reply ${text}` });
    await flush();
  };
  await turn(laptop, "Laptop", "one", 1);
  await waitFor("the studio's copy", () => studio.head("b_alpha") === laptop.head("b_alpha"));
  return {
    c, laptopDev, studioDev, clock, runs, logs, laptop, studio, drivers, turn,
    shared: laptop.head("b_alpha"),
    /** Apart: the lease moves to the studio; the laptop hears only later. */
    apart: async () => {
      c.net.partition(laptopDev.key.publicKey, studioDev.key.publicKey);
      await waitFor("the link down", () => !laptopDev.transport.links().some((l) => l.peer === studioDev.id && l.up));
      holder = studioDev.id;
      runs.Studio = true;
      studio.update("b_alpha", { computer: "Studio" });
      studio.resume();
      clock.advance(1_000);
    },
    /** The laptop hears the lease moved. */
    heard: () => {
      runs.Laptop = false;
      laptop.update("b_alpha", { computer: "Studio" });
    },
    meet: async () => {
      c.net.heal(laptopDev.key.publicKey, studioDev.key.publicKey);
      for (let i = 0; ; i++) {
        try {
          await laptopDev.transport.connect(studioDev.id);
          return;
        } catch (e) {
          if (i > 100) throw e;
          await Bun.sleep(50);
        }
      }
    },
  };
}

describe("a fork between two computers, end to end", () => {
  for (const busy of [false, true]) test(busy
    ? "the main is in a turn of its own when they meet: it says busy, and the laptop's records arrive once the turn ended"
    : "A10, A11 against B10–B12: the old main's copy becomes the main's log; its own records reach the main, late, behind a note; its grant grants nothing", async () => {
    const w = await together();
    const { laptop, studio, shared } = w;
    await w.apart();
    await w.laptop.sendUser("b_alpha", user("two", "laptop", 2));
    await flush();
    laptop.recordCore("b_alpha", { type: "session_grant", key: USER_BROWSER_PARTITION_GRANT, cardId: "card_laptop" });
    w.drivers.get("Laptop")!.end({ text: "reply two" });
    await flush();
    w.clock.advance(1_000);
    await w.turn(studio, "Studio", "three", 3);
    if (busy) {
      // The studio is in the middle of another turn of its own when they meet.
      await studio.sendUser("b_alpha", user("four", "studio", 4));
      await flush();
    }
    w.heard();
    const mineAfterFork = laptop.history("b_alpha", { afterSeq: shared - 1 });
    expect(mineAfterFork.length).toBeGreaterThan(0);

    await w.meet();
    if (busy) {
      // The laptop's copy follows the studio's own records; its set-aside run is refused busy, and asked again.
      await waitFor("the laptop's copy", () => texts(laptop).includes("four"));
      await waitFor("a busy refusal", () => w.logs.some((l) => l.startsWith("Laptop") && /didn't take what this computer set aside \(busy\); trying again/.test(l)));
      expect(texts(studio)).not.toContain("two");
      expect(laptop.earlier("b_alpha")[0]?.delivered).toBeUndefined();
      w.drivers.get("Studio")!.end({ text: "reply four" });
      await flush();
    }
    await waitFor("the laptop's records at the end of the studio's log", () => texts(studio).includes("two"));
    await waitFor("one log on both", () => laptop.head("b_alpha") === studio.head("b_alpha"));

    // The studio's log: its own, then the laptop's behind the note, marked late; history only.
    expect(texts(studio)).toEqual(busy ? ["one", "three", "four", "note:Earlier on Laptop", "two"] : ["one", "three", "note:Earlier on Laptop", "two"]);
    const tail = studio.history("b_alpha").filter((r) => (r as { late?: boolean }).late === true);
    expect(tail.length).toBeGreaterThan(1);
    expect(studio.history("b_alpha").slice(-tail.length)).toEqual(tail);
    // The laptop's copy is that log, record for record: never A's records under B's.
    expect(bare(laptop.history("b_alpha"))).toEqual(bare(studio.history("b_alpha")));
    expect(texts(laptop)).toEqual(texts(studio));
    // What the laptop set aside is kept, listed and delivered.
    const [earlier, ...more] = laptop.earlier("b_alpha");
    expect(more).toEqual([]);
    expect(earlier).toMatchObject({ fromSeq: shared, records: mineAfterFork.length });
    expect(earlier!.delivered).toEqual(expect.any(Number));
    // The laptop's grant grants nothing anywhere: not on the studio, nor on the laptop's copy now.
    const deny = { request: async () => ({ allowed: false, by: "card" }) as never };
    expect(new SessionGrants({ host: studio, approvals: deny }).has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(false);
    expect(new SessionGrants({ host: laptop, approvals: deny }).has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(false);
    expect(JSON.stringify(studio.history("b_alpha"))).not.toContain("card_laptop");
  }, 30_000);

  test("two logs forked at the same length: the main's next record, pushed live, finds the fork; the copy is never mixed (#297 B1)", async () => {
    const w = await together();
    const { laptop, studio } = w;
    await w.apart();
    // One similar turn each, so both heads are the same.
    await w.turn(laptop, "Laptop", "two", 2);
    w.clock.advance(1_000);
    await w.turn(studio, "Studio", "three", 3);
    expect(laptop.head("b_alpha")).toBe(studio.head("b_alpha"));
    w.heard();
    await w.meet();
    // The studio's next turn goes out live, overlapping the laptop's last record.
    await w.turn(studio, "Studio", "four", 4);
    await waitFor("one log on both", () => texts(studio).includes("two") && laptop.head("b_alpha") === studio.head("b_alpha"));
    await waitFor("the studio's own turn there too", () => texts(laptop).includes("four"));
    // Whichever came first (the catch-up's compare or the live push's), the laptop's "two" stands after the note, late.
    const t = texts(studio);
    expect(t.slice(0, 2)).toEqual(["one", "three"]);
    expect(t.indexOf("note:Earlier on Laptop")).toBeLessThan(t.indexOf("two"));
    expect([...t].sort()).toEqual(["four", "note:Earlier on Laptop", "one", "three", "two"]);
    // Never "one", "two", "four" on the laptop: its copy is the studio's log.
    expect(texts(laptop)).toEqual(texts(studio));
    expect(bare(laptop.history("b_alpha"))).toEqual(bare(studio.history("b_alpha")));
  }, 30_000);

  test("a grant both hold, just before the fork, stays shared: the run starts after it, and no grant is doubled (#297 S1)", async () => {
    const w = await together();
    const { laptop, studio } = w;
    // The laptop records a grant while together: the studio holds its copy.
    laptop.recordCore("b_alpha", { type: "session_grant", key: USER_BROWSER_PARTITION_GRANT, cardId: "card_one" });
    await waitFor("the grant's copy", () => studio.head("b_alpha") === laptop.head("b_alpha"));
    const forkAt = laptop.head("b_alpha");
    await w.apart();
    await w.turn(laptop, "Laptop", "two", 2);
    w.clock.advance(1_000);
    await w.turn(studio, "Studio", "three", 3);
    w.heard();
    await w.meet();
    await waitFor("one log on both", () => texts(studio).includes("two") && laptop.head("b_alpha") === studio.head("b_alpha"));
    // The run set aside starts right after the shared grant, not at it.
    expect(laptop.earlier("b_alpha")[0]).toMatchObject({ fromSeq: forkAt });
    // One grant on each: the shared one; no late copy of it.
    expect(grantsOn(studio)).toBe(1);
    expect(grantsOn(laptop)).toBe(1);
    expect(texts(studio)).toEqual(["one", "three", "note:Earlier on Laptop", "two"]);
  }, 30_000);

  test("a set-aside run with nothing a person would see goes nowhere: no 'Earlier on' note over nothing", async () => {
    const w = await together();
    const { laptop, studio } = w;
    await w.apart();
    // The laptop's only write while apart is a core-only record no client is shown (a grant, which never grants there).
    laptop.recordCore("b_alpha", { type: "session_grant", key: "nothing.visible" });
    w.clock.advance(1_000);
    await w.turn(studio, "Studio", "three", 3);
    w.heard();
    await w.meet();
    await waitFor("the laptop's copy", () => texts(laptop).includes("three") && laptop.head("b_alpha") === studio.head("b_alpha"));
    await waitFor("the run marked done", () => laptop.earlier("b_alpha")[0]?.delivered !== undefined);
    expect(texts(studio)).toEqual(["one", "three"]);
    expect(studio.history("b_alpha").some((r) => (r as { late?: boolean }).late === true)).toBe(false);
  }, 30_000);
});
