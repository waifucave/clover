// The app's and the CLI's plugin methods (`plugin.*`, spec §5.1, §5.6): the registry's records as the protocol's views,
// the user's switch, restart and logs, the adult confirmation, development folders and removing a plugin.
//
// `plugin.install` installs from a folder on disk (`install-folder.ts`), and `plugin.dev.add` from the app raises its
// sealed card (a sensitive change; in the user's own terminal it applies).
//
// Not served here yet, each refused with why (and listed in the PR): `plugin.install` from an index, npm or a wrapped
// item, `plugin.update` and `plugin.index.*` (no index client or npm installer on main), `plugin.pin`,
// `plugin.setScope` and `plugin.setComputers` (the synced plugin list that holds them isn't on main),
// `plugin.renameFolder` (a found folder is named by its manifest's id today), and `plugin.setEnabled`'s `bots` (a
// plugin's `when.bot` override).
// `plugin.auth.*` are lane A's.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PLUGINS_METHODS, PluginDetail, PluginSummary } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import type { OpenedRegistry } from "../registry/open";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { pluginPath } from "./paths";
import { installFromFolder, installStagingDir } from "../registry/install-folder";
import type { CardOpener } from "../devices/rpc";
import { realpathSync, statSync } from "node:fs";
import { PluginSecretFiles } from "../registry/secret-files";

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

/** A development folder's real path, checked before its card is raised: the card names what will load. */
function devFolderCheck(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new ContractError("invalid", `${path} doesn't exist`);
  }
  if (!statSync(real).isDirectory() || !existsSync(join(real, "clover.json"))) throw new ContractError("invalid", `${real} has no clover.json`);
  return real;
}

const notServed = (what: string, why: string): never => {
  throw new ContractError("refused", `${what} isn't served on this computer yet: ${why}`);
};

/** What removing a plugin leaves behind, and where (#332's review): its secrets, its settings file and its synced store
 *  are deleted, for it and each of its children, so a later plugin installed under the same id inherits none of them.
 *  Its data folder is kept, as the spec says (§5.4), but moved out of the id's path to
 *  `<home>/plugin-data/.removed/<id>/<when>-<tree hash>/`, keyed to that install, so another publisher's plugin with
 *  the same id starts with an empty one. No plugin id starts with a dot. */
export async function forgetRemovedPlugin(o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; record: PluginRecord; children: readonly string[]; now?: () => number }): Promise<{ dataKeptAt?: string }> {
  const ids = [o.record.id, ...o.children];
  for (const pluginId of ids) {
    if (o.secrets !== undefined) for (const meta of await o.secrets.list({ kind: "plugin", pluginId })) await o.secrets.delete(meta.ref);
    rmSync(`${pluginPath(join(o.home, "settings", "plugins"), pluginId)}.json`, { force: true });
    rmSync(`${pluginPath(join(o.home, "settings", "plugin-stores"), pluginId)}.json`, { force: true });
  }
  // Its secrets' files (`${secretFile:…}`) go with it.
  new PluginSecretFiles(o.home).releasePlugin(o.record.id);
  const data = pluginPath(join(o.home, "plugin-data"), o.record.id);
  if (!existsSync(data)) return {};
  const hash = (o.record.okHash ?? o.record.treeHash ?? "unknown").replace(/^sha256:/, "").slice(0, 16);
  const kept = join(o.home, "plugin-data", ".removed", ...o.record.id.split("/"), `${new Date(o.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-")}-${hash}`);
  mkdirSync(join(kept, ".."), { recursive: true, mode: 0o700 });
  renameSync(data, kept);
  writeFileSync(join(kept, ".clover-removed.json"), JSON.stringify({ id: o.record.id, source: o.record.source, treeHash: o.record.treeHash, okHash: o.record.okHash, provenance: o.record.provenance, removedAt: o.now?.() ?? Date.now() }), { mode: 0o600 });
  return { dataKeptAt: kept };
}

