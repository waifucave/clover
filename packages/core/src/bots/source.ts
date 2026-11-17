// THE switch for where the bot service takes its bots from (lane BT; spec §13 Split 1). Owner: lane BT.
//
// `plugins`: as today, every plugin's `bot` entry under the user layer (the single app's window draws a bot's tab with
// plugin parts). `records`: bots as engine data (`bots/<seg>/bot.json`), the one-time move run first, and the `bot.*`
// record methods and the `MakeBot` and `EditBotInstructions` tools served. The default stays `plugins` until the
// controller flips it with lanes MA and MC, here and nowhere else; `MOSS_BOT_SOURCE=records` turns it on for one
// daemon (tests and the acceptance row).
export type BotSource = "plugins" | "records";

export const DEFAULT_BOT_SOURCE: BotSource = "plugins";

export const BOT_SOURCE_ENV = "MOSS_BOT_SOURCE";

export function botSource(env: Readonly<Record<string, string | undefined>> = process.env): BotSource {
  const v = env[BOT_SOURCE_ENV];
  return v === "records" || v === "plugins" ? v : DEFAULT_BOT_SOURCE;
}
