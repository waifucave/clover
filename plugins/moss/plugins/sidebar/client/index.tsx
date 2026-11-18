// The sidebar plugin's client entry (`client.entry` in moss.json): `SidebarEntry` fills the shell's `sidebar` spot on
// the runtime and declares `sidebar.app`; the plain `Sidebar` takes mocked props. It imports no CSS: `client.css`
// lists the stylesheet (lane B).
export { Sidebar, sameRoute } from "./Sidebar";
export { SidebarEntry, agentStatus, toShellRoute, toSidebarRoute, type SidebarEntryProps } from "./entry";
export { TOKENS } from "./tokens";
export type * from "./types";
