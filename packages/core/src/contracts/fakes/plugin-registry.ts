// FakePluginRegistry: plugins given as validated manifests (no folders, no validation), with the registry's rules for
// states, children, waiting points, unique entry ids and namespaces, private points, the OK bound to a tree hash, and
// change order. `put` and `remove` stand for a folder appearing, changing or going away; `setStopped` is what the
// plugin host reports after crashes. The catalog's declarations come in as `catalog` (the plugin SDK's
// `catalogPointDecl`), since the contracts don't import the SDK at run time.
import { createHash } from "node:crypto";
import { BUNDLED_ROOT_PLUGIN, type PluginClass, type PluginProvenance, type PluginSource, type PluginState, type ValidationIssue } from "@waifucave/clover-protocol";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import {
  type ApproveResult, type Contribution, type InstallFrom, type PluginRecord, type PluginRegistry, type RegisteredPoint, type RegistryChange,
  type SwitchOptions, type SwitchResult,
} from "../plugin-registry";
import type { CoreEntries, Manifest, PointDecl } from "../sdk-types";
import { EMPTY_SNAPSHOT, computeRegistry, parentOf, registryChanges, type RegistryPlugin, type RegistrySnapshot } from "../plugin-registry-rules";

export interface FakePluginInput {
  /** `<id>`, or `<parent>/<folder>` for a child; a child's parent must be put first. */
  id: string;
  manifest: Manifest;
  source?: PluginSource;
  /** False for a folder found on disk that waits for the user's OK (§5.1). Default true; a child follows its parent. */
  approved?: boolean;
  /** Default true; for a child, its manifest's `enabledByDefault`. */
  enabled?: boolean;
  /** The validator refused it: its reason. */
  invalid?: string;
  /** The index revoked it: the revocation's reason. */
  blocked?: string;
  folder?: string;
  issues?: ValidationIssue[];
  class?: PluginClass;
  provenance?: PluginProvenance;
  dev?: boolean;
  /** `sha256:<hex>`; default a hash of the manifest, so a changed manifest is a changed tree. */
  treeHash?: string;
  /** For a folder that changed after its OK, what the change is (§5.6): `asks-again` (the default) hits a trigger or
   *  changes what runs, so it waits for a new OK; `applies` is another data edit; `card-styling` changes only how it
   *  styles approval cards, which wait for their own OK while the rest applies. */
  change?: "asks-again" | "applies" | "card-styling";
}

export interface FakePluginRegistryOptions {
  /** The catalog's declaration of a well-known name, or undefined for any other: the plugin SDK's `catalogPointDecl`. */
  catalog: (name: string) => PointDecl | undefined;
  plugins?: FakePluginInput[];
  adultConfirmed?: boolean;
}

interface Held {
  input: FakePluginInput;
  hash: string;
  enabled: boolean;
  approved: boolean;
  refused: boolean;
  okHash?: string;
  cardHeld: boolean;
  stopped?: string;
}

const manifestHash = (m: Manifest) => `sha256:${createHash("sha256").update(JSON.stringify(m)).digest("hex")}`;

export class FakePluginRegistry implements PluginRegistry {
  readonly #plugins = new Map<string, Held>();
  readonly #listeners = new Listeners<RegistryChange>();
  readonly #catalog: (name: string) => PointDecl | undefined;
  /** The OK cards raised, by top-level plugin: the card and the tree it shows. */
  readonly #okCards = new Map<string, { card: string; treeHash: string }>();
  #okSeq = 0;
  #adultConfirmed: boolean;
  #snap: RegistrySnapshot = EMPTY_SNAPSHOT;

  constructor(opts: FakePluginRegistryOptions) {
    this.#catalog = opts.catalog;
    this.#adultConfirmed = opts.adultConfirmed ?? false;
    for (const p of opts.plugins ?? []) this.#hold(p);
    this.#snap = this.#compute();
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
      if (opts.from !== "cli" || opts.okHash === undefined) return { applied: false, card: this.#raiseOk(top) };
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
    return { state, card: this.#raiseOk(id) };
  }

  /** The OK cards waiting, by plugin. */
  okCards(): { id: string; card: string; treeHash: string }[] {
    return [...this.#okCards].map(([id, c]) => ({ id, ...c }));
  }

  /** One OK card per plugin and tree: a second ask while it waits gets the same card. */
  #raiseOk(id: string): string {
    const treeHash = this.#mustGet(id).hash;
    const waiting = this.#okCards.get(id);
    if (waiting?.treeHash === treeHash) return waiting.card;
    const card = `card_ok${String(++this.#okSeq).padStart(6, "0")}`;
    this.#okCards.set(id, { card, treeHash });
    return card;
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
  put(input: FakePluginInput): void {
    this.#hold(input);
    this.#update();
  }

  /** A folder went away; its children go with it. */
  remove(id: string): void {
    for (const key of [...this.#plugins.keys()]) if (key === id || parentOf(key) === id) this.#plugins.delete(key);
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
    this.#adultConfirmed = true;
    this.#update();
  }

  /** A folder appears or changes. New: OK'd unless `approved: false` (an install through the app is its OK). Changed
   *  after its OK: by `change` (§5.6). A refused plugin is asked about again once its tree changes. */
  #hold(input: FakePluginInput): void {
    const parent = parentOf(input.id);
    const defaultEnabled = parent === undefined ? true : (input.manifest.enabledByDefault ?? true);
    const hash = input.treeHash ?? manifestHash(input.manifest);
    const prev = this.#plugins.get(input.id);
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
    this.#plugins.set(input.id, {
      input: structuredClone(input),
      hash,
      enabled: input.enabled ?? prev?.enabled ?? defaultEnabled,
      approved,
      refused: prev !== undefined && prev.refused && prev.hash === hash,
      ...(okHash === undefined ? {} : { okHash }),
      cardHeld,
    });
  }

  #mustGet(id: string): Held {
    const held = this.#plugins.get(id);
    if (!held) throw new Error(`no plugin ${id}`);
    return held;
  }

  /** Recomputes, then tells listeners in dependency order. */
  #update(): void {
    const before = this.#snap;
    this.#snap = this.#compute();
    for (const change of registryChanges(before, this.#snap)) this.#listeners.emit(change);
  }

  #compute(): RegistrySnapshot {
    const plugins = new Map<string, RegistryPlugin>();
    for (const [id, h] of this.#plugins) {
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
    return computeRegistry(plugins, { catalog: this.#catalog, adultConfirmed: this.#adultConfirmed });
  }
}
