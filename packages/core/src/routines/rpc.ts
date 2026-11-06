// Lane D's routine methods (protocol sessions area): `routine.list`, `routine.runs`, `routine.runNow`. Owner: lane D.
// The list is this computer's routines; lane H's sync makes it the synced list every device shows (§8.5).
import { SESSIONS_METHODS } from "@waifucave/clover-protocol";
import { handler, requireUser, type MethodHandler } from "../bots/rpc";
import type { RoutineEngine } from "./engine";

export function routineMethods(deps: { routines: RoutineEngine }): Record<string, MethodHandler> {
  const M = SESSIONS_METHODS;
  const { routines } = deps;
  return {
    [M.routineList.name]: handler(M.routineList, async ({ bot }) => ({ routines: routines.list(bot) })),
    [M.routineRuns.name]: handler(M.routineRuns, async ({ id, cursor, limit }) => {
      const before = cursor === undefined ? undefined : Number.parseInt(cursor, 10);
      const page = routines.runs(id, { ...(before === undefined || Number.isNaN(before) ? {} : { before }), ...(limit === undefined ? {} : { limit }) });
      return { runs: page.runs, ...(page.next === undefined ? {} : { next: String(page.next) }) };
    }),
    [M.routineRunNow.name]: handler(M.routineRunNow, async ({ id }, ctx) => {
      requireUser(ctx, "run a routine now");
      return { session: await routines.runNow(id) };
    }),
  };
}
