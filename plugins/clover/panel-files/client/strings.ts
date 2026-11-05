// Every string the files panel shows, for the move to `clover.` keys (plan, F-M3).
export const S = {
  tree: "Files",
  filter: "Filter files",
  filterHint: "Filter, or start with ? to search inside files",
  noMatch: "No file matches",
  emptyTitle: "No file open",
  emptyText: "Pick a file in the tree, or a path in the conversation, to read it here.",
  loading: "Listing…",
  viewer: (path: string) => `Contents of ${path}`,
  fold: (name: string) => `Fold ${name}`,
  unfold: (name: string) => `Unfold ${name}`,
};
