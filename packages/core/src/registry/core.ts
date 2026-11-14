// The registry's state machine (spec §5.1, §5.4, §5.6; the PluginRegistry contract): the plugins it holds, their
// OKs, refusals and switches, kept in the registry's records, with OK cards raised through `OkCardRaiser`. Snapshots
// come from the contract's rules (`computeRegistry`), as the fake's do, so the conformance suite pins both. Where
// plugins come from (folders, their tree hashes and what a change since the OK does) is `folders.ts`'s; this takes
// each one as a `RegistryInput`.
import { APP_PARTS_SUFFIX, BUNDLED_ROOT_PLUGIN, NOT_AVAILABLE_YET, type PluginClass, type PluginProvenance, type PluginSource, type PluginState, type ValidationIssue } from "@waifucave/clover-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type {
  ApproveResult, Contribution, InstallFrom, PluginRecord, PluginRegistry, RegisteredPoint, RegistryChange, SwitchResult,
} from "../contracts/plugin-registry";
import {
  EMPTY_SNAPSHOT, computeRegistry, parentOf, registryChanges, type RegistryPlugin, type RegistrySnapshot,
} from "../contracts/plugin-registry-rules";
import type { CoreEntries, Manifest, PointDecl } from "../contracts/sdk-types";
import { botNameOf, contributionLabels, mayHoldCapability, pluginParts } from "@waifucave/clover-plugin-sdk";
import type { ChangeKind } from "./changes";
import type { PluginState as StoredState, RegistryStore } from "./state";

/** A plugin as its folder shows it now (the fake's `FakePluginInput`, field for field). */
export interface RegistryInput {
  id: string;
  manifest: Manifest;
  source?: PluginSource;
  /** True only for a tree OK'd already (bundled, a development folder); false for one that waits for the user's OK.
   *  Undefined keeps what the records say for this id, and with no record for it, means not approved: nothing is
   *  approved by default. */
  approved?: boolean;
  enabled?: boolean;
  invalid?: string;
  folder?: string;
  issues?: ValidationIssue[];
  class?: PluginClass;
  provenance?: PluginProvenance;
  dev?: boolean;
  treeHash?: string;
  /** What a change since the OK does (§5.6, `classifyChange`); default `asks-again`. */
  change?: ChangeKind;
  /** A plugin a bot built (the workshop rule, §5.6): `change` is judged against the user's last OK whatever came between
   *  (a change that asked, the user's no), so one that takes a request back out applies and runs again with no card. */
  workshop?: boolean;
}

/** Raises a plugin's OK card and reports the user's answer once (an unanswered card never refuses, rule 6). */
export interface OkCardRaiser {
  raise(
    req: { id: string; treeHash: string; children: { id: string; label: string; checked: boolean }[] },
    answered: (a: { approved: boolean; children?: readonly string[] }) => void,
    /** Aborted when the card is no longer the plugin's question (its tree moved on, or it no longer asks): the card goes. */
    opts?: { signal?: AbortSignal },
  ): string | Promise<string>;
}

/** Card ids and no answers: the registry alone, for tests and a core without a broker. */
export function idleOkCards(): OkCardRaiser {
  let seq = 0;
  return { raise: () => `card_ok${String(++seq).padStart(6, "0")}` };
}

export interface RegistryCoreOptions {
  catalog: (name: string) => PointDecl | undefined;
  store: RegistryStore;
  cards?: OkCardRaiser;
  now?: () => number;
  /** A plugin's OK was answered or a folder changed: the folder layer keeps the OK'd tree's snapshot. */
  onOk?: (id: string, treeHash: string) => void;
  /** This computer's platform, for plugins' `platforms` (`thisPlatform()`); absent, none is held to it. */
  platform?: string;
}

/** This computer's platform as a manifest's `platforms` names it (`darwin-arm64`, `windows-x64`, `linux-x64`,
 *  `linux-arm64`); another (an Intel Mac) is named the same way and matches no list that leaves it out. */
export function thisPlatform(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform;
  return `${os}-${process.arch}`;
}

interface Held {
  input: RegistryInput;
  hash: string;
  enabled: boolean;
  approved: boolean;
  refused: boolean;
  okHash?: string;
  cardHeld: boolean;
  stopped?: string;
  /** Its client didn't build at load (`client-builds.ts`), for this tree only. */
  buildFailed?: { hash: string; reason: string };
  /** Its parts beside its bot are switched on (§5.5, the owner's rule of November 14): their own switch. */
  appParts: boolean;
}

