// Point messages (`points.send`, `points.onMessage`): a live line between a point's declaring plugin and the plugins
// with an active entry in it, both ways. A general piece of the plugin API: any plugin that declares a point may talk
// with its fillers this way, and nothing here knows what a point is for.
//
// * Who: the point's active declaration names its declaring plugin; its fillers are the plugins that run now and have
//   an active entry in it (for a UI spot, an active `ui` entry whose `spot` is the point). From the declaring plugin a
//   message goes to every filler but itself, or to the one `to` names (which must fill it); from a filler it goes to the
//   declaring plugin. Any other sender is refused, saying why. The gate is the entry: filling a point is what the
//   declarer's `fills` words on the filler's OK card say, so the person saw it before anything reaches it.
// * What: plain data, serialized at most POINT_MESSAGE_MAX_BYTES; a plugin sends at most POINT_MESSAGES_PER_SECOND a
//   second, every point together. Every message is handed on, in the order it was sent (no coalescing): a listener is a
//   watch, and a component's watch values go to its own connection alone, in order.
// * Hearing: `points.onMessage(point, listener)` in either half; a listener hears what reaches its plugin on that point
//   while the plugin declares or fills it. A plugin holds at most LISTENERS_MAX of them.
// * A core point (`hooks`, `models` …) has no declaring plugin and takes no message.
import { POINT_MESSAGES_PER_SECOND, POINT_MESSAGE_MAX_BYTES, type PointMessage } from "@waifucave/moss-plugin-sdk";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import { contributorRuns } from "./points";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "./router";

/** Listeners one plugin may hold, every point together. */
export const POINT_LISTENERS_MAX = 32;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PointMessagesOptions {
  registry: Pick<PluginRegistry, "entries" | "points"> & Partial<Pick<PluginRegistry, "get">>;
  now?: () => number;
}

/** Whether a point's declaration carries the line its fillers' OK cards show (`fills.ok`). */
function hasFillsOk(decl: unknown): boolean {
  const ok = (decl as { fills?: { ok?: unknown } } | undefined)?.fills?.ok;
  return (typeof ok === "string" && ok.trim() !== "") || (ok !== null && typeof ok === "object" && Object.keys(ok).length > 0);
}
const noFillsLine = (point: string, declarer: string) => `${declarer} declares ${point} with no \`fills.ok\` line, so it carries no point messages: the line is what each filler's OK card tells the person it is handed and sends`;

/** The plugins that fill `point` now: running, with an active entry in it (a UI spot's through `ui`). */
export function fillersOf(registry: PointMessagesOptions["registry"], point: string, spot: boolean): string[] {
  const entries = spot
    ? registry.entries("ui").filter((c) => isObject(c.value) && c.value.spot === point)
    : registry.entries(point);
  const out: string[] = [];
  for (const c of entries) if (c.state === "active" && contributorRuns(registry, c.pluginId) && !out.includes(c.pluginId)) out.push(c.pluginId);
  return out;
}

export class PointMessages {
  readonly #o: PointMessagesOptions;
  /** Listeners by plugin, then by point. */
  readonly #listeners = new Map<string, Map<string, Set<(m: PointMessage) => void>>>();
  readonly #windows = new Map<string, { start: number; n: number }>();

  constructor(o: PointMessagesOptions) {
    this.#o = o;
  }

