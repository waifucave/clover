// Every string the window frame shows, in one place, for the move to `clover.` keys (plan, F-M3).
export const S = {
  sessionMenu: (title: string) => `${title}: options`,
  panelToggles: "Panels",
  showSidebar: "Show the sidebar",
  hideSidebar: "Hide the sidebar",
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
  /** The one button for the panels a plugin adds beyond the third. */
  otherPanels: "Other panels",
  close: (title: string) => `Close ${title}`,
  expand: (title: string) => `Expand ${title}`,
  panel: "Panel",
  empty: (title: string) => `No plugin shows the ${title.toLowerCase()} here yet`,
  emptyDetail: "Each panel comes from a plugin of its own. Install one that fills this panel, and it opens here.",
  findPlugin: "Find a plugin",
  // A bot's own replacement for a stock panel that did not draw: the stock one shows, with a way to try the bot's again.
  fellBack: (bot: string, title: string) => `${bot}'s ${title.toLowerCase()} panel didn't draw; showing Clover's.`,
  tryAgain: (bot: string) => `Try ${bot}'s again`,
  showClovers: "Show Clover's panel",
  useBots: (bot: string) => `Use ${bot}'s panel`,
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
