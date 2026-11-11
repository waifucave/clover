// Updating plugins from an index or npm (spec §5.1 "Updates"; the owner's answer E, 2026-11-11):
//
// * Forward only: a version above the one installed, never below or equal.
// * Index plugins update on their own (after each index check) unless pinned (`plugin.pin`, a local record); npm
//   plugins' updates are offered, never applied on their own (`NPM_UPDATES`). `plugin.update` with an id is the user
//   asking for that plugin's update: it applies an offered one too (npm, or one that adds a trigger), but never a
//   pinned plugin's.
// * The OK carries over: an update that adds none of §5.6's triggers runs on the OK given (its code changes included);
//   one that adds a trigger asks again, from any source, and an automatic check never applies it (it is offered).
// * Checked as an install is: the index's tree hash (or npm's integrity record), Clover's own unpacker, validation with
//   the same id, and never a revoked tree.
// * The previous version is kept beside it (`.<id>.previous-*` in the plugins folder, which the registry skips) until
//   the new one runs, and comes back if the new one is refused, invalid or blocked. At start, a kept copy is put back
//   when its plugin's folder is missing, else removed (`sweepPreviousVersions`).
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { topPluginIdOf, type PluginProvenance } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import type { PluginFolders } from "../folders";
import { newStage, type InstallTarget } from "../install-folder";
import { validatePluginFolder } from "../validate";
import { byVersion, type IndexClient } from "./client";
import { stageIndexVersion } from "./install";
import { npmMetadata, npmVersionOf, NPM_UPDATES, stageNpmVersion } from "./npm";
import type { Revocations } from "./revocations";

export interface UpdateChange {
  id: string;
  from: string;
  to: string;
}

export interface UpdateResult {
  /** Put in place: running on its OK, or (asked for by the user, with a trigger) waiting for a new one. */
  updated: UpdateChange[];
  /** Newer, not applied: why (npm updates are offered; it adds a trigger; it's pinned). */
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
  /** `NPM_UPDATES`; tests set it. */
  npmUpdates?: "offer" | "apply";
  log?: (line: string) => void;
}

const PREVIOUS = /^\.([a-z0-9-]+)\.previous-[0-9a-f]+$/;

/** At start: a kept previous version is put back when its plugin's folder is missing (an update cut short), else
 *  removed (its update ran). */
export function sweepPreviousVersions(pluginsDir: string): void {
  if (!existsSync(pluginsDir)) return;
  for (const name of readdirSync(pluginsDir)) {
    const m = PREVIOUS.exec(name);
    if (m === null) continue;
    const dest = join(pluginsDir, m[1]!);
    if (!existsSync(dest)) {
      try {
        renameSync(join(pluginsDir, name), dest);
        continue;
      } catch {
        // Falls through: removed.
      }
    }
    rmSync(join(pluginsDir, name), { recursive: true, force: true });
  }
}

interface Kept {
  folder: string;
  treeHash: string;
  provenance: PluginProvenance;
  /** The new tree's hash: what the registry must show before the kept copy goes. */
  to: string;
}

export class PluginUpdater {
  readonly #o: UpdaterOptions;
  /** By plugin id: the previous version kept beside it while the new one comes up. */
  readonly #kept = new Map<string, Kept>();
  readonly #unwatch: () => void;
  #running: Promise<UpdateResult> | undefined;

  constructor(o: UpdaterOptions) {
    this.#o = o;
    this.#unwatch = o.registry.watch((c) => {
      if (c.type === "plugin" && this.#kept.has(c.id)) void this.#settle(c.id);
      if (c.type === "removed" && this.#kept.has(c.id)) this.#drop(c.id);
    });
  }

  close(): void {
    this.#unwatch();
  }

  /** Checks for updates and applies those that may apply: all of them (`only` absent, after an index check), or the
   *  one plugin the user asked for (`only`). One run at a time; a second call joins the first's. */
  check(o: { only?: string; signal?: AbortSignal } = {}): Promise<UpdateResult> {
    if (this.#running !== undefined && o.only === undefined) return this.#running;
    const run = this.#run(o).finally(() => {
      if (this.#running === run) this.#running = undefined;
    });
    if (o.only === undefined) this.#running = run;
    return run;
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
      if (this.#kept.has(r.id)) continue; // an update of it is still coming up
      try {
        await this.#one(r, o.only !== undefined, out, o.signal);
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.#o.log?.(`update of ${r.id}: ${why}`);
        out.failed.push({ id: r.id, from: r.version ?? "", to: "", why });
      }
    }
    return out;
  }

