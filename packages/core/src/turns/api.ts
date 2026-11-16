// The `turns` area of the plugin API (spec §5.4 "Turns"), served to both halves of a plugin: `take`, `done`, `extend`,
// `state` and `watch` over the daemon's one set of queues (`./queue.ts`).
//
// Who may use a name (the catalog gives the area no capability of its own; the name decides):
// * `<the caller's plugin id>/<name>`: the plugin's own, no declaration needed;
// * `<another plugin's id>/<name>`: only when that plugin is installed and its manifest lists `<name>` in
//   `contributes.turns`;
// * a device turn (`device/speech`): the capability the turns catalog names (`audio`).
// A `take` is a watch on the wire: its listener hears the take's events, and its watch ending (the frame gone, the
// host process exited, the app quit, or the SDK's own leave) ends the take. The SDK makes the `Turn` from it.
import { parseTurnName, TURN_LIMIT_MAX_MS, TURN_LIMIT_MIN_MS, TURN_NOTE_MAX, type TurnEvent, type TurnState } from "@waifucave/moss-plugin-sdk";
import { ContractError } from "../contracts/common";
import type { PluginRecord } from "../contracts/plugin-registry";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "../plugin-host/api/router";
import type { TurnQueues } from "./queue";

export interface TurnsApiOptions {
  queues: TurnQueues;
  /** An installed plugin's record (another plugin's turn: its `contributes.turns`). */
  record(pluginId: string): PluginRecord | undefined;
}

/** Whether the caller may take, read or watch `name`; refuses with why. */
export function checkTurnName(name: string, ctx: Pick<ApiCallContext, "pluginId" | "record">, record: (id: string) => PluginRecord | undefined): void {
  const parsed = parseTurnName(name);
  if (parsed === undefined) throw new ContractError("invalid", `"${name.slice(0, 80)}" isn't a turn's name: <plugin id>/<name> (a-z, 0-9, ".", "_", "-") or a device turn such as device/speech`);
  if ("device" in parsed) {
    const cap = parsed.device.capability;
    if (cap !== undefined && !ctx.record.granted.includes(cap)) throw new ContractError("refused", `${name} needs the capability ${cap}, which this plugin's OK doesn't list`);
    return;
  }
  if (parsed.owner === ctx.pluginId) return;
  const owner = record(parsed.owner);
  const offered = (owner?.manifest as { contributes?: { turns?: { name?: unknown }[] } } | undefined)?.contributes?.turns;
  if (owner === undefined || !Array.isArray(offered) || !offered.some((t) => t?.name === parsed.local)) {
    throw new ContractError("refused", `${name} is ${parsed.owner}'s own turn, which it doesn't offer to other plugins (its manifest's contributes.turns)`);
  }
}

function options(raw: unknown): { limitMs?: number; note?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ContractError("invalid", "a take's options are an object: { limitMs?, note? }");
  const o = raw as { limitMs?: unknown; note?: unknown };
  const out: { limitMs?: number; note?: string } = {};
  if (o.limitMs !== undefined) {
    if (typeof o.limitMs !== "number" || !Number.isInteger(o.limitMs) || o.limitMs < TURN_LIMIT_MIN_MS || o.limitMs > TURN_LIMIT_MAX_MS) {
      throw new ContractError("invalid", `limitMs is a whole number of milliseconds from ${TURN_LIMIT_MIN_MS} to ${TURN_LIMIT_MAX_MS}`);
    }
    out.limitMs = o.limitMs;
  }
  if (o.note !== undefined) {
    if (typeof o.note !== "string" || o.note.length > TURN_NOTE_MAX) throw new ContractError("invalid", `a take's note is a string of at most ${TURN_NOTE_MAX} characters`);
    out.note = o.note;
  }
  return out;
}

export function turnsApi(o: TurnsApiOptions): ApiHandlers {
  const name = (ctx: ApiCallContext, args: readonly unknown[]): string => {
    const n = stringArg(args, 0, "a turn's name", 256);
    checkTurnName(n, ctx, o.record);
    return n;
  };
  return {
    "turns.take": (ctx, args) => {
      const n = name(ctx, args);
      const opts = options(args[1]);
      const listener = listenerArg<TurnEvent>(args, 2);
      return o.queues.take(n, { pluginId: ctx.pluginId, side: ctx.process }, opts, listener).leave;
    },
    "turns.done": (ctx, args) => {
      o.queues.done(stringArg(args, 0, "a turn's id", 128), ctx.pluginId);
    },
    "turns.extend": (ctx, args) => {
      const id = stringArg(args, 0, "a turn's id", 128);
      const ms = args[1];
      if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0 || ms > TURN_LIMIT_MAX_MS) throw new ContractError("invalid", `extend takes a whole number of milliseconds up to ${TURN_LIMIT_MAX_MS}`);
      return o.queues.extend(id, ctx.pluginId, ms);
    },
    "turns.state": (ctx, args): TurnState => o.queues.state(name(ctx, args)),
    "turns.watch": (ctx, args) => {
      const n = name(ctx, args);
      return o.queues.watch(n, listenerArg<TurnState>(args, 1));
    },
  };
}
