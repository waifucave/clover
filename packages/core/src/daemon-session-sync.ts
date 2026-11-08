// Sessions' records copied in from the user's other computers (lane H's `SessionRecordSync`, the daemon integration
// lane): what the daemon puts between the sync and lane D's host.
//
// * **A copied grant never grants** (review N7; D's reviewer). A `session_grant` record is the person's yes on a card
//   on the computer that recorded it, for that computer's browser. Taken as it is into this computer's log, lane D's
//   `SessionGrants` would read it as a grant here, and the session would drive this computer's browser without a card.
//   So every one that comes in is converted at ingest, before the host sees it, into `session_grant_copied`: the same
//   place in the log (the seq stays, so the runner's and this copy's heads still agree), the key and the computer it
//   came from kept for the record, and nothing `SessionGrants` reads. A session that moves here asks again, on its own
//   card here.
// * The converted record is core-only, as the grant itself is: never sent to clients (lane D's `CORE_ONLY_EVENT_TYPES`,
//   which the clients' projection drops). D's `ingest` renames a copied grant too (#279); this keeps the rule at the
//   daemon's own door whatever the host does, and adds the computer it came from.
import type { SessionRecord } from "./contracts/session-host";
import { COPIED_GRANT_EVENT_TYPE } from "./sessions/durable-host";
import type { SessionHostForSync, SessionRecordSink } from "./sync/session-records";

/** What a grant copied from another computer becomes in this computer's log (lane D's name for it). */
export const COPIED_GRANT_EVENT = COPIED_GRANT_EVENT_TYPE;

/** The grant records' type (lane D's `SessionGrants`). */
const GRANT_EVENT = "session_grant";

/** One record as it lands here: a grant from another computer is converted; everything else is as it came. */
export function copiedRecord(r: SessionRecord, from: string): SessionRecord {
  if (r.type !== "driver" || r.event.type !== GRANT_EVENT) return r;
  const key = r.event["key"];
  return { ...r, event: { type: COPIED_GRANT_EVENT, ...(typeof key === "string" ? { key } : {}), from } };
}

/** Lane D's host as the sync's sink, with every copied grant converted before it lands. The daemon hands the sync
 *  this, never the host itself. */
export function sinkWithoutCopiedGrants(host: SessionRecordSink): SessionRecordSink {
  return {
    head: (id) => host.head(id),
    ingest: (view, records, opts) => host.ingest(view, records.map((r) => copiedRecord(r, opts.from)), opts),
    setAside: (id, fromSeq, opts) => host.setAside(id, fromSeq, opts),
    // Another computer's set-aside records are copies too: a grant among them never grants here.
    appendLate: (id, records, opts) => host.appendLate(id, records.map((r) => copiedRecord(r, opts.from)), opts),
    earlier: (id) => host.earlier(id),
    readEarlier: (id, earlierId) => host.readEarlier(id, earlierId),
    ackEarlier: (id, earlierId) => host.ackEarlier(id, earlierId),
  };
}

/** Lane D's host as the sync reads and fills it: its records as they are, the others' through the guard above. */
export function hostForSync(host: SessionHostForSync): SessionHostForSync {
  const sink = sinkWithoutCopiedGrants(host);
  return {
    tap: (fn) => host.tap(fn),
    history: (id, opts) => host.history(id, opts),
    list: () => host.list(),
    get: (id) => host.get(id),
    head: sink.head,
    ingest: sink.ingest,
    setAside: sink.setAside,
    appendLate: sink.appendLate,
    earlier: sink.earlier,
    readEarlier: sink.readEarlier,
    ackEarlier: sink.ackEarlier,
  };
}
