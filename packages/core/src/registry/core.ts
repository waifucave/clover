// The registry's state machine (spec §5.1, §5.4, §5.6; the PluginRegistry contract): the plugins it holds, their
// OKs, refusals and switches, kept in the registry's records, with OK cards raised through `OkCardRaiser`. Snapshots
// come from the contract's rules (`computeRegistry`), as the fake's do, so the conformance suite pins both. Where
// plugins come from (folders, their tree hashes and what a change since the OK does) is `folders.ts`'s; this takes
// each one as a `RegistryInput`.
import { BUNDLED_ROOT_PLUGIN, type PluginClass, type PluginProvenance, type PluginSource, type PluginState, type ValidationIssue } from "@waifucave/clover-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type {
  ApproveResult, Contribution, InstallFrom, PluginRecord, PluginRegistry, RegisteredPoint, RegistryChange, SwitchOptions, SwitchResult,
} from "../contracts/plugin-registry";
import {
  EMPTY_SNAPSHOT, computeRegistry, parentOf, registryChanges, type RegistryPlugin, type RegistrySnapshot,
} from "../contracts/plugin-registry-rules";
import type { CoreEntries, Manifest, PointDecl } from "../contracts/sdk-types";
import type { ChangeKind } from "./changes";
import type { PluginState as StoredState, RegistryStore } from "./state";

/** A plugin as its folder shows it now (the fake's `FakePluginInput`, field for field). */
export interface RegistryInput {
  id: string;
  manifest: Manifest;
  source?: PluginSource;
  /** False for a folder that waits for the user's OK; true for one OK'd already (bundled, or installed by the user
   *  with its OK). Undefined keeps what the records say, and a plugin seen for the first time is OK'd. */
  approved?: boolean;
  enabled?: boolean;
  invalid?: string;
  blocked?: string;
  folder?: string;
  issues?: ValidationIssue[];
  class?: PluginClass;
  provenance?: PluginProvenance;
  dev?: boolean;
  treeHash?: string;
  /** What a change since the OK does (§5.6, `classifyChange`); default `asks-again`. */
  change?: ChangeKind;
}

/** Raises a plugin's OK card and reports the user's answer once (an unanswered card never refuses, rule 6). */
export interface OkCardRaiser {
  raise(
    req: { id: string; treeHash: string; children: { id: string; label: string; checked: boolean }[] },
    answered: (a: { approved: boolean; children?: readonly string[] }) => void,
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
}

const stableHash = (m: Manifest) => `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(m)).digest("hex")}`;

export class RegistryCore implements PluginRegistry {
  readonly #plugins = new Map<string, Held>();
  readonly #listeners = new Listeners<RegistryChange>();
  readonly #okCards = new Map<string, { card: string; treeHash: string }>();
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