  async #one(r: PluginRecord, asked: boolean, out: UpdateResult, signal?: AbortSignal): Promise<void> {
    const from = r.version ?? "0.0.0";
    const pinned = this.#o.client.isPinned(r.id);
    let to: string;
    let provenance: PluginProvenance;
    let stage: (dir: string) => Promise<string>;
    let expectHash: string | undefined;
    if (r.provenance.index !== undefined) {
      const e = this.#o.client.find(r.id, { index: r.provenance.index.url, adultConfirmed: this.#o.adultConfirmed() });
      if (e === undefined || byVersion(e.version, from) <= 0) return;
      to = e.version;
      expectHash = e.hash;
      provenance = { ...r.provenance, index: { url: e.index, version: e.version } };
      stage = (dir) => stageIndexVersion(this.#o.client, r.id, e, dir, signal);
    } else {
      const name = r.provenance.npm!.name;
      const v = npmVersionOf(await npmMetadata(this.#o.client, name, undefined, signal), name);
      if (byVersion(v.version, from) <= 0) return;
      to = v.version;
      provenance = { ...r.provenance, npm: { name, version: v.version } };
      stage = (dir) => stageNpmVersion(this.#o.client, name, v, dir, signal);
      if (!asked && (this.#o.npmUpdates ?? NPM_UPDATES) === "offer") {
        out.offered.push({ id: r.id, from, to, why: "npm updates are offered, not applied on their own" });
        return;
      }
    }
    const change = { id: r.id, from, to };
    if (pinned) {
      out.offered.push({ ...change, why: "it's pinned to its version" });
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

  /** Puts the new version in place, the previous one kept beside it, and reads it. */
  async #swap(r: PluginRecord, root: string, treeHash: string, provenance: PluginProvenance): Promise<void> {
    const dest = join(this.#o.pluginsDir, r.id);
    const previous = join(this.#o.pluginsDir, `.${r.id}.previous-${randomBytes(6).toString("hex")}`);
    renameSync(dest, previous);
    try {
      renameSync(root, dest);
    } catch (err) {
      renameSync(previous, dest);
      throw new ContractError("failed", `${r.id} couldn't be moved into the plugins folder: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    this.#kept.set(r.id, { folder: previous, treeHash: r.treeHash ?? "", provenance: r.provenance, to: treeHash });
    await this.#o.folders.updated(r.id, treeHash, provenance);
    await this.#settle(r.id);
  }

  /** The new version's fate: running on its OK lets the previous go; refused, invalid or blocked brings it back; the
   *  rest (waiting for its OK, starting) waits. */
  async #settle(id: string): Promise<void> {
    const k = this.#kept.get(id);
    if (k === undefined) return;
    const r = this.#o.registry.get(id);
    if (r === undefined) return;
    if (r.treeHash !== k.to) return;
    if (r.state === "running" || (r.state === "off" && r.okHash === k.to) || (r.state === "waiting" && r.okHash === k.to)) {
      this.#drop(id);
      return;
    }
    if (r.state === "refused" || r.state === "invalid" || r.state === "blocked" || r.state === "stopped") {
      this.#o.log?.(`update of ${id}: the new version is ${r.state}${r.reason ? ` (${r.reason})` : ""}; the previous one comes back`);
      this.#kept.delete(id);
      const dest = join(this.#o.pluginsDir, id);
      const failed = join(this.#o.pluginsDir, `.${id}.failed-${randomBytes(6).toString("hex")}`);
      try {
        renameSync(dest, failed);
        renameSync(k.folder, dest);
      } finally {
        rmSync(failed, { recursive: true, force: true });
      }
      await this.#o.folders.updated(id, k.treeHash, k.provenance);
    }
  }

  #drop(id: string): void {
    const k = this.#kept.get(id);
    this.#kept.delete(id);
    if (k !== undefined) rmSync(k.folder, { recursive: true, force: true });
  }
}