export function pluginRegistryMethods(o: {
  opened: OpenedRegistry;
  host: Pick<PluginHost, "restart">;
  home: string;
  secrets?: Pick<SecretStore, "list" | "delete">;
  /** Raises a sensitive change's sealed card (lane C's broker, `brokerCardOpener`): a development folder added from
   *  the app waits for it. Absent until the daemon's broker is wired, when adding one from the app is refused. */
  openCard?: CardOpener;
  os?: "macos" | "windows" | "linux";
}): Record<string, MethodHandler> {
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
    [M.pluginSetEnabled.name]: handler(M.pluginSetEnabled, async ({ id, enabled, bots }, ctx) => {
      requireUser(ctx, "switch a plugin on or off");
      if (bots !== undefined) notServed("choosing the bots a plugin dresses", "a plugin's `when.bot` override isn't kept yet");
      must(id);
      return registry.setEnabled(id, enabled);
    }),
    [M.pluginRestart.name]: handler(M.pluginRestart, async ({ id }, ctx) => {
      requireUser(ctx, "restart a plugin");
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
      const children = registry.list().filter((c) => c.parent === r.id).map((c) => c.id);
      // What it leaves goes first: a secret that can't be deleted stops the removal, so no later plugin under the same
      // id finds it (#332's second review).
      await forgetRemovedPlugin({ home: o.home, ...(o.secrets !== undefined ? { secrets: o.secrets } : {}), record: r, children });
      rmSync(folder, { recursive: true, force: true });
      await folders.refresh(folder);
      return { ok: true as const };
    }),
    [M.pluginDevList.name]: handler(M.pluginDevList, () => ({ folders: folders.devFolders().map(devView) })),
    [M.pluginDevAdd.name]: handler(M.pluginDevAdd, async ({ path }, ctx) => {
      const user = requireUser(ctx, "add a development folder");
      // In the user's own terminal it applies (§5.6); from the app it's a sensitive change, behind its sealed card.
      if (user.client === "cli") {
        await folders.addDevFolder(path, "cli");
        return { applied: true as const };
      }
      if (o.openCard === undefined) notServed("adding a development folder from the app", "this computer's approval broker isn't running; `clover plugin dev <folder>` in your terminal adds it");
      const checked = devFolderCheck(path);
      const opened = await o.openCard!({
        kind: "change", origin: "user", computers: [], effect: "other", change: "dev-folder",
        fields: {
          title: { type: "text", text: "Load a plugin you're developing?" },
          detail: { type: "list", items: [checked, "Its code runs on this computer as it is, reloading when it changes, for 24 hours unless you renew it."] },
        },
      });
      void opened.allowed.then(async (yes) => {
        if (yes) await folders.addDevFolder(checked, "app");
      }).catch(() => undefined);
      if (opened.card === undefined) {
        if (!(await opened.allowed)) throw new ContractError("refused", "the development folder wasn't added");
        return { applied: true as const };
      }
      return { applied: false as const, card: opened.card };
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
    // From a folder on disk (the app's "install from folder", the terminal): copied in, validated, found, and its sealed
    // OK card raised at once (§5.1). The index and npm wait for their clients.
    [M.pluginInstall.name]: handler(M.pluginInstall, async ({ source }, ctx) => {
      const user = requireUser(ctx, "install a plugin");
      if (source.from !== "folder") notServed(`installing from ${source.from === "index" ? "a plugin index" : source.from === "npm" ? "npm" : "a wrapped item"}`, "only a folder on disk installs for now");
      const src = source as { from: "folder"; path: string };
      const { id, treeHash } = await installFromFolder({
        source: src.path, pluginsDir: join(o.home, "plugins"), stagingDir: installStagingDir(o.home),
        ...(o.os ? { os: o.os } : {}),
        taken: (pluginId) => registry.get(pluginId) !== undefined,
      });
      await folders.installed(id, user.client === "cli" ? "user-terminal" : "user-app");
      const r = registry.get(id);
      if (r === undefined) throw new ContractError("failed", `${id} was copied in but isn't found; its folder is ${join(o.home, "plugins", id)}`);
      const raised = await registry.installed(id, user.client === "cli" ? "cli" : "app");
      return { id: id as never, state: raised.state, treeHash, ...(raised.card !== undefined ? { card: raised.card } : {}) };
    }),
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