const stableHash = (m: Manifest) => `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(m)).digest("hex")}`;

export class RegistryCore implements PluginRegistry {
  readonly #plugins = new Map<string, Held>();
  readonly #listeners = new Listeners<RegistryChange>();
  readonly #okCardListeners = new Listeners<{ id: string; card: string }>();
  readonly #treeListeners = new Listeners<{ id: string }>();
  readonly #okCards = new Map<string, { card: string; treeHash: string; withdraw?: AbortController }>();
  /** Installed plugins' records a development folder stood over, kept after it went (until read again or removed). */
  readonly #devKept = new Set<string>();
  /** An OK card being raised, by plugin: a second switch or install while it waits joins it (#397's review), so one
   *  plugin never gets two cards for one tree. */
  readonly #raising = new Map<string, { treeHash: string; card: Promise<string> }>();
  readonly #o: RegistryCoreOptions;
  readonly #cards: OkCardRaiser;
  #state;
  #adult: boolean;
  #snap: RegistrySnapshot = EMPTY_SNAPSHOT;

  constructor(opts: RegistryCoreOptions) {
    this.#o = opts;
    this.#cards = opts.cards ?? idleOkCards();
    this.#state = opts.store.load();
    this.#adult = opts.store.adultConfirmed();
  }

  list(): PluginRecord[] {
    return [...this.#snap.records.values()].map((r) => structuredClone(r));
  }

  get(id: string): PluginRecord | undefined {
    const r = this.#snap.records.get(id);
    return r ? structuredClone(r) : undefined;
  }

  entries<P extends keyof CoreEntries>(point: P): Contribution<CoreEntries[P]>[];
  entries(point: string): Contribution[];
  entries(point: string): Contribution[] {
    return (this.#snap.entries.get(point) ?? []).map((c) => structuredClone(c));
  }

  points(): RegisteredPoint[] {
    return this.#snap.points.map((p) => structuredClone(p));
  }

  async setEnabled(id: string, enabled: boolean, opts: { part?: "app" } = {}): Promise<SwitchResult> {
    const held = this.#mustGet(id);
    const state = this.#snap.records.get(id)?.state;
    if (opts.part === "app") {
      // Only its parts beside its bot (§5.5): the bot and the plugin's own switch stay as they are.
      if (this.#snap.records.get(id)?.parts === undefined) throw new ContractError("refused", `${id} has no parts beside a bot to switch`);
      if (state === "refused" || state === "invalid") throw new ContractError("refused", `${id} is ${state}; it can't be switched`);
      // A found plugin's parts come on with its OK, by the card's checkbox for them.
      if (enabled && state === "found") return { applied: false, card: await this.#raiseOk(parentOf(id) ?? id) };
      held.appParts = enabled;
      this.#update();
      return { applied: true };
    }
    if (id === BUNDLED_ROOT_PLUGIN && held.input.source === "bundled" && !enabled) throw new ContractError("refused", "Clover's own plugin holds Settings; it stays on");
    if (state === "refused" || state === "invalid") throw new ContractError("refused", `${id} is ${state}; it can't be switched`);
    // The rules' not-yet state (the mark in Clover's own tree): its switch stays as it is.
    if (state === "off" && this.#snap.records.get(id)?.reason === NOT_AVAILABLE_YET) {
      throw new ContractError("refused", `${id} isn't available in this build yet, so it can't be turned on or off`);
    }
    // A found plugin's switch is its sealed OK card (S2): nothing loads until the user's yes on it.
    if (enabled && state === "found") return { applied: false, card: await this.#raiseOk(parentOf(id) ?? id) };
    held.enabled = enabled;
    this.#update();
    return { applied: true };
  }

  async installed(id: string, _from: InstallFrom): Promise<{ state: PluginState; card?: string }> {
    this.#mustGet(id);
    const state = this.#snap.records.get(id)!.state;
    // From anywhere, the same sealed OK card (S1): no install is the OK.
    if (state !== "found") return { state };
    return { state, card: await this.#raiseOk(id) };
  }

  /** The OK cards waiting, by plugin. */
  okCards(): { id: string; card: string; treeHash: string }[] {
    return [...this.#okCards].map(([id, c]) => ({ id, card: c.card, treeHash: c.treeHash }));
  }

  async approve(id: string, treeHash: string, selection: Readonly<Record<string, boolean>> = {}): Promise<ApproveResult> {
    const held = this.#mustGet(id);
    if (held.hash !== treeHash) return "changed";
    held.approved = true;
    held.refused = false;
    held.okHash = treeHash;
    held.cardHeld = false;
    this.#okCards.delete(id);
    // One OK covers the tree (§5.6): its children, which share its tree hash, are OK'd with it; each one's checkbox is
    // its switch.
    for (const [child, c] of this.#plugins) {
      if (parentOf(child) !== id || c.hash !== treeHash) continue;
      c.approved = true;
      c.refused = false;
      c.okHash = treeHash;
    }
    for (const [child, on] of Object.entries(selection)) {
      const c = this.#plugins.get(child);
      if (c && parentOf(child) === id) c.enabled = on;
      // The checkbox for a plugin's parts beside its bot (`<id>#app`, §5.5): its own, or a child's that holds a bot.
      if (child.endsWith(APP_PARTS_SUFFIX)) {
        const owner = child.slice(0, -APP_PARTS_SUFFIX.length);
        const o = this.#plugins.get(owner);
        if (o && (owner === id || parentOf(owner) === id)) o.appParts = on;
      }
    }
    if (held.input.dev !== true) this.#o.onOk?.(id, treeHash);
    this.#update();
    return "approved";
  }

  async refuse(id: string): Promise<void> {
    this.#mustGet(id).refused = true;
    this.#okCards.delete(id);
    this.#update();
  }

  watch(fn: (change: RegistryChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  /** A plugin's tree changed under its id (its tree hash or version: an update applied, a folder edited) while nothing
   *  `watch` reports changed with it (its state, reason or what it waits for). */
  watchTrees(fn: (changed: { id: string }) => void): Unsubscribe {
    return this.#treeListeners.add(fn);
  }

  /** A plugin's OK card was raised (it waits, found, for the user's answer): its id and the card's. */
  watchOkCards(fn: (raised: { id: string; card: string }) => void): Unsubscribe {
    return this.#okCardListeners.add(fn);
  }

  /** A folder appeared or changed. A refused plugin is asked about again once its folder changes (§5.1). */
  put(input: RegistryInput): void {
    this.#hold(input);
    this.#update();
  }

  /** Several folders at once (a scan), with one recompute. */
  putAll(inputs: readonly RegistryInput[], removed: readonly string[] = []): void {
    for (const id of removed) this.#drop(id);
    for (const i of inputs) this.#hold(i);
    this.#update();
  }

  /** A folder went away; its children go with it, and so does its place in the records (a removal syncs as a delete). */
  remove(id: string): void {
    // An id held by nothing here: what the records still kept for it (an installed plugin a development folder stood
    // over) goes too, so a different tree found later under the id asks fresh.
    if (!this.#plugins.has(id)) this.forgetInstalled(id);
    this.#drop(id);
    this.#update();
  }

  /** The installed plugin under `id` is gone (its folder deleted, while a development folder stood over it or after):
   *  its kept record and its OK snapshot are forgotten, so a tree found later under the id asks for its OK fresh. */
  forgetInstalled(id: string): void {
    for (const key of Object.keys(this.#state.plugins)) {
      if (key !== id && parentOf(key) !== id) continue;
      delete this.#state.plugins[key];
      this.#devKept.delete(key);
    }
    this.#state.order = this.#state.order.filter((k) => k !== id && parentOf(k) !== id);
    this.#o.store.saveOk(id, undefined);
    this.#o.store.save(structuredClone(this.#state));
  }

  /** The plugin host stopped it after crashes (reason), or the user restarted it (null). */
  setStopped(id: string, reason: string | null): void {
    const held = this.#mustGet(id);
    if (reason === null) delete held.stopped;
    else held.stopped = reason;
    this.#update();
  }

  /** Its client didn't build at load for `treeHash` (the reason, the bundler's message made plain), or that is over
   *  (null): the plugin is `invalid` with it while its tree is that one. A tree that moved on drops it. */
  setBuildFailure(id: string, treeHash: string, reason: string | null): void {
    const held = this.#plugins.get(id);
    if (held === undefined || held.hash !== treeHash) return;
    if (reason === null) {
      if (held.buildFailed === undefined) return;
      delete held.buildFailed;
    } else held.buildFailed = { hash: treeHash, reason: reason.slice(0, 2000) };
    this.#update();
  }

  /** Whether the user has confirmed they are 18 or older (§5.7). */
  get adultConfirmed(): boolean {
    return this.#adult;
  }

  /** The user confirmed they are 18 or older (§5.7). */
  confirmAdult(): void {
    this.#adult = true;
    this.#o.store.confirmAdult(this.#o.now?.() ?? Date.now());
    this.#update();
  }

  /** The tree hash a plugin's folder has now, if it is held. */
  treeHashOf(id: string): string | undefined {
    return this.#plugins.get(id)?.hash;
  }

  #drop(id: string): void {
    // A development folder going away isn't the installed plugin's removal: it never wrote the records (§5.6), so the
    // installed one it stood in for keeps its OK, its switch and its place, and comes back with them.
    const dev = this.#plugins.get(id)?.input.dev === true;
    for (const key of [...this.#plugins.keys()]) {
      if (key !== id && parentOf(key) !== id) continue;
      this.#plugins.delete(key);
      if (!dev) {
        delete this.#state.plugins[key];
        this.#devKept.delete(key);
      } else if (this.#state.plugins[key] !== undefined) this.#devKept.add(key);
      this.#withdrawOk(key);
    }
    if (!dev) this.#state.order = this.#state.order.filter((k) => k !== id && parentOf(k) !== id);
  }

  async #raiseOk(id: string): Promise<string> {
    const held = this.#mustGet(id);
    const waiting = this.#okCards.get(id);
    if (waiting?.treeHash === held.hash) return waiting.card;
    // One card per pending question: the card for a tree that has since changed goes as the new one comes.
    if (waiting !== undefined) this.#withdrawOk(id);
    const inFlight = this.#raising.get(id);
    if (inFlight?.treeHash === held.hash) return inFlight.card;
    const card = this.#raiseOkNow(id, held.hash);
    this.#raising.set(id, { treeHash: held.hash, card });
    try {
      return await card;
    } finally {
      if (this.#raising.get(id)?.card === card) this.#raising.delete(id);
    }
  }

  /** The plugin's waiting OK card is no longer its question: withdrawn from the user, and forgotten. */
  #withdrawOk(id: string): void {
    const waiting = this.#okCards.get(id);
    if (waiting === undefined) return;
    this.#okCards.delete(id);
    waiting.withdraw?.abort();
  }

  async #raiseOkNow(id: string, treeHash: string): Promise<string> {
    const children = [...this.#plugins.entries()]
      .filter(([k]) => parentOf(k) === id)
      .map(([k, c]) => ({ id: k, label: String(typeof c.input.manifest.name === "string" ? c.input.manifest.name : k), checked: c.enabled }));
    // A plugin with a bot and parts beside it (§5.5): one more checkbox, for those parts, ticked as they are switched.
    for (const k of [id, ...children.map((c) => c.id)]) {
      if (this.#snap.records.get(k)?.parts === undefined) continue;
      const bot = botNameOf(this.#plugins.get(k)!.input.manifest) ?? k;
      children.push({ id: `${k}${APP_PARTS_SUFFIX}`, label: `Its parts beyond ${bot}'s tab`, checked: this.#plugins.get(k)!.appParts });
    }
    let card = "";
    const withdraw = new AbortController();
    const raised = this.#cards.raise({ id, treeHash, children }, (a) => {
      if (this.#okCards.get(id)?.card !== card) return;
      if (!a.approved) return void this.refuse(id);
      const picked = new Set(a.children ?? children.filter((c) => c.checked).map((c) => c.id));
      void this.approve(id, treeHash, Object.fromEntries(children.map((c) => [c.id, picked.has(c.id)])));
    }, { signal: withdraw.signal });
    card = await raised;
    // Its tree moved on while the card was being raised: this one is no longer the question.
    if (this.#plugins.get(id)?.hash !== treeHash) {
      withdraw.abort();
      return card;
    }
    this.#okCards.set(id, { card, treeHash, withdraw });
    this.#okCardListeners.emit({ id, card });
    return card;
  }

  #hold(input: RegistryInput): void {
    const parent = parentOf(input.id);
    const defaultEnabled = parent === undefined ? true : (input.manifest.enabledByDefault ?? true);
    const hash = input.treeHash ?? stableHash(input.manifest);
    const stored: StoredState | undefined = this.#state.plugins[input.id];
    const prev: Pick<Held, "hash" | "approved" | "refused" | "okHash" | "cardHeld" | "enabled"> | undefined = this.#plugins.get(input.id)
      ?? (stored?.okHash !== undefined || stored?.refusedHash !== undefined
        ? {
          hash: stored.refusedHash ?? stored.okHash!, approved: stored.okHash !== undefined, refused: stored.refusedHash !== undefined,
          ...(stored.okHash === undefined ? {} : { okHash: stored.okHash }), cardHeld: stored.cardHeld ?? false, enabled: stored.enabled ?? defaultEnabled,
        }
        : undefined);
    let approved: boolean;
    let okHash: string | undefined;
    let cardHeld = false;
    // A found folder's `approved: false` says the records hold no OK for it; it never undoes the OK this core holds for
    // this very tree (a folder read that loaded the records before the user's answer landed, and puts after it: the
    // install's settle racing its OK card). A changed tree is judged below, as any change.
    const okHeld = prev !== undefined && prev.approved && !prev.refused && prev.hash === hash && prev.okHash === hash;
    if (input.approved === true || (input.approved === false && !okHeld)) {
      approved = input.approved;
      okHash = approved ? hash : prev?.okHash;
    } else if (prev === undefined) {
      // Never seen and no record: not approved (lane J's question: nothing arrives OK'd by default). Only
      // `approved: true` approves (the bundled and development-folder paths), or the user's OK. A child is covered by
      // its parent's OK of this very tree (a child carries its tree's hash, so a parent OK'd for it, by its card or by
      // a change that applies, OK'd the child with it); held after its parent, it reads that.
      const parentHeld = parent !== undefined ? this.#plugins.get(parent) : undefined;
      approved = parentHeld !== undefined && parentHeld.approved && !parentHeld.refused && parentHeld.okHash === hash;
      okHash = approved ? hash : undefined;
    } else if (prev.hash === hash) {
      ({ approved, okHash, cardHeld } = prev);
    } else {
      const change = input.change ?? "asks-again";
      okHash = prev.okHash;
      // A workshop plugin's change is judged against the last OK, whatever came between (the controller's ruling).
      const againstLastOk = input.workshop === true && prev.okHash !== undefined;
      if (change === "asks-again" || (!againstLastOk && (!prev.approved || prev.refused))) approved = false;
      else if (change === "card-styling") [approved, cardHeld] = [true, true];
      else [approved, okHash, cardHeld] = [true, hash, prev.cardHeld];
    }
    // A development folder's tree is never an OK of the installed plugin it stands over (the review of 6047b427f): its
    // OK snapshot isn't kept under the id, so the installed tree is judged against its own OK after it goes.
    if (approved && okHash === hash && prev?.okHash !== hash && input.dev !== true) this.#o.onOk?.(input.id, hash);
    // A card waiting on a tree that now runs under its OK (a workshop change that took its request back out) goes.
    if (approved && this.#okCards.has(input.id)) this.#withdrawOk(input.id);
    // A client that didn't build stays so while the tree is the same one (a folder read again doesn't retry it).
    const failed = this.#plugins.get(input.id)?.buildFailed;
    this.#plugins.set(input.id, {
      ...(failed !== undefined && failed.hash === hash ? { buildFailed: failed } : {}),
      input: structuredClone(input),
      hash,
      enabled: input.enabled ?? prev?.enabled ?? stored?.enabled ?? defaultEnabled,
      approved,
      refused: prev !== undefined && prev.refused && prev.hash === hash,
      ...(okHash === undefined ? {} : { okHash }),
      cardHeld,
      appParts: this.#plugins.get(input.id)?.appParts ?? stored?.appParts ?? true,
    });
  }

  #mustGet(id: string): Held {
    const held = this.#plugins.get(id);
    if (!held) throw new ContractError("not_found", `no plugin ${id}`);
    return held;
  }

  /** The held plugins in the synced list's order: the records' order first, new ones after, each child after its
   *  parent. */
  #ordered(): string[] {
    const known = new Map(this.#state.order.map((id, i) => [id, i]));
    const tops = [...this.#plugins.keys()].filter((id) => parentOf(id) === undefined);
    const rank = (id: string) => known.get(id) ?? Number.MAX_SAFE_INTEGER;
    const inserted = new Map(tops.map((id, i) => [id, i]));
    tops.sort((a, b) => rank(a) - rank(b) || inserted.get(a)! - inserted.get(b)!);
    const out: string[] = [];
    for (const top of tops) {
      out.push(top);
      for (const id of this.#plugins.keys()) if (parentOf(id) === top) out.push(id);
    }
    return out;
  }

  #update(): void {
    const ids = this.#ordered();
    const plugins = new Map<string, RegistryPlugin>();
    for (const id of ids) {
      const h = this.#plugins.get(id)!;
      const i = h.input;
      const p: RegistryPlugin = { id, manifest: i.manifest, approved: h.approved, refused: h.refused, enabled: h.enabled, hash: h.hash, cardHeld: h.cardHeld };
      if (!h.appParts) p.appParts = false;
      // Its parts beside its bot (§5.5), as the SDK reads its manifest (a child's scope defaults to its top plugin's).
      const beside = pluginParts(i.manifest, this.#plugins.get(parentOf(id) ?? id)?.input.manifest).beside;
      if (beside.length > 0) p.beside = { refs: beside.map((b) => b.ref), kinds: beside.map((b) => b.kind) };
      if (i.source !== undefined) p.source = i.source;
      if (h.okHash !== undefined) p.okHash = h.okHash;
      if (i.invalid !== undefined) p.invalid = i.invalid;
      else if (h.buildFailed !== undefined && h.buildFailed.hash === h.hash) p.invalid = h.buildFailed.reason;
      if (h.stopped !== undefined) p.stopped = h.stopped;
      if (i.folder !== undefined) p.folder = i.folder;
      if (i.issues !== undefined) p.issues = i.issues;
      if (i.class !== undefined) p.class = i.class;
      if (i.provenance !== undefined) p.provenance = i.provenance;
      if (i.dev !== undefined) p.dev = i.dev;
      plugins.set(id, p);
    }
    this.#persist(ids);
    const before = this.#snap;
    this.#snap = computeRegistry(plugins, { catalog: this.#o.catalog, adultConfirmed: this.#adult, mayHold: mayHoldCapability, labels: contributionLabels, ...(this.#o.platform !== undefined ? { platform: this.#o.platform } : {}) });
    const changes = registryChanges(before, this.#snap);
    for (const change of changes) this.#listeners.emit(change);
    // A plugin whose tree changed under the same id (an update applied, a folder edited) and is still there, when the
    // changes above didn't already name it.
    const named = new Set(changes.flatMap((c) => (c.type === "plugin" ? [c.id] : [])));
    for (const [id, rec] of this.#snap.records) {
      const was = before.records.get(id);
      if (was !== undefined && !named.has(id) && (was.treeHash !== rec.treeHash || was.version !== rec.version)) this.#treeListeners.emit({ id });
    }
  }

  #persist(ids: readonly string[]): void {
    const plugins: Record<string, StoredState> = {};
    for (const id of ids) {
      const h = this.#plugins.get(id)!;
      if (h.input.dev) {
        // A development folder never syncs (§5.6): the installed plugin it stands in for keeps its records.
        const kept = this.#state.plugins[id];
        if (kept) plugins[id] = kept;
        continue;
      }
      const s: StoredState = { enabled: h.enabled };
      if (h.input.source !== undefined) s.source = h.input.source;
      if (h.input.provenance !== undefined) s.provenance = h.input.provenance;
      if (h.okHash !== undefined) s.okHash = h.okHash;
      if (h.refused) s.refusedHash = h.hash;
      if (h.cardHeld) s.cardHeld = true;
      if (!h.appParts) s.appParts = false;
      plugins[id] = s;
    }
    // Records a development folder stood over while it was on (#drop keeps them): kept until the installed plugin is
    // read again or removed.
    for (const id of this.#devKept) {
      if (this.#plugins.has(id)) this.#devKept.delete(id);
      else if (this.#state.plugins[id] !== undefined) plugins[id] = this.#state.plugins[id]!;
    }
    const order = [...ids.filter((id) => plugins[id] !== undefined), ...this.#state.order.filter((id) => !ids.includes(id) && plugins[id] !== undefined)];
    const next = { ...this.#state, order, plugins };
    if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
    this.#state = next;
    this.#o.store.save(next);
  }

  /** The records' development folders (`folders.ts` keeps them). */
  get devFolders() {
    return this.#state.dev;
  }

  set devFolders(dev) {
    this.#state = { ...this.#state, dev };
    this.#o.store.save(this.#state);
  }
}
