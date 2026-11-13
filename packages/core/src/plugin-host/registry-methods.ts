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
import { CORE_VERSION } from "../version";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PLUGINS_METHODS, PluginDetail, PluginSummary, topPluginIdOf, type PluginProvenance } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import type { OpenedRegistry } from "../registry/open";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { pluginPath } from "./paths";
import { onCardYes } from "./card-yes";
import { manifestIconOf } from "./ui";
import { installFromFolder, installStagingDir } from "../registry/install-folder";
import { httpsUrl, type IndexClient } from "../registry/indexes/client";
import { installFromIndex } from "../registry/indexes/install";
import { installFromNpm } from "../registry/indexes/npm";
import type { PluginUpdater } from "../registry/indexes/update";
import { readReviewTree, REVIEW_CHANGED, type PluginReviews, type ReviewTree } from "../registry/plugin-review";
import { folderTreeHash } from "../registry/tree";
import { homedir } from "node:os";
import { installWrapped } from "../registry/wrap";
import { forgetRemovedPlugin } from "../registry/leftovers";
import { redactReadText } from "../computer-use/browser/http-read";
import { REDACTED } from "../computer-use/browser/page-runtime/redact";
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

/** A listed description's length, per language. */
const DESCRIPTION_MAX = 500;

export function summaryOf(r: PluginRecord): PluginSummary {
  // The bundled `clover` tree is the app itself: its version is the app's (the generated VERSION), not its manifests'
  // unset "0.0.0".
  const app = r.source === "bundled" && topPluginIdOf(r.id) === "clover" && (r.manifest as { version?: unknown } | undefined)?.version === undefined;
  // Its description only when it's text (a string, or a table with `en`), each language cut to DESCRIPTION_MAX: a
  // manifest that isn't valid lists still, and the list stays small (the page shows one line).
  const d = (r.manifest as { description?: unknown } | undefined)?.description;
  const description = typeof d === "string"
    ? d.slice(0, DESCRIPTION_MAX)
    : typeof d === "object" && d !== null && typeof (d as { en?: unknown }).en === "string" && Object.values(d).every((v) => typeof v === "string")
      ? Object.fromEntries(Object.entries(d as Record<string, string>).map(([k, v]) => [k, v.slice(0, DESCRIPTION_MAX)]))
      : undefined;
  // Its own icon (a top plugin's, from its manifest, a path inside its folder): the app serves it as a picture only.
  const icon = r.parent === undefined ? manifestIconOf(r.manifest) : undefined;
  return PluginSummary.parse({ ...r, ...(app ? { version: CORE_VERSION } : {}), ...(description !== undefined ? { description } : {}), ...(icon !== undefined ? { icon } : {}) });
}

