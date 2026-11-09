// Every string the archive shows, for the move to `clover.` keys (plan, F-M3).
export const S = {
  title: "Archive",
  intro: "Sessions from before Clover, kept to read. They aren't part of any bot's history.",
  search: "Search old sessions",
  sessions: "Old sessions",
  loading: "Loading…",
  none: (query: string) => (query ? `No old session matches “${query}”.` : "There are no sessions from before Clover on this computer."),
  more: "Show older",
  mode: { code: "Code", chat: "Chat", dispatch: "Dispatch" } as const,
  /** `ArchivedSessionView.messages` is the log's length as the index counts it (every record, not only the
   *  messages), so it is shown as entries. */
  messages: (n: number) => (n === 1 ? "1 entry" : `${n} entries`),
  untitled: "Untitled session",
  pick: "Pick a session to read it.",
  readOnly: "Read only. Start something new with a bot.",
};
