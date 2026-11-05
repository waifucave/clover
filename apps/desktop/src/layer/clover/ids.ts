// The `clover` children the layer's bundle binds, in the order their stylesheets join `clover.css`. Plain data, so the
// build reads it without loading React.
export const modules = [
  "clover/shell",
  "clover/sidebar",
  "clover/conversation",
  "clover/composer",
  "clover/panel",
  "clover/panel-diff",
  "clover/panel-files",
  "clover/panel-terminal",
  "clover/settings",
] as const;

export type CloverChildId = (typeof modules)[number];
