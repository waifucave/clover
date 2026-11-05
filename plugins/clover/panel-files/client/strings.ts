// Every string the files panel shows, for the move to `clover.` keys (plan, F-M3).
export const S = {
  tree: "Files",
  filter: "Filter files",
  filterHint: "Filter names · ?word inside",
  noMatch: "No file matches",
  emptyTitle: "No file open",
  emptyText: "Choose one from the tree on the right, or any path the bot names in the conversation.",
  hiddenWarning: "Has hidden characters",
  hiddenMark: (code: string, name: string) => `Hidden character ${code}, ${name}`,
  loading: "Listing…",
  viewer: (path: string) => `Contents of ${path}`,
  fold: (name: string) => `Fold ${name}`,
  unfold: (name: string) => `Unfold ${name}`,
};
