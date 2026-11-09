// What the palette and Settings read of the registry (spec §5.4 "Commands", §5.3, §6.8): `command.list`, the plugin
// API's `commands.list`, and `point.list`.
//
// * `command.list`: every active command, as `<namespace>.<name>` (the registry's entry id), its plugin, description,
//   `args` schema, default key and `runsOn`, in the registry's order (the synced list's).
// * `point.list`: the core's points (the plugin SDK's `CORE_POINTS`, declared by `core`) and every point a plugin
//   declares, with its declaring entry, its occupants (active entries) and its waiting ones. A second declarer of a
//   point that isn't a UI spot is listed too, inactive, so Settings can offer the choice (§5.4).
import { CORE_POINTS, WELL_KNOWN_POINT_NAMES } from "@waifucave/clover-plugin-sdk";
import { PLUGINS_METHODS, type CommandView, type PointView } from "@waifucave/clover-protocol";
import type { Contribution, PluginRegistry } from "../contracts/plugin-registry";
import { CORE_SPOTS } from "../contracts/plugin-registry";
import { handler, type MethodHandler } from "../rpc/handler";
import type { ApiHandlers } from "../plugin-host/api/router";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The active commands, for the palette. */
export function commandViews(registry: Pick<PluginRegistry, "entries">): CommandView[] {
  const out: CommandView[] = [];
  for (const c of registry.entries("commands")) {
    if (c.state !== "active" || c.entryId === undefined || !isObject(c.value)) continue;
    const v = c.value;
    out.push({
      name: c.entryId,
      pluginId: c.pluginId,
      description: v.description as CommandView["description"],
      ...(isObject(v.args) ? { args: v.args } : {}),
      ...(typeof v.key === "string" ? { key: v.key } : {}),
      ...(v.runsOn === "each" || v.runsOn === "main" || v.runsOn === "chosen" ? { runsOn: v.runsOn } : {}),
    });
  }
  return out;
}

/** The top-level plugin whose namespace starts a command's name (`<namespace>.<name>`), when it is installed and
 *  active: `commands.run`'s target for its `call:` check. */
export function commandOwner(registry: Pick<PluginRegistry, "entries">, name: string): string | undefined {
  const c = registry.entries("commands").find((e) => e.state === "active" && e.entryId === name);
  return c === undefined ? undefined : c.pluginId.split("/")[0];
}

const refOf = (c: Contribution) => ({ pluginId: c.pluginId, entry: c.ref });

/** Every point, the core's first. */
export function pointViews(registry: Pick<PluginRegistry, "entries" | "points">): PointView[] {
  const pointOf = (c: Contribution): string => (c.point === "ui" && isObject(c.value) && typeof c.value.spot === "string" ? c.value.spot : c.point);
  const all = new Map<string, Contribution[]>();
  const add = (name: string, c: Contribution) => all.set(name, [...(all.get(name) ?? []), c]);
  const declared = registry.points();
  for (const name of new Set([...CORE_POINTS.map((p) => p.name), ...declared.map((p) => p.name)])) {
    for (const c of registry.entries(name)) add(name, c);
  }
  for (const c of registry.entries("ui")) add(pointOf(c), c);
  const listed = (name: string) => {
    const cs = all.get(name) ?? [];
    return { occupants: cs.filter((c) => c.state === "active").map(refOf), waiting: cs.filter((c) => c.state === "waiting").map(refOf) };
  };
  const out: PointView[] = [];
  for (const p of CORE_POINTS) {
    out.push({ name: p.name, shape: p.shape, declaredBy: "core", spot: CORE_SPOTS.includes(p.name), ...listed(p.name), replacesShipped: false, private: false, doc: p.doc });
  }
  for (const p of declared) {
    const decl = p.decl;
    out.push({
      name: p.name,
      shape: p.shape,
      declaredBy: p.declaredBy === "core" ? "core" : { pluginId: p.declaredBy.pluginId, entry: p.declaredBy.ref },
      spot: p.spot,
      ...(isObject(decl?.fields) ? { fields: decl.fields } : {}),
      ...(isObject(decl?.props) ? { props: decl.props } : {}),
      ...(p.active ? listed(p.name) : { occupants: [], waiting: [] }),
      // Filling a point a bundled plugin declares, a well-known one, replaces UI Clover ships (§6.8).
      replacesShipped: WELL_KNOWN_POINT_NAMES.has(p.name) && p.declaredBy !== "core" && p.declaredBy.pluginId.split("/")[0] === "clover",
      private: decl?.private === true,
      ...(typeof decl?.deprecated === "string" ? { deprecated: decl.deprecated } : {}),
      ...(typeof decl?.doc === "string" ? { doc: decl.doc } : {}),
    });
  }
  return out;
}

/** `commands.list` in the plugin API. */
export function commandsApi(registry: Pick<PluginRegistry, "entries">): ApiHandlers {
  return { "commands.list": () => commandViews(registry) };
}

/** `command.list` and `point.list` on the user's connections. */
export function commandListMethods(registry: Pick<PluginRegistry, "entries" | "points">): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  return {
    [M.commandList.name]: handler(M.commandList, () => ({ commands: commandViews(registry) })),
    [M.pointList.name]: handler(M.pointList, () => ({ points: pointViews(registry) })),
  };
}
