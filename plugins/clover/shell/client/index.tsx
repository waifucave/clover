// The shell plugin's client entry (`client.entry` in clover.json): the window frame that fills
// `app.root` and declares the `sidebar`, `main` and `panel` spots, and the default sidebar. It imports
// no CSS: `client.css` lists the stylesheet (lane B).
export { Sidebar, botStatusLine, sameRoute } from "./Sidebar";
export { BotTab, Window, type WindowProps } from "./Window";
export { TOKENS } from "./tokens";
export type * from "./types";
