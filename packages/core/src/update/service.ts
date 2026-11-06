// `update.status` and `update.apply` (lane M's methods, packages/protocol/src/app.ts), served on Clover connections.
// The app's own update is electron-updater's (apps/desktop/src/main/updater.ts): the app downloads it, asks here
// whether the daemon is idle (`idle`, `busy`), and installs once it is. A server install (no app; `<home>/install.json`
// says `server`) updates the daemon itself (`self`, src/update/self-update.ts), which `update.apply` starts.
import type { CloverHandler } from "../ipc/clover";
import type { UpdateGate } from "./gate";

/** The daemon's own update, on a server install. */
export interface SelfUpdate {
  /** The newer version found, if any. */
  available(): string | undefined;
  /** Downloaded and checked, waiting for an idle moment. */
  ready(): boolean;
  /** Install it at the next idle moment (now, when idle). */
  apply(): void;
}

export interface UpdateServiceDeps {
  readonly gate: UpdateGate;
  readonly current: string;
  channel(): string;
  readonly self?: SelfUpdate;
  log?(line: string): void;
}

/** `busy` as the protocol carries it: at most 32 entries of at most 64 characters. */
function wireBusy(busy: readonly string[]): string[] {
  return busy.slice(0, 32).map((b) => (b.length > 64 ? b.slice(0, 64) : b));
}

export function updateHandlers(d: UpdateServiceDeps): Record<string, CloverHandler> {
  return {
    "update.status": () => {
      const v = d.gate.verdict();
      const available = d.self?.available();
      return {
        current: d.current,
        ...(available === undefined ? {} : { available }),
        channel: d.channel(),
        ready: d.self?.ready() ?? false,
        idle: v.idle,
        busy: wireBusy(v.busy),
      };
    },
    // On an app install, `now` means the app may stop the pair and install: the daemon first runs the steps before
    // a restart (the lease's renew), so the restart runs inside a full lease. A server install's own update waits
    // for idle itself (`self.apply`).
    "update.apply": async () => {
      if (d.self !== undefined) {
        d.self.apply();
        return { at: d.gate.verdict().idle ? "now" : "when-idle" };
      }
      if (!d.gate.verdict().idle) return { at: "when-idle" };
      await d.gate.prepareRestart(5_000, d.log);
      return { at: "now" };
    },
  };
}
