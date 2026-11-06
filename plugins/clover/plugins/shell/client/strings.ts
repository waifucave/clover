// Every string the window frame shows, in one place, for the move to `clover.` keys (plan, F-M3).
export const S = {
  sessionMenu: (title: string) => `${title}: options`,
  panelToggles: "Panels",
  statusBar: "Status",
  dialogHeld: "Answer the waiting card first, then open it again.",
  // The panel host and its toggles.
  views: {
    session: "Session",
    terminal: "Terminal",
    diff: "Changes",
    browser: "Browser",
    files: "Files",
    agent: "Agent",
  } as Record<string, string>,
  /** A bot's tab's slim column. */
  botColumn: "Details",
  toggle: (label: string, open: boolean) => (open ? `Hide ${label}` : `Show ${label}`),
  more: "More panels",
  close: (title: string) => `Close ${title}`,
  expand: (title: string) => `Expand ${title}`,
  panel: "Panel",
  empty: (title: string) => `No plugin shows the ${title.toLowerCase()} here yet`,
  emptyDetail: "Each panel comes from a plugin of its own. Install one that fills this panel, and it opens here.",
  findPlugin: "Find a plugin",
  // The shell's own pages.
  editBot: (name: string) => `Edit ${name}`,
  settings: "Settings",
  plugins: "Plugins",
  nothingHere: "Nothing here yet",
  nothingHereDetail: "No plugin fills this page. Find one that does, and it opens here.",
  loading: "Loading…",
  // An agent's live tab.
  agentStatus: {
    starting: "Starting",
    ready: "Ready",
    prompting: "Working",
    cancelling: "Stopping",
    idle: "Waiting for you",
    stopped: "Stopped",
    failed: "Failed",
  } as Record<string, string>,
  interrupt: "Interrupt",
  stop: "Stop",
  agentOn: (backend: string, computer: string) => `${backend} on ${computer}`,
};
