// A session's copy that forked from the computer running it (the controller's ruling on the pre-pairing fork): the
// main's log wins; this computer's records from the fork on are kept aside, never deleted, and listed; the log is cut
// back and follows the main; and the main puts the set-aside records after its own, marked late, behind an "Earlier
// on <computer>" note, as history that never runs.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverSessionEvent, SessionEvent } from "@waifucave/clover-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { isContractError } from "../../contracts/common";
import type { SessionRecord } from "../../contracts/session-host";
import { DurableSessionHost } from "../durable-host";
import { SessionLogFile } from "../event-log";
import { SessionGrants, USER_BROWSER_PARTITION_GRANT } from "../grants";
import { sessionLogPath } from "../ids";
import { projectRecords } from "../wire";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const tempHome = () => {
  const h = mkdtempSync(join(tmpdir(), "clover-d-fork-"));
  homes.push(h);
  return h;
};

/** Records as their computer wrote them: a copy's source left out. */
const bare = (rs: SessionRecord[]) => rs.map((r) => {
  const { copiedFrom: _, ...rest } = r as SessionRecord & { copiedFrom?: string };
  return rest;
});
const user = (text: string, device: string, sentAt: number) => ({ text, device, sentAt, clientMessageId: `m-${text}` });
const caught = (fn: () => unknown) => Promise.resolve().then(fn).catch((e: unknown) => e);

/** Laptop runs the bot first and Studio copies it; then both write (the lease moved, and the laptop didn't know yet). */
async function forked() {
  const clock = new FakeClock();
  const runs = { laptop: true, studio: false };
  const laptopHome = tempHome();
  const studioHome = tempHome();
  const hostOn = (home: string, computer: "Laptop" | "Studio") => new DurableSessionHost({
    home, clock, computer,
    runsHere: () => (computer === "Laptop" ? runs.laptop : runs.studio),
    mayStart: () => (computer === "Laptop" ? runs.laptop : runs.studio),
  });
  const laptop = hostOn(laptopHome, "Laptop");
  const studio = hostOn(studioHome, "Studio");
  const laptopDriver = new FakeSessionDriver({ canFold: true });
  const studioDriver = new FakeSessionDriver({ canFold: true });
  const spec = { id: "b_alpha", kind: "bot" as const, bot: "alpha" };
  laptop.open({ ...spec, computer: "Laptop" }, laptopDriver);
  studio.open({ ...spec, computer: "Laptop" }, studioDriver);
  await laptop.sendUser("b_alpha", user("one", "laptop", 1));
  await flush();
  laptopDriver.end({ text: "reply one" });
  await flush();
  // Studio holds the laptop's log so far (the openings both wrote alike are the same record).
  studio.ingest(laptop.get("b_alpha")!, laptop.history("b_alpha"), { from: "laptop-device", late: false });
  const shared = laptop.head("b_alpha");
  expect(studio.head("b_alpha")).toBe(shared);
  // The lease moves to Studio; the laptop goes on for a while before it hears.
  runs.studio = true;
  studio.update("b_alpha", { computer: "Studio" });
  studio.resume();
  clock.advance(1_000);
  await laptop.sendUser("b_alpha", user("two", "laptop", 2));
  await flush();
  laptop.recordCore("b_alpha", { type: "session_grant", grant: USER_BROWSER_PARTITION_GRANT, computers: ["Laptop"], by: "card", device: "laptop" });
  laptopDriver.end({ text: "reply two" });
  await flush();
  clock.advance(1_000);
  await studio.sendUser("b_alpha", user("three", "studio", 3));
  await flush();
  studioDriver.end({ text: "reply three" });
  await flush();
  runs.laptop = false;
  laptop.update("b_alpha", { computer: "Studio" });
  return { clock, runs, laptop, studio, laptopDriver, studioDriver, shared, laptopHome, studioHome };
}

