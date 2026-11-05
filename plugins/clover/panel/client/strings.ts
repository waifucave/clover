// Every string the panel shows, in one place, for the move to `clover.` keys (plan, F-M3).
const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));

export const S = {
  views: {
    session: "Session",
    terminal: "Terminal",
    diff: "Changes",
    browser: "Browser",
    files: "Files",
  } as const,
  toggle: (label: string, open: boolean) => (open ? `Hide ${label}` : `Show ${label}`),
  more: "More panels",
  close: (title: string) => `Close ${title}`,
  expand: (title: string) => `Expand ${title}`,
  panel: "Panel",
  // The session column.
  agents: "Agents and tasks",
  environment: "Environment",
  here: "This computer",
  save: "Save",
  saveTitle: "Keep this setup for new sessions here",
  remote: "Reach it from your phone",
  context: "Context",
  contextUsed: (pct: number) => `${pct}%`,
  contextLabel: (pct: number) => `${pct}% of the context used`,
  connectors: "Connectors",
  connectorsState: (total: number, needSignIn: number) =>
    needSignIn > 0 ? n(needSignIn, "1 to sign in again", "# to sign in again") : n(total, "1 connected", "# connected"),
  outputs: "Outputs",
  outputKind: { artifact: "Artifact", file: "File", image: "Image" } as const,
  showMore: (count: number) => n(count, "Show 1 more", "Show # more"),
  changes: "Changes",
  diffStat: (added: number, removed: number) => `+${added} −${removed}`,
  diffStatLabel: (files: number, added: number, removed: number) =>
    `${n(files, "1 file", "# files")}, ${added} added, ${removed} removed`,
  createPr: "Create PR",
  prState: { open: "Open", draft: "Draft", merged: "Merged" } as const,
  pr: (repo: string, number: number) => `${repo} #${number}`,
  agentStatus: {
    running: "Running",
    "needs-you": "Needs you",
    completed: "Done",
    failed: "Failed",
    stopped: "Stopped",
    stalled: "Stalled",
  } as const,
  fold: (title: string) => `Fold ${title}`,
  unfold: (title: string) => `Unfold ${title}`,
};
