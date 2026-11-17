// The engine's activity feed (spec revision 19, §3.6, G4; contract `contracts/activity-feed.ts`): one view per code
// session and per bot, kept in memory (it is derived from the sessions' own records, `derive.ts`, and rebuilt at start).
// `ActivityView` is strict: a state, a name, a tool's wire name and a time, never message text, tool arguments or card
// text, so a derivation that tried to carry one in is refused here whatever it reads from.
import { ActivityView, type ActivitySubject, type DataKind } from "@waifucave/moss-protocol";
import { readerMay, type ActivityFeed, type FeedReader } from "../contracts/activity-feed";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";

const keyOf = (s: ActivitySubject) => `${s.kind}:${s.id}`;

export class EngineActivityFeed implements ActivityFeed {
  readonly #views = new Map<string, ActivityView>();
  readonly #listeners: Record<DataKind, Listeners<ActivityView>> = { sessions: new Listeners(), bots: new Listeners() };

  set(view: ActivityView): void {
    const parsed = ActivityView.safeParse(view);
    if (!parsed.success) throw new ContractError("invalid", "the feed takes a state, a name and a tool's name only");
    const v = parsed.data;
    const old = this.#views.get(keyOf(v.subject));
    if (old && old.state === v.state && old.name === v.name && old.tool === v.tool) return;
    this.#views.set(keyOf(v.subject), v);
    this.#listeners[v.subject.kind].emit(v);
  }

  remove(subject: ActivitySubject): void {
    this.#views.delete(keyOf(subject));
  }

  #check(kind: DataKind, reader: FeedReader): void {
    if (!readerMay(reader, "activity.read.*", kind)) throw new ContractError("refused", `reading the ${kind} feed needs activity.read.${kind}`);
  }

  list(kind: DataKind, reader: FeedReader): ActivityView[] {
    this.#check(kind, reader);
    return [...this.#views.values()].filter((v) => v.subject.kind === kind);
  }

  watch(kind: DataKind, reader: FeedReader, fn: (view: ActivityView) => void): Unsubscribe {
    this.#check(kind, reader);
    return this.#listeners[kind].add(fn);
  }
}
