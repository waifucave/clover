import { describe, expect, test } from "bun:test";
import type { SessionView } from "@waifucave/clover-protocol";
import type { ApprovalDecision, ApprovalRequest } from "../src/contracts/approval-broker";
import type { SessionRecord } from "../src/contracts/session-host";
import { COPIED_GRANT_EVENT, copiedRecord, sinkWithoutCopiedGrants } from "../src/daemon-session-sync";
import { SessionGrants, USER_BROWSER_PARTITION_GRANT } from "../src/sessions/grants";

// D's reviewer's rule for the sessions' records copied from another computer: a `session_grant` made there never
// counts as a grant here, so a session that moves here can't drive this computer's browser without its own card.

/** Lane D's host as far as the sync and the grants read it: one log per session. */
class LogHost {
  readonly logs = new Map<string, SessionRecord[]>();
  readonly views = new Map<string, SessionView>();
  head(id: string): number {
    return this.logs.get(id)?.length ?? 0;
  }
  ingest(view: SessionView, records: SessionRecord[]): void {
    this.views.set(view.id, view);
    const log = this.logs.get(view.id) ?? [];
    for (const r of records) log.push(r);
    this.logs.set(view.id, log);
  }
  get(id: string) {
    return this.views.get(id);
  }
  callerOf(_id: string) {
    return { bot: "luna" };
  }
  turnOrigin(_id: string) {
    return "bot" as const;
  }
  recordCore(id: string, event: { type: string; [key: string]: unknown }): SessionRecord {
    const log = this.logs.get(id) ?? [];
    const r: SessionRecord = { type: "driver", event, seq: log.length, sessionId: id, ts: Date.now() };
    log.push(r);
    this.logs.set(id, log);
    return r;
  }
  history(id: string, opts: { afterSeq?: number } = {}): SessionRecord[] {
    return (this.logs.get(id) ?? []).filter((r) => r.seq > (opts.afterSeq ?? -1));
  }
  length(id: string): number {
    return this.logs.get(id)?.length ?? 0;
  }
}

const view = { id: "s_luna", status: "idle", bot: "luna" } as unknown as SessionView;
const record = (seq: number, body: Pick<SessionRecord, "type"> & Record<string, unknown>): SessionRecord =>
  ({ ...body, seq, sessionId: view.id, ts: 1_000 + seq }) as SessionRecord;

describe("sessions' records from another computer", () => {
  test("a copied session_grant never grants here; it keeps its place in the log; the person's own card here does", async () => {
    const host = new LogHost();
    const sink = sinkWithoutCopiedGrants(host);
    const copied = [
      record(0, { type: "turn_started", origin: "bot" }),
      record(1, { type: "driver", event: { type: "session_grant", key: USER_BROWSER_PARTITION_GRANT, cardId: "card_there" } }),
      record(2, { type: "turn_ended", end: { reason: "done" } }),
    ];
    sink.ingest(view, copied, { from: "dev_studio", late: false });
    // The same place in the log: the runner's head and this copy's agree.
    expect(sink.head(view.id)).toBe(3);
    expect(host.logs.get(view.id)!.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(host.logs.get(view.id)![1]).toMatchObject({ type: "driver", event: { type: COPIED_GRANT_EVENT, key: USER_BROWSER_PARTITION_GRANT, from: "dev_studio" } });
    expect(JSON.stringify(host.logs.get(view.id)![1])).not.toContain("card_there");

    // Lane D's grants over this log: the copy isn't a grant, so the session is asked on its own card here.
    const asked: ApprovalRequest[] = [];
    let answer: ApprovalDecision = { allowed: false, by: "card" } as ApprovalDecision;
    const grants = new SessionGrants({ host: host as never, approvals: { request: async (r) => (asked.push(r), answer) } });
    expect(grants.has(view.id, USER_BROWSER_PARTITION_GRANT)).toBe(false);
    expect((await grants.ensure(view.id, USER_BROWSER_PARTITION_GRANT, { title: "Use your browser" } as never)).allowed).toBe(false);
    expect(asked).toHaveLength(1);
    // The person's yes on the card here grants it, here.
    answer = { allowed: true, by: "card", cardId: "card_here" } as ApprovalDecision;
    expect((await grants.ensure(view.id, USER_BROWSER_PARTITION_GRANT, { title: "Use your browser" } as never)).allowed).toBe(true);
    expect(grants.has(view.id, USER_BROWSER_PARTITION_GRANT)).toBe(true);
  });

  test("without the guard the same record would grant: the guard is what stands between them", () => {
    const host = new LogHost();
    host.ingest(view, [record(0, { type: "driver", event: { type: "session_grant", key: USER_BROWSER_PARTITION_GRANT } })]);
    const grants = new SessionGrants({ host: host as never, approvals: { request: async () => ({ allowed: false }) as never } });
    expect(grants.has(view.id, USER_BROWSER_PARTITION_GRANT)).toBe(true);
  });

  test("every other record comes in as it was", () => {
    const r = record(4, { type: "driver", event: { type: "tool_call", name: "Read" } });
    expect(copiedRecord(r, "dev_studio")).toBe(r);
    const input = record(5, { type: "status", status: "idle" });
    expect(copiedRecord(input, "dev_studio")).toBe(input);
  });
});
