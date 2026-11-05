// Desktop notifications (clover/notifications, spec §10): a `notifiers` entry that runs on each computer (`runsOn:
// "each"`) and shows the OS's own notification when something happens the user hasn't seen. The core never hands a
// notifier a message's, a card's or a question's text (lane B's `NotifierUpdate`), so the words are what happened and
// who: "Alpha sent you a message", "Alpha needs your OK". Only a plugin's `notify.send` carries a title and a body.
//
// One notification per bot and kind, replaced as more arrive ("Alpha sent you 3 messages"), so a busy bot never
// stacks a column of banners; the user catching up (`clear`) takes every one of them away. Nothing shows while the
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
}

const KINDS_THAT_WAIT = new Set<NotifierUpdate["kind"]>(["card", "question"]);
/** A plugin's title and body are shown as they are, cut to what a banner holds. */
const MAX_TITLE = 120;
const MAX_BODY = 400;

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The banner's words for an update. Pure. */
export function noticeWords(update: NotifierUpdate, name: string | undefined, count: number): { title: string; body?: string } {
  if (update.kind === "notification") {
    const n = update.notification;
    if (n) return { title: cut(n.title, MAX_TITLE) || t("clover.notifications.fallbackTitle"), body: n.body ? cut(n.body, MAX_BODY) : undefined };
    return { title: t("clover.notifications.fallbackTitle") };
  }
  const who = name ?? t("clover.notifications.aBot");
  const vars = { name: who, count };
  switch (update.kind) {
    case "message":
      return { title: who, body: t("clover.notifications.message", vars) };
    case "card":
      return { title: who, body: t("clover.notifications.card", vars) };
    case "question":
      return { title: who, body: t("clover.notifications.question", vars) };
    case "routine-result":
      return { title: who, body: t("clover.notifications.routine", vars) };
    case "agent-finished":
      return { title: who, body: t("clover.notifications.agent", vars) };
  }
}

/** Which banner an update replaces: one per bot and kind; each plugin notification its own. */
export function noticeId(update: NotifierUpdate): string {
  if (update.kind === "notification") return `notification:${update.seq}`;
  return `${update.kind}:${update.bot ?? "-"}`;
}

export class DesktopNotifier {
  /** Since the user last caught up: how many of each banner, and which ids show. */
  private readonly counts = new Map<string, number>();
  private readonly shown = new Set<string>();
  private lastSeq = -1;

  constructor(private readonly options: DesktopNotifierOptions) {}

  /** The `notify` handler. Older updates than one already shown are dropped (the core coalesces; order is by seq). */
  async notify(update: NotifierUpdate): Promise<void> {
    if (update.seq <= this.lastSeq) return;
    this.lastSeq = update.seq;
    const id = noticeId(update);
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    try {
      if (await this.options.desktop.showing?.({ bot: update.bot, session: update.session, kind: update.kind })) return;
      const name = update.bot ? ((await this.options.botName?.(update.bot)) ?? update.bot) : undefined;
      const words = noticeWords(update, name, count);
      await this.options.desktop.show({
        id,
        ...words,
        open: update.bot || update.session ? { bot: update.bot, session: update.session } : undefined,
        urgent: KINDS_THAT_WAIT.has(update.kind),
      });
      this.shown.add(id);
    } catch (error) {
      // A banner that could not show is not worth more than a line in the plugin's log; never its words.
      this.options.log?.("warn", `a desktop notification could not show (${update.kind}): ${error instanceof Error ? error.name : "error"}`);
    }
  }

  /** The `clear` handler: the user caught up, so every banner goes and the counts start again. */
  async clear(): Promise<void> {
    const ids = [...this.shown];
    this.shown.clear();
    this.counts.clear();
    for (const id of ids) {
      try {
        await this.options.desktop.close(id);
      } catch {
        // Already gone (the user dismissed it).
      }
    }
  }
}
