// The fence's per-caller rules (the owner's decision on bots' memory; B's `Fence.forCaller`): matched by pattern and
// denied by default, never built from a list of known bots or sessions, so a bot not made yet, one synced from
// another computer before any list refreshes, or a removed bot's leftover folder is covered the same.
//
//   <home>/bots/<x>/memory/**   read and written only by the bot whose id folds equal to <x>, from its own main
//                               conversation or side threads; everyone else (other bots, the user's coding sessions,
//                               ACP and delegated agents, that bot's own agents) is denied both
//   <home>/bots/<x>/memory      itself: never deleted, moved or replaced, by its own bot either
//   <home>/bots, <home>/bots/<x>, and the rest of <home>/bots/<x>/**   write-denied to all; reads allowed
//   <home>/sessions-runtime/**  write-denied to all; read only by the session whose state file it is
import { lstatSync, mkdirSync } from "node:fs";
import { join as hostJoin, posix, win32 } from "node:path";
import type { Os } from "@waifucave/clover-protocol";
import { botSegment } from "../sessions/ids";
import { foldName, foldPath } from "./fold";

export interface FenceCaller {
  readonly sessionId?: string;
  readonly bot?: string;
  /** The bot's own main conversation or one of its side threads: the only caller its memory opens to. */
  readonly botsOwnSession?: boolean;
}

export type CallerReason = "bot-memory" | "sessions-runtime";

/** The bot driver's state file for a session (A-M3's driver names it so). */
export function runtimeStateName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export interface CallerPlaces {
  readonly bots: string;
  readonly runtime: string;
  /** The caller's own memory folder, when it is a bot's own session. */
  readonly ownMemory: string | null;
  /** The caller's own state file in `runtime`, when it has a session. */
  readonly ownRuntime: string | null;
}

export function callerPlaces(cloverHome: string, os: Os, caller: FenceCaller): CallerPlaces {
  const p = os === "windows" && !cloverHome.startsWith("/") ? win32 : posix;
  const bots = p.join(cloverHome, "bots"), runtime = p.join(cloverHome, "sessions-runtime");
  const own = caller.botsOwnSession && caller.bot !== undefined ? botSegment(caller.bot) : null;
  return {
    bots, runtime,
    ownMemory: own === null ? null : p.join(bots, own, "memory"),
    ownRuntime: caller.sessionId === undefined ? null : p.join(runtime, runtimeStateName(caller.sessionId)),
  };
}

/** The verdict of the per-caller rules for one access to a canonical path, or null where none applies. */
export function callerVerdict(o: { cloverHome: string; os: Os; caller: FenceCaller; path: string; write: boolean }): { reason: CallerReason; path: string } | null {
  const places = callerPlaces(o.cloverHome, o.os, o.caller);
  const f = foldPath(o.path, o.os);
  const under = (root: string): string[] | null => {
    const r = foldPath(root, o.os);
    if (f === r) return [];
    return f.startsWith(`${r}/`) ? f.slice(r.length + 1).split("/") : null;
  };
  const inBots = under(places.bots);
  if (inBots !== null) {
    const [x, second] = inBots;
    if (x === undefined || second === undefined) return o.write ? { reason: "bot-memory", path: places.bots } : null;
    const isMemory = foldName(second) === "memory";
    const own = places.ownMemory !== null && foldName(x) === foldName(posixBase(places.ownMemory, 1));
    // The memory folder itself is never removed, renamed or replaced, by its own bot either; inside it, only its bot.
    if (isMemory && o.write && inBots.length === 2) return { reason: "bot-memory", path: join(o.os, places.bots, x, "memory") };
    if (isMemory) return own ? null : { reason: "bot-memory", path: join(o.os, places.bots, x, "memory") };
    return o.write ? { reason: "bot-memory", path: join(o.os, places.bots, x) } : null;
  }
  const inRuntime = under(places.runtime);
  if (inRuntime !== null) {
    if (o.write) return { reason: "sessions-runtime", path: places.runtime };
    const mine = places.ownRuntime !== null && inRuntime.length === 1 && inRuntime[0] === foldName(posixBase(places.ownRuntime, 0));
    return mine ? null : { reason: "sessions-runtime", path: places.runtime };
  }
  return null;
}

/** The `n`th-from-last component of a path, either separator. */
function posixBase(path: string, n: number): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1 - n] ?? "";
}

function join(os: Os, ...parts: string[]): string {
  return (os === "windows" && !parts[0]!.startsWith("/") ? win32 : posix).join(...parts);
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
