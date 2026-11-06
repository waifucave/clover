// The diff panel's client entry: `DiffEntry` fills `panel` keyed `diff` on the runtime, in coding sessions only; the
// plain parts take mocked props. It imports no CSS: `client.css` lists the stylesheet (lane B).
export { DiffEntry, type DiffEntryProps } from "./entry";
export { DiffLayoutSwitch, DiffPanel, DiffTitle } from "./DiffPanel";
export { splitRows } from "./split";
export { TOKENS } from "./tokens";
export type * from "./types";
