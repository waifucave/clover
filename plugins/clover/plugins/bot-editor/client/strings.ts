// Every string the bot editor shows, for the move to `clover.` keys (plan, F-M3).
/** "a, b or c". */

export const S = {
  back: "Back to the bot",
  title: (name: string) => `Edit ${name}`,
  intro: (name: string) => `What you set here is yours, kept over what ${name}'s plugin says. Reset puts a field back.`,
  reset: "Reset",
  resetField: (field: string) => `Reset the ${field}`,
  save: "Save",
  waiting: "Waiting for your answer on the card.",
  name: "Name",
  nameDetail: "What the bot is called everywhere.",
  instructions: "Your instructions",
  instructionsDetail: (name: string) => `Added after ${name}'s own instructions, which stay as its plugin wrote them.`,
  instructionsSet: "You've set instructions. Type new ones to replace them, or reset.",
  instructionsPlaceholder: "Talk less about the weather.",
  model: "Model",
  modelDetail: "The model the bot thinks with.",
  effort: "Effort",
  voice: "Voice",
  voiceDetail: "Voices come with voice plugins.",
  noVoice: "None",
  voiceOf: (provider: string, voice: string) => `${voice} · ${provider}`,
  theme: "Theme",
  themeDetail: "What the bot's tab wears.",
  themeOwn: "The bot's own",
  layout: "Layout",
  layoutDetail: "How the bot's tab is arranged.",
  layoutOwn: "The bot's own",
  layoutYours: "Your layout",
  rearrangedBy: "Rearranged by",
  rearrangedByDetail: "Plugins that move parts of this bot's tab. Switch one off to undo its changes here.",
  tabPatchOn: (name: string) => `${name} rearranges this tab`,
  hiddenBy: "Hidden by plugins",
  hiddenByDetail: "Parts other plugins take out of this bot's tab. Switch one on to show it again.",
  hiddenPart: (title: string, by: string) => `${title}, hidden by ${by}`,
  showPart: (title: string) => `Show ${title}`,
  partOf: (spot: string, key: string | undefined) => {
    const named: Record<string, string> = { "composer.action": "Composer button", "chrome.action": "Top-bar button", "bot.header.action": "Header button", "conversation.message": "Message" };
    const what = named[spot] ?? spot;
    return key === undefined ? what : `${what}: ${key}`;
  },
  lan: "Local network",
  lanDetail: (name: string) => `Lets ${name}'s browser tabs open pages on devices on your local network, such as your router or a printer.`,
  fields: { name: "name", instructions: "instructions", model: "model", effort: "effort", voice: "voice", theme: "theme", layout: "layout", lan: "local network setting" },
};
