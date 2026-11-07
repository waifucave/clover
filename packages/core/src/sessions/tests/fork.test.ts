// A session's copy that forked from the computer running it (the controller's ruling on the pre-pairing fork): the
// main's log wins; this computer's records from the fork on are kept aside, never deleted, and listed; the log is cut
// back and follows the main; and the main puts the set-aside records after its own, marked late, behind an "Earlier
// on <computer>" note, as history that never runs.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { isContractError } from "../../contracts/common";
import type { SessionRecord } from "../../contracts/session-host";
import { DurableSessionHost } from "../durable-host";
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
    expect(existsSync(sessionLogPath(laptopHome, "alpha", "b_alpha").replace(/\.ndjson$/, `.earlier-${entry!.id}.json`))).toBe(true);
    // Setting aside at the head is nothing.
    expect(laptop.setAside("b_alpha", shared, { from: "studio-device" })).toEqual([]);

    // The copy follows the main from the fork on.
    laptop.ingest(view, studio.history("b_alpha", { afterSeq: shared - 2 }), { from: "studio-device", late: false });
    expect(bare(laptop.history("b_alpha"))).toEqual(bare(studio.history("b_alpha")));

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
    expect(texts).toEqual(["one", "three", "note:Earlier on Laptop", "two"]);
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
});
