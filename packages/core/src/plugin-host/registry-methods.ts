// The app's and the CLI's plugin methods (`plugin.*`, spec §5.1, §5.6): the registry's records as the protocol's views,
// the user's switch, restart and logs, the adult confirmation, development folders and removing a plugin.
//
// Not served here yet, each refused with why (and listed in the PR): `plugin.install`, `plugin.update` and
// `plugin.index.*` (no index client or npm installer on main), `plugin.pin`, `plugin.setScope` and
// `plugin.setComputers` (the synced plugin list that holds them isn't on main), `plugin.renameFolder` (a found folder
// is named by its manifest's id today), `plugin.setEnabled`'s `bots` (a plugin's `when.bot` override), and
// `plugin.dev.add` from the app (a sensitive change: it waits for the approval broker's card, C-M3; the CLI's applies).
// `plugin.auth.*` are lane A's.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PLUGINS_METHODS, PluginDetail, PluginSummary } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { OpenedRegistry } from "../registry/open";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { pluginPath } from "./paths";

/** The last `n` lines of a plugin's log (`<home>/logs/plugins/<id>.log`). */
export function pluginLogTail(home: string, pluginId: string, n: number): string[] {
  let text: string;
  try {
    text = readFileSync(`${pluginPath(join(home, "logs", "plugins"), pluginId)}.log`, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l !== "");
  return lines.slice(Math.max(0, lines.length - n)).map((l) => l.slice(0, 4000));
}

function summaryOf(r: PluginRecord): PluginSummary {
  return PluginSummary.parse(r);
}

function detailOf(r: PluginRecord, home: string): PluginDetail {
  const manifest = (r.manifest ?? {}) as Record<string, unknown>;
  const helper = (manifest.helper ?? {}) as { permissions?: string[] };
  return PluginDetail.parse({
    ...summaryOf(r),
    manifest,
    provenance: r.provenance,
    capabilities: [...r.granted],
    networkHosts: r.granted.filter((c) => c.startsWith("network:")).map((c) => c.slice("network:".length)).filter((h) => h !== ""),
    helperPermissions: [...(helper.permissions ?? [])],
    issues: [...r.issues],
    logTail: pluginLogTail(home, r.id, 200),
    pinned: false,
  });
}

const notServed = (what: string, why: string): never => {
  throw new ContractError("refused", `${what} isn't served on this computer yet: ${why}`);
};

export function pluginRegistryMethods(o: { opened: OpenedRegistry; host: Pick<PluginHost, "restart">; home: string }): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  const { registry, folders } = o.opened;
  const must = (id: string): PluginRecord => {
    const r = registry.get(id);
    if (r === undefined) throw new ContractError("not_found", `${id} isn't installed`);
    return r;
  };
  const devView = (d: { path: string; addedAt: number; expiresAt: number }): { path: string; addedAt: number; expiresAt: number; pluginId?: string } => {
    const plugin = registry.list().find((r) => r.dev && resolve(r.folder) === resolve(d.path));
    return { path: d.path, addedAt: d.addedAt, expiresAt: d.expiresAt, ...(plugin !== undefined ? { pluginId: plugin.id } : {}) };
  };
  return {
    [M.pluginList.name]: handler(M.pluginList, () => ({ plugins: registry.list().map(summaryOf), adultConfirmed: registry.adultConfirmed })),
    [M.pluginGet.name]: handler(M.pluginGet, ({ id }) => ({ plugin: detailOf(must(id), o.home) })),
    [M.pluginSetEnabled.name]: handler(M.pluginSetEnabled, async ({ id, enabled, bots }) => {
      if (bots !== undefined) notServed("choosing the bots a plugin dresses", "a plugin's `when.bot` override isn't kept yet");
      must(id);
      return registry.setEnabled(id, enabled);
    }),
    [M.pluginRestart.name]: handler(M.pluginRestart, async ({ id }) => {
      must(id);
      await o.host.restart(id);
      return { ok: true as const };
    }),
    [M.pluginLogs.name]: handler(M.pluginLogs, ({ id, lines }) => {
      must(id);
      return { lines: pluginLogTail(o.home, id, lines ?? 200) };
    }),
    [M.pluginConfirmAdult.name]: handler(M.pluginConfirmAdult, (_p, ctx) => {
      requireUser(ctx, "confirm their age");
      registry.confirmAdult();
      return { ok: true as const };
    }),
    // Removing deletes a plugin's folder from the plugins directory; a bundled or development plugin isn't removed here.
    [M.pluginRemove.name]: handler(M.pluginRemove, async ({ id }, ctx) => {
      requireUser(ctx, "remove a plugin");
      const r = must(id);
      if (r.source === "bundled") throw new ContractError("refused", `${id} comes with Clover; switch it off instead`);
      if (r.dev) throw new ContractError("refused", `${id} is a development folder; remove the folder from development instead`);
      const pluginsDir = resolve(join(o.home, "plugins"));
      const folder = resolve(r.folder);
      if (!folder.startsWith(pluginsDir + sep) || !existsSync(folder)) throw new ContractError("refused", `${id}'s folder isn't in the plugins directory`);
      rmSync(folder, { recursive: true, force: true });
      await folders.refresh(folder);
      return { ok: true as const };
    }),
    [M.pluginDevList.name]: handler(M.pluginDevList, () => ({ folders: folders.devFolders().map(devView) })),
    [M.pluginDevAdd.name]: handler(M.pluginDevAdd, async ({ path }, ctx) => {
      const user = requireUser(ctx, "add a development folder");
      if (user.client !== "cli") notServed("adding a development folder from the app", "it waits for the approval broker's card (C-M3); `clover plugin dev add` applies it");
      await folders.addDevFolder(path, "cli");
      return { applied: true as const };
    }),
    [M.pluginDevRemove.name]: handler(M.pluginDevRemove, async ({ path }, ctx) => {
      requireUser(ctx, "remove a development folder");
      await folders.removeDevFolder(path);
      return { ok: true as const };
    }),
    [M.pluginDevRenew.name]: handler(M.pluginDevRenew, async ({ path }, ctx) => {
      requireUser(ctx, "renew a development folder");
      return { expiresAt: await folders.renewDevFolder(path) };
    }),
    [M.pluginInstall.name]: handler(M.pluginInstall, () => notServed("plugin.install", "the index client and npm installer aren't on main")),
    [M.pluginUpdate.name]: handler(M.pluginUpdate, () => notServed("plugin.update", "the index client isn't on main")),
    [M.pluginIndexList.name]: handler(M.pluginIndexList, () => ({ indexes: [] })),
    [M.pluginIndexSearch.name]: handler(M.pluginIndexSearch, () => ({ entries: [] })),
    [M.pluginIndexAdd.name]: handler(M.pluginIndexAdd, () => notServed("plugin.index.add", "the index client isn't on main")),
    [M.pluginIndexRemove.name]: handler(M.pluginIndexRemove, () => notServed("plugin.index.remove", "the index client isn't on main")),
    [M.pluginPin.name]: handler(M.pluginPin, () => notServed("plugin.pin", "the synced plugin list isn't on main")),
    [M.pluginSetScope.name]: handler(M.pluginSetScope, () => notServed("plugin.setScope", "the synced plugin list isn't on main")),
    [M.pluginSetComputers.name]: handler(M.pluginSetComputers, () => notServed("plugin.setComputers", "the synced plugin list isn't on main")),
    [M.pluginRenameFolder.name]: handler(M.pluginRenameFolder, () => notServed("plugin.renameFolder", "a found folder is named by its manifest's id")),
  };
}

