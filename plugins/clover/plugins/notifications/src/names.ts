// A bot's name in this plugin's English banners (the host half has no `t`: its words are its own English table).
import type { BotsApi } from "@waifucave/clover-plugin-sdk";

/** A bot's name as this half's English banners put it: a name in several languages gives its English one, else the
 *  first language it has (a name from a plugin that left out `en`, whatever the type says); none, and the notifier
 *  names the bot by its id. */
export function englishOf(name: Awaited<ReturnType<BotsApi["get"]>>["name"] | undefined): string | undefined {
  if (typeof name === "string") return name === "" ? undefined : name;
  if (name === null || typeof name !== "object") return undefined;
  const values = name as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  return text(values.en) ?? Object.values(values).map(text).find((v) => v !== undefined);
}
