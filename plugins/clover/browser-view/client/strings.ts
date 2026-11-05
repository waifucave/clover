// Every string the browser view shows, for the move to `clover.` keys (plan, F-M3).
export const S = {
  tabs: "Browser tabs",
  newTab: "New tab",
  close: (title: string) => `Close ${title}`,
  back: "Back",
  forward: "Forward",
  reload: "Reload",
  address: "Address",
  annotate: "Mark up the page",
  tools: { pointer: "Point at something", pen: "Draw", box: "Draw a box", text: "Write a note" } as const,
  stopAnnotating: "Stop marking up",
  view: (title: string) => `Page: ${title}`,
  placeholderTitle: "The live page shows here",
  placeholderText: "The page opens here as soon as the browser has it.",
  /** A tab the user holds in the view: the bot's commands on it wait. */
  held: "You are using this tab. The bot waits until you let go.",
  noTab: "No tab open",
  /** The live view went to another panel the person used since (R8). */
  paused: "Paused: the live page is in another panel. Click the picture to bring it here.",
  resume: "Show the live page here",
  /** What went wrong, in a sentence a person can use; the browser's own reason follows when it gave one. */
  failed: {
    tabs: "Couldn't load the tabs.",
    open: "Couldn't open a new tab.",
    close: "Couldn't close that tab.",
    navigate: "Couldn't open that address.",
    history: "Couldn't change the page.",
    reload: "Couldn't reload the page.",
    show: "Couldn't show the page here.",
  },
  /** The browser view's plugin has no browser to drive (the plugin API has no `browser`). */
  unavailable: "The browser isn't available here.",
};
