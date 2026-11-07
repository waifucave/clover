// Desktop notifications (clover/notifications, spec §10): a `notifiers` entry that runs on each computer (`runsOn:
// "each"`) and shows the OS's own notification when something happens the user hasn't seen. The core never hands a
// notifier a message's, a card's or a question's text (lane B's `NotifierUpdate`), so the words are what happened and
// who: "Alpha · Sent you a message", "Alpha · Needs your OK". Only a plugin's `notify.send` carries a title and a body,
// and its banner names the plugin first and marks a third-party one as a plugin, so no plugin can speak as a bot or
// as Clover: a plugin named "Luna" shows as "Plugin “Luna”: …", never as the bot Luna.
//
// One notification per bot and kind, replaced as more arrive, so a busy bot never stacks a column of banners; how many
// things wait is the core's own count (`unseen`), never one this notifier keeps (the core coalesces updates, so a
// notifier sees gaps); the user catching up (`clear`) takes every one of them away. Nothing shows while the
// app says the user is already looking (the island and the app show it there). The OS draws the banner and decides
// its sound; this plugin only asks the local app to show it, through `DesktopNotifications` (lane E's app, a port
// until its API exists).

import { t } from "./strings";

/** What the core hands a notifier (lane B's `NotifierUpdate`, mirrored until #157 merges). */
export interface NotifierUpdate {
  seq: number;
  kind: "message" | "card" | "question" | "routine-result" | "agent-finished" | "notification";
  unseen: number;
  bot?: string;
  session?: string;
  at: number;
  notification?: { title: string; body?: string };
  /** Who sent it: the plugin whose `notify.send` asked for a `notification`, or `clover` for the core's own updates
   *  and notices. Required (B-M1's review); `thirdParty` marks a plugin outside the bundled `clover` tree. */
  sender: NoticeSender;
  /** A routine's result: whether the routine failed (a field asked of lanes B and D). Absent, the notifier can't tell,
   *  and shows the result when routine failures are on. */
  failed?: boolean;
}

/** The plugin's own settings (clover.json), as Settings → Notifications shows them. Each defaults to on. */
export interface NotifyPrefs {
  /** Cards and questions waiting for the user. */
  needsYou: boolean;
  /** An agent a bot started has finished. */
  agentDone: boolean;
  /** A routine that ran on its own failed. */
  routineFailed: boolean;
  /** The OS plays its notification sound; off, the banners are silent. */
  sounds: boolean;
}

export const DEFAULT_PREFS: NotifyPrefs = { needsYou: true, agentDone: true, routineFailed: true, sounds: true };

/** Whether the user wants a banner for this update. A message and a plugin's own notification always show. */
export function wanted(update: NotifierUpdate, prefs: NotifyPrefs): boolean {
  switch (update.kind) {
    case "card":
    case "question":
      return prefs.needsYou;
    case "agent-finished":
      return prefs.agentDone;
    case "routine-result":
      return prefs.routineFailed && update.failed !== false;
    default:
      return true;
  }
}

/** A notification's sender (lane B's, mirrored until B-M1 merges). */
export interface NoticeSender {
  pluginId: string;
  /** The plugin's name, as its manifest gives it. */
  name: string;
  /** True for a plugin outside the bundled `clover` tree, which the banner marks (lane B's `thirdParty`). */
  thirdParty: boolean;
}

/** One banner, as the local app's OS notification takes it. */
export interface DesktopNotice {
  /** The same id replaces the banner already showing (the OS's tag or replace id). */
  id: string;
  title: string;
  body?: string;
  /** Where a click takes the user: the app, at this bot's session. */
  open?: { bot?: string; session?: string };
  /** A request that waits on the user (a card, a question) stays until they act, where the OS allows. */
  urgent: boolean;
  /** No sound (the `sounds` setting off). */
  silent: boolean;
}

/** The local app's notifications: Electron's `Notification` in the main process (lane E). */
export interface DesktopNotifications {
  show(notice: DesktopNotice): void | Promise<void>;
  close(id: string): void | Promise<void>;
  /** The app is in front and shows this already: no banner. Absent, every update shows. */
  showing?(update: { bot?: string; session?: string; kind: NotifierUpdate["kind"] }): boolean | Promise<boolean>;
}

