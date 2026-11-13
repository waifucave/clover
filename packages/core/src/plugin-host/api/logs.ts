// `logs.read` and `logs.follow` (spec §5.4, capability `logs.read`), the plugin API's reads of a plugin's log: what its
// host half's console, its stdio servers' stderr and Clover's notes about it wrote (`<home>/logs/plugins/<id>.log`,
// `pluginLogWriter`, the same file its Settings page shows). Owner: lane A.
//
// * **Whose:** a plugin reads its own tree's logs (its own and its children's, by id). The capability's text says
//   "Clover's logs and every plugin's"; this build serves the narrow reading, a plugin's own, for the coordinator's
//   ruling: Clover's own log (`source: "core"`) and another plugin's are refused with why.
// * **`read(source, { lines })`:** the last `lines` lines (default LOG_READ_DEFAULT, at most LOG_READ_MAX), from the
//   file and, when it holds fewer, the one it rotated to (`<id>.log.1`); at most LOG_READ_BYTES of each is read.
// * **`follow(source, listener)`:** each line written from now on, read as the file grows (a rotation starts it again
//   from its top); at most LOG_FOLLOWS_PER_PLUGIN open per plugin, closed when the plugin stops (`forget`).
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
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

/** The plugin whose log `source` names, if the caller may read it: its own tree's only. */
function sourceOf(ctx: ApiCallContext, raw: unknown): string {
  if (raw === "core") throw new ContractError("refused", "Clover's own log isn't open to plugins; a plugin reads its own logs ({ plugin: id })");
  const id = typeof raw === "object" && raw !== null ? (raw as { plugin?: unknown }).plugin : undefined;
  if (typeof id !== "string" || id === "") throw new ContractError("invalid", "the source is { plugin: id }");
  if (topPluginIdOf(id) !== topPluginIdOf(ctx.pluginId)) throw new ContractError("refused", `${ctx.pluginId} reads only its own logs, not ${id}'s`);
  return id;
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

export function logsApi(o: { home: string; pollMs?: number }): { handlers: ApiHandlers; forget(pluginId: string): void } {
  const follows = new Map<string, Set<() => void>>();
  const handlers: ApiHandlers = {
    "logs.read": (ctx, args) => {
      const id = sourceOf(ctx, args[0]);
      const want = (args[1] as { lines?: unknown } | undefined)?.lines;
      const n = typeof want === "number" && Number.isFinite(want) ? Math.min(LOG_READ_MAX, Math.max(1, Math.floor(want))) : LOG_READ_DEFAULT;
      const file = pluginLogFile(o.home, id);
      let lines = linesOf(tail(file, LOG_READ_BYTES));
      if (lines.length < n && existsSync(`${file}.1`)) lines = [...linesOf(tail(`${file}.1`, LOG_READ_BYTES)), ...lines];
      return lines.slice(-n);
    },
    "logs.follow": (ctx, args): Unsubscribe => {
      const id = sourceOf(ctx, args[0]);
      const listener = listenerArg<string>(args, 1);
      const mine = follows.get(ctx.pluginId) ?? new Set<() => void>();
      if (mine.size >= LOG_FOLLOWS_PER_PLUGIN) throw new ContractError("refused", `${ctx.pluginId} follows ${LOG_FOLLOWS_PER_PLUGIN} logs already; close one first`);
      const file = pluginLogFile(o.home, id);
      const sizeNow = () => { try { return statSync(file).size; } catch { return 0; } };
      let offset = sizeNow();
      let partial = "";
      const poll = () => {
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
