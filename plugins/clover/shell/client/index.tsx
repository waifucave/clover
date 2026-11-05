// The shell plugin's client entry (`client.entry` in clover.json). M1 ships the sidebar; the shell
// that fills `app.root` and declares the catalog's spots comes in M2.
import "./styles.css";

export { Sidebar, agentStatusLine, botStatusLine, sameRoute } from "./Sidebar";
export { TOKENS } from "./tokens";
export type * from "./types";