describe("a fork: the main's log wins, and the other computer's records go after it, late", () => {
  test("A10, A11 against B10: set aside, cut back, followed; the main appends them late behind a note; nothing runs; a resend adds nothing", async () => {
    const { laptop, studio, studioDriver, shared, laptopHome, clock } = await forked();
    const view = studio.get("b_alpha")!;
    // The copy forked: the main's records at held seqs differ.
    const err = await caught(() => laptop.ingest(view, studio.history("b_alpha", { afterSeq: shared - 2 }), { from: "studio-device", late: false }));
    expect(isContractError(err, "conflict")).toBe(true);
    const mine = laptop.history("b_alpha", { afterSeq: shared - 1 });
    expect(mine.some((r) => r.type === "input" && r.input.from === "user" && r.input.text === "two")).toBe(true);

    // The runner refuses to set its own log aside; a place past the head is refused.
    expect(isContractError(await caught(() => studio.setAside("b_alpha", shared, { from: "laptop-device" })), "refused")).toBe(true);
    expect(isContractError(await caught(() => laptop.setAside("b_alpha", laptop.head("b_alpha") + 1, { from: "studio-device" })), "invalid")).toBe(true);

    clock.advance(500);
    const aside = laptop.setAside("b_alpha", shared, { from: "studio-device" });
    expect(aside).toEqual(mine);
    expect(laptop.head("b_alpha")).toBe(shared);
    expect(laptop.get("b_alpha")?.rebasedAt).toBe(clock.now());
    const [entry, ...more] = laptop.earlier("b_alpha");
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({ fromSeq: shared, records: mine.length, from: "studio-device", at: clock.now() });
    expect(entry!.delivered).toBeUndefined();
    expect(laptop.readEarlier("b_alpha", entry!.id)).toEqual(mine);
    const asideFile = sessionLogPath(laptopHome, "alpha", "b_alpha").replace(/\.ndjson$/, `.earlier-${entry!.id}.json`);
    expect(existsSync(asideFile)).toBe(true);
    // It holds a conversation, so only its owner reads it, as the log (review S3).
    expect(statSync(asideFile).mode & 0o777).toBe(0o600);
    // Setting aside at the head is nothing.
    expect(laptop.setAside("b_alpha", shared, { from: "studio-device" })).toEqual([]);

    // The copy follows the main from the fork on.
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: shared - 2 }), { from: "studio-device", late: false });
    expect(bare(laptop.history("b_alpha"))).toEqual(bare(studio.history("b_alpha")));

    // While one of the main's own turns runs, it says try again (review S4); once the turn ends, it takes them.
    await studio.sendUser("b_alpha", user("busy", "studio", 4));
    await flush();
    expect(isContractError(await caught(() => studio.appendLate("b_alpha", aside, { from: "laptop-device", computer: "Laptop" })), "busy")).toBe(true);
    studioDriver.end({ text: "reply busy" });
    await flush();
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: laptop.head("b_alpha") - 2 }), { from: "studio-device", late: false });

    // The main puts them after its own, behind a note; a status record is left out.
    const turnsBefore = studioDriver.turns.length;
    const statusBefore = studio.get("b_alpha")!.status;
    const head = studio.head("b_alpha");
    const kept = mine.filter((r) => r.type !== "status");
    expect(studio.appendLate("b_alpha", aside, { from: "laptop-device", computer: "Laptop" })).toBe(kept.length);
    const tail = studio.history("b_alpha", { afterSeq: head - 1 });
    expect(tail).toHaveLength(kept.length + 1);
    expect(tail.every((r) => (r as { late?: boolean }).late === true)).toBe(true);
    expect(tail[0]).toMatchObject({ type: "input", disposition: "note", input: { from: "note", by: { kind: "core" }, label: "Earlier on Laptop" } });
    expect(tail.slice(1).map((r) => (r as { lateFrom?: { seq: number } }).lateFrom?.seq)).toEqual(kept.map((r) => r.seq));
    expect(tail.slice(1).map((r) => r.ts)).toEqual(kept.map((r) => r.ts));
    // A grant from there grants nothing here.
    expect(tail.some((r) => r.type === "driver" && r.event.type === "session_grant")).toBe(false);
    expect(tail.some((r) => r.type === "driver" && r.event.type === "session_grant_copied")).toBe(true);
    const grants = new SessionGrants({ host: studio, approvals: { request: async () => ({ allowed: false, by: "card" }) } });
    expect(grants.has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(false);
    // Clients see the note and the laptop's messages after the main's own.
    const wire = projectRecords(studio.history("b_alpha"), { kind: "bot" });
    const texts = wire.filter((e) => e.type === "user_message" || e.type === "note").map((e) => (e.type === "note" ? `note:${String(e.label)}` : String(e.text)));
    expect(texts).toEqual(["one", "three", "busy", "note:Earlier on Laptop", "two"]);
    // On the wire they say so (review S1), through the protocol's own schemas; the main's own events don't.
    const lateWire = wire.filter((e) => e.late === true);
    expect(lateWire.map((e) => e.type)).toContain("note");
    expect(lateWire.map((e) => e.type)).toContain("user_message");
    expect(wire.filter((e) => e.type === "user_message" && e.text !== "two").every((e) => e.late === undefined)).toBe(true);
    expect(SessionEvent.parse(lateWire.find((e) => e.type === "user_message")).late).toBe(true);
    expect(CloverSessionEvent.parse(lateWire.find((e) => e.type === "note")).late).toBe(true);
    // History only: nothing runs, the status stays.
    studio.resume();
    await flush();
    expect(studioDriver.turns).toHaveLength(turnsBefore);
    expect(studio.get("b_alpha")!.status).toBe(statusBefore);
    // A resend adds nothing.
    expect(studio.appendLate("b_alpha", aside, { from: "laptop-device", computer: "Laptop" })).toBe(0);
    expect(studio.head("b_alpha")).toBe(head + kept.length + 1);
    // The laptop marks the run delivered; its copy takes the late records back like any other.
    laptop.ackEarlier("b_alpha", entry!.id);
    expect(laptop.earlier("b_alpha")[0]!.delivered).toBe(clock.now());
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: laptop.head("b_alpha") - 2 }), { from: "studio-device", late: false });
    expect(bare(laptop.history("b_alpha"))).toEqual(bare(studio.history("b_alpha")));
    // Only the runner takes late records.
    expect(isContractError(await caught(() => laptop.appendLate("b_alpha", aside, { from: "x", computer: "X" })), "refused")).toBe(true);
  });

  test("after a restart: the cut log, the kept run and rebasedAt are read back; the main's late records stay history", async () => {
    const { laptop, studio, shared, laptopHome, studioHome, clock, runs } = await forked();
    const view = studio.get("b_alpha")!;
    const aside = laptop.setAside("b_alpha", shared, { from: "studio-device" });
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: shared - 2 }), { from: "studio-device", late: false });
    studio.appendLate("b_alpha", aside, { from: "laptop-device", computer: "Laptop" });
    const laptopHistory = laptop.history("b_alpha");
    const studioHistory = studio.history("b_alpha");

    const laptop2 = new DurableSessionHost({ home: laptopHome, clock, computer: "Laptop", runsHere: () => runs.laptop, mayStart: () => runs.laptop });
    expect(laptop2.history("b_alpha")).toEqual(laptopHistory);
    expect(laptop2.get("b_alpha")?.rebasedAt).toBe(laptop.get("b_alpha")?.rebasedAt);
    expect(laptop2.readEarlier("b_alpha", laptop2.earlier("b_alpha")[0]!.id)).toEqual(aside);

    const studio2 = new DurableSessionHost({ home: studioHome, clock, computer: "Studio", runsHere: () => runs.studio, mayStart: () => runs.studio });
    const driver = new FakeSessionDriver({ canFold: true });
    studio2.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
    studio2.resume();
    await flush();
    // The laptop's "two" is in the log, late: it never comes back as something to run.
    expect(driver.turns).toHaveLength(0);
    expect(studio2.history("b_alpha").slice(0, studioHistory.length)).toEqual(studioHistory);
    expect(studio2.get("b_alpha")!.status).not.toBe("prompting");
    // The once-per-place rule holds across the restart.
    expect(studio2.appendLate("b_alpha", aside, { from: "laptop-device", computer: "Laptop" })).toBe(0);
  });

  test("a second fork from the same device opens its own run, with its own note (review S2)", async () => {
    const { laptop, studio, laptopDriver, studioDriver, shared, runs, clock } = await forked();
    const view = studio.get("b_alpha")!;
    const first = laptop.setAside("b_alpha", shared, { from: "studio-device" });
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: shared - 2 }), { from: "studio-device", late: false });
    studio.appendLate("b_alpha", first, { from: "laptop-device", computer: "Laptop" });
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: laptop.head("b_alpha") - 2 }), { from: "studio-device", late: false });
    // Both write again (a second split), then the laptop hears.
    const again = laptop.head("b_alpha");
    runs.laptop = true;
    clock.advance(1_000);
    await laptop.sendUser("b_alpha", user("four", "laptop", 5));
    await flush();
    laptopDriver.end({ text: "reply four" });
    await flush();
    await studio.sendUser("b_alpha", user("five", "studio", 6));
    await flush();
    studioDriver.end({ text: "reply five" });
    await flush();
    runs.laptop = false;
    expect(isContractError(await caught(() => laptop.ingest(view, studio.history("b_alpha", { afterSeq: again - 2 }), { from: "studio-device", late: false })), "conflict")).toBe(true);
    const second = laptop.setAside("b_alpha", again, { from: "studio-device" });
    // INT's call names no run: the run is named by its first place, so it gets its own note.
    studio.appendLate("b_alpha", second, { from: "laptop-device", computer: "Laptop" });
    const notes = studio.history("b_alpha").filter((r) => r.type === "input" && r.input.from === "note");
    expect(notes).toHaveLength(2);
    expect(projectRecords(studio.history("b_alpha"), { kind: "bot" }).filter((e) => e.type === "user_message" || e.type === "note").map((e) => (e.type === "note" ? "note" : String(e.text))))
      .toEqual(["one", "three", "note", "two", "five", "note", "four"]);
  });

  test("a crash after the meta lists a run but before the cut: set aside again, appended once", async () => {
    const { laptop, studio, shared, laptopHome, clock, runs } = await forked();
    const cut = SessionLogFile.prototype.cut;
    SessionLogFile.prototype.cut = function () {
      throw new Error("power cut");
    };
    try {
      expect(() => laptop.setAside("b_alpha", shared, { from: "studio-device" })).toThrow("power cut");
    } finally {
      SessionLogFile.prototype.cut = cut;
    }
    // The next start: the log is whole, and the run is listed with its file.
    const laptop2 = new DurableSessionHost({ home: laptopHome, clock, computer: "Laptop", runsHere: () => runs.laptop, mayStart: () => runs.laptop });
    const [run1] = laptop2.earlier("b_alpha");
    expect(laptop2.head("b_alpha")).toBe(laptop.head("b_alpha"));
    const records1 = laptop2.readEarlier("b_alpha", run1!.id);
    expect(records1.length).toBe(laptop2.head("b_alpha") - shared);
    // The sync finds the fork again and sets it aside again: a second run of the same records.
    clock.advance(1);
    const records2 = laptop2.setAside("b_alpha", shared, { from: "studio-device" });
    const [, run2] = laptop2.earlier("b_alpha");
    expect(records2).toEqual(records1);
    expect(laptop2.head("b_alpha")).toBe(shared);
    // Both runs reach the main: the records go in once, behind one note.
    const head = studio.head("b_alpha");
    const n = studio.appendLate("b_alpha", records1, { from: "laptop-device", computer: "Laptop", earlierId: run1!.id });
    expect(n).toBe(records1.filter((r) => r.type !== "status").length);
    expect(studio.appendLate("b_alpha", records2, { from: "laptop-device", computer: "Laptop", earlierId: run2!.id })).toBe(0);
    expect(studio.appendLate("b_alpha", records2, { from: "laptop-device", computer: "Laptop" })).toBe(0);
    expect(studio.head("b_alpha")).toBe(head + n + 1);
  });

  test("records already late from a third computer keep where they came from, and go in once whoever resends them", async () => {
    const { laptop, studio, shared } = await forked();
    const aside = laptop.setAside("b_alpha", shared, { from: "studio-device" });
    const fromDesk = aside.filter((r) => r.type !== "status").map((r, i) => ({ ...r, late: true, lateFrom: { device: "desk-device", computer: "Desk", seq: 100 + i, ts: r.ts } })) as SessionRecord[];
    const head = studio.head("b_alpha");
    expect(studio.appendLate("b_alpha", fromDesk, { from: "laptop-device", computer: "Laptop" })).toBe(fromDesk.length);
    const tail = studio.history("b_alpha", { afterSeq: head - 1 });
    // Not the laptop's own: no "Earlier on Laptop" note opens them, and each keeps the desk's place.
    expect(tail).toHaveLength(fromDesk.length);
    expect(tail.map((r) => (r as { lateFrom?: { device: string; seq: number } }).lateFrom)).toEqual(fromDesk.map((r) => expect.objectContaining({ device: "desk-device", seq: (r as unknown as { lateFrom: { seq: number } }).lateFrom.seq })));
    expect(studio.appendLate("b_alpha", fromDesk, { from: "other-device", computer: "Other" })).toBe(0);
    expect(studio.head("b_alpha")).toBe(head + fromDesk.length);
  });
});

