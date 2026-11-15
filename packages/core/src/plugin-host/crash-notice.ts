// A plugin a bot built (its install record's `{ by: "bot", bot }`, the workshop rule) that the crash rules stop tells
// that bot, once per stop: one message into its conversation that starts a turn, so the bot that wrote the code can read
// the log (`PluginStatus`) and fix it, instead of the plugin sitting stopped until the user looks. (Try 14c: a bot's
// video-editor plugin crashed three times at start and stopped, and its builder never heard of it.) Its fixing edit,
// once applied, starts it again (daemon-host.ts).
//
// * Only the crash rules' stop (`isCrashStop`; a start that fails or is refused is a crash too): never the user's
//   stop, a removal or a plugin switched off.
// * Once per stop: the next message only after it left `stopped` (the user restarted it, an edit started it again) and
//   stopped again.
// * A cap, so a bot can't loop unseen: the third crash-stop of the same plugin within an hour says so, and no further
//   notice goes until the user restarts it (`userRestarted`) or an hour passes.
// * It names the plugin that stopped, a child entry by its own id: `PluginStatus <id>` shows that plugin's own log.
//   A child's provenance is its tree's (the folder read gives every entry the top's), so its builder is the tree's.
// * The door is the bots' own (`BotService.deliverTo`, SendMessage's): the bot's main conversation, wherever it runs
//   here; the input is Clover's `notice` (a note that starts a turn, origin `plugin`), so the turn runs at the bot's
//   own level and nothing it asks counts as the user's.
import type { Unsubscribe } from "../contracts/common";
import { isCrashStop, type HostedStatus } from "../contracts/plugin-host";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { DeliveredInput, Disposition } from "../contracts/session-host";

/** How many crash-stops of one plugin within `CRASH_NOTICE_WINDOW_MS` its builder is told of. */
export const CRASH_NOTICES_PER_WINDOW = 3;
export const CRASH_NOTICE_WINDOW_MS = 60 * 60_000;

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
  /** The core's clock (the cap's hour). */
  now?: () => number;
}

export interface CrashNotices {
  /** The user restarted it: its builder may be told of its stops again. */
  userRestarted(id: string): void;
  stop(): void;
}

/** The text a builder bot gets: what stopped, why, where the log is, and, at the cap, that it is the last for now. */
export function crashNoticeText(name: string, id: string, reason: string, capped = false): string {
  const text = `${name} stopped: ${reason.replace(/[.\s]+$/, "")}. PluginStatus ${id} has the log.`;
  return capped
    ? `${text} That makes ${CRASH_NOTICES_PER_WINDOW} stops within an hour: you won't be told of another until the user restarts it or an hour passes.`
    : text;
}

export function crashNotices(o: CrashNoticeOptions): CrashNotices {
  const now = o.now ?? Date.now;
  /** Plugins whose current stop was already handled. */
  const told = new Set<string>();
  /** Each plugin's recent crash-stops its builder was told of, and until when it is told of no more. */
  const recent = new Map<string, { stops: number[]; mutedUntil?: number }>();
  const off = o.host.watch((s) => {
    if (s.state !== "stopped") return void told.delete(s.pluginId);
    if (!isCrashStop(s.reason) || told.has(s.pluginId)) return;
    told.add(s.pluginId);
    const record = o.registry.get(s.pluginId);
    if (record === undefined) return;
    // Its own provenance (a child's is its tree's), else its top plugin's.
    const top = record.parent === undefined ? undefined : o.registry.get(record.parent);
    const bot = record.provenance?.by === "bot" ? record.provenance.bot : top?.provenance?.by === "bot" ? top.provenance.bot : undefined;
    if (bot === undefined) return;
    const at = now();
    let r = recent.get(s.pluginId);
    if (r?.mutedUntil !== undefined && at >= r.mutedUntil) r = undefined;
    if (r?.mutedUntil !== undefined) return void o.log(`[plugin-host] ${s.pluginId} stopped; its builder ${bot} isn't told again (${CRASH_NOTICES_PER_WINDOW} stops within the hour)`);
    r = { stops: [...(r?.stops ?? []).filter((t) => at - t < CRASH_NOTICE_WINDOW_MS), at] };
    const capped = r.stops.length >= CRASH_NOTICES_PER_WINDOW;
    if (capped) r.mutedUntil = at + CRASH_NOTICE_WINDOW_MS;
    recent.set(s.pluginId, r);
    const bots = o.bots();
    if (bots === undefined || !bots.has(bot)) return void o.log(`[plugin-host] ${s.pluginId} stopped; its builder ${bot} doesn't run here, so it isn't told`);
    const name = typeof record.name === "string" ? record.name : record.name?.en;
    const text = crashNoticeText(name || s.pluginId, s.pluginId, s.reason!, capped);
    bots.deliverTo(bot, { from: "notice", label: "Plugin stopped", text }).then(
      ({ disposition }) => o.log(`[plugin-host] ${s.pluginId} stopped; told its builder ${bot} (${disposition})`),
      (err: unknown) => o.log(`[plugin-host] ${s.pluginId} stopped; telling its builder ${bot} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
  return {
    userRestarted: (id) => void recent.delete(id),
    stop: off,
  };
}
