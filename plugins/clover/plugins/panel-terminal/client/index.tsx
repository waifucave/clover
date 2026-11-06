// The terminal panel's client entry: `TerminalEntry` fills `panel` keyed `terminal` on the runtime, in coding sessions
// only, with its tabs in the panel's header row; the plain parts take mocked props. It imports no CSS: `client.css`
// lists the stylesheet (lane B).
export { TerminalEntry, type TerminalEntryProps } from "./entry";
export { TerminalPanel, TerminalTabs, focusPast } from "./TerminalPanel";
export { keyToData } from "./keys";
export { TOKENS } from "./tokens";
export type * from "./types";
