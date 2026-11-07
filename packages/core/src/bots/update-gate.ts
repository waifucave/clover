// The bots' side of lane M's update gate (#198's `UpdateGate`, `packages/core/src/update/gate.ts`): while an update
// closes the gate for its restart, no turn of a bot's conversation, side thread or agent starts here. Owner: lane D.
// Coded against #198's surface (head c27dc9c5b: `register`, `beforeTurn`, `onReopen`; `RunningDaemon.updateGate`
// hands it in) before it is on main.
//
// * **Busy:** the turns running in this computer's sessions are a busy source (`bot-turns`), so an update waits for
//   them to end.
// * **No new turn while closed:** the host's start gate (`mayStart`) asks `beforeTurn` before every turn, whatever
//   starts it: the user's message, a fold that would start one, a bot's or an agent's message, a routine's run. What
//   arrives is recorded and waits; `onReopen` starts it again, so a routine fired meanwhile runs then.
// * **The user's own message** (and a relayed one) is refused while closed, typed as the gate types it
//   (`daemon_shutting_down`, `update-restarting`, `retry`), so the app says "restarting for an update" and sends again.
import { ERR } from "@waifucave/clover-protocol";
import { MethodError } from "../rpc/handler";

/** What D uses of #198's `UpdateGate`. */
export interface UpdateGateLike {
  register(source: { readonly name: string; count(): number }): () => void;
  /** Throws #198's `UpdateRestartingRefusal` while the gate is closed. */
  beforeTurn(): void;
  /** Called each time the gate opens again; returns its removal. */
  onReopen(cb: () => void): () => void;
}

/** #198's `isUpdateRestarting`: a turn refused for an update's restart. */
export function isUpdateRestarting(err: unknown): err is Error & { code: string; reason: string; retry: boolean } {
  return typeof err === "object" && err !== null && (err as { reason?: unknown }).reason === "update-restarting";
}

/** Whether a turn may start now: false while the gate is closed. */
export function turnMayStart(gate: UpdateGateLike | undefined): boolean {
  if (gate === undefined) return true;
  try {
    gate.beforeTurn();
    return true;
  } catch (err) {
    if (isUpdateRestarting(err)) return false;
    throw err;
  }
}

/** The gate's typed refusal, as a method error, while it is closed. */
export function refuseWhileUpdating(gate: UpdateGateLike | undefined): void {
  try {
    gate?.beforeTurn();
  } catch (err) {
    if (!isUpdateRestarting(err)) throw err;
    throw new MethodError(ERR.INVALID_REQUEST, err.message, { code: err.code, reason: err.reason, retry: err.retry });
  }
}
