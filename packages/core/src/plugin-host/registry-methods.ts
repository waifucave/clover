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
import { parentOf } from "../contracts/plugin-registry-rules";
import { ContractError } from "../contracts/common";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import type { OpenedRegistry } from "../registry/open";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { pluginPath } from "./paths";
import { onCardYes } from "./card-yes";
import { installFromFolder, installStagingDir } from "../registry/install-folder";
import { httpsUrl, keyFingerprint, type IndexClient } from "../registry/indexes/client";
import type { Revocations } from "../registry/indexes/revocations";
import { installFromIndex } from "../registry/indexes/install";
import { installFromNpm } from "../registry/indexes/npm";
import type { PluginUpdater } from "../registry/indexes/update";
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
  return PluginSummary.parse({ ...r, ...(app ? { version: CORE_VERSION } : {}), ...(description !== undefined ? { description } : {}) });
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
  /** Their revocation lists: their state in the index list, and the override switch (`REVOKED_OVERRIDE`). */
  revocations?: Revocations;
  /** Plugin updates (`registry/indexes/update.ts`), with the index client. */
  updater?: PluginUpdater;
  /** The core's events (`plugin_card_note`). */
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  log?: (line: string) => void;
}): Record<string, MethodHandler> {
  const M = PLUGINS_METHODS;
  /** The plugins whose update card (from the Plugins page) is up, with the versions it names. */
  const updateCards = new Map<string, { from: string; to: string }>();
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
      const r = must(id);
      if (r.state === "blocked" && enabled) {
        // A revoked tree (the owner's answer C): the user may run it anyway on this computer, after one sealed warning
        // card from any caller (the app's switch and the terminal alike). Only the yes on that card records the
        // override, keyed to the revoked record (the top plugin: a list names top-level ids, and its tree hash covers
        // every child) and the exact tree hash that was revoked, so a changed tree is blocked again.
        const top = must(parentOf(r.id) ?? r.id);
        const v = o.revocations?.verdict({ id: top.id, treeHash: top.treeHash, version: (top.manifest as { version?: string } | undefined)?.version, provenance: top.provenance });
        if (v === undefined || o.revocations?.overrideAllowed !== true || o.indexes === undefined || top.treeHash === undefined) {
          throw new ContractError("refused", `${id} is blocked: ${r.reason ?? "a revocation list names it"}. Its files, data and keys stay on this computer.`);
        }
        if (o.openCard === undefined) notServed("running a revoked plugin anyway", "this computer's approval broker isn't running, and its warning card must be answered first");
        const revokedHash = top.treeHash;
        const opened = await o.openCard!({
          kind: "change", origin: "user", computers: [], effect: "other", change: "plugin-revoked",
          fields: {
            title: { type: "text", text: `Run ${top.name} anyway?` },
            detail: {
              type: "list", items: [
                `${v.by} revoked it, giving this reason: "${v.reason}"`,
                "If you go on, Clover will run it anyway on this computer. A changed version of it is blocked again.",
                "Its data and settings are kept either way.",
                `Its tree: ${revokedHash}`,
              ],
            },
          },
        });
        const apply = async (): Promise<string | undefined> => {
          const now = registry.get(top.id);
          // The tree the user saw on the card, and only that one.
          if (now?.treeHash !== revokedHash) return now === undefined ? "It was removed meanwhile." : "Its files changed since the card, so it stays blocked; switching it on shows a new card.";
          o.indexes!.setOverride(top.id, revokedHash);
          await folders.refresh(now.folder);
          if (registry.get(id)?.state !== "blocked") await registry.setEnabled(id, true);
          return undefined;
        };
        if (opened.card === undefined) {
          if (!(await opened.allowed)) throw new ContractError("refused", `${id} stays blocked`);
          await apply();
          return { applied: true as const };
        }
        onYes(opened.card, "plugin-revoked", opened.allowed, apply);
        return { applied: false as const, card: opened.card };
      }
      return registry.setEnabled(id, enabled);
    }),
    [M.pluginRestart.name]: handler(M.pluginRestart, async ({ id }, ctx) => {
      requireUser(ctx, "restart a plugin");
      const r = must(id);
      // Only a plugin that may run: blocked, waiting for its OK, refused or off, a restart starts nothing (the host's
      // start already finds no startable record for it; this says so instead of marking it stopped).
      if (!["running", "waiting", "stopped"].includes(r.state)) throw new ContractError("refused", `${id} isn't running (${r.state}${r.reason !== undefined ? `: ${r.reason}` : ""}), so there's nothing to restart`);
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
    [M.pluginRemove.name]: handler(M.pluginRemove, async ({ id, card }, ctx) => {
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
        await forgetRemovedPlugin({ home: o.home, ...(o.secrets !== undefined ? { secrets: o.secrets } : {}), record: now, children });
        // This computer's records for the id go too: a later install under it is never pinned, and never runs a revoked
        // tree on this one's override.
        if (o.indexes !== undefined) {
          o.indexes.setPinned(id, false);
          o.indexes.setOverride(id, undefined);
          o.indexes.setRemovedBlock(id, undefined);
        }
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
            `Its saved keys and settings on this computer are deleted. Its data is set aside.`,
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
        // From a signed index (§5.1): its id and tree hash as the index lists them, never a revoked tree.
        const src = source as { from: "index"; id: string; version?: string; index?: string };
        const done = await installFromIndex({
          ...target, client: o.indexes!, ...(o.revocations ? { revocations: o.revocations } : {}),
          id: src.id, ...(src.version !== undefined ? { version: src.version } : {}), ...(src.index !== undefined ? { index: src.index } : {}),
          adultConfirmed: registry.adultConfirmed,
        });
        await folders.installed(done.id, by, { index: done.index });
        return raise(done.id, done.treeHash);
      }
      if (source.from === "npm") {
        // From npm (§5.1): unpacked as it is, its bytes checked against npm's integrity record, never a revoked tree.
        const src = source as { from: "npm"; name: string; version?: string };
        const done = await installFromNpm({
          ...target, client: o.indexes!, ...(o.revocations ? { revocations: o.revocations } : {}),
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
      // The indexes now, then the updates: every unpinned index plugin's, or the one the user names. `list`: what is
      // newer, each offered with why, nothing applied.
      // One update card per plugin: while one waits, asking again raises nothing.
      const waiting = id !== undefined && card === true && list !== true ? updateCards.get(id) : undefined;
      if (waiting !== undefined) return { updated: [], offered: [{ id: id!, ...waiting, why: "already waiting for your yes on its card" }] };
      await o.indexes!.refresh();
      // From the Plugins page (main sets `card`): an update that runs on the old OK and isn't the official index's asks on
      // a sealed card first. The call answers at once (offered, "waiting for your yes on its card"); the yes applies that
      // tree, and only that one, by a check of its own, so an unanswered card never holds the updater's turn.
      const confirm = card === true
        ? async (c: { id: string; from: string; to: string; source: string; treeHash: string }): Promise<boolean | "asked" | "pending"> => {
          if (updateCards.has(c.id)) return "pending";
          if (o.openCard === undefined) throw new ContractError("refused", "applying this update from this page needs a sealed card, and this computer's approval broker isn't running");
          const n = registry.get(c.id)?.name;
          const opened = await o.openCard({
            kind: "change", origin: "user", computers: [], effect: "other", change: "plugin-update",
            fields: {
              title: { type: "text", text: `Update ${typeof n === "string" ? n : c.id} ${c.from} → ${c.to} from ${c.source}?` },
              detail: { type: "list", items: ["Its new code runs on the OK you gave before."] },
            },
          });
          if (opened.card === undefined) return opened.allowed;
          updateCards.set(c.id, { from: c.from, to: c.to });
          onYes(opened.card, "plugin-update", opened.allowed.finally(() => updateCards.delete(c.id)), async () => {
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
    [M.pluginIndexList.name]: handler(M.pluginIndexList, () => ({
      indexes: (o.indexes?.list() ?? []).map((i) => {
        const rev = o.revocations?.status(i.url);
        return { ...i, ...(rev !== undefined ? { revocations: rev } : {}) };
      }),
    })),
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
    // Another index, by URL with its keys, after a warning (§5.1, §14.2 item 25): plugins from it aren't reviewed by
    // the official index. In the user's own terminal the CLI shows the warning; from the app it's a sealed card.
    [M.pluginIndexAdd.name]: handler(M.pluginIndexAdd, async ({ url, keys }, ctx) => {
      const user = requireUser(ctx, "add a plugin index");
      const indexes = o.indexes;
      if (indexes === undefined) notServed("plugin.index.add", "this computer has no index client");
      const checked = httpsUrl(url);
      const add = async () => {
        indexes!.add(checked, keys);
        await indexes!.refresh(checked);
        // Its revocation list, for the plugins installed from it.
        void o.revocations?.check();
      };
      if (user.client === "cli") {
        await add();
        return { applied: true as const };
      }
      if (o.openCard === undefined) notServed("adding a plugin index from the app", "this computer's approval broker isn't running; `clover plugin index add <url> <key>` in your terminal adds it");
      const opened = await o.openCard!({
        kind: "change", origin: "user", computers: [], effect: "other", change: "plugin-index",
        fields: {
          title: { type: "text", text: "Add a plugin index?" },
          detail: { type: "list", items: [checked, "Plugins from it aren't reviewed by Clover's official index. Each still asks for your OK before it runs.", ...keys.map((k, i) => `Key${keys.length > 1 ? ` ${i + 1}` : ""}, to compare with the one the index publishes: ${keyFingerprint(k)}`)] },
        },
      });
      onYes(opened.card, "plugin-index", opened.allowed, async () => {
        await add();
        return undefined;
      });
      if (opened.card === undefined) {
        if (!(await opened.allowed)) throw new ContractError("refused", "the index wasn't added");
        return { applied: true as const };
      }
      return { applied: false as const, card: opened.card };
    }),
    [M.pluginIndexRemove.name]: handler(M.pluginIndexRemove, async ({ url, card }, ctx) => {
      requireUser(ctx, "remove a plugin index");
      if (o.indexes === undefined) throw new ContractError("not_found", `${url} isn't one of your indexes`);
      const checked = httpsUrl(url);
      const plainName = (r: PluginRecord) => (typeof r.name === "string" ? r.name : r.id);
      const remove = () => {
        // A block its list holds on an installed plugin stays (the controller's ruling): kept for that exact tree, with
        // the reason, marked as from an index since removed; only the override card lifts it.
        for (const r of registry.list()) {
          if (r.parent !== undefined || r.treeHash === undefined) continue;
          const v = o.revocations?.verdict({ id: r.id, treeHash: r.treeHash, version: r.version, provenance: r.provenance });
          if (v?.index === checked) o.indexes!.setRemovedBlock(r.id, { treeHash: r.treeHash, by: `${v.by}, since removed`, reason: v.reason });
        }
        o.indexes!.remove(checked);
        void o.revocations?.check();
      };
      // From the Plugins page (main sets `card`): when plugins installed from it are here, a sealed card says they get no
      // more updates or revocations from it.
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
          detail: { type: "list", items: [checked, `${from.length} installed plugin${from.length === 1 ? "" : "s"} came from it and will get no more updates or revocations from it: ${names.length > 1000 ? `${names.slice(0, 999)}…` : names}.`] },
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
      // The user's alone: a layer reaches this as a plugin (its `change` passes the gate for the handler to decide),
      // and a pin it moved would let new code in on the old OK, or keep fixes out.
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
  "command.run", "glossary.query", "plugin.ui", "plugin.layer.api", "notify.send",
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