/** The plugin methods' names, registered from the daemon's start so a call before the registry opens gets an answer:
 *  the lists are empty until then, and anything else is refused while it opens. */
export const PLUGIN_METHOD_NAMES: readonly string[] = [
  "plugin.list", "plugin.get", "plugin.setEnabled", "plugin.setScope", "plugin.setComputers", "plugin.restart", "plugin.logs",
  "plugin.settings.get", "plugin.settings.set", "plugin.install", "plugin.remove", "plugin.update", "plugin.pin",
  "plugin.renameFolder", "plugin.confirmAdult", "plugin.dev.list", "plugin.dev.add", "plugin.dev.remove", "plugin.dev.renew",
  "plugin.index.list", "plugin.index.add", "plugin.index.remove", "plugin.index.search", "point.list", "command.list",
  "command.run", "glossary.query", "plugin.ui", "plugin.layer.api",
];

/** What a method answers before the registry opens. */
export function beforePluginsOpen(method: string): unknown {
  if (method === "plugin.list") return { plugins: [], adultConfirmed: false };
  // The app re-reads `plugin.ui` on the nudge the registry's opening sends.
  if (method === "plugin.ui") return { plugins: [] };
  if (method === "plugin.dev.list") return { folders: [] };
  if (method === "plugin.index.list") return { indexes: [] };
  if (method === "plugin.index.search") return { entries: [] };
  if (method === "point.list") return { points: [] };
  if (method === "command.list") return { commands: [] };
  throw new ContractError("refused", "the plugin registry is still opening; try again in a moment");
}
