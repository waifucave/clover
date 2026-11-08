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
import { CloverUsageCounter } from "../../usage/counter";
import { cloverUsageDbPath, UsageLedger } from "../../usage/ledger";
import type { SessionRecord } from "../../contracts/session-host";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const tempHome = () => {
  const h = mkdtempSync(join(tmpdir(), "clover-d-ingest-"));
  homes.push(h);
  return h;
};

/** Records as their computer wrote them: a copy's source left out. */
const bare = (rs: SessionRecord[]) => rs.map((r) => {
  const { copiedFrom: _, ...rest } = r as SessionRecord & { copiedFrom?: string };
  return rest;
});

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
    expect(bare(laptop.history("b_alpha"))).toEqual(records);
    expect(laptop.history("b_alpha").every((r) => (r as { copiedFrom?: string }).copiedFrom === "studio-device")).toBe(true);
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
    expect(bare(laptop.history("b_alpha"))).toEqual(records.slice(0, 4));
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

  test("a bot's conversation the lease left keeps its driver and takes copies; a takeover ends the open turn and runs here", async () => {
    const clock = new FakeClock();
    let laptopRuns = true;
    const studio = new DurableSessionHost({ home: tempHome(), clock, computer: "Studio" });
    const laptop = new DurableSessionHost({ home: tempHome(), clock, computer: "Laptop", runsHere: () => laptopRuns, mayStart: () => laptopRuns });
    const laptopDriver = new FakeSessionDriver({ canFold: true });
    // Both computers ran the bot before they paired: each opened its conversation.
    laptop.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Laptop" }, laptopDriver);
    const view = studio.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver({ canFold: true }));
    // While the lease is here, this computer runs it and takes no copies.
    const here = await Promise.resolve().then(() => laptop.ingest(view, studio.history("b_alpha"), { from: "studio-device", late: false })).catch((e: unknown) => e);
    expect(isContractError(here, "refused")).toBe(true);
    // Studio becomes main: a turn starts there, and a second message waits behind it.
    laptopRuns = false;
    await studio.sendUser("b_alpha", { text: "first", device: "studio", sentAt: 1, clientMessageId: "m1" });
    await studio.sendUser("b_alpha", { text: "second", device: "studio", sentAt: 2, clientMessageId: "m2" });
    await flush();
    const records = studio.history("b_alpha");
    expect(records.some((r) => r.type === "turn_started")).toBe(true);
    // The opening both wrote alike is the same record, skipped; the rest goes on. Nothing runs here.
    laptop.ingest(view, records, { from: "studio-device", late: false });
    laptop.resume();
    await flush();
    expect(laptop.head("b_alpha")).toBe(records.length);
    expect(laptop.get("b_alpha")?.computer).toBe("Studio");
    expect(laptopDriver.turns).toHaveLength(0);
    // Studio goes away mid-turn and the lease comes here: the open turn is ended, and the next message runs here.
    laptopRuns = true;
    laptop.resume();
    await flush();
    const after = laptop.history("b_alpha", { afterSeq: records.length - 1 });
    expect(after[0]).toMatchObject({ type: "turn_ended", end: { reason: "interrupted" } });
    // The second message interrupted the first there and its turn was left open: nothing waits, nothing ran here.
    expect(laptopDriver.turns).toHaveLength(0);
    expect(laptop.get("b_alpha")?.status).toBe("idle");
    await laptop.sendUser("b_alpha", { text: "third", device: "laptop", sentAt: 3, clientMessageId: "m3" });
    await flush();
    expect(laptopDriver.turns.map((t) => (t.input as { text?: string }).text)).toEqual(["third"]);
  });

  test("a different record at a held seq is a fork: refused whole, nothing written", async () => {
    const clock = new FakeClock();
    const studio = new DurableSessionHost({ home: tempHome(), clock, computer: "Studio" });
    const laptop = new DurableSessionHost({ home: tempHome(), clock, computer: "Laptop" });
    const view = studio.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, new FakeSessionDriver({ canFold: true }));
    await studio.sendUser("b_alpha", { text: "from the studio", device: "studio", sentAt: 1, clientMessageId: "m1" });
    const records = studio.history("b_alpha");
    laptop.ingest(view, records.slice(0, 1), { from: "studio-device", late: false });
    // Another computer's record at seq 1 (the laptop wrote that place itself), then the studio's own batch over it.
    const theirs = { ...records[1]!, ts: records[1]!.ts + 1 };
    laptop.ingest(view, [theirs], { from: "studio-device", late: false });
    const head = laptop.head("b_alpha");
    const fork = await Promise.resolve().then(() => laptop.ingest(view, records, { from: "studio-device", late: false })).catch((e: unknown) => e);
    expect(isContractError(fork, "conflict")).toBe(true);
    expect(laptop.head("b_alpha")).toBe(head);
    expect(bare(laptop.history("b_alpha"))[1]).toEqual(theirs);
    // A repeat that differs only by its late mark is the same record.
    laptop.ingest(view, [theirs], { from: "studio-device", late: true });
    expect(laptop.head("b_alpha")).toBe(head);
  });

  test("a copied view must parse and be what its id says, and may not name this computer (review S1)", async () => {
    const { studio, laptop, view } = await pair();
    const records = studio.history("b_alpha");
    const refused = async (v: unknown, code: "invalid" | "refused") => {
      const err = await Promise.resolve().then(() => laptop.ingest(v as typeof view, records, { from: "studio-device", late: false })).catch((e: unknown) => e);
      expect(isContractError(err, code)).toBe(true);
    };
    await refused({ ...view, status: "dancing" }, "invalid");
    await refused({ ...view, bot: "luna" }, "invalid");
    await refused({ ...view, kind: "agent" }, "invalid");
    await refused({ ...view, id: "b_luna", bot: "luna" } as typeof view, "invalid");
    await refused({ ...view, computer: "Laptop" }, "refused");
    expect(laptop.head("b_alpha")).toBe(0);
    // A bot's main conversation whose lease is elsewhere may still name this computer (the view hasn't followed yet).
    const clock = new FakeClock();
    const other = new DurableSessionHost({ home: tempHome(), clock, computer: "Laptop", runsHere: () => false });
    other.ingest({ ...view, computer: "Laptop" }, records, { from: "studio-device", late: false });
    expect(other.head("b_alpha")).toBe(records.length);
    // Once known, a session's kind and bot come from this computer, never from the sender.
    laptop.ingest(view, records.slice(0, 1), { from: "studio-device", late: false });
    const side = { ...view, id: "t_000000000001", kind: "side-thread" as const, parent: "b_alpha" };
    expect(isContractError(await Promise.resolve().then(() => laptop.ingest({ ...side, id: "b_alpha" }, records, { from: "studio-device", late: false })).catch((e: unknown) => e), "invalid")).toBe(true);
  });

  test("a copied turn's usage is counted on the computer that ran it, not on a copy's start (review S2)", async () => {
    const clock = new FakeClock();
    const studio = new DurableSessionHost({ home: tempHome(), clock, computer: "Studio" });
    const driver = new FakeSessionDriver({ canFold: true });
    const view = studio.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
    await studio.sendUser("b_alpha", { text: "hi", device: "studio", sentAt: 1, clientMessageId: "m1" });
    await flush();
    driver.emit({ type: "turn_usage", model: "anthropic/claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 200 });
    driver.end({ text: "hello", usage: { inputTokens: 1_000, outputTokens: 200 } });
    await flush();
    const laptopHome = tempHome();
    const laptop = new DurableSessionHost({ home: laptopHome, clock, computer: "Laptop" });
    laptop.ingest(view, studio.history("b_alpha"), { from: "studio-device", late: false });
    const ledgerOf = (home: string, host: DurableSessionHost) => {
      const ledger = new UsageLedger({ path: cloverUsageDbPath(home), computer: "x" });
      new CloverUsageCounter({ ledger, host }).start();
      return ledger;
    };
    expect(ledgerOf(laptopHome, laptop).rows({ since: 0 }).rows).toHaveLength(0);
    expect(ledgerOf(tempHome(), studio).rows({ since: 0 }).rows).toHaveLength(1);
  });
});

