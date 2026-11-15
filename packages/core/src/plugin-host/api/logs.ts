// `logs.read` and `logs.follow` (spec §5.4, capability `logs.read`), the plugin API's reads of a plugin's log: what its
// host half's console, its stdio servers' stderr and Clover's notes about it wrote (`<home>/logs/plugins/<id>.log`,
// `pluginLogWriter`, the same file its Settings page shows). Owner: lane A.
//
// * **Whose** (the coordinator's ruling: the OK card is the gate): a plugin reads its own tree's logs (its own and its
//   children's, by id) with no capability. With `logs.read`, whose OK line says "It reads Clover's logs and every
//   plugin's logs", it also reads Clover's own log (`source: "core"`, `<home>/logs/daemon.log`) and any other plugin's.
// * **`read(source, { lines })`:** the last `lines` lines (default LOG_READ_DEFAULT, at most LOG_READ_MAX), from the
//   file and, when it holds fewer, the one it rotated to (`<id>.log.1`); at most LOG_READ_BYTES of each is read.
// * **`follow(source, listener)`:** each line written from now on, read as the file grows (a rotation starts it again
//   from its top); at most LOG_FOLLOWS_PER_PLUGIN open per plugin, closed when the plugin stops (`forget`).
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import { DAEMON_LOG_FILE } from "../../daemon-log-file";
import { pluginPath } from "../paths";
import { listenerArg, type ApiCallContext, type ApiHandlers } from "./router";

export const LOG_READ_DEFAULT = 200;
export const LOG_READ_MAX = 2_000;
/** How much of one file a read looks at, from its end. */
export const LOG_READ_BYTES = 1024 * 1024;
export const LOG_FOLLOWS_PER_PLUGIN = 8;
/** How often a follow looks for new lines. */
export const LOG_FOLLOW_POLL_MS = 250;
/** The longest line a follow hands over (a longer one is cut). */
const LINE_MAX = 4_000;

/** The log file of `pluginId` under the plugins' log folder, as `pluginLogWriter` writes it. */
export function pluginLogFile(home: string, pluginId: string): string {
  return `${pluginPath(join(home, "logs", "plugins"), pluginId)}.log`;
}

/** The log file `source` names, if the caller may read it: its own tree's always, Clover's own and any other plugin's
 *  with `logs.read` on its OK. */
function fileOf(home: string, ctx: ApiCallContext, raw: unknown): string {
  const granted = ctx.record.granted.includes("logs.read");
  if (raw === "core") {
    if (!granted) throw new ContractError("refused", "Clover's own log needs the capability logs.read, which this plugin's OK doesn't list");
    return join(home, "logs", DAEMON_LOG_FILE);
  }
  const id = typeof raw === "object" && raw !== null ? (raw as { plugin?: unknown }).plugin : undefined;
  if (typeof id !== "string" || id === "") throw new ContractError("invalid", "the source is \"core\" or { plugin: id }");
  if (!granted && topPluginIdOf(id) !== topPluginIdOf(ctx.pluginId)) throw new ContractError("refused", `${id}'s log needs the capability logs.read, which this plugin's OK doesn't list (a plugin reads its own logs without it)`);
  return pluginLogFile(home, id);
}

/** The last bytes of a file (at most `max`), as text from its first whole line; empty when it isn't there. */
function tail(file: string, max: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const linesOf = (text: string): string[] => text.split("\n").filter((l) => l !== "");

export function logsApi(o: {
  home: string;
  pollMs?: number;
  /** What a plugin's OK grants now (its record, read at each poll): a follow beyond its own logs ends when an update
   *  drops `logs.read`. Absent: the grant read at the call. */
  granted?(pluginId: string): readonly string[];
}): { handlers: ApiHandlers; forget(pluginId: string): void } {
  const follows = new Map<string, Set<() => void>>();
  const handlers: ApiHandlers = {
    "logs.read": (ctx, args) => {
      const file = fileOf(o.home, ctx, args[0]);
      const want = (args[1] as { lines?: unknown } | undefined)?.lines;
      const n = typeof want === "number" && Number.isFinite(want) ? Math.min(LOG_READ_MAX, Math.max(1, Math.floor(want))) : LOG_READ_DEFAULT;
      let lines = linesOf(tail(file, LOG_READ_BYTES));
      if (lines.length < n && existsSync(`${file}.1`)) lines = [...linesOf(tail(`${file}.1`, LOG_READ_BYTES)), ...lines];
      return lines.slice(-n);
    },
    "logs.follow": (ctx, args): Unsubscribe => {
      const file = fileOf(o.home, ctx, args[0]);
      // Beyond its own tree's logs, it holds only while its OK still grants `logs.read`.
      const ownLog = typeof args[0] === "object" && args[0] !== null && topPluginIdOf(String((args[0] as { plugin?: unknown }).plugin)) === topPluginIdOf(ctx.pluginId);
      const listener = listenerArg<string>(args, 1);
      const mine = follows.get(ctx.pluginId) ?? new Set<() => void>();
      if (mine.size >= LOG_FOLLOWS_PER_PLUGIN) throw new ContractError("refused", `${ctx.pluginId} follows ${LOG_FOLLOWS_PER_PLUGIN} logs already; close one first`);
      const sizeNow = () => { try { return statSync(file).size; } catch { return 0; } };
      let offset = sizeNow();
      let partial = "";
      const poll = () => {
        if (!ownLog && o.granted !== undefined && !o.granted(ctx.pluginId).includes("logs.read")) return stop();
        const size = sizeNow();
        if (size < offset) { offset = 0; partial = ""; } // rotated: the new file from its top
        if (size === offset) return;
        let fd: number | undefined;
        try {
          const buf = Buffer.alloc(Math.min(size - offset, LOG_READ_BYTES));
          fd = openSync(file, "r");
          const got = readSync(fd, buf, 0, buf.length, offset);
          offset += got;
          const text = partial + buf.subarray(0, got).toString("utf8");
          const parts = text.split("\n");
          partial = (parts.pop() ?? "").slice(-LINE_MAX);
          for (const line of parts) {
            if (line === "") continue;
            try { listener(line.slice(0, LINE_MAX)); } catch { /* the plugin's listener; its error is its own */ }
          }
        } catch {
          // gone for now: looked at again next time
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      };
      const timer = setInterval(poll, o.pollMs ?? LOG_FOLLOW_POLL_MS);
      timer.unref?.();
      const stop = () => {
        clearInterval(timer);
        mine.delete(stop);
        if (mine.size === 0) follows.delete(ctx.pluginId);
      };
      mine.add(stop);
      follows.set(ctx.pluginId, mine);
      return stop;
    },
  };
  return {
    handlers,
    forget(pluginId) {
      for (const stop of [...(follows.get(pluginId) ?? [])]) stop();
    },
  };
}
