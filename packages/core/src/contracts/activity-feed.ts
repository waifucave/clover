// Contract: ActivityFeed (spec revision 19, §3.6 "The activity feed", §6.9 moods; G4, item 105). Owner: lane AF.
//
// One general feed per code session and per bot, with the states of `ACTIVITY_STATES`. MOSS's faces read it for their
// moods; a plugin reads it by kind (`activity.read.sessions`, `activity.read.bots`); the user's own clients read both.
//
// What the contract promises:
// * Only a state, a name, a tool's wire name and a time go in: `set` refuses anything else (`invalid`), so no message
//   text, tool argument or card text can ride along.
// * Readers are scoped by kind: a plugin without the kind's capability is refused (`refused`), and a watch of one kind
//   never hears the other's.
// * `set` with the same state and name as before changes nothing and is heard by no one.
import { kindCapability, type ActivitySubject, type ActivityView, type DataKind } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

/** Who reads: the user's own client, or a plugin with its granted capabilities. */
export type FeedReader = { kind: "user" } | { kind: "plugin"; capabilities: readonly string[] };

export interface ActivityFeed {
  /** The engine's own reading of a subject (from its session's events). */
  set(view: ActivityView): void;
  /** The session ended or the bot was removed. */
  remove(subject: ActivitySubject): void;
  list(kind: DataKind, reader: FeedReader): ActivityView[];
  watch(kind: DataKind, reader: FeedReader, fn: (view: ActivityView) => void): Unsubscribe;
}

/** Whether `reader` may read `kind` from a family (`activity.read.*`, `picture.read.*`): the user always, a plugin with
 *  that kind's capability. */
export function readerMay(reader: FeedReader, family: "activity.read.*" | "picture.read.*" | "conversation.*", kind: DataKind): boolean {
  return reader.kind === "user" || reader.capabilities.includes(kindCapability(family, kind));
}
