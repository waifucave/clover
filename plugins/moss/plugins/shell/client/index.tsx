// The shell plugin's client entry (`client.entry` in moss.json). Its entries: `Shell` fills `app.root` and places
// every spot it declares, and draws its own page to start a session (`NewSession`); `AgentTab` fills `main` keyed
// `agent` and `panel` keyed `agent`. The frame, the panel host and its toggles are exported too. It
// imports no CSS: `client.css` lists the stylesheet (lane B).
// `Shell` is the `app.root` entry (the window's shell, with what main tells that part); `ShellView` the shell itself.
export { WindowShell as Shell } from "./WindowShell";
export { Shell as ShellView, type ShellProps, type ShellRoute, type ShellStart } from "./Shell";
export { AgentStatus, AgentTab } from "./Tabs";
export { NewSession, agentsHere, type NewSessionAgent } from "./NewSession";
export { BotTab, Window, type WindowProps } from "./Window";
export { PanelEmpty, PanelHost } from "./PanelHost";
export { belongsIn, CODE_ONLY, PANEL_VIEWS, PanelToggles, toggleView, VIEWS_BY_KIND } from "./PanelToggles";
export type * from "./panel-types";
export { TOKENS } from "./tokens";
export { ChromeContext, useChrome, type ChromeApi, type ChromePartId } from "./chrome";
export { shapeOf, skinOf, type ChromeShape } from "./Window";
