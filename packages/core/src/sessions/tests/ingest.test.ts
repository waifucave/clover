// Records copied from the computer running a session (lane H's SessionRecordSync) land in this computer's log through
// `head` and `ingest`: in seq order, a repeat skipped, a gap refused, no driver run, and a copied grant granting nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { isContractError } from "../../contracts/common";
import { DurableSessionHost } from "../durable-host";
import { SessionGrants, USER_BROWSER_PARTITION_GRANT } from "../grants";
import { projectRecords } from "../wire";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const tempHome = () => {
  const h = mkdtempSync(join(tmpdir(), "clover-d-ingest-"));
  homes.push(h);
  return h;
};

/** The computer running the session, and one that copies it. */
async function pair() {
  const clock = new FakeClock();
  const studio = new DurableSessionHost({ home: tempHome(), clock, computer: "Studio" });
  const laptop = new DurableSessionHost({ home: tempHome(), clock, computer: "Laptop" });
  const driver = new FakeSessionDriver({ canFold: true });
  const view = studio.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
  await studio.sendUser("b_alpha", { text: "hi", device: "studio", sentAt: 1, clientMessageId: "m1" });
  await flush();
  driver.end({ text: "hello" });
  await flush();
  return { clock, studio, laptop, driver, view };
}

describe("ingest: a session's records copied from the computer running it", () => {
  test("in order: a dormant copy opens, its log matches, its view follows, and no driver runs", async () => {
    const { studio, laptop, view } = await pair();
    const records = studio.history("b_alpha");
    expect(laptop.head("b_alpha")).toBe(0);
    laptop.ingest(view, records.slice(0, 2), { from: "studio-device", late: false });
    expect(laptop.head("b_alpha")).toBe(2);
    laptop.ingest(view, records.slice(2), { from: "studio-device", late: false });
    expect(laptop.head("b_alpha")).toBe(records.length);
    expect(laptop.history("b_alpha")).toEqual(records);
    expect(laptop.get("b_alpha")).toMatchObject({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" });
    expect(laptop.isAttached("b_alpha")).toBe(false);
    expect(laptop.turnOrigin("b_alpha")).toBeUndefined();
    // Clients see the same conversation.
    expect(projectRecords(laptop.history("b_alpha"), { kind: "bot" }).map((e) => e.type)).toEqual(projectRecords(records, { kind: "bot" }).map((e) => e.type));
    // A copy marked late carries it.
    await studio.sendUser("b_alpha", { text: "again", device: "studio", sentAt: 2, clientMessageId: "m2" });
    const more = studio.history("b_alpha", { afterSeq: records.length - 1 });
    laptop.ingest(view, more, { from: "studio-device", late: true });
    expect(laptop.history("b_alpha", { afterSeq: records.length - 1 }).every((r) => (r as { late?: boolean }).late === true)).toBe(true);
  });

  test("a repeat is skipped; a gap or another session's record is refused whole; a session run here takes no copies", async () => {
    const { studio, laptop, view } = await pair();
    const records = studio.history("b_alpha");
    laptop.ingest(view, records.slice(0, 3), { from: "studio-device", late: false });
    // Repeated, and overlapping: only what is new is taken.
    laptop.ingest(view, records.slice(0, 3), { from: "studio-device", late: false });
    laptop.ingest(view, records.slice(1, 4), { from: "studio-device", late: false });
    expect(laptop.history("b_alpha")).toEqual(records.slice(0, 4));
    // A gap: nothing taken.
    const gap = await Promise.resolve().then(() => laptop.ingest(view, records.slice(5), { from: "studio-device", late: false })).catch((e: unknown) => e);
    expect(isContractError(gap, "invalid")).toBe(true);
    expect(laptop.head("b_alpha")).toBe(4);
    const other = { ...records[4]!, sessionId: "b_luna" };
    expect(isContractError(await Promise.resolve().then(() => laptop.ingest(view, [other], { from: "studio-device", late: false })).catch((e: unknown) => e), "invalid")).toBe(true);
    expect(laptop.head("b_alpha")).toBe(4);
    // The computer running it refuses a copy of its own session.
    const own = await Promise.resolve().then(() => studio.ingest(view, records, { from: "laptop-device", late: false })).catch((e: unknown) => e);
    expect(isContractError(own, "refused")).toBe(true);
  });

  test("a copied grant grants nothing here and never reaches clients", async () => {
    const { studio, laptop, view } = await pair();
    const asked: unknown[] = [];
    const grants = new SessionGrants({ host: studio, approvals: { request: async (req) => (asked.push(req), { allowed: true, by: "card", cardId: "card_1" }) } });
    await grants.ensure("b_alpha", USER_BROWSER_PARTITION_GRANT, { computers: ["Studio"], effect: "screen", fields: {} });
    expect(grants.has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(true);
    const records = studio.history("b_alpha");
    expect(records.some((r) => r.type === "driver" && r.event.type === "session_grant")).toBe(true);
    laptop.ingest(view, records, { from: "studio-device", late: false });
    const copied = laptop.history("b_alpha").filter((r) => r.type === "driver");
    expect(copied.some((r) => r.type === "driver" && r.event.type === "session_grant")).toBe(false);
    expect(copied.some((r) => r.type === "driver" && r.event.type === "session_grant_copied")).toBe(true);
    // The copy counts for nothing: the laptop's grants don't hold it, and would ask the person.
    const laptopGrants = new SessionGrants({ host: laptop, approvals: { request: async () => ({ allowed: false, by: "card" }) } });
    expect(laptopGrants.has("b_alpha", USER_BROWSER_PARTITION_GRANT)).toBe(false);
    // Neither the grant nor its copy is ever a client's event.
    const wire = [...projectRecords(records, { kind: "bot" }), ...projectRecords(laptop.history("b_alpha"), { kind: "bot" })];
    expect(wire.some((e) => e.type === "session_grant" || e.type === "session_grant_copied")).toBe(false);
  });
});
