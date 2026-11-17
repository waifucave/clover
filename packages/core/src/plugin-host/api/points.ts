// `points.*` (spec §5.4 "Points"): a declarer reads its point's entries, hears them change, and calls an entry's
// handler, which runs in the contributor's worker.
//
// * Only the point's declarer reads it: its active declaring plugin, or another plugin of the same top-level tree (a
//   host that ships its default guests as children). A core point (`models`, `hooks` …) is the core's to read, and a
//   point with no active declarer has no entries for anyone (`not_found`).
// * Entries are the active ones of contributors that may run now (on and running, `grantsInForce`'s rule: an off,
//   stopped, blocked or not-yet-OK'd contributor has none), in the registry's order (the synced list's), each with its
//   plugin, entry id, key and value. When the point's declaration names its fields, the value carries those fields
//   only (what the contributor declared for that point, nothing else of its manifest). A value's `path` fields (by the
//   point's declaration, `format: "path"`) become asset URLs.
// * The reader must be on and running too: a turned-off plugin's connection still open reads nothing.
// * A platform point (one the core and the app read, which no plugin declares; none ships today) is read by any
//   plugin that holds one of the capabilities its catalog entry names (`readBy`); there is no declarer's right to read
//   it, and no plugin's id decides. Its entries are in force as soon as their plugins run.
// * A component reads them the same way (`plugin.layer.call`'s `points.entries`, its own plugin as the caller), and
//   hears a change as `plugin_point_changed`, the point's name only, on its own plugin's connection (`pointChanges`).
// * `points.call` runs the handler an entry names in `field`, a field whose format is `handler` in the point's
//   declaration; any other field is refused, so a declarer can't make a contributor run an export its entry doesn't
//   name. The call is the contributor's handler, told the declarer's caller (R7: a call the declarer makes while it
//   serves a session's call acts as that session).
// * `points.stream` is `points.call` for a handler that answers with a stream (§5.4 "Streams"): the same entry, field and
//   checks, the caller's watch the stream's reader and the contributor's host half its writer.
// * `points.active` and `points.onActive` (§5.4 "One at a time"): which entry of a one-at-a-time point is active, as
//   its plugin and entry id (never its value), for the declarer's tree and for a plugin of a tree with an entry in it
//   (`registry/active-one.ts`). Only the user's own door changes it (`point.active.set`); no plugin call does.
import { STREAM_POINT_TIMEOUT_MAX_MS, DATA_POINTS, catalogPointDecl, dataPointInfo, type ActiveFiller, type PointEntry } from "@waifucave/moss-plugin-sdk";
import { topPluginIdOf } from "@waifucave/moss-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { PluginHost } from "../../contracts/plugin-host";
import { RUNNING_STATES, type Contribution, type PluginRegistry, type RegisteredPoint } from "../../contracts/plugin-registry";
import type { StreamEvent, StreamHub } from "../../streams/hub";
import { assetPath } from "../paths";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "./router";
import { activeOne, mayReadActive, refOf } from "../../registry/active-one";