export interface DesktopNotifierOptions {
  desktop: DesktopNotifications;
  /** A bot's name from its id (`bots.read`); the id itself when absent or unknown. */
  botName?: (bot: string) => string | undefined | Promise<string | undefined>;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** The user's settings now; every one on when absent. */
  prefs?: () => NotifyPrefs;
}

const KINDS_THAT_WAIT = new Set<NotifierUpdate["kind"]>(["card", "question"]);
/** A plugin's title and body are shown as they are, cut to what a banner holds. */
const MAX_TITLE = 120;
const MAX_BODY = 400;

/** Bidi controls a shown name may not carry (one would turn the title around its colon). */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function shownName(name: string): string {
  return name.replace(BIDI, "").trim();
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The banner's words for an update. Pure. */
export function noticeWords(update: NotifierUpdate, name: string | undefined): { title: string; body?: string } {
  const waiting = update.unseen > 1 ? t("clover.notifications.unseen", { count: update.unseen }) : null;
  const withWaiting = (body: string | undefined) => (waiting ? (body ? `${body} · ${waiting}` : waiting) : body);
  if (update.kind === "notification") {
    const n = update.notification;
    const own = n ? cut(n.title, MAX_TITLE) : "";
    const body = n?.body ? cut(n.body, MAX_BODY) : undefined;
    // The core's own notices (sender `clover`) come under Clover's name; a bundled child's under its name; a
    // third-party plugin's under its name, quoted and marked as a plugin, first so a cut title keeps the mark. A
    // sender missing (an older core) counts as third-party.
    const sender = update.sender as NoticeSender | undefined;
    if (sender?.pluginId === "clover") return { title: own || t("clover.notifications.fallbackTitle"), body: withWaiting(body) };
    const name = cut(shownName(sender?.name ?? "") || sender?.pluginId || t("clover.notifications.aPlugin"), 40);
    const thirdParty = sender?.thirdParty !== false;
    const from = thirdParty ? t("clover.notifications.plugin", { plugin: name }) : name;
    return { title: own ? t("clover.notifications.fromPlugin", { from, title: own }) : from, body: withWaiting(body) };
  }
  const who = name ?? t("clover.notifications.aBot");
  const kind = {
    message: "clover.notifications.message",
    card: "clover.notifications.card",
    question: "clover.notifications.question",
    "routine-result": "clover.notifications.routine",
    "agent-finished": "clover.notifications.agent",
  }[update.kind];
  return { title: who, body: withWaiting(t(kind)) };
}

/** Which banner an update replaces: one per bot and kind; each plugin notification its own. */
export function noticeId(update: NotifierUpdate): string {
  if (update.kind === "notification") return `notification:${update.seq}`;
  return `${update.kind}:${update.bot ?? "-"}`;
}

export class DesktopNotifier {
  /** Since the user last caught up: which banners show. */
  private readonly shown = new Set<string>();
  private lastSeq = -1;

  constructor(private readonly options: DesktopNotifierOptions) {}

  /** The `notify` handler. Older updates than one already shown are dropped (the core coalesces; order is by seq). */
  async notify(update: NotifierUpdate): Promise<void> {
    if (update.seq <= this.lastSeq) return;
    this.lastSeq = update.seq;
    const prefs = this.options.prefs?.() ?? DEFAULT_PREFS;
    if (!wanted(update, prefs)) return;
    const id = noticeId(update);
    try {
      if (await this.options.desktop.showing?.({ bot: update.bot, session: update.session, kind: update.kind })) return;
      const name = update.bot ? ((await this.options.botName?.(update.bot)) ?? update.bot) : undefined;
      const words = noticeWords(update, name);
      await this.options.desktop.show({
        id,
        ...words,
        open: update.bot || update.session ? { bot: update.bot, session: update.session } : undefined,
        urgent: KINDS_THAT_WAIT.has(update.kind),
        silent: !prefs.sounds,
      });
      this.shown.add(id);
    } catch (error) {
      // A banner that could not show is not worth more than a line in the plugin's log; never its words.
      this.options.log?.("warn", `a desktop notification could not show (${update.kind}): ${error instanceof Error ? error.name : "error"}`);
    }
  }

  /** The `clear` handler: the user caught up, so every banner goes. */
  async clear(): Promise<void> {
    const ids = [...this.shown];
    this.shown.clear();
    for (const id of ids) {
      try {
        await this.options.desktop.close(id);
      } catch {
        // Already gone (the user dismissed it).
      }
    }
  }
}
