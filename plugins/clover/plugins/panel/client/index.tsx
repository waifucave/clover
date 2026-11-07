// The panel plugin's client entry: the column beside the conversation. `SessionColumn` fills the shell's `panel` keyed
// `session` (a coding session's or an agent's column) and `BotColumn` fills `bot.side` (a bot's slim column); the plain
// `SessionView` takes mocked props. The panel host and its toggles are the shell's, which declares `panel`. It imports
// no CSS: `client.css` lists the stylesheet (lane B).
export { BotColumn, SessionColumn, type ColumnProps } from "./entry";
export { OutputEntry, type OutputEntryProps } from "./output";
export { SessionView } from "./SessionView";
export { TOKENS } from "./tokens";
export type * from "./types";
