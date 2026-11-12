// The character plugin's client entry: `BotStage` fills `bot.stage` (where a bot's character stands) and asks the `avatar`
// spot, keyed by the avatar file's format, for the drawing; a renderer plugin fills that spot for a format. It imports no
// CSS: `client.css` lists the stylesheet.
export { BotStage } from "./stage";
// `AvatarSection` fills the bot editor's `bot.editor.section`: the avatar's packs, the user's own model and its credit note.
export { AvatarSection } from "./section";
