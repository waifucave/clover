// The Weather plugin's host half (`host.entry`): one command, /rain-alert, which sends the user a notification through
// Clover's notifiers (`notify.send`, behind the `notify` capability the OK card names). Its forecasts come from its stdio
// server (stdio/forecast.mjs), which reaches the weather service through the plugin's own proxy.
//
// A notification is refused while an approval card waits, past 3 a minute or 20 an hour, and while the user has muted
// this plugin on the Plugins page: the command says so instead of failing silently.
import type { PluginApi } from "@waifucave/clover-plugin-sdk";

let api: PluginApi | undefined;

export function start(a: PluginApi): void {
  api = a;
}

export function stop(): void {
  api = undefined;
}

/** /rain-alert <place>: runs as the user, from the composer's slash menu. */
export async function rainAlert(args: { place?: unknown }): Promise<{ text: string }> {
  if (api === undefined) return { text: "Weather isn't started yet." };
  const place = typeof args?.place === "string" ? args.place.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (place === "") return { text: "Say where: /rain-alert <place>." };
  // `notify` is there only for a plugin whose OK card granted it (its `notify` capability).
  if (api.notify === undefined) return { text: "No alert: this plugin can't send notifications here." };
  try {
    await api.notify.send({ title: `Rain in ${place}`, body: "Take an umbrella." });
    return { text: `Rain alert sent for ${place}.` };
  } catch (err) {
    return { text: `No alert: ${err instanceof Error ? err.message : String(err)}` };
  }
}
