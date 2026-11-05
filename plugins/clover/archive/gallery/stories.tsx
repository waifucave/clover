// Every archive state the gallery shows. In the app the picked session's transcript is the conversation part's (the
// shell gallery's archive screen shows it); here a line stands in for it.
import { useState } from "react";
import { Archive } from "../client/Archive";
import type { ArchivedSession } from "../client/types";
import { ARCHIVED, NOW } from "./fixtures";
import type { Story } from "./story";

const FORMAT = { locale: "en-US", timeZone: "UTC" };

export function ArchiveDemo({ sessions = ARCHIVED, start, loading, query = "" }: { sessions?: ArchivedSession[]; start?: string; loading?: boolean; query?: string }) {
  const [selected, setSelected] = useState(start);
  const [q, setQ] = useState(query);
  return (
    <Archive
      sessions={sessions}
      {...(loading ? { loading } : {})}
      more
      onMore={() => undefined}
      query={q}
      onQuery={setQ}
      onSearch={() => undefined}
      {...(selected ? { selected } : {})}
      onSelect={setSelected}
      transcript={<p className="story-transcript">The conversation part draws the transcript here.</p>}
      now={NOW}
      format={FORMAT}
    />
  );
}

export const archiveStories: Story[] = [
  { id: "archive/list", title: "The archive", notes: "Old Winter sessions, newest first: each with its mode, its project and when it was last used.", width: 1000, height: 640, render: () => <ArchiveDemo /> },
  { id: "archive/picked", title: "A session picked", notes: "It reads on the right, read only.", width: 1000, height: 640, render: () => <ArchiveDemo start="w-1" /> },
  { id: "archive/empty", title: "No old sessions", width: 1000, height: 480, render: () => <ArchiveDemo sessions={[]} /> },
  { id: "archive/no-match", title: "Nothing matches", width: 1000, height: 480, render: () => <ArchiveDemo sessions={[]} query="taxes" /> },
];