  /** The active declaration of a point a plugin declares, or refused / not_found. */
  #declared(point: string): { declarer: string; spot: boolean } {
    const p = this.#o.registry.points().find((x) => x.name === point && x.active);
    if (p === undefined) throw new ContractError("not_found", `no plugin declares ${point} here`);
    if (p.declaredBy === "core") throw new ContractError("refused", `${point} is a core point; it takes no messages`);
    // Every message path has a line the person saw: the declaration's `fills.ok`, on each filler's OK card.
    if (!hasFillsOk(p.decl)) throw new ContractError("refused", noFillsLine(point, p.declaredBy.pluginId));
    return { declarer: p.declaredBy.pluginId, spot: p.spot };
  }

  /** Who a message from `from` on `point` reaches. */
  recipients(from: string, point: string, to?: string): string[] {
    const { declarer, spot } = this.#declared(point);
    const fillers = fillersOf(this.#o.registry, point, spot);
    if (from === declarer) {
      const others = fillers.filter((id) => id !== declarer);
      if (to === undefined) return others;
      if (!others.includes(to)) throw new ContractError("refused", `${to} has no active entry in ${point}, so nothing is sent to it`);
      return [to];
    }
    if (fillers.includes(from)) {
      if (to !== undefined && to !== declarer) throw new ContractError("refused", `a plugin that fills ${point} sends only to its declarer, ${declarer}`);
      if (!contributorRuns(this.#o.registry, declarer)) return [];
      return [declarer];
    }
    throw new ContractError("refused", `${from} neither declares nor fills ${point}: only its declarer and the plugins with an entry in it send there`);
  }

  send(from: string, point: string, value: unknown, to?: string): number {
    let text: string | undefined;
    try {
      text = JSON.stringify(value ?? null);
    } catch {
      text = undefined;
    }
    if (text === undefined) throw new ContractError("invalid", "a point message is plain data");
    if (Buffer.byteLength(text) > POINT_MESSAGE_MAX_BYTES) throw new ContractError("invalid", `a point message is at most ${POINT_MESSAGE_MAX_BYTES} bytes`);
    const t = (this.#o.now ?? Date.now)();
    const w = this.#windows.get(from);
    if (w === undefined || t - w.start >= 1000) this.#windows.set(from, { start: t, n: 1 });
    else if (++w.n > POINT_MESSAGES_PER_SECOND) throw new ContractError("refused", `${from} sent more than ${POINT_MESSAGES_PER_SECOND} point messages this second`);
    const who = this.recipients(from, point, to);
    const message: PointMessage = { from, value: JSON.parse(text) as unknown };
    let n = 0;
    for (const id of who) {
      const set = this.#listeners.get(id)?.get(point);
      if (set === undefined) continue;
      for (const l of [...set]) {
        n += 1;
        try {
          l(message);
        } catch {
          // a listener that throws loses only its own message
        }
      }
    }
    return n;
  }

  listen(pluginId: string, point: string, listener: (m: PointMessage) => void): Unsubscribe {
    const mine = this.#listeners.get(pluginId) ?? new Map<string, Set<(m: PointMessage) => void>>();
    let count = 0;
    for (const s of mine.values()) count += s.size;
    if (count >= POINT_LISTENERS_MAX) throw new ContractError("refused", `${pluginId} has ${POINT_LISTENERS_MAX} point listeners open; close one first`);
    const set = mine.get(point) ?? new Set();
    set.add(listener);
    mine.set(point, set);
    this.#listeners.set(pluginId, mine);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(listener);
      if (set.size === 0) mine.delete(point);
      if (mine.size === 0) this.#listeners.delete(pluginId);
    };
  }

  /** A plugin stopped, went off or was removed: its listeners go. */
  endPlugin(pluginId: string): void {
    this.#listeners.delete(pluginId);
    this.#windows.delete(pluginId);
  }

  handlers(): ApiHandlers {
    const runs = (ctx: ApiCallContext) => {
      if (!contributorRuns(this.#o.registry, ctx.pluginId)) throw new ContractError("refused", `${ctx.pluginId} isn't running, so it sends and hears no point message`);
    };
    return {
      "points.send": (ctx, args) => {
        runs(ctx);
        const point = stringArg(args, 0, "the point");
        const opts = args[2];
        if (opts !== undefined && opts !== null && !isObject(opts)) throw new ContractError("invalid", "points.send's third argument is { to? }");
        const to = isObject(opts) ? opts.to : undefined;
        if (to !== undefined && (typeof to !== "string" || to === "" || to.length > 128)) throw new ContractError("invalid", "points.send's to is a plugin's id");
        this.send(ctx.pluginId, point, args[1], to as string | undefined);
      },
      "points.onMessage": (ctx, args): Unsubscribe => {
        runs(ctx);
        const point = stringArg(args, 0, "the point");
        const listener = listenerArg<PointMessage>(args, 1);
        // No declaration is needed to listen: a part may mount before the point's declarer runs, and hears once it does.
        // One declared with no `fills.ok` line carries no message, so listening on it is refused, saying why.
        const p = this.#o.registry.points().find((x) => x.name === point && x.active);
        if (p !== undefined && p.declaredBy !== "core" && !hasFillsOk(p.decl)) throw new ContractError("refused", noFillsLine(point, p.declaredBy.pluginId));
        return this.listen(ctx.pluginId, point, listener);
      },
    };
  }
}
