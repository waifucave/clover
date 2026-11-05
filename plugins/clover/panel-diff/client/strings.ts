// Every string the diff panel shows, for the move to `clover.` keys (plan, F-M3).
const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));

export const S = {
  compare: (base: string, target: string) => `Comparing ${base} with ${target}`,
  workingTree: "working tree",
  layout: "Layout",
  unified: "Unified",
  split: "Split",
  files: "Changed files",
  open: (path: string) => `Open ${path}`,
  fold: (path: string) => `Fold ${path}`,
  unfold: (path: string) => `Unfold ${path}`,
  tooLarge: "Too big to draw here",
  hiddenWarning: "Has hidden characters",
  hiddenMark: (code: string, name: string) => `Hidden character ${code}, ${name}`,
  binary: "Binary file",
  renamed: (from: string) => `from ${from}`,
  stat: (added: number, removed: number) => `${n(added, "1 line added", "# lines added")}, ${n(removed, "1 removed", "# removed")}`,
  status: { added: "Added", modified: "Changed", deleted: "Deleted", renamed: "Renamed" } as const,
  base: "Base",
  target: "Compare with",
  none: "No changes",
};
