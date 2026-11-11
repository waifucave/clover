// Updating plugins from an index or npm (spec §5.1 "Updates"; the owner's answer E and the controller's rulings,
// 2026-11-11):
//
// * Forward only: a version above the one recorded at install (`provenance.index.version` / `provenance.npm.version`,
//   which an install checks against the manifest), never below or equal.
// * Applied on their own (after each index check), unless pinned (`plugin.pin`, a local record): only updates from the
//   official index that add no trigger (`INDEX_AUTO_UPDATE`). An added index's and npm's (`NPM_UPDATES`) are offered,
//   as is one that adds a trigger. `plugin.update` with an id is the user asking for that plugin's update: it applies an
//   offered one too, but never a pinned plugin's.
// * The OK carries over: an update that adds none of the triggers (`updateAddsTrigger`) runs on the OK given, its code
//   changes included, and its OK snapshot moves to the new tree; one that adds a trigger asks again, from any source.
// * Checked as an install is: the index's tree hash (or npm's integrity record), Clover's own unpacker, validation with
//   the same id and the listed version, and never a revoked tree.
// * The previous version is kept beside it (`.<id>.previous-*` in the plugins folder, which the registry skips), with a
//   record in the MAC'd state written before the first rename, until the new tree is OK'd; it comes back if the new one
//   is refused, invalid, blocked or stopped, across restarts too. A crash between the renames puts it back at start.
// * One check at a time: a check the user asks for waits for the one running (never two swaps of one plugin).
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { topPluginIdOf, type PluginProvenance } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import type { PluginFolders } from "../folders";
import { manifestVersion, newStage, type InstallTarget } from "../install-folder";
import { validatePluginFolder } from "../validate";
import { byVersion, type IndexClient } from "./client";
import { stageIndexVersion } from "./install";
import { npmMetadata, npmVersionOf, NPM_UPDATES, stageNpmVersion } from "./npm";
import type { Revocations } from "./revocations";

/** Which indexes' updates apply on their own (the controller's ruling, 2026-11-11): the official one's only; an added
 *  index's are offered, as npm's are. The official slot is empty today, so every update is offered for now. */
export const INDEX_AUTO_UPDATE: "official" | "all" = "official";

export interface UpdateChange {
  id: string;
  from: string;
  to: string;
}

export interface UpdateResult {
  /** Put in place: running on its OK, or (asked for by the user, with a trigger) waiting for a new one. */
  updated: UpdateChange[];
  /** Newer, not applied: why (npm's and an added index's are offered; it adds a trigger; it's pinned). */
  offered: (UpdateChange & { why: string })[];
  /** Newer, but it couldn't be put in place: why. */
  failed: (UpdateChange & { why: string })[];
}

export interface UpdaterOptions extends Omit<InstallTarget, "taken"> {
  client: IndexClient;
  revocations?: Revocations;
  registry: Pick<PluginRegistry, "get" | "list" | "watch">;
  folders: Pick<PluginFolders, "updated" | "updateTrigger">;
  adultConfirmed: () => boolean;
  /** `NPM_UPDATES` and `INDEX_AUTO_UPDATE`; tests set them. */
  npmUpdates?: "offer" | "apply";
  indexAutoUpdate?: "official" | "all";
  log?: (line: string) => void;
  /** The folder renames (tests make one fail). */
  rename?: (from: string, to: string) => void;
}

const PREVIOUS = /^\.([a-z0-9-]+)\.previous-[0-9a-f]+$/;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

type Kept = NonNullable<ReturnType<IndexClient["updating"]>[string]>;

export class PluginUpdater {
  readonly #o: UpdaterOptions;
  readonly #unwatch: () => void;
  /** Checks run one after another; `#auto` is the automatic one waiting or running, which another automatic joins. */
  #tail: Promise<unknown> = Promise.resolve();
  #auto: Promise<UpdateResult> | undefined;

  readonly #rename: (from: string, to: string) => void;

