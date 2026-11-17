// The activity feed's and the live pictures' changes as core events (spec revision 19, §3.6): `activity_changed`,
// `picture_changed` and `picture_ended`. Each carries the kind it is about, and a plugin hears only the kinds it reads
// (`pluginMayHear`), so a bots-only plugin never hears a code session's activity.
import type { DataKind } from "@waifucave/moss-protocol";
import type { EngineActivityFeed } from "../activity/feed";
import type { EngineLivePictures } from "./live-pictures";

export function wireFeedEvents(o: { feed: EngineActivityFeed; pictures: EngineLivePictures; emit(event: { type: string; [key: string]: unknown }): void }): () => void {
  const user = { kind: "user" as const };
  const offs: (() => void)[] = [];
  const sessions = new Map<string, string>();
  for (const kind of ["sessions", "bots"] as DataKind[]) {
    offs.push(o.feed.watch(kind, user, (activity) => o.emit({ type: "activity_changed", activity })));
    offs.push(o.pictures.watch(kind, user, (e) => {
      if ("picture" in e) {
        sessions.set(e.picture.id, e.picture.session);
        o.emit({ type: "picture_changed", picture: e.picture });
        return;
      }
      const session = sessions.get(e.ended);
      sessions.delete(e.ended);
      if (session !== undefined) o.emit({ type: "picture_ended", id: e.ended, kind, session, why: e.why });
    }));
  }
  return () => offs.forEach((f) => f());
}