export interface PointsApiOptions {
  registry: Pick<PluginRegistry, "entries" | "points" | "watch"> & Partial<Pick<PluginRegistry, "get" | "chosen">>;
  host: Pick<PluginHost, "invoke">;
  /** The URL a component or host fetches a plugin's file from (lane E's asset server), given the path relative to the
   *  plugin's folder, checked and with each segment percent-encoded (`assetPath`). */
  assetUrl: (pluginId: string, path: string) => string;
  /** The streams hub (`points.stream`); without it that call is refused. */
  streams?: Pick<StreamHub, "openPoint" | "producerFinished">;
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

/** The platform point `point` names, when `granted` lets its holder read it: the point as the catalog declares it, or
 *  `undefined` when `point` is not a platform point; refused when it is and none of the capabilities that read it is held. */
export function platformPointFor(point: string, granted: readonly string[]): RegisteredPoint | undefined {
  const info = dataPointInfo(point);
  if (info === undefined || info.declaredBy !== "core") return undefined;
  const readers = info.readBy ?? [];
  if (!readers.some((c) => granted.includes(c))) throw new ContractError("refused", `${point} is the platform's; reading it takes ${readers.map((c) => `\`${c}\``).join(" or ")}`);
  return { name: point, shape: info.shape, declaredBy: "core", spot: false, active: true, decl: catalogPointDecl(point) as RegisteredPoint["decl"] };
}

/** The platform's own data points by name (the catalog's, whose `declaredBy` is `"core"`), for the change notices. */
const PLATFORM_POINTS: ReadonlyMap<string, (typeof DATA_POINTS)[number]> = new Map(DATA_POINTS.filter((p) => p.declaredBy === "core").map((p) => [p.name, p]));

/** A contribution as a declarer sees it, its `path` fields as asset URLs. */
export function pointEntryOf(c: Contribution, decl: RegisteredPoint["decl"], assetUrl: (pluginId: string, path: string) => string): PointEntry {
  // A path that could leave the contributor's folder or name another origin becomes null (#332's review); `assetUrl`
  // gets the rest with each segment percent-encoded (`assetPath`), whoever serves it.
  const value = mapFormat(decl?.fields as Schema | undefined, c.value, "path", (v) => {
    if (typeof v !== "string") return v;
    const safe = assetPath(v);
    return safe === undefined ? null : assetUrl(c.pluginId, safe);
  });
  // Only the fields the point's declaration names, when it names them: the contributor's entry for this point, never
  // the rest of what its manifest holds there.
  const named = isObject(decl?.fields) && isObject((decl.fields as Schema).properties) ? Object.keys((decl.fields as Schema).properties as Schema) : undefined;
  const shown = isObject(value) && named !== undefined ? Object.fromEntries(Object.entries(value).filter(([k]) => named.includes(k))) : value;
  return {
    pluginId: c.pluginId,
    entryId: c.entryId ?? c.ref.slice(c.ref.lastIndexOf("/") + 1),
    ...(c.key === undefined ? {} : { key: c.key }),
    value: (isObject(shown) ? shown : { value: shown }) as Record<string, unknown>,
  };
}

/** Whether a contributor's entries count now: it is on and running (none while off, stopped, blocked or awaiting its
 *  OK). A registry with no records (a test's) counts every active entry. */
export function contributorRuns(registry: Partial<Pick<PluginRegistry, "get">>, pluginId: string): boolean {
  if (registry.get === undefined) return true;
  const r = registry.get(pluginId);
  return r !== undefined && r.enabled && RUNNING_STATES.has(r.state);
}

/** The point entries a declarer sees now (active, from contributors that run), for its host half and its layer. */
export function visibleEntries(o: Pick<PointsApiOptions, "registry" | "assetUrl">, point: RegisteredPoint): PointEntry[] {
  return o.registry.entries(point.name).filter((c) => c.state === "active" && contributorRuns(o.registry, c.pluginId)).map((c) => pointEntryOf(c, point.decl, o.assetUrl));
}

/** Watches every point a plugin declares and calls `changed(pluginId, point)` for each running plugin of the declaring
 *  tree when what that tree sees of the point changes (`plugin_point_changed`, the name only), at most once per point
 *  every `ms`. */
export function pointChanges(o: Pick<PointsApiOptions, "registry" | "assetUrl"> & { registry: Pick<PluginRegistry, "list"> }, changed: (pluginId: string, point: string) => void, ms = 100): () => void {
  const last = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // What each declared point shows, with its declaring tree: a new declarer taking a point over is a change too.
  const platform = PLATFORM_POINTS;
  const snapshot = () => {
    const now = new Map<string, { text: string; tree: string }>();
    for (const [name, info] of platform) {
      const p: RegisteredPoint = { name, shape: info.shape, declaredBy: "core", spot: false, active: true, decl: catalogPointDecl(name) as RegisteredPoint["decl"] };
      now.set(name, { text: `core\u0000${JSON.stringify(visibleEntries(o, p))}`, tree: "" });
    }
    for (const p of o.registry.points()) {
      if (!p.active || p.declaredBy === "core" || platform.has(p.name)) continue;
      const tree = topPluginIdOf(p.declaredBy.pluginId);
      now.set(p.name, { text: `${tree}\u0000${JSON.stringify(visibleEntries(o, p))}`, tree });
    }
    return now;
  };
  for (const [name, v] of snapshot()) last.set(name, v.text);
  const off = o.registry.watch(() => {
    for (const [name, v] of snapshot()) {
      if (last.get(name) === v.text) continue;
      last.set(name, v.text);
      if (timers.has(name)) continue;
      timers.set(name, setTimeout(() => {
        timers.delete(name);
        // The tree that declares the point when the notice goes, not when the first change came.
        const tree = snapshot().get(name)?.tree;
        if (tree === undefined) return;
        const readers = platform.get(name)?.readBy;
        for (const r of o.registry.list()) {
          if (!r.enabled || !RUNNING_STATES.has(r.state)) continue;
          // A platform point goes to the running plugins that may read it (their grants); any other to the declaring tree.
          if (readers !== undefined ? readers.some((c) => r.granted.includes(c)) : topPluginIdOf(r.id) === tree) changed(r.id, name);
        }
      }, ms));
    }
  });
  return () => {
    off();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
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
  // The reader runs (on and running, `grantsInForce`'s rule, as `settings.get` from a page): a turned-off plugin's
  // connection that is still open reads nothing, and calls no entry's handler.
  const readerRuns = (ctx: ApiCallContext) => {
    if (!contributorRuns(o.registry, ctx.pluginId)) throw new ContractError("refused", `${ctx.pluginId} isn't running, so it reads no point's entries`);
  };
  const entriesFor = (ctx: ApiCallContext, point: string): PointEntry[] => {
    readerRuns(ctx);
    return visibleEntries(o, platformPointFor(point, ctx.record.granted) ?? declaredPointFor(o.registry, point, ctx.pluginId));
  };
  /** `points.call`'s and `points.stream`'s checks: the point, its entry and the handler field's export. */
  const resolveCall = (ctx: ApiCallContext, args: readonly unknown[]) => {
    const point = stringArg(args, 0, "the point");
    const ref = args[1];
    if (!isObject(ref) || typeof ref.pluginId !== "string" || typeof ref.entryId !== "string") throw new ContractError("invalid", "points.call names an entry by { pluginId, entryId }");
    const field = stringArg(args, 2, "the field", 128);
    const opts = isObject(args[4]) ? args[4] : {};
    readerRuns(ctx);
    const decl = declaredPointFor(o.registry, point, ctx.pluginId);
    if (!handlerFields(decl.decl?.fields as Schema | undefined).includes(field)) {
      throw new ContractError("refused", `${field} isn't a handler field of ${point}`);
    }
    const entry = o.registry.entries(point).find((c) => c.state === "active" && contributorRuns(o.registry, c.pluginId) && c.pluginId === ref.pluginId && pointEntryOf(c, undefined, o.assetUrl).entryId === ref.entryId);
    if (entry === undefined) throw new ContractError("not_installed", `${ref.pluginId} has no active entry ${ref.entryId} for ${point}`);
    const handler = isObject(entry.value) ? entry.value[field] : undefined;
    if (typeof handler !== "string") throw new ContractError("not_installed", `${ref.pluginId}'s entry names no ${field}`);
    return { entry, handler, opts, point, field };
  };
  const activeFor = (ctx: ApiCallContext, point: string): ActiveFiller | undefined => {
    readerRuns(ctx);
    mayReadActive(o.registry, point, ctx.pluginId);
    const a = activeOne(o.registry, point)?.active;
    return a === undefined ? undefined : refOf(a);
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
    "points.active": (ctx, args) => activeFor(ctx, stringArg(args, 0, "the point")),
    "points.onActive": (ctx, args): Unsubscribe => {
      const point = stringArg(args, 0, "the point");
      const listener = listenerArg<ActiveFiller | undefined>(args, 1);
      let last = JSON.stringify(activeFor(ctx, point) ?? null);
      return o.registry.watch(() => {
        let now: ActiveFiller | undefined;
        try {
          now = activeFor(ctx, point);
        } catch {
          now = undefined; // the point or the reader went: nothing is active for it
        }
        const text = JSON.stringify(now ?? null);
        if (text === last) return;
        last = text;
        listener(now);
      });
    },
    "points.call": async (ctx, args) => {
      const { entry, handler, opts } = resolveCall(ctx, args);
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
    // `points.stream`: the same entry, field and checks as `points.call`, but the handler answers with a stream. The
    // caller's watch is the stream's reader; the handler is told the stream's id and its host half writes what the
    // handler returns (bytes, an async iterable or a ReadableStream of bytes) into it (the runtime's pump). The stream
    // ending any way but the writer's own end cancels the handler's call.
    "points.stream": (ctx, args) => {
      const hub = o.streams;
      if (hub === undefined) throw new ContractError("refused", "points.stream is not served on this computer");
      const listener = listenerArg<StreamEvent>(args, 5);
      const { entry, handler, opts, point, field } = resolveCall(ctx, args);
      const abort = new AbortController();
      const opened = hub.openPoint(
        { pluginId: ctx.pluginId, side: ctx.process, listener },
        { pluginId: entry.pluginId, onAbort: (reason) => abort.abort(new ContractError("cancelled", reason)) },
        `${point}/${field}`,
      );
      const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, STREAM_POINT_TIMEOUT_MAX_MS) : STREAM_POINT_TIMEOUT_MAX_MS;
      o.host.invoke({
        pluginId: entry.pluginId,
        handler,
        ...(typeof opts.method === "string" ? { method: opts.method } : {}),
        args: args[3],
        caller: ctx.caller,
        ...(ctx.caller.kind === "session" ? { session: ctx.caller.sessionId } : {}),
        timeoutMs,
        ownLimit: true,
        streamId: opened.id,
        signal: abort.signal,
      }).then(
        // The handler's call is over: its pump ended the stream, or it didn't, and the stream is cancelled.
        () => hub.producerFinished(opened.id),
        (err: unknown) => hub.producerFinished(opened.id, `the handler failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)),
      );
      return opened.stop;
    },
  };
}