  /** Built before the registry's first scan: a crash between an update's renames is undone first. */
  constructor(o: UpdaterOptions) {
    this.#o = o;
    this.#rename = o.rename ?? renameSync;
    this.#sweep();
    this.#unwatch = o.registry.watch((c) => {
      if (c.type === "plugin" && this.#keptOf(c.id) !== undefined) this.#settleLogged(c.id);
      // The id's folder gone while an update is kept (a restore whose rename failed, or deleted by hand): the record and
      // the previous copy stay, and the next start puts it back. `plugin.remove` lets them go (`forget`).
    });
  }

  /** `plugin.remove`: an update of it coming up is dropped, its previous copy with it. */
  forget(id: string): void {
    if (this.#keptOf(id) !== undefined) this.#drop(id);
  }

  close(): void {
    this.#unwatch();
  }

  /** After the first scan: each update still coming up (a restart while its card waited) is judged again. */
  async resume(): Promise<void> {
    for (const [id, k] of Object.entries(this.#o.client.updating())) {
      // Put back at start (`#sweep`): read again with its own provenance.
      if (this.#o.registry.get(id)?.treeHash === k.treeHash && existsSync(join(this.#o.pluginsDir, id)) && !existsSync(join(this.#o.pluginsDir, k.previous))) {
        await this.#o.folders.updated(id, k.treeHash, k.provenance as PluginProvenance);
        this.#o.client.setUpdating(id, undefined);
        continue;
      }
      await this.#settle(id).catch((err) => this.#o.log?.(`update of ${id}: ${errText(err)}`));
    }
  }

  /** Checks for updates and applies those that may apply: every one that applies on its own (`only` absent), or the
   *  one plugin the user asked for (`only`). One check runs at a time. */
  check(o: { only?: string; signal?: AbortSignal } = {}): Promise<UpdateResult> {
    if (o.only === undefined && this.#auto !== undefined) return this.#auto;
    const run = this.#tail.then(() => this.#run(o));
    this.#tail = run.catch(() => undefined);
    if (o.only === undefined) {
      this.#auto = run;
      void run.finally(() => {
        if (this.#auto === run) this.#auto = undefined;
      }).catch(() => undefined);
    }
    return run;
  }

  #keptOf(id: string): Kept | undefined {
    return this.#o.client.updating()[id];
  }

  /** At start, before any folder is read: a previous version whose record names it comes back when its plugin's
   *  folder is missing (a crash between the renames); one no record names goes, unless its folder is missing. */
  #sweep(): void {
    const dir = this.#o.pluginsDir;
    if (!existsSync(dir)) return;
    const kept = this.#o.client.updating();
    for (const name of readdirSync(dir)) {
      const m = PREVIOUS.exec(name);
      if (m === null) continue;
      const id = m[1]!;
      const dest = join(dir, id);
      const named = kept[id]?.previous === name;
      if (!existsSync(dest)) {
        try {
          this.#rename(join(dir, name), dest);
          continue;
        } catch {
          // Falls through: removed.
        }
      }
      if (!named) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  async #run(o: { only?: string; signal?: AbortSignal }): Promise<UpdateResult> {
    const out: UpdateResult = { updated: [], offered: [], failed: [] };
    const records = this.#o.registry.list().filter((r) => topPluginIdOf(r.id) === r.id && (o.only === undefined || r.id === o.only));
    if (o.only !== undefined && records.length === 0) throw new ContractError("not_found", `no plugin ${o.only}`);
    for (const r of records) {
      if (r.dev || (r.provenance.index === undefined && r.provenance.npm === undefined)) {
        if (o.only !== undefined) throw new ContractError("refused", `${r.id} isn't from a plugin index or npm: ${r.dev ? "a development folder changes when you change it" : "a local plugin changes only when its folder does"}`);
        continue;
      }
      if (this.#keptOf(r.id) !== undefined) {
        if (o.only !== undefined) throw new ContractError("conflict", `an update of ${r.id} is waiting for your OK; answer its card first`);
        continue;
      }
      const from = r.provenance.index?.version ?? r.provenance.npm?.version ?? "0.0.0";
      try {
        await this.#one(r, from, o.only !== undefined, out, o.signal);
      } catch (err) {
        const why = errText(err);
        this.#o.log?.(`update of ${r.id}: ${why}`);
        out.failed.push({ id: r.id, from, to: "", why });
      }
    }
    return out;
  }

  async #one(r: PluginRecord, from: string, asked: boolean, out: UpdateResult, signal?: AbortSignal): Promise<void> {
    let to: string;
    let provenance: PluginProvenance;
    let stage: (dir: string) => Promise<string>;
    let expectHash: string | undefined;
    let offer: string | undefined;
    if (r.provenance.index !== undefined) {
      const e = this.#o.client.find(r.id, { index: r.provenance.index.url, adultConfirmed: this.#o.adultConfirmed() });
      if (e === undefined || byVersion(e.version, from) <= 0) return;
      to = e.version;
      expectHash = e.hash;
      provenance = { ...r.provenance, index: { url: e.index, version: e.version } };
      stage = (dir) => stageIndexVersion(this.#o.client, r.id, e, dir, signal);
      if ((this.#o.indexAutoUpdate ?? INDEX_AUTO_UPDATE) === "official" && !this.#o.client.isOfficial(e.index)) offer = "updates from an index you added are offered, not applied on their own";
    } else {
      const name = r.provenance.npm!.name;
      const v = npmVersionOf(await npmMetadata(this.#o.client, name, undefined, signal), name);
      if (byVersion(v.version, from) <= 0) return;
      to = v.version;
      provenance = { ...r.provenance, npm: { name, version: v.version } };
      stage = (dir) => stageNpmVersion(this.#o.client, name, v, dir, signal);
      if ((this.#o.npmUpdates ?? NPM_UPDATES) === "offer") offer = "npm updates are offered, not applied on their own";
    }
    const change = { id: r.id, from, to };
    if (this.#o.client.isPinned(r.id)) {
      out.offered.push({ ...change, why: "it's pinned to its version" });
      return;
    }
    if (offer !== undefined && !asked) {
      out.offered.push({ ...change, why: offer });
      return;
    }
    const st = newStage(this.#o.stagingDir);
    try {
      const root = await stage(st.dir);
      const v = await validatePluginFolder(root, ...(this.#o.os ? [{ os: this.#o.os }] : []));
      if (!v.ok || v.plugin === undefined || v.treeHash === undefined) {
        const errors = v.issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => i.message);
        throw new ContractError("invalid", `the new version isn't valid${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
      }
      if (v.plugin.id !== r.id) throw new ContractError("invalid", `the new version is ${JSON.stringify(v.plugin.id)}, not ${r.id}`);
      if (expectHash !== undefined && v.treeHash !== expectHash) throw new ContractError("invalid", `the download's tree hash (${v.treeHash}) isn't the one its index lists (${expectHash})`);
      const says = manifestVersion(root);
      if (says !== to) throw new ContractError("invalid", `the download says it is version ${JSON.stringify(says ?? null)}, not ${to} as listed`);
      const blocked = this.#o.revocations?.blockedOf({ id: r.id, treeHash: v.treeHash, version: to, provenance });
      if (blocked !== undefined) throw new ContractError("refused", `${r.id} ${to} isn't installed: ${blocked}`);
      // What it adds that asks for a new OK, against the OK'd tree: an automatic check never applies that.
      const trigger = await this.#o.folders.updateTrigger(r.id, root, provenance);
      if (trigger !== undefined && !asked) {
        out.offered.push({ ...change, why: `it asks for your OK again: ${trigger}` });
        return;
      }
      await this.#swap(r, root, v.treeHash, provenance);
      out.updated.push(change);
    } finally {
      st.done();
    }
  }

  /** Puts the new version in place, the previous one kept beside it (its record first), and reads it. */
  async #swap(r: PluginRecord, root: string, treeHash: string, provenance: PluginProvenance): Promise<void> {
    if (r.treeHash === undefined) throw new ContractError("failed", `${r.id} has no tree to keep`);
    const dest = join(this.#o.pluginsDir, r.id);
    const name = `.${r.id}.previous-${randomBytes(6).toString("hex")}`;
    this.#o.client.setUpdating(r.id, { previous: name, treeHash: r.treeHash, provenance: r.provenance as Record<string, unknown>, to: treeHash });
    try {
      this.#rename(dest, join(this.#o.pluginsDir, name));
    } catch (err) {
      this.#o.client.setUpdating(r.id, undefined);
      throw new ContractError("failed", `${r.id} couldn't be moved aside: ${(err as NodeJS.ErrnoException).code ?? errText(err)}`);
    }
    try {
      this.#rename(root, dest);
    } catch (err) {
      this.#rename(join(this.#o.pluginsDir, name), dest);
      this.#o.client.setUpdating(r.id, undefined);
      throw new ContractError("failed", `${r.id} couldn't be moved into the plugins folder: ${(err as NodeJS.ErrnoException).code ?? errText(err)}`);
    }
    await this.#o.folders.updated(r.id, treeHash, provenance);
    await this.#settle(r.id);
  }

  #settleLogged(id: string): void {
    this.#settle(id).catch((err) => this.#o.log?.(`update of ${id}: the previous version couldn't be judged again: ${errText(err)}`));
  }

  /** The new version's fate: OK'd (running, off or waiting for a point) lets the previous go; refused, invalid,
   *  blocked or stopped brings it back; waiting for its OK waits. A tree that is neither (the user changed the
   *  folder, or the previous one is back) ends the record. */
  async #settle(id: string): Promise<void> {
    const k = this.#keptOf(id);
    if (k === undefined) return;
    const r = this.#o.registry.get(id);
    if (r === undefined) return;
    if (r.treeHash !== k.to) {
      if (r.treeHash === k.treeHash) {
        // The previous version is back (put back at start, or never moved): read with the provenance it had, since the
        // folder's going may have dropped its record.
        this.#drop(id);
        if (JSON.stringify(r.provenance) !== JSON.stringify(k.provenance)) await this.#o.folders.updated(id, k.treeHash, k.provenance as PluginProvenance);
      }
      return;
    }
    if (r.okHash === k.to && (r.state === "running" || r.state === "off" || r.state === "waiting")) {
      this.#drop(id);
      return;
    }
    if (r.state === "refused" || r.state === "invalid" || r.state === "blocked" || r.state === "stopped") {
      this.#o.log?.(`update of ${id}: the new version is ${r.state}${r.reason ? ` (${r.reason})` : ""}; the previous one comes back`);
      const dest = join(this.#o.pluginsDir, id);
      const previous = join(this.#o.pluginsDir, k.previous);
      if (!existsSync(previous)) {
        this.#o.client.setUpdating(id, undefined);
        return;
      }
      // If the second rename fails, the id's folder is missing: the record stays, so its going records no leftovers
      // (`Leftovers.left`), and the next start puts the previous copy back and reads it with the record's provenance.
      const failed = join(this.#o.pluginsDir, `.${id}.failed-${randomBytes(6).toString("hex")}`);
      try {
        this.#rename(dest, failed);
        this.#rename(previous, dest);
      } finally {
        rmSync(failed, { recursive: true, force: true });
      }
      this.#o.client.setUpdating(id, undefined);
      await this.#o.folders.updated(id, k.treeHash, k.provenance as PluginProvenance);
    }
  }

  #drop(id: string): void {
    const k = this.#keptOf(id);
    this.#o.client.setUpdating(id, undefined);
    if (k !== undefined) rmSync(join(this.#o.pluginsDir, k.previous), { recursive: true, force: true });
  }
}
