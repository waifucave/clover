// Desktop notifications (spec §5.8: a bundled plugin contributing to `notifiers`, lane G's), the app's port: the
// daemon asks the app to show one (`app.notify`), replace it (the same id) or close it (`app.notify.close`). The app
// shows nothing while it is in front showing that session already, and says so (`shown: false`), so the notifier can
// tell. A headless run never shows one: nothing it runs may open a window or play a sound. Pure apart from what it is
// handed, so the rules are unit-tested.
import type { NotificationConstructorOptions } from "electron";

export interface NotifyRequest {
  id: string;
  title: string;
  body?: string;
  session?: string;
  urgent?: boolean;
  /** No sound with the banner (lane G's sounds setting, through `app.notify`). */
  silent?: boolean;
}

/** What the app knows of where the user is looking: is a window of its own in front, and which session it shows. */
export interface Front {
  focused: boolean;
  /** The session the focused window shows, as its shell said. */
  session?: string | null;
}

/** Whether to show a notification now: not while the app is in front showing its session (an urgent one too: the
 *  user is looking at it). */
export function shouldShow(req: Pick<NotifyRequest, "session">, front: Front): boolean {
  if (!front.focused) return true;
  return req.session === undefined || front.session === undefined || front.session === null || front.session !== req.session;
}

/** The OS banner's options for a request: `silent` rides through to Electron's own flag, and urgency stays
 *  Linux-only and urgent-only. Pure, so the mapping is unit-tested (the `new Notification` itself isn't). */
export function notificationOptions(req: NotifyRequest, platform: NodeJS.Platform): NotificationConstructorOptions {
  return {
    title: req.title,
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(platform === "linux" && req.urgent === true ? { urgency: "critical" as const } : {}),
    ...(req.silent === true ? { silent: true } : {}),
  };
}

export interface Shown {
  close(): void;
}

/** The notifications the app shows, by the daemon's id: a new one with the same id replaces the old. */
export class Notifications {
  private readonly shown = new Map<string, Shown>();

  constructor(
    private readonly show: (req: NotifyRequest, onClick: () => void) => Shown | undefined,
    private readonly open: (session: string | undefined) => void,
  ) {}

  notify(req: NotifyRequest, front: Front): { shown: boolean } {
    if (!shouldShow(req, front)) return { shown: false };
    this.close(req.id);
    const n = this.show(req, () => {
      this.shown.delete(req.id);
      this.open(req.session);
    });
    if (n === undefined) return { shown: false };
    this.shown.set(req.id, n);
    return { shown: true };
  }

  /** One by id, or every one. */
  close(id?: string): void {
    for (const [key, n] of [...this.shown]) {
      if (id !== undefined && key !== id) continue;
      this.shown.delete(key);
      try {
        n.close();
      } catch {
        // Already gone.
      }
    }
  }

  get count(): number {
    return this.shown.size;
  }
}
