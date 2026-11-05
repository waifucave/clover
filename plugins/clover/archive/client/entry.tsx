// The archive on the runtime: the `main` entry keyed `archive`, which its `sidebar.app` button opens. It lists the
// sessions from the app Clover replaces through the core (`archive.list`, newest first, a page at a time) and draws the picked one through
// the `conversation` spot, read only: the conversation part reads it from `archive.history` when its props say
// `archived`. An old session's approvals have no sealed card, so they read as notes there.
import { useEffect, useState } from "react";
import type { ArchivedSessionView } from "../../shell/runtime/types";
import { Archive } from "./Archive";
import { Spot, useCore } from "./sdk";

export interface ArchiveEntryProps {
  route?: string;
  params?: { session?: string };
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
  now?: number;
}

const PAGE = 50;

/** Who speaks in an old session: the app it came from, by name (the one place the archive spells it, with strings.ts). */
export const OLD_APP = { id: "winter", name: "Winter" };

export function ArchiveEntry({ props }: { props: ArchiveEntryProps }) {
  const core = useCore();
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [sessions, setSessions] = useState<ArchivedSessionView[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | undefined>(props.params?.session);

  useEffect(() => {
    if (!core) return;
    let live = true;
    setLoading(true);
    core.call("archive.list", { ...(asked ? { query: asked } : {}), limit: PAGE }).then(
      (page) => {
        if (!live) return;
        setSessions(page.sessions);
        setMore(page.more);
        setLoading(false);
      },
      () => live && setLoading(false),
    );
    return () => {
      live = false;
    };
  }, [core, asked]);

  const older = () => {
    const last = sessions[sessions.length - 1];
    if (!core || !last) return;
    void core.call("archive.list", { ...(asked ? { query: asked } : {}), before: last.updatedAt, limit: PAGE }).then((page) => {
      setSessions((s) => [...s, ...page.sessions.filter((x) => !s.some((y) => y.id === x.id))]);
      setMore(page.more);
    });
  };

  return (
    <Archive
      sessions={sessions}
      loading={loading}
      more={more}
      onMore={older}
      query={query}
      onQuery={setQuery}
      onSearch={setAsked}
      {...(selected ? { selected } : {})}
      onSelect={setSelected}
      {...(selected ? { transcript: <Spot name="conversation" props={{ bot: OLD_APP, session: selected, archived: true }} /> } : {})}
      now={props.now ?? Date.now()}
    />
  );
}

/** The `sidebar.app` entry's component. B's manifest rule gives every `ui` entry one, but the sidebar draws the app
 *  button from the entry's fields (title, icon, opens), so this draws nothing: the archive has nothing to badge. */
export function ArchiveAppBadge(): null {
  return null;
}
