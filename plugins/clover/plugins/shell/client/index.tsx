// The shell plugin's client entry (`client.entry` in clover.json). Its entries: `Shell` fills `app.root` and places
// every spot it declares; `DefaultBotTab` fills `bot.tab` for every bot without a tab of its own; `AgentTab` fills
// `main` keyed `agent` and `panel` keyed `agent`. The frame, the panel host and its toggles are exported too. It
// imports no CSS: `client.css` lists the stylesheet (lane B).
export { Shell, type ShellProps, type ShellRoute, type ShellStart } from "./Shell";
export { AgentTab, DefaultBotTab } from "./Tabs";
export { BotTab, Window, type WindowProps } from "./Window";
export { PanelEmpty, PanelHost } from "./PanelHost";
export { belongsIn, CODE_ONLY, PANEL_VIEWS, PanelToggles, toggleView, VIEWS_BY_KIND } from "./PanelToggles";
export type * from "./panel-types";
export { TOKENS } from "./tokens";
