// The `moss` children the layer's bundle binds, in the order their stylesheets join `moss.css`. Plain data, so the
// build reads it without loading React.
export const modules = [
  "moss/shell",
  "moss/character",
  "moss/sidebar",
  "moss/conversation",
  "moss/composer",
  "moss/panel",
  "moss/panel-diff",
  "moss/panel-files",
  "moss/panel-terminal",
  "moss/settings",
  "moss/browser-view",
  "moss/archive",
  "moss/bot-editor",
  "moss/plugin-index",
  "moss/island",
  "moss/live2d",
  "moss/pill",
  "moss/vrm",
  "moss/usage",
  "moss/voice",
  "moss/devices",
] as const;

export type MossChildId = (typeof modules)[number];
