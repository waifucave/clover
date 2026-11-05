// Every string the browser panel shows, for the move to `clover.` keys (plan, F-M3).
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
  placeholderText: "The Clover Browser's view of this tab (lane L's tab host) fills this frame.",
  loading: "Loading",
  noTab: "No tab open",
};
