// The bots' side of lane M's update gate (#198's `UpdateGate`, `packages/core/src/update/gate.ts`): while an update
// closes the gate for its restart, no turn of a bot's conversation, side thread or agent starts here. Owner: lane D.
// Coded against #198's surface (`closed` and `register`; `RunningDaemon.updateGate` hands it in) before it is on main.
//
// * **Busy:** the turns running in this computer's sessions are a busy source (`bot-turns`), so an update waits for
//   them to end.
// * **No new turn while closed:** the host's start gate (`mayStart`) holds every turn, whatever starts it: the user's
//   message, a fold that would start one, a bot's or an agent's message, a routine's run. What arrives is recorded and
//   waits; the host starts it once the gate reopens (`watchReopen`), so a routine fired meanwhile runs then.
// * **The user's own message** is refused while closed, typed (`daemon_shutting_down`, `update-restarting`), so the
//   app shows "restarting for an update" and sends it again, as the inherited session driver's pre-turn gate does.
import { ERR } from "@waifucave/clover-protocol";
import { MethodError } from "../rpc/handler";

/** What D uses of #198's `UpdateGate`. */
export interface UpdateGateLike {
  readonly closed: boolean;
  register(source: { readonly name: string; count(): number }): () => void;
}

export const UPDATE_RESTARTING = { code: "daemon_shutting_down", reason: "update-restarting", retry: true } as const;
export const UPDATE_RESTARTING_MESSAGE = "Clover is restarting for an update; send it again in a moment";
/** How often a held start looks again whether the gate reopened. */
export const REOPEN_POLL_MS = 1_000;

/** Throws the typed refusal while the gate is closed. */
export function refuseWhileUpdating(gate: UpdateGateLike | undefined): void {
  if (gate?.closed) throw new MethodError(ERR.INVALID_REQUEST, UPDATE_RESTARTING_MESSAGE, { ...UPDATE_RESTARTING });
}

/** Calls `resume` once the gate reopens after a start it held; one watch at a time. */
export function watchReopen(gate: UpdateGateLike, resume: () => void): { held(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    held() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (gate.closed) return;
        stop();
        resume();
      }, REOPEN_POLL_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop,
  };
}