  async setEnabled(id: string, enabled: boolean, opts: SwitchOptions = {}): Promise<SwitchResult> {
    const held = this.#mustGet(id);
    const state = this.#snap.records.get(id)?.state;
    if (id === BUNDLED_ROOT_PLUGIN && held.input.source === "bundled") throw new ContractError("refused", "Clover's own plugin is always on");
    if (state === "blocked" || state === "refused" || state === "invalid") throw new ContractError("refused", `${id} is ${state}; it can't be switched`);
    if (enabled && state === "found") {
      const top = parentOf(id) ?? id;
      if (opts.from !== "cli" || opts.okHash === undefined) return { applied: false, card: await this.#raiseOk(top) };
      if ((await this.approve(top, opts.okHash)) === "changed") throw new ContractError("conflict", `${top} changed since its OK text was shown`);
    }
    held.enabled = enabled;
    this.#update();
    return { applied: true };
  }

  async installed(id: string, from: InstallFrom): Promise<{ state: PluginState; card?: string }> {
    this.#mustGet(id);
    const state = this.#snap.records.get(id)!.state;
    if (from === "cli" || state !== "found") return { state };
    return { state, card: await this.#raiseOk(id) };
  }

  /** The OK cards waiting, by plugin. */
  okCards(): { id: string; card: string; treeHash: string }[] {
    return [...this.#okCards].map(([id, c]) => ({ id, ...c }));
  }

  async approve(id: string, treeHash: string, selection: Readonly<Record<string, boolean>> = {}): Promise<ApproveResult> {
    const held = this.#mustGet(id);
    if (held.hash !== treeHash) return "changed";
    held.approved = true;
    held.refused = false;
    held.okHash = treeHash;
    held.cardHeld = false;
    this.#okCards.delete(id);
    for (const [child, on] of Object.entries(selection)) {
      const c = this.#plugins.get(child);
      if (c && parentOf(child) === id) c.enabled = on;
    }
    this.#o.onOk?.(id, treeHash);
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
    this.#drop(id);
    this.#update();
  }

  /** The plugin host stopped it after crashes (reason), or the user restarted it (null). */
  setStopped(id: string, reason: string | null): void {
    const held = this.#mustGet(id);
    if (reason === null) delete held.stopped;
    else held.stopped = reason;
    this.#update();
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
    for (const key of [...this.#plugins.keys()]) {
      if (key !== id && parentOf(key) !== id) continue;
      this.#plugins.delete(key);
      delete this.#state.plugins[key];
      this.#okCards.delete(key);
    }
    this.#state.order = this.#state.order.filter((k) => k !== id && parentOf(k) !== id);
  }

  async #raiseOk(id: string): Promise<string> {
    const held = this.#mustGet(id);
    const waiting = this.#okCards.get(id);
    if (waiting?.treeHash === held.hash) return waiting.card;
    const treeHash = held.hash;
    const children = [...this.#plugins.entries()]
      .filter(([k]) => parentOf(k) === id)
      .map(([k, c]) => ({ id: k, label: String(typeof c.input.manifest.name === "string" ? c.input.manifest.name : k), checked: c.enabled }));
    let card = "";
    const raised = this.#cards.raise({ id, treeHash, children }, (a) => {
      if (this.#okCards.get(id)?.card !== card) return;
      if (!a.approved) return void this.refuse(id);
      const picked = new Set(a.children ?? children.filter((c) => c.checked).map((c) => c.id));
      void this.approve(id, treeHash, Object.fromEntries(children.map((c) => [c.id, picked.has(c.id)])));
    });
    card = await raised;
    this.#okCards.set(id, { card, treeHash });
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
    if (input.approved !== undefined) {
      approved = input.approved;
      okHash = approved ? hash : prev?.okHash;
    } else if (prev === undefined) {
      approved = true;
      okHash = hash;
    } else if (prev.hash === hash) {
      ({ approved, okHash, cardHeld } = prev);
    } else {
      const change = input.change ?? "asks-again";
      okHash = prev.okHash;
      if (!prev.approved || prev.refused || change === "asks-again") approved = false;
      else if (change === "card-styling") [approved, cardHeld] = [true, true];
      else [approved, okHash, cardHeld] = [true, hash, prev.cardHeld];
    }
    if (approved && okHash === hash && prev?.okHash !== hash) this.#o.onOk?.(input.id, hash);
    this.#plugins.set(input.id, {
      input: structuredClone(input),
      hash,
      enabled: input.enabled ?? prev?.enabled ?? stored?.enabled ?? defaultEnabled,
      approved,
      refused: prev !== undefined && prev.refused && prev.hash === hash,
      ...(okHash === undefined ? {} : { okHash }),
      cardHeld,
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
      if (i.source !== undefined) p.source = i.source;
      if (h.okHash !== undefined) p.okHash = h.okHash;
      if (i.invalid !== undefined) p.invalid = i.invalid;
      if (i.blocked !== undefined) p.blocked = i.blocked;
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
    this.#snap = computeRegistry(plugins, { catalog: this.#o.catalog, adultConfirmed: this.#adult });
    for (const change of registryChanges(before, this.#snap)) this.#listeners.emit(change);
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
      plugins[id] = s;
    }
    const order = ids.filter((id) => plugins[id] !== undefined);
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
