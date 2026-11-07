// `points.*` (spec §5.4 "Points"): a declarer reads its point's entries, hears them change, and calls an entry's
// handler, which runs in the contributor's worker.
//
// * Only the point's declarer reads it: its active declaring plugin, or another plugin of the same top-level tree (a
//   host that ships its default guests as children). A core point (`models`, `hooks` …) is the core's to read, and a
//   point with no active declarer has no entries for anyone (`not_found`).
// * Entries are the active ones, in the registry's order (the synced list's), each with its plugin, entry id, key and
//   value. A value's `path` fields (by the point's declaration, `format: "path"`) become asset URLs.
// * `points.call` runs the handler an entry names in `field`, a field whose format is `handler` in the point's
//   declaration; any other field is refused, so a declarer can't make a contributor run an export its entry doesn't
//   name. The call is the contributor's handler, told the declarer's caller (R7: a call the declarer makes while it
//   serves a session's call acts as that session).
import type { PointEntry } from "@waifucave/clover-plugin-sdk";
import { topPluginIdOf } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { PluginHost } from "../../contracts/plugin-host";
import type { Contribution, PluginRegistry, RegisteredPoint } from "../../contracts/plugin-registry";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "./router";

export interface PointsApiOptions {
  registry: Pick<PluginRegistry, "entries" | "points" | "watch">;
  host: Pick<PluginHost, "invoke">;
  /** The URL a component or host fetches a plugin's file from (lane E's asset server). */
  assetUrl: (pluginId: string, path: string) => string;
}

type Schema = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The active declaration of a point, or `not_found`; `refused` when `pluginId`'s tree isn't the declarer's. */
export function declaredPointFor(registry: Pick<PluginRegistry, "points">, point: string, pluginId: string): RegisteredPoint {
  const p = registry.points().find((x) => x.name === point && x.active);
  if (p === undefined) throw new ContractError("not_found", `no plugin declares ${point} here`);
  if (p.declaredBy === "core") throw new ContractError("refused", `${point} is a core point; the core reads it`);
  if (topPluginIdOf(p.declaredBy.pluginId) !== topPluginIdOf(pluginId)) {
    throw new ContractError("refused", `only ${p.declaredBy.pluginId}, which declares ${point}, reads its entries`);
  }
  return p;
}

/** A contribution as a declarer sees it, its `path` fields as asset URLs. */
export function pointEntryOf(c: Contribution, decl: RegisteredPoint["decl"], assetUrl: (pluginId: string, path: string) => string): PointEntry {
  const value = mapFormat(decl?.fields as Schema | undefined, c.value, "path", (v) => (typeof v === "string" ? assetUrl(c.pluginId, v) : v));
  return {
    pluginId: c.pluginId,
    entryId: c.entryId ?? c.ref.slice(c.ref.lastIndexOf("/") + 1),
    ...(c.key === undefined ? {} : { key: c.key }),
    value: (isObject(value) ? value : { value }) as Record<string, unknown>,
  };
}

/** `value` with every value whose schema has `format: <format>` passed through `fn` (properties, items, nested). */
export function mapFormat(schema: Schema | undefined, value: unknown, format: string, fn: (v: unknown) => unknown, depth = 0): unknown {
  if (schema === undefined || depth > 32) return value;
  if (schema.format === format) return fn(value);
  if (isObject(value) && isObject(schema.properties)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const sub = (schema.properties as Record<string, unknown>)[k];
      out[k] = isObject(sub) ? mapFormat(sub, v, format, fn, depth + 1) : v;
    }
    return out;
  }
  if (Array.isArray(value) && isObject(schema.items)) return value.map((v) => mapFormat(schema.items as Schema, v, format, fn, depth + 1));
  return value;
}

/** The top-level fields of a declaration whose format is `handler`. */
export function handlerFields(fields: Schema | undefined): string[] {
  if (!isObject(fields?.properties)) return [];
  return Object.entries(fields.properties as Record<string, unknown>).filter(([, s]) => isObject(s) && s.format === "handler").map(([k]) => k);
}

export function pointsApi(o: PointsApiOptions): ApiHandlers {
  const entriesFor = (ctx: ApiCallContext, point: string): PointEntry[] => {
    const decl = declaredPointFor(o.registry, point, ctx.pluginId);
    return o.registry.entries(point).filter((c) => c.state === "active").map((c) => pointEntryOf(c, decl.decl, o.assetUrl));
  };
  return {
    "points.entries": (ctx, args) => entriesFor(ctx, stringArg(args, 0, "the point")),
    "points.watch": (ctx, args): Unsubscribe => {
      const point = stringArg(args, 0, "the point");
      const listener = listenerArg<PointEntry[]>(args, 1);
      let last = JSON.stringify(entriesFor(ctx, point));
      return o.registry.watch(() => {
        let now: PointEntry[];
        try {
          now = entriesFor(ctx, point);
        } catch {
          now = []; // the declaration went away: its entries are gone for the declarer
        }
        const text = JSON.stringify(now);
        if (text === last) return;
        last = text;
        listener(now);
      });
    },
    "points.call": async (ctx, args) => {
      const point = stringArg(args, 0, "the point");
      const ref = args[1];
      if (!isObject(ref) || typeof ref.pluginId !== "string" || typeof ref.entryId !== "string") throw new ContractError("invalid", "points.call names an entry by { pluginId, entryId }");
      const field = stringArg(args, 2, "the field", 128);
      const opts = isObject(args[4]) ? args[4] : {};
      const decl = declaredPointFor(o.registry, point, ctx.pluginId);
      if (!handlerFields(decl.decl?.fields as Schema | undefined).includes(field)) {
        throw new ContractError("refused", `${field} isn't a handler field of ${point}`);
      }
      const entry = o.registry.entries(point).find((c) => c.state === "active" && c.pluginId === ref.pluginId && pointEntryOf(c, undefined, o.assetUrl).entryId === ref.entryId);
      if (entry === undefined) throw new ContractError("not_installed", `${ref.pluginId} has no active entry ${ref.entryId} for ${point}`);
      const handler = isObject(entry.value) ? entry.value[field] : undefined;
      if (typeof handler !== "string") throw new ContractError("not_installed", `${ref.pluginId}'s entry names no ${field}`);
      return await o.host.invoke({
        pluginId: entry.pluginId,
        handler,
        ...(typeof opts.method === "string" ? { method: opts.method } : {}),
        args: args[3],
        caller: ctx.caller,
        ...(ctx.caller.kind === "session" ? { session: ctx.caller.sessionId } : {}),
        ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
      });
    },
  };
}
