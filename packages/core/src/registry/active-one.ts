// One at a time (spec §5.4 "One at a time"; the owner's general capability P4): a point, in the platform's catalog or
// declared by a plugin, may say `oneAtATime: true`, and then one of its entries is THE active one.
//
// * Its fillers are its active entries whose plugins are on and running (`grantsInForce`'s rule, as `points.entries`
//   reads them), in the registry's order (the synced list's, which is the order they were installed in).
// * The active one: the user's choice (Settings' picker, `point.active.set`; kept with the registry's records, the
//   registry's `chosen`), while that entry is a filler; else the default, the first bundled filler, else the first
//   installed. No plugin's own setting decides it, and no plugin call changes it.
// * The choice outlives its entry being off, stopped or crashed (it is the active one again when it runs again); a
//   plugin removed takes its choices with it (the registry's records forget them).
// * When the active one stops being a filler (turned off, removed, stopped), the next one takes over and the user is
//   told once, in words (`ActiveNotices`).
import { CORE_POINTS, oneAtATimeOf, type CorePointInfo } from "@waifucave/moss-plugin-sdk";
import { topPluginIdOf } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import { RUNNING_STATES, type Contribution, type PluginRegistry, type RegisteredPoint } from "../contracts/plugin-registry";

/** An entry of a point by its plugin and entry id: what a choice names, and what `points.active` answers. */
export interface ActiveRef {
  pluginId: string;
  entryId: string;
}

export type ActiveRegistry = Pick<PluginRegistry, "points" | "entries"> & Partial<Pick<PluginRegistry, "get" | "chosen">>;

/** A one-at-a-time point now: its fillers, the one active, and the user's choice when they made one. */
export interface OneAtATime {
  point: RegisteredPoint;
  /** The point's own title (its declaration's, or the catalog's), for Settings' picker. */
  title: string | { en: string; [lang: string]: string };
  fillers: Contribution[];
  active?: Contribution;
  chosen?: ActiveRef;
}

/** An entry's id as the plugin API names it (`PointEntry.entryId`): its `id`, or its index in the contributing list. */
export const entryIdOf = (c: Contribution): string => c.entryId ?? c.ref.slice(c.ref.lastIndexOf("/") + 1);

export const refOf = (c: Contribution): ActiveRef => ({ pluginId: c.pluginId, entryId: entryIdOf(c) });

const same = (c: Contribution, r: ActiveRef | undefined): boolean => r !== undefined && c.pluginId === r.pluginId && entryIdOf(c) === r.entryId;

/** Whether a contributor's entries count now: it is on and running. A registry with no records (a test's) counts every
 *  active entry. */
function runs(registry: ActiveRegistry, pluginId: string): boolean {
  if (registry.get === undefined) return true;
  const r = registry.get(pluginId);
  return r !== undefined && r.enabled && RUNNING_STATES.has(r.state);
}

/** A core point that takes one filler at a time (`CORE_POINTS[].oneAtATime`), as a registered point: the registry
 *  lists only the points plugins declare, and a core point is the core's, always there. */
export function coreOneAtATime(name: string, catalog: readonly CorePointInfo[] = CORE_POINTS): RegisteredPoint | undefined {
  const c = catalog.find((p) => p.name === name && p.oneAtATime === true);
  return c === undefined ? undefined : { name: c.name, shape: c.shape, declaredBy: "core", spot: false, active: true };
}

/** The declaration of `name` that is in force, when it takes one filler at a time. */
export function oneAtATimePoint(registry: Pick<PluginRegistry, "points">, name: string, catalog: readonly CorePointInfo[] = CORE_POINTS): RegisteredPoint | undefined {
  const core = coreOneAtATime(name, catalog);
  if (core !== undefined) return core;
  const p = registry.points().find((x) => x.name === name && x.active);
  return p !== undefined && p.declaredBy !== "core" && oneAtATimeOf(p.name, p.decl) !== undefined ? p : undefined;
}

/** A one-at-a-time point as it is now, or undefined when `name` isn't one (or isn't declared here). */
export function activeOne(registry: ActiveRegistry, name: string, catalog: readonly CorePointInfo[] = CORE_POINTS): OneAtATime | undefined {
  const point = oneAtATimePoint(registry, name, catalog);
  if (point === undefined) return undefined;
  const fillers = registry.entries(name).filter((c) => c.state === "active" && runs(registry, c.pluginId));
  const chosen = registry.chosen?.(name);
  const active = fillers.find((c) => same(c, chosen))
    ?? fillers.find((c) => registry.get?.(c.pluginId)?.source === "bundled")
    ?? fillers[0];
  return {
    point,
    title: point.declaredBy === "core" ? (catalog.find((p) => p.name === point.name)?.title ?? point.name) : oneAtATimeOf(point.name, point.decl)!.title,
    fillers,
    ...(active !== undefined ? { active } : {}),
    ...(chosen !== undefined ? { chosen } : {}),
  };
}

