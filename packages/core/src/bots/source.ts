// THE switch for where the bot service takes its bots from (lane BT; spec §13 Split 1). Owner: lane BT.
//
// `plugins`: as today, every plugin's `bot` entry under the user layer (the single app's window draws a bot's tab with
// plugin parts). `records`: bots as engine data (`bots/<seg>/bot.json`), the one-time move run first, and the `bot.*`
// record methods and the `MakeBot` and `EditBotInstructions` tools served, with the default bot (Alpha,
// `default-bot.ts`) offered through the move. The default is `records` (lane MC, spec §13 Split 3: bots are shown only
// by MOSS, and MOSS Code's window has none). `MOSS_BOT_SOURCE=plugins` runs one daemon on the old source, which only
// the bot side's own tests of the plugin path still use (`bots/tests/fixtures.ts`).
export type BotSource = "plugins" | "records";

export const DEFAULT_BOT_SOURCE: BotSource = "records";

export const BOT_SOURCE_ENV = "MOSS_BOT_SOURCE";

export function botSource(env: Readonly<Record<string, string | undefined>> = process.env): BotSource {
  const v = env[BOT_SOURCE_ENV];
  return v === "records" || v === "plugins" ? v : DEFAULT_BOT_SOURCE;
}
