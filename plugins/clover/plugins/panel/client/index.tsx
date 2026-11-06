// The panel plugin's client entry: the toggles, the host that holds the panels (each fills `panel`, keyed
// by its id), and the session column. It imports no CSS: `client.css` lists the stylesheet (lane B).
export { belongsIn, CODE_ONLY, PANEL_VIEWS, PanelToggles, toggleView, VIEWS_BY_KIND } from "./PanelToggles";
export { PanelHost } from "./PanelHost";
export { SessionView } from "./SessionView";
export { TOKENS } from "./tokens";
export type * from "./types";
