// What the palette and Settings read of the registry (spec §5.4 "Commands", §5.3, §6.8): `command.list`, the plugin
// API's `commands.list`, and `point.list`.
//
// * `command.list`: every active command, as `<namespace>.<name>` (the registry's entry id), its plugin, description,
//   `args` schema, default key and `runsOn`, in the registry's order (the synced list's).
// * `point.list`: the core's points (the plugin SDK's `CORE_POINTS`, declared by `core`) and every point a plugin
//   declares, with its declaring entry, its occupants (active entries) and its waiting ones. A second declarer of a
//   point that isn't a UI spot is listed too, inactive, so Settings can offer the choice (§5.4).
import { CORE_POINTS, WELL_KNOWN_POINT_NAMES, resolveKeys } from "@waifucave/clover-plugin-sdk";
import { PLUGINS_METHODS, type Caller, type CommandView, type PointView } from "@waifucave/clover-protocol";
import type { Contribution, PluginRegistry } from "../contracts/plugin-registry";
import { CORE_SPOTS } from "../contracts/plugin-registry";
import { handler, type MethodHandler } from "../rpc/handler";
import type { ApiHandlers } from "../plugin-host/api/router";
import { mayRunCommand, registryCommand, runCommand } from "../registry/commands";
import type { PluginHost } from "../contracts/plugin-host";
import { grantsInForce } from "../contracts/plugin-registry";
import { ContractError } from "../contracts/common";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The active commands, for the palette. */
export function commandViews(registry: Pick<PluginRegistry, "entries">, platform: NodeJS.Platform = process.platform): CommandView[] {
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
  // What each key comes to (the app's chords win; a chord two commands name binds neither): the one resolver main binds by.
  const states = resolveKeys(out, platform);
  return out.map((c) => (states.has(c.name) ? { ...c, keyState: states.get(c.name)! } : c));
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

/** `commands.list` in the plugin API: only what the calling plugin may run (`mayRunCommand`): its own tree's
 *  commands, and those of each plugin its OK grants `call:` for. */
/** `commands.list`, and with a host `commands.run` (§5.4): a plugin runs its own tree's commands, and another plugin's
 *  with `call:<its top-level id>` on its OK, which the router has checked before this runs (the command's plugin found
 *  by its namespace). The run is `command.run`'s own (`runCommand`): the command's `args` checked against its schema
 *  first, then its handler, told the plugin as its caller (or the session whose tool call it serves, R7; never the user).
 *  The answer is the handler's result itself. */
export function commandsApi(registry: Pick<PluginRegistry, "entries"> & Partial<Pick<PluginRegistry, "get">>, host?: Pick<PluginHost, "invoke">): ApiHandlers {
  return {
    "commands.list": (ctx) => commandViews(registry).filter((c) => mayRunCommand({ kind: "plugin", pluginId: ctx.pluginId }, c.pluginId, ctx.record.granted)),
    ...(host === undefined ? {} : {
      "commands.run": async (ctx, args) => {
        const name = args[0];
        if (typeof name !== "string" || name === "" || name.length > 256) throw new ContractError("invalid", "commands.run takes the command's full name");
        // The plugin's own right, whatever caller it acts for: its tree's commands, or `call:` on its OK.
        const command = registryCommand(registry, name);
        if (command === undefined) throw new ContractError("not_installed", `no command ${name}`);
        if (!mayRunCommand({ kind: "plugin", pluginId: ctx.pluginId }, command.pluginId, ctx.record.granted)) {
          throw new ContractError("refused", `${name} is ${command.pluginId.split("/")[0]}'s: running it needs the capability call:${command.pluginId.split("/")[0]}, which ${ctx.pluginId}'s OK doesn't list`);
        }
        // Who the command's handler hears: the session whose tool call the plugin is serving (R7), else the plugin
        // itself. Never the user: a call a plugin makes while it serves the user's own call (a button in its page, the
        // palette) is still the plugin's, so another plugin's handler can't take it for the user's.
        const as: Caller = ctx.caller.kind === "session" ? ctx.caller : { kind: "plugin", pluginId: ctx.pluginId };
        const out = await runCommand({ find: (n) => registryCommand(registry, n), host, grantedOf: (id) => grantsInForce(registry.get?.(id)) }, { name, ...(args[1] === undefined ? {} : { args: args[1] }) }, as);
        return out.result;
      },
    }),
  };
}

/** `command.list` and `point.list` on the user's connections. */
export function commandListMethods(registry: Pick<PluginRegistry, "entries" | "points">): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  return {
    [M.commandList.name]: handler(M.commandList, () => ({ commands: commandViews(registry) })),
    [M.pointList.name]: handler(M.pointList, () => ({ points: pointViews(registry) })),
  };
}