function detailOf(r: PluginRecord, home: string, pinned = false): PluginDetail {
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
    pinned,
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

/** What a renew card's yes says when the folder's 24 hours ended while it waited. */
export const EXPIRED_DEV_FOLDER = "This folder's 24 hours had already ended; add it again from Plugins › Add.";

const notServed = (what: string, why: string): never => {
  throw new ContractError("refused", `${what} isn't served on this computer yet: ${why}`);
};

export { forgetRemovedPlugin } from "../registry/leftovers";

export function pluginRegistryMethods(o: {
  opened: OpenedRegistry;
  host: Pick<PluginHost, "restart">;
  home: string;
  /** The user's home (tests pass a temp one): a pasted server's own folders in it are opened to it (`wrap-reads.ts`). */
  userHome?: string;
  /** `set`: where a wrapped MCP config's keys go (absent, a config with keys isn't wrapped). */
  secrets?: Pick<SecretStore, "list" | "delete"> & Partial<Pick<SecretStore, "set">>;
  /** Raises a sensitive change's sealed card (lane C's broker, `brokerCardOpener`): a development folder added from
   *  the app waits for it. Absent until the daemon's broker is wired, when adding one from the app is refused. */
  openCard?: CardOpener;
  os?: "macos" | "windows" | "linux";
  /** The plugin indexes (§5.1); absent, there are none (the lists are empty and adding one is refused). */
  indexes?: IndexClient;
  /** Plugin updates (`registry/indexes/update.ts`), with the index client. */
  updater?: PluginUpdater;
  /** The Review on OK and update cards (`registry/plugin-review.ts`); absent, `plugin.review` isn't served. */
  reviews?: PluginReviews;
  /** The core's events (`plugin_card_note`). */
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  log?: (line: string) => void;
  /** The user restarted a plugin (`plugin.restart`): its builder may be told of its crash-stops again (crash-notice.ts). */
  onRestart?: (id: string) => void;
}): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  /** The plugins whose update card (from the Plugins page) is up, with the versions it names. */
  const updateCards = new Map<string, { from: string; to: string }>();
  /** The trees an update card is about, by card, as read when it was raised (the staged folder goes after): its Review
   *  reads this. */
  const updateTrees = new Map<string, { pluginId: string; treeHash: string; tree: ReviewTree }>();
  const { registry, folders } = o.opened;
  const onYes = (card: string | undefined, change: string, allowed: Promise<boolean>, apply: () => Promise<string | undefined> | string | undefined) =>
    onCardYes({ ...(o.emit ? { emit: o.emit } : {}), ...(o.log ? { log: o.log } : {}) }, card, change, allowed, apply);
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
    [M.pluginGet.name]: handler(M.pluginGet, ({ id }) => ({ plugin: detailOf(must(id), o.home, o.indexes?.isPinned(id) ?? false) })),
    [M.pluginSetEnabled.name]: handler(M.pluginSetEnabled, async ({ id, enabled, bots }, ctx) => {
      requireUser(ctx, "switch a plugin on or off");
      if (bots !== undefined) notServed("choosing the bots a plugin dresses", "a plugin's `when.bot` override isn't kept yet");
      must(id);
      return registry.setEnabled(id, enabled);
    }),
    [M.pluginRestart.name]: handler(M.pluginRestart, async ({ id }, ctx) => {
      requireUser(ctx, "restart a plugin");
      const r = must(id);
      // Only a plugin that may run: waiting for its OK, refused or off, a restart starts nothing (the host's
      // start already finds no startable record for it; this says so instead of marking it stopped).
      if (!["running", "waiting", "stopped"].includes(r.state)) throw new ContractError("refused", `${id} isn't running (${r.state}${r.reason !== undefined ? `: ${r.reason}` : ""}), so there's nothing to restart`);
      o.onRestart?.(id);
      await o.host.restart(id);
      return { ok: true as const };
    }),
    [M.pluginLogs.name]: handler(M.pluginLogs, ({ id, lines }) => {
      must(id);
      // Only this plugin's own file; a line that carries a key or a token (a URL's secret parts, a key-looking run) is
      // shown with it cut out ("…"), for every client.
      return { lines: pluginLogTail(o.home, id, lines ?? 200).map((l) => redactReadText(l).split(REDACTED).join("…")) };
    }),
    [M.pluginConfirmAdult.name]: handler(M.pluginConfirmAdult, (_p, ctx) => {
      requireUser(ctx, "confirm their age");
      registry.confirmAdult();
      return { ok: true as const };
    }),
    // Removing deletes a plugin's folder from the plugins directory; a bundled or development plugin isn't removed here.
    [M.pluginRemove.name]: handler(M.pluginRemove, async ({ id, card, deleteData }, ctx) => {
      requireUser(ctx, "remove a plugin");
      const r = must(id);
      if (r.source === "bundled") throw new ContractError("refused", `${id} comes with Clover; switch it off instead`);
      if (r.dev) throw new ContractError("refused", `${id} is a development folder; remove the folder from development instead`);
      const pluginsDir = resolve(join(o.home, "plugins"));
      const folder = resolve(r.folder);
      if (!folder.startsWith(pluginsDir + sep) || !existsSync(folder)) throw new ContractError("refused", `${id}'s folder isn't in the plugins directory`);
      const remove = async (): Promise<string | undefined> => {
        // The tree as it is when the user says yes (a card may wait).
        const now = registry.get(id);
        if (now === undefined) return "It was already removed.";
        const children = registry.list().filter((c) => c.parent === now.id).map((c) => c.id);
        // What it leaves goes first: a secret that can't be deleted stops the removal, so no later plugin under the same
        // id finds it (#332's second review).
        await forgetRemovedPlugin({ home: o.home, ...(o.secrets !== undefined ? { secrets: o.secrets } : {}), record: now, children, ...(deleteData === true ? { deleteData: true } : {}) });
        // This computer's record for the id goes too: a later install under it is never pinned.
        o.indexes?.setPinned(id, false);
        rmSync(folder, { recursive: true, force: true });
        await folders.refresh(folder);
        // Forgotten above: the folder's going leaves nothing to record, and no update of it comes back.
        o.opened.leftovers?.cleared(id);
        o.opened.updater?.forget(id);
        return undefined;
      };
      if (card !== true) {
        await remove();
        return { ok: true as const };
      }
      // From a part of the app's own tree (the controller's ruling): a part's page shows plugin-supplied text, so a click
      // there never deletes a plugin's keys by itself; only the yes on this sealed card does.
      if (o.openCard === undefined) notServed("removing a plugin from this page", "this computer's approval broker isn't running");
      const opened = await o.openCard!({
        kind: "change", origin: "user", computers: [], effect: "other", change: "plugin-remove",
        fields: {
          title: { type: "text", text: `Remove ${typeof r.name === "string" ? r.name : id}?` },
          detail: { type: "list", items: [
            deleteData === true ? "Its saved keys, settings and data on this computer are deleted, for good." : "Its saved keys and settings on this computer are deleted. Its data is set aside.",
            folders.okText(id, o.os ?? "macos").source,
          ] },
        },
      });
      onYes(opened.card, "plugin-remove", opened.allowed, remove);
      if (opened.card === undefined) {
        if (!(await opened.allowed)) throw new ContractError("refused", `${id} wasn't removed`);
        return { ok: true as const };
      }
      return { applied: false as const, card: opened.card };
    }),
    // Where a top plugin's icon is, for the app's main process alone (it reads the file itself, as a picture only).
    [M.pluginIconSource.name]: handler(M.pluginIconSource, ({ id }, ctx) => {
      requireUser(ctx, "read a plugin's icon");
      const r = registry.get(id);
      if (r === undefined || r.parent !== undefined) return {};
      const icon = manifestIconOf(r.manifest);
      return icon === undefined ? {} : { folder: r.folder, icon };
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
      onYes(opened.card, "dev-folder", opened.allowed, async () => {
        await folders.addDevFolder(checked, "app");
        return undefined;
      });
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
    [M.pluginDevRenew.name]: handler(M.pluginDevRenew, async ({ path, card }, ctx) => {
      requireUser(ctx, "renew a development folder");
      if (card !== true) return { expiresAt: await folders.renewDevFolder(path) };
      // From the Plugins page (main sets `card`): another 24 hours of code that reloads when it changes is the same
      // kind of yes as adding it.
      const d = folders.devFolders().find((x) => x.path === path);
      if (d === undefined) throw new ContractError("not_found", `${path} isn't a development folder`);
      if (o.openCard === undefined) notServed("renewing a development folder from the app", "this computer's approval broker isn't running; `clover plugin dev renew <folder>` in your terminal renews it");
      const opened = await o.openCard!({
        kind: "change", origin: "user", computers: [], effect: "other", change: "dev-folder",
        fields: {
          title: { type: "text", text: `Keep loading the plugin you're developing at ${d.path} for another 24 hours?` },
          detail: { type: "list", items: ["Its code runs on this computer as it is, reloading when it changes."] },
        },
      });
      if (opened.card === undefined) {
        if (!(await opened.allowed)) throw new ContractError("refused", "the development folder wasn't renewed");
        return { expiresAt: await folders.renewDevFolder(d.path) };
      }
      onYes(opened.card, "dev-folder", opened.allowed, async () => {
        // Its 24 hours may have ended while the card waited: the folder is gone, and nothing is renewed.
        if (!folders.devFolders().some((x) => x.path === d.path)) return EXPIRED_DEV_FOLDER;
        try {
          await folders.renewDevFolder(d.path);
        } catch (err) {
          if ((err as { code?: unknown } | null)?.code === "not_found") return EXPIRED_DEV_FOLDER;
          throw err;
        }
        return undefined;
      });
      return { applied: false as const, card: opened.card };
    }),
    // From a folder on disk (the app's "install from folder", the terminal): copied in, validated, found, and its sealed
    // OK card raised at once (§5.1). The index and npm wait for their clients.
    [M.pluginInstall.name]: handler(M.pluginInstall, async ({ source }, ctx) => {
      const user = requireUser(ctx, "install a plugin");
      if (source.from === "npm" && o.indexes === undefined) notServed("installing from npm", "this computer has no index client");
      if (source.from === "index" && o.indexes === undefined) notServed("installing from a plugin index", "this computer has no index client");
      const by = user.client === "cli" ? "user-terminal" : "user-app";
      const leftovers = o.opened.leftovers;
      const target = {
        pluginsDir: join(o.home, "plugins"), stagingDir: installStagingDir(o.home),
        ...(o.os ? { os: o.os } : {}),
        taken: (pluginId: string) => registry.get(pluginId) !== undefined,
        // What an earlier plugin under the id left, settled before the folder lands (`leftovers.ts`).
        ...(leftovers !== undefined ? { leftovers: (pluginId: string, treeHash: string | undefined, from: Partial<PluginProvenance>) => leftovers.settle(pluginId, { ...(treeHash !== undefined ? { treeHash } : {}), provenance: { by, at: 0, ...from } }) } : {}),
      };
      const raise = async (id: string, treeHash: string) => {
        if (registry.get(id) === undefined) throw new ContractError("failed", `${id} was copied in but isn't found; its folder is ${join(o.home, "plugins", id)}`);
        const raised = await registry.installed(id, user.client === "cli" ? "cli" : "app");
        return { id: id as never, state: raised.state, treeHash, ...(raised.card !== undefined ? { card: raised.card } : {}) };
      };
      if (source.from === "index") {
        // From an index (§5.1): its id and tree hash as the index lists them; its OK card decides.
        const src = source as { from: "index"; id: string; version?: string; index?: string };
        const done = await installFromIndex({
          ...target, client: o.indexes!,
          id: src.id, ...(src.version !== undefined ? { version: src.version } : {}), ...(src.index !== undefined ? { index: src.index } : {}),
          adultConfirmed: registry.adultConfirmed,
        });
        await folders.installed(done.id, by, { index: done.index });
        return raise(done.id, done.treeHash);
      }
      if (source.from === "npm") {
        // From npm (§5.1): unpacked as it is, its bytes checked against npm's integrity record; its OK card decides.
        const src = source as { from: "npm"; name: string; version?: string };
        const done = await installFromNpm({
          ...target, client: o.indexes!,
          name: src.name, ...(src.version !== undefined ? { version: src.version } : {}),
        });
        await folders.installed(done.id, by, { npm: done.npm });
        return raise(done.id, done.treeHash);
      }
      if (source.from === "wrap") {
        // A bare item (§5.1): the core generates a plugin around it (one per server for an MCP config), and records what
        // it was made from. Each gets its own OK card.
        const made = await installWrapped({
          ...target, kind: source.kind, value: source.value, by: "user",
          homes: { user: o.userHome ?? homedir(), clover: o.home, os: target.os ?? (process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos") },
          ...(o.secrets?.set !== undefined ? { secrets: { set: o.secrets.set.bind(o.secrets), delete: o.secrets.delete.bind(o.secrets) } } : {}),
        });
        const results = [];
        for (const w of made) {
          await folders.installed(w.id, by, {
            wrapped: {
              from: source.kind, ...(w.unused.length > 0 ? { unused: w.unused.slice(0, 64) } : {}), ...(w.network !== undefined ? { network: w.network } : {}),
              ...(w.reads !== undefined ? { reads: w.reads } : {}), ...(w.unreadable !== undefined ? { unreadable: w.unreadable } : {}),
            },
          });
          results.push(await raise(w.id, w.treeHash));
        }
        const [first, ...more] = results;
        return { ...first!, ...(more.length > 0 ? { more } : {}) };
      }
      const { id, treeHash } = await installFromFolder({ ...target, source: (source as { from: "folder"; path: string }).path });
      await folders.installed(id, by);
      return raise(id, treeHash);
    }),
    [M.pluginUpdate.name]: handler(M.pluginUpdate, async ({ id, list, card }, ctx) => {
      const user = requireUser(ctx, "update a plugin");
      if (o.updater === undefined || o.indexes === undefined) notServed("plugin.update", "this computer has no index client");
      // The indexes now, then the updates: without an id (or with `list`), what is newer, each offered with why, nothing
      // applied; with an id, the user's click on that plugin's update, which applies it.
      // One update card per plugin: while one waits, asking again raises nothing.
      const waiting = id !== undefined && card === true && list !== true ? updateCards.get(id) : undefined;
      if (waiting !== undefined) return { updated: [], offered: [{ id: id!, ...waiting, why: "already waiting for your yes on its card" }] };
      await o.indexes!.refresh();
      // From the Plugins page (main sets `card`): an update that runs on the old OK asks on a sealed card first. The call answers at once (offered, "waiting for your yes on its card"); the yes applies that
      // tree, and only that one, by a check of its own, so an unanswered card never holds the updater's turn.
      const confirm = card === true
        ? async (c: { id: string; from: string; to: string; source: string; treeHash: string; root: string; changed: string }): Promise<boolean | "asked" | "pending"> => {
          if (updateCards.has(c.id)) return "pending";
          if (o.openCard === undefined) throw new ContractError("refused", "applying this update from this page needs a sealed card, and this computer's approval broker isn't running");
          const n = registry.get(c.id)?.name;
          // Read now, for its Review: the staged folder goes once this answers.
          const tree = o.reviews !== undefined ? readReviewTree(c.root, { pluginId: c.id, treeHash: c.treeHash, okLines: folders.okText(c.id, o.os ?? "macos").lines }) : undefined;
          const opened = await o.openCard({
            kind: "change", origin: "user", computers: [], effect: "other", change: "plugin-update",
            fields: {
              title: { type: "text", text: `Update ${typeof n === "string" ? n : c.id} ${c.from} → ${c.to} from ${c.source}?` },
              detail: { type: "list", items: ["Its new code runs on the OK you gave before.", c.changed] },
            },
          });
          if (opened.card === undefined) return opened.allowed;
          const card = opened.card;
          updateCards.set(c.id, { from: c.from, to: c.to });
          if (tree !== undefined) updateTrees.set(card, { pluginId: c.id, treeHash: c.treeHash, tree });
          onYes(opened.card, "plugin-update", opened.allowed.finally(() => {
            updateCards.delete(c.id);
            updateTrees.delete(card);
            o.reviews?.forget(card);
          }), async () => {
            const again = await o.updater!.check({ only: c.id, confirm: async (now) => now.treeHash === c.treeHash && now.from === c.from && now.to === c.to });
            for (const u of again.updated) if (registry.get(u.id)?.state === "found") await registry.installed(u.id, "app");
            if (again.updated.some((u) => u.id === c.id)) return undefined;
            const failed = again.failed.find((u) => u.id === c.id);
            return failed !== undefined ? `It wasn't updated: ${failed.why}` : `The update on the card (${c.from} → ${c.to}) isn't the one offered now, so nothing changed; look at Updates again.`;
          });
          return "asked";
        }
        : undefined;
      const r = await o.updater!.check({ ...(id !== undefined ? { only: id } : {}), ...(list === true ? { listOnly: true } : {}), ...(confirm ? { confirm } : {}) });
      // One the user named that asks for the OK again: its sealed card now, as an install's (the previous version
      // stays beside it until this one runs, and comes back if it's refused).
      for (const u of r.updated) if (registry.get(u.id)?.state === "found") await registry.installed(u.id, user.client === "cli" ? "cli" : "app");
      return { updated: r.updated, ...(r.offered.length > 0 ? { offered: r.offered } : {}), ...(r.failed.length > 0 ? { failed: r.failed } : {}) };
    }),
    // The Review on a waiting OK card or update card (the owner's ruling, 2026-11-13): advice for the user's side of
    // the card, from the `reviewer.model` role; it never answers, pre-selects or delays the card.
    [M.pluginReview.name]: handler(M.pluginReview, async ({ card, peek }, ctx) => {
      requireUser(ctx, "review a plugin");
      if (o.reviews === undefined) notServed("plugin.review", "this computer runs no internal jobs");
      const reviews = o.reviews!;
      const ok = registry.okCards().find((x) => x.card === card);
      const u = ok === undefined ? updateTrees.get(card) : undefined;
      const pluginId = ok?.id ?? u?.pluginId;
      if (pluginId === undefined) throw new ContractError("not_found", `${card} isn't a plugin's OK card or update card waiting for an answer`);
      const answer = (v: { state: string; report?: string; why?: string; model?: string }) => ({
        state: v.state as never, pluginId: pluginId as never,
        ...(v.model !== undefined ? { model: v.model } : {}), ...(v.report !== undefined ? { report: v.report } : {}), ...(v.why !== undefined ? { why: v.why } : {}),
      });
      if (peek === true) {
        const had = reviews.get(card);
        if (had !== undefined) return answer(had);
        const model = reviews.model();
        return answer(model === undefined ? { state: "unavailable", why: "No model is set for reviews: choose one in Settings › Models (the reviewer role)." } : { state: "idle", model });
      }
      const had = reviews.get(card);
      if (had !== undefined && (had.state === "running" || had.state === "done")) return answer(had);
      let target: { treeHash: string; tree: () => ReviewTree };
      if (ok !== undefined) {
        // An OK card is about the tree it was made for: the folder as it is now must still be that tree, before and
        // after it is read (a bot's edit since the card was raised is a tree the card doesn't approve).
        const r = registry.get(ok.id);
        const hashNow = async () => (r === undefined ? undefined : await folderTreeHash(r.folder).catch(() => undefined));
        if (r === undefined || (await hashNow()) !== ok.treeHash) return answer({ state: "changed", why: REVIEW_CHANGED });
        const read = readReviewTree(r.folder, { pluginId: ok.id, treeHash: ok.treeHash, okLines: folders.okText(ok.id, o.os ?? "macos").lines });
        if ((await hashNow()) !== ok.treeHash) return answer({ state: "changed", why: REVIEW_CHANGED });
        target = { treeHash: ok.treeHash, tree: () => read };
      } else target = { treeHash: u!.treeHash, tree: () => u!.tree };
      return answer(reviews.start(card, target.tree, { pluginId, treeHash: target.treeHash }));
    }),
    [M.pluginIndexList.name]: handler(M.pluginIndexList, () => ({ indexes: o.indexes?.list() ?? [] })),
    [M.pluginIndexSearch.name]: handler(M.pluginIndexSearch, ({ query, limit }) => {
      if (o.indexes === undefined) return { entries: [] };
      const entries = o.indexes.search({ ...(query !== undefined ? { query } : {}), ...(limit !== undefined ? { limit } : {}), adultConfirmed: registry.adultConfirmed });
      return {
        entries: entries.map((e) => {
          const installed = (registry.get(e.id)?.manifest as { version?: string } | undefined)?.version;
          return {
            id: e.id as never, index: e.index,
            ...(e.name !== undefined ? { name: e.name } : {}),
            ...(e.description !== undefined ? { description: e.description } : {}),
            versions: e.versions.slice(0, 1000).map((v) => ({ version: v.version, hash: v.hash as never })),
            ...(installed !== undefined ? { installed } : {}),
            ...(e.adult === true ? { adult: true } : {}),
          };
        }),
      };
    }),
    // Another index, by its https URL (§5.1; the owner's ruling, 2026-11-13): a plain list, unsigned. Adding one runs
    // nothing, so no card: each plugin installed from it asks for its OK as every install does.
    [M.pluginIndexAdd.name]: handler(M.pluginIndexAdd, async ({ url }, ctx) => {
      requireUser(ctx, "add a plugin index");
      const indexes = o.indexes;
      if (indexes === undefined) notServed("plugin.index.add", "this computer has no index client");
      const checked = indexes!.add(httpsUrl(url));
      await indexes!.refresh(checked);
      return { applied: true as const };
    }),
    [M.pluginIndexRemove.name]: handler(M.pluginIndexRemove, async ({ url, card }, ctx) => {
      requireUser(ctx, "remove a plugin index");
      if (o.indexes === undefined) throw new ContractError("not_found", `${url} isn't one of your indexes`);
      const checked = httpsUrl(url);
      const plainName = (r: PluginRecord) => (typeof r.name === "string" ? r.name : r.id);
      const remove = () => o.indexes!.remove(checked);
      // From the Plugins page (main sets `card`): when plugins installed from it are here, a sealed card says they get no
      // more updates from it.
      const from = registry.list().filter((r) => r.parent === undefined && r.provenance.index?.url === checked);
      if (card !== true || from.length === 0) {
        remove();
        return { ok: true as const };
      }
      if (o.openCard === undefined) throw new ContractError("refused", "removing this index from this page needs a sealed card, and this computer's approval broker isn't running");
      const names = from.map(plainName).join(", ");
      const opened = await o.openCard({
        kind: "change", origin: "user", computers: [], effect: "other", change: "plugin-index-remove",
        fields: {
          title: { type: "text", text: "Remove this index?" },
          detail: { type: "list", items: [checked, `${from.length} installed plugin${from.length === 1 ? "" : "s"} came from it and will get no more updates from it: ${names.length > 1000 ? `${names.slice(0, 999)}…` : names}.`] },
        },
      });
      onYes(opened.card, "plugin-index-remove", opened.allowed, () => {
        if (!o.indexes!.list().some((i) => i.url === checked)) return "It was already removed.";
        remove();
        return undefined;
      });
      if (opened.card === undefined) {
        if (!(await opened.allowed)) throw new ContractError("refused", "the index wasn't removed");
        return { ok: true as const };
      }
      return { applied: false as const, card: opened.card };
    }),
    [M.pluginPin.name]: handler(M.pluginPin, ({ id, pinned }, ctx) => {
      // The user's alone: a layer reaches this as a plugin (its `change` passes the gate for the handler to decide). A
      // pinned plugin isn't offered updates (the owner's ruling, 2026-11-13: nothing updates on its own).
      requireUser(ctx, "pin a plugin");
      if (o.indexes === undefined) notServed("plugin.pin", "this computer has no index client");
      const r = must(id);
      if (r.provenance.index === undefined && r.provenance.npm === undefined) throw new ContractError("refused", `${id} isn't from a plugin index or npm, so nothing updates it`);
      // Local (the controller's ruling): this computer's record, never synced.
      o.indexes!.setPinned(id, pinned);
      return { applied: true as const };
    }),
    // The user's alone, whenever they are served (a layer's `change` call reaches the handler as a plugin).
    [M.pluginSetScope.name]: handler(M.pluginSetScope, (_p, ctx) => {
      requireUser(ctx, "change a plugin's scope");
      return notServed("plugin.setScope", "the synced plugin list isn't on main");
    }),
    [M.pluginSetComputers.name]: handler(M.pluginSetComputers, (_p, ctx) => {
      requireUser(ctx, "choose a plugin's computers");
      return notServed("plugin.setComputers", "the synced plugin list isn't on main");
    }),
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
  "command.run", "glossary.query", "plugin.ui", "plugin.layer.api", "plugin.layer.call", "notify.send", "plugin.iconSource",
];

/** What a method answers before the registry opens. */
export function beforePluginsOpen(method: string): unknown {
  if (method === "plugin.list") return { plugins: [], adultConfirmed: false };
  // The app re-reads `plugin.ui` on the nudge the registry's opening sends.
  if (method === "plugin.ui") return { plugins: [] };
  if (method === "plugin.iconSource") return {};
  if (method === "plugin.dev.list") return { folders: [] };
  if (method === "plugin.index.list") return { indexes: [] };
  if (method === "plugin.index.search") return { entries: [] };
  if (method === "point.list") return { points: [] };
  if (method === "command.list") return { commands: [] };
  throw new ContractError("refused", "the plugin registry is still opening; try again in a moment");
}
