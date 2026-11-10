// The fence's per-caller rules (B's contract `contracts/fence.ts`: the Clover home is default-deny for every tool
// runner; only the core and the user's own surfaces reach it. The only allows, each per caller and matched by
// pattern):
// 1. a session's own `outputs/<session>/**`, read and write;
// 2. a bot's own `scratch/<bot>/**` and `routines/<bot>/**`, read and write, for that bot's main conversation and its
//    side threads;
// 3. the owning bot's own `bots/<x>/**`, read only, and its `bots/<x>/memory/**`, read and write (`ownMemory`). It
//    still can't delete or move the memory folder;
// 4. a plugin's own `plugin-data/<id>/**`, read and write, for that plugin's own code alone.
// Everything else under the Clover home is denied: projects, sdk, sessions, transcripts, diffs, cache, logs and other
// bots' folders. The verdict itself is B's shared `judge`; this module only names the caller's places for the OS
// sandboxes, which can't nest an allow inside the home deny.
import { lstatSync, mkdirSync } from "node:fs";
import { join as hostJoin, posix } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { ownFoldersOf, type FenceContext } from "../contracts/fence";
import { botSegment } from "../sessions/ids";

/** The caller's places under the Clover home, for one sandboxed command: the folders the sandbox denies outright
 *  (`bots`, `sessions-runtime`) and the caller's own ways back in (B's `ownFoldersOf`). */
export interface CallerPlaces {
  /** `<home>/bots`: never listed by a runner; only the owning bot's folder reads. */
  readonly bots: string;
  /** `<home>/sessions-runtime`: hidden from every runner. */
  readonly runtime: string;
  /** `<home>/bots/<x>`, read only, for the owning bot's own conversation and side threads; else null. */
  readonly ownBot: string | null;
  /** `<home>/bots/<x>/memory`, read and write, for the same runners; else null. */
  readonly ownMemory: string | null;
  /** `<home>/outputs/<session>`, read and write, for the session whose it is; else null. */
  readonly ownOutputs: string | null;
  /** `<home>/scratch/<bot>`, read and write, for the owning bot's own conversation and side threads; else null. */
  readonly ownScratch: string | null;
  /** `<home>/routines/<bot>`, read and write, for the same runners; else null. */
  readonly ownRoutines: string | null;
  /** `<home>/plugin-data/<id>`, read and write, for that plugin's own code alone; else null. */
  readonly ownPluginData: string | null;
  /** A bot's own conversation and side threads (the owner's ruling of November 9 and its amendment): the whole home
   *  read, inside every bot's scratch folder and every bot's memory read and written, less the policy's denies inside
   *  them; else null. */
  readonly botAccess: { home: string; scratch: string; bots: string } | null;
}

export function callerPlaces(cloverHome: string, _os: Os, ctx?: FenceContext): CallerPlaces {
  const own = ownFoldersOf(ctx, cloverHome);
  return {
    bots: posix.join(cloverHome, "bots"),
    runtime: posix.join(cloverHome, "sessions-runtime"),
    ownBot: own.ownBot ?? null,
    ownMemory: own.ownMemory ?? null,
    ownOutputs: own.ownOutputs ?? null,
    ownScratch: own.ownScratch ?? null,
    ownRoutines: own.ownRoutines ?? null,
    ownPluginData: own.ownPluginData ?? null,
    botAccess: own.ownMemory !== undefined ? { home: cloverHome, scratch: posix.join(cloverHome, "scratch"), bots: posix.join(cloverHome, "bots") } : null,
  };
}

/** Makes a bot's folders when the bot is made (#205's S6), `bots/<bot>/memory` included, refusing any part of the way
 *  that is a link (a leftover or a planted one), so nothing written there later lands elsewhere. Lane D calls it at
 *  creation; writes there go through `openChecked`. */
export function makeBotFolders(cloverHome: string, bot: string): { root: string; memory: string } {
  const root = hostJoin(cloverHome, "bots", botSegment(bot));
  let at = cloverHome;
  for (const part of ["bots", botSegment(bot), "memory"]) {
    at = hostJoin(at, part);
    let st: ReturnType<typeof lstatSync> | undefined;
    try { st = lstatSync(at); } catch { st = undefined; }
    if (st === undefined) mkdirSync(at, { mode: 0o700 });
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${at} isn't a plain folder: a bot's folders are never made through a link`);
  }
  return { root, memory: hostJoin(root, "memory") };
}
