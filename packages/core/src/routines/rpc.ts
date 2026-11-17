// Lane D's routine methods (protocol sessions area): `routine.list`, `routine.runs`, `routine.runNow`,
// `routine.webhookKey` (the user's only: a webhook key is shown once, then only a rotated one), and `routine.get` and
// `routine.edit` (the person's window only: the routine's own file, read and rewritten). Owner: lane D.
// The list is this computer's routines; lane H's sync makes it the synced list every device shows (§8.5).
import { MOSS_ERR, SESSIONS_METHODS } from "@waifucave/moss-protocol";
import { handler, MethodError, requireUser, type MethodContext, type MethodHandler } from "../bots/rpc";
import type { RoutineEngine } from "./engine";

/** The user, on an `app` client: never a CLI, a phone or the web, a plugin, a bot's or tool's session, a peer, or the
 *  core. The host, which is also an `app` and the user, is refused before this at dispatch: the methods are
 *  `windowOnly` (ipc/moss.ts `isWindowConn`, MOSS's and MOSS Code's windows only). */
function theWindow(ctx: MethodContext, what: string): void {
  const user = requireUser(ctx, what);
  if (user.client !== "app") throw new MethodError(MOSS_ERR.NOT_THE_USER, `only the user's window can ${what}`);
}

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
    [M.routineWebhookKey.name]: handler(M.routineWebhookKey, async ({ id, rotate }, ctx) => {
      requireUser(ctx, "see a routine's webhook key");
      return routines.revealWebhookKey(id, rotate === undefined ? {} : { rotate });
    }),
    // The gate (checked again here after the server's role list and `userOnly`): the user, on one of our programs'
    // windows (`app`); never a CLI, a phone or the web, a plugin's layer or host, a bot's or tool's session, a peer,
    // or the core.
    [M.routineEdit.name]: handler(M.routineEdit, async ({ bot, id, patch }, ctx) => {
      theWindow(ctx, "edit a routine");
      return { routine: await routines.edit(id, bot, patch) };
    }),
    [M.routineGet.name]: handler(M.routineGet, async ({ bot, id }, ctx) => {
      theWindow(ctx, "read a routine's instructions");
      return routines.read(id, bot);
    }),
  };
}
