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

/** Records as their computer wrote them: a copy's marks left out. */
const bare = (rs: SessionRecord[]) => rs.map((r) => {
  const { copiedFrom: _c, late: _l, ...rest } = r as SessionRecord & { copiedFrom?: string; late?: boolean };
  return rest;
});
const user = (text: string, device: string, sentAt: number) => ({ text, device, sentAt, clientMessageId: `m-${text}` });
const texts = (host: DurableSessionHost) => projectRecords(host.history("b_alpha"), { kind: "bot" })
  .filter((e) => e.type === "user_message" || e.type === "note")
  .map((e) => (e.type === "note" ? `note:${String(e.label)}` : String(e.text)));

describe("a fork between two computers, end to end", () => {
  for (const busy of [false, true]) test(busy
    ? "the main is in a turn of its own when they meet: it says busy, and the laptop's records arrive once the turn ended"
    : "A10, A11 against B10–B12: the old main's copy becomes the main's log; its own records reach the main, late, behind a note; its grant grants nothing", async () => {
    const c = await makeLinkCluster(["Laptop", "Studio"], { clock: new SystemClock() });
    stops.push(() => c.close());
    const laptopDev = c.devices.get("Laptop")!;
    const studioDev = c.devices.get("Studio")!;
    const clock = new FakeClock();
    const runs = { Laptop: true, Studio: false };
    let holder = laptopDev.id;
    const hosts = new Map<string, DurableSessionHost>();
    const drivers = new Map<string, FakeSessionDriver>();
    for (const [name, dev] of [["Laptop", laptopDev], ["Studio", studioDev]] as const) {
      const host = new DurableSessionHost({ home: temp(), clock, computer: name, runsHere: () => runs[name], mayStart: () => runs[name] });
      hosts.set(name, host);
      const sync = new SessionRecordSync({
        self: dev.id, computer: () => name, transport: dev.transport, registry: dev.registry, host: hostForSync(host),
        holder: () => holder, lateRetryMs: 50,
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

    // Together: the laptop's turn reaches the studio as it's written.
    await laptop.sendUser("b_alpha", user("one", "laptop", 1));
    await flush();
    drivers.get("Laptop")!.end({ text: "reply one" });
    await flush();
    await waitFor("the studio's copy", () => studio.head("b_alpha") === laptop.head("b_alpha"));
    const shared = laptop.head("b_alpha");

    // Apart. The lease moves to the studio, which writes (B); the laptop goes on before it hears (A), and records a
    // grant from its own card.
    c.net.partition(laptopDev.key.publicKey, studioDev.key.publicKey);
    await waitFor("the link down", () => !laptopDev.transport.links().some((l) => l.peer === studioDev.id && l.up));
    holder = studioDev.id;
    runs.Studio = true;
    studio.update("b_alpha", { computer: "Studio" });
    studio.resume();
    clock.advance(1_000);
    await laptop.sendUser("b_alpha", user("two", "laptop", 2));
    await flush();
    laptop.recordCore("b_alpha", { type: "session_grant", key: USER_BROWSER_PARTITION_GRANT, cardId: "card_laptop" });
    drivers.get("Laptop")!.end({ text: "reply two" });
    await flush();
    clock.advance(1_000);
    await studio.sendUser("b_alpha", user("three", "studio", 3));
    await flush();
    drivers.get("Studio")!.end({ text: "reply three" });
    await flush();
    if (busy) {
      // The studio is in the middle of another turn of its own when they meet.
      await studio.sendUser("b_alpha", user("four", "studio", 4));
      await flush();
    }
    // The laptop hears the lease moved.
    runs.Laptop = false;
    laptop.update("b_alpha", { computer: "Studio" });
    const mineAfterFork = laptop.history("b_alpha", { afterSeq: shared - 1 });
    expect(mineAfterFork.length).toBeGreaterThan(0);
    expect(laptop.head("b_alpha")).toBeGreaterThan(shared);

    // Together again.
    c.net.heal(laptopDev.key.publicKey, studioDev.key.publicKey);
    for (let i = 0; ; i++) {
      try {
        await laptopDev.transport.connect(studioDev.id);
        break;
      } catch (e) {
        if (i > 100) throw e;
        await Bun.sleep(50);
      }
    }
    if (busy) {
      // The laptop's copy follows the studio's own records; its set-aside run waits, refused busy and asked again.
      await waitFor("the laptop's copy", () => texts(laptop).includes("four"));
      await Bun.sleep(300);
      expect(texts(studio)).not.toContain("two");
      expect(laptop.earlier("b_alpha")[0]?.delivered).toBeUndefined();
      drivers.get("Studio")!.end({ text: "reply four" });
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
});
