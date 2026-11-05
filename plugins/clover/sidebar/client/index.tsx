// The sidebar plugin's client entry (`client.entry` in clover.json): the default sidebar, which fills the
// shell's `sidebar` spot and declares `sidebar.bot` and `sidebar.app`. It imports no CSS: `client.css`
// lists the stylesheet (lane B).
export { Sidebar, botStatusLine, sameRoute } from "./Sidebar";
export { TOKENS } from "./tokens";
export type * from "./types";
