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
  /** The daemon's own update, on a server install (read at each call: it is set once the daemon runs). */
  self?(): SelfUpdate | undefined;
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
      const self = d.self?.();
      const available = self?.available();
      return {
        current: d.current,
        ...(available === undefined ? {} : { available }),
        channel: d.channel(),
        ready: self?.ready() ?? false,
        idle: v.idle,
        busy: wireBusy(v.busy),
      };
    },
    // On an app install, `now` means the app may stop the pair and install: the gate closes (no new turn starts), the
    // steps before a restart run (the lease's renew, so the restart runs inside a full lease), and idle is checked
    // again; work that started meanwhile reopens it and the answer is `when-idle`. A server install's own update
    // waits for idle itself (`self.apply`).
    "update.apply": async () => {
      const self = d.self?.();
      if (self !== undefined) {
        self.apply();
        return { at: d.gate.verdict().idle ? "now" : "when-idle" };
      }
      return { at: (await d.gate.closeForRestart({ timeoutMs: 5_000, ...(d.log ? { log: d.log } : {}) })) ? "now" : "when-idle" };
    },
  };
}

/**
 * `pair.exiting{update}`: it goes ahead only with the gate closed for the restart and nothing busy, and then the gate
 * commits (closed until the process ends, however long the drain). Refused while busy, the gate reopens at once, so
 * the user's sends aren't refused for nothing.
 */
export function acceptUpdateExit(gate: UpdateGate): boolean {
  if (!gate.closed) return false;
  if (!gate.verdict().idle) {
    gate.reopen();
    return false;
  }
  gate.commit();
  return true;
}

