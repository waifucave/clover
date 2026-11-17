// The avatar plugin's words: its panel, its window on the screen and its Settings section.
export const S = {
  avatar: "Avatar",
  noFigure: "No figure to show yet. Add an avatar pack and a renderer plugin that draws its format.",
  noRenderer: (format: string) => `Nothing installed draws ${format} figures. Install or turn on a renderer plugin for it.`,
  settingsDetail: "One figure at a time, beside your sessions and, if you like, on your screen. Figures come from avatar packs; renderer plugins draw them.",
  pick: "Figure",
  none: "No avatar packs are installed yet. Find one in the plugin index.",
  from: (by: string) => `From ${by}`,
  own: "Your own model",
  notDrawn: (format: string) => `Nothing draws ${format} figures now`,
  onScreen: "Show it on the screen",
  onScreenDetail: "The figure stands over your other windows while MOSS runs.",
  followBots: "On the screen, follow my bots too",
  license: "Licence",
} as const;
