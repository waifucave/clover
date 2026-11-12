// A plugin a bot built (its install record's `{ by: "bot", bot }`, the workshop rule) that the crash rules stop tells
// that bot, once per stop: one message into its conversation that starts a turn, so the bot that wrote the code can read
// the log (`PluginStatus`) and fix it, instead of the plugin sitting stopped until the user looks. (Try 14c: a bot's
// video-editor plugin crashed three times at start and stopped, and its builder never heard of it.)
//
// * Only the crash rules' stop (`crashed 3 times in 10 minutes: …`; a start that fails or is refused is a crash too):
//   never the user's stop, a removal or a plugin switched off.
// * Once per stop: the next message only after it left `stopped` (the user restarted it, it was edited) and stopped
//   again.
// * The door is the bots' own (`BotService.deliverTo`, SendMessage's): the bot's main conversation, wherever it runs
//   here; the input is Clover's `notice` (a note that starts a turn, origin `plugin`), so the turn runs at the bot's
//   own level and nothing it asks counts as the user's.
// * A bot's plugin installed by a child entry without its own provenance is its top plugin's.
import type { Unsubscribe } from "../contracts/common";
import type { HostedStatus } from "../contracts/plugin-host";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { DeliveredInput, Disposition } from "../contracts/session-host";

/** The crash rules' own reason prefix (core-host.ts: `crashed ${CRASH_LIMIT} times in 10 minutes: …`). */
const CRASH_STOP = /^crashed \d+ times in /;

export interface CrashNoticeBots {
  has(id: string): boolean;
  deliverTo(id: string, input: DeliveredInput): Promise<{ disposition: Disposition }>;
}

export interface CrashNoticeOptions {
  host: { watch(fn: (status: HostedStatus) => void): Unsubscribe };
  registry: { get(id: string): Pick<PluginRecord, "id" | "name" | "provenance" | "parent"> | undefined };
  /** The bot side, read at each stop: it comes up after the plugin host, and may not run here at all. */
  bots: () => CrashNoticeBots | undefined;
  log: (line: string) => void;
}

/** The text a builder bot gets: what stopped, why, and where the log is. */
export function crashNoticeText(name: string, id: string, reason: string): string {
  return `${name} stopped: ${reason.replace(/[.\s]+$/, "")}. PluginStatus ${id} has the log.`;
}

export function crashNotices(o: CrashNoticeOptions): Unsubscribe {
  /** Plugins whose current stop was already told. */
  const told = new Set<string>();
  return o.host.watch((s) => {
    if (s.state !== "stopped") return void told.delete(s.pluginId);
    if (s.reason === undefined || !CRASH_STOP.test(s.reason) || told.has(s.pluginId)) return;
    told.add(s.pluginId);
    const record = o.registry.get(s.pluginId);
    if (record === undefined) return;
    // Its own provenance, else its top plugin's (a child entry of a bot's plugin).
    const top = record.parent === undefined ? undefined : o.registry.get(record.parent);
    const builtBy = record.provenance?.by === "bot" ? record : top?.provenance?.by === "bot" ? top : undefined;
    const bot = builtBy?.provenance.bot;
    if (builtBy === undefined || bot === undefined) return;
    const bots = o.bots();
    if (bots === undefined || !bots.has(bot)) return void o.log(`[plugin-host] ${s.pluginId} stopped; its builder ${bot} doesn't run here, so it isn't told`);
    const name = typeof record.name === "string" ? record.name : record.name?.en;
    const text = crashNoticeText(name || s.pluginId, builtBy.id, s.reason);
    bots.deliverTo(bot, { from: "notice", label: "Plugin stopped", text }).then(
      ({ disposition }) => o.log(`[plugin-host] ${s.pluginId} stopped; told its builder ${bot} (${disposition})`),
      (err: unknown) => o.log(`[plugin-host] ${s.pluginId} stopped; telling its builder ${bot} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
}