/** Every one-at-a-time point here now: the core's (the catalog's order), then those plugins declare (the registry's). */
export function oneAtATimePoints(registry: ActiveRegistry, catalog: readonly CorePointInfo[] = CORE_POINTS): OneAtATime[] {
  const out: OneAtATime[] = [];
  for (const name of [...catalog.filter((p) => p.oneAtATime === true).map((p) => p.name), ...registry.points().filter((p) => p.active).map((p) => p.name)]) {
    if (out.some((o) => o.point.name === name)) continue;
    const one = activeOne(registry, name, catalog);
    if (one !== undefined) out.push(one);
  }
  return out;
}

/** Whether `pluginId` may read which entry of `name` is active: its declarer's tree, or a plugin of a tree with an entry
 *  in it (a filler learns whether it is the one). The core reads the core's points itself. */
export function mayReadActive(registry: Pick<PluginRegistry, "points" | "entries">, name: string, pluginId: string, catalog: readonly CorePointInfo[] = CORE_POINTS): RegisteredPoint {
  const p = coreOneAtATime(name, catalog) ?? registry.points().find((x) => x.name === name && x.active);
  if (p === undefined) throw new ContractError("not_found", `no plugin declares ${name} here`);
  if (p.declaredBy !== "core" && oneAtATimeOf(p.name, p.decl) === undefined) throw new ContractError("refused", `${name} doesn't take one filler at a time, so no entry of it is the active one`);
  const tree = topPluginIdOf(pluginId);
  if (p.declaredBy !== "core" && topPluginIdOf(p.declaredBy.pluginId) === tree) return p;
  if (registry.entries(name).some((c) => c.state === "active" && topPluginIdOf(c.pluginId) === tree)) return p;
  throw new ContractError("refused", `only the plugin that declares ${name} and the plugins that fill it read which one is active`);
}

/** The user's choice, checked: `name` takes one filler at a time and `ref` is one of its fillers now. */
export function checkChoice(registry: ActiveRegistry, name: string, ref: ActiveRef): OneAtATime {
  const one = activeOne(registry, name);
  if (one === undefined) throw new ContractError("not_found", `${name} isn't a point that takes one filler at a time here`);
  if (!one.fillers.some((c) => same(c, ref))) throw new ContractError("not_found", `${ref.pluginId} has no entry ${ref.entryId} running for ${name}`);
  return one;
}

/** A filler's name for the user: its entry's own `name` or `title` (English, or the only text), else its plugin's. */
export function fillerName(registry: ActiveRegistry, c: Contribution): string {
  const v = c.value as { name?: unknown; title?: unknown } | undefined;
  for (const t of [v?.name, v?.title]) {
    if (typeof t === "string" && t.trim() !== "") return t.trim().slice(0, 200);
    if (typeof t === "object" && t !== null && typeof (t as { en?: unknown }).en === "string") return ((t as { en: string }).en).slice(0, 200);
  }
  const n = registry.get?.(c.pluginId)?.name;
  return typeof n === "string" && n !== "" ? n.slice(0, 200) : c.pluginId;
}

export const titleText = (t: string | { en: string }): string => (typeof t === "string" ? t : t.en);

/** Tells the user, once, when a one-at-a-time point's active entry stops being a filler (turned off, removed, stopped)
 *  and another takes over, or none is left. Never at the start (nothing was active before), and never for the user's
 *  own choice. */
export class ActiveNotices {
  readonly #last = new Map<string, { ref?: ActiveRef; name?: string }>();
  readonly #off: () => void;

  constructor(private readonly o: {
    registry: ActiveRegistry & Pick<PluginRegistry, "watch">;
    tell(point: RegisteredPoint, title: string, text: string): void;
  }) {
    for (const one of oneAtATimePoints(o.registry)) this.#last.set(one.point.name, this.#seen(one));
    this.#off = o.registry.watch(() => this.#check());
  }

  #seen(one: OneAtATime): { ref?: ActiveRef; name?: string } {
    return one.active === undefined ? {} : { ref: refOf(one.active), name: fillerName(this.o.registry, one.active) };
  }

  #check(): void {
    const now = oneAtATimePoints(this.o.registry);
    for (const one of now) {
      const was = this.#last.get(one.point.name);
      const seen = this.#seen(one);
      this.#last.set(one.point.name, seen);
      if (was?.ref === undefined || (seen.ref !== undefined && seen.ref.pluginId === was.ref.pluginId && seen.ref.entryId === was.ref.entryId)) continue;
      // The one that was active is still a filler: the user chose another, or a choice came back. Nothing to say.
      if (one.fillers.some((c) => same(c, was.ref))) continue;
      const title = titleText(one.title);
      this.o.tell(one.point, title, seen.name === undefined
        ? `${was.name} isn't running, and nothing else fills ${title} for now.`
        : `${was.name} isn't running, so ${seen.name} takes its place for now.`);
    }
    for (const name of [...this.#last.keys()]) if (!now.some((o) => o.point.name === name)) this.#last.delete(name);
  }

  close(): void {
    this.#off();
  }
}
