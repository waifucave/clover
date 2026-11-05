// Every string the archive shows, for the move to `clover.` keys (plan, F-M3).
export const S = {
  title: "Archive",
  intro: "Sessions from Winter, kept to read. They aren't part of any bot's history.",
  search: "Search old sessions",
  sessions: "Old sessions",
  loading: "Loading…",
  none: (query: string) => (query ? `No old session matches “${query}”.` : "There are no sessions from Winter on this computer."),
  more: "Show older",
  mode: { code: "Code", chat: "Chat", dispatch: "Dispatch" } as const,
  messages: (n: number) => (n === 1 ? "1 message" : `${n} messages`),
  untitled: "Untitled session",
  pick: "Pick a session to read it.",
  readOnly: "Read only. Start something new with a bot.",
};
