// FakePluginRegistry: plugins given as validated manifests (no folders, no validation), with the registry's rules for
// states, children, waiting points, unique entry ids and namespaces, private points, the OK bound to a tree hash, and
// change order. `put` and `remove` stand for a folder appearing, changing or going away; `setStopped` is what the
// plugin host reports after crashes. The catalog's declarations come in as `catalog` (the plugin SDK's
// `catalogPointDecl`), since the contracts don't import the SDK at run time.
import { createHash } from "node:crypto";
import type { PluginClass, PluginProvenance, PluginSource, PluginState, ValidationIssue } from "@waifucave/clover-protocol";
import { Listeners, type Unsubscribe } from "../common";
import {
  CORE_SPOTS, UNIQUE_ENTRY_FIELD,
  type ApproveResult, type Contribution, type PluginRecord, type PluginRegistry, type RegisteredPoint, type RegistryChange,
} from "../plugin-registry";
import type { CoreEntries, Manifest, PointDecl } from "../sdk-types";

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

interface Snapshot {
  records: Map<string, PluginRecord>;
  entries: Map<string, Contribution[]>;
  points: RegisteredPoint[];
}

const ARRAY_POINTS = new Set([
  "models", "skills", "agents", "agentBackends", "hooks", "commands", "triggers", "voices", "computerProviders",
  "relays", "notifiers", "companions", "themes", "locales", "ui",
]);
const SINGLE_POINTS = new Set(["bot", "computer"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const parentOf = (id: string): string | undefined => (id.includes("/") ? id.slice(0, id.indexOf("/")) : undefined);

export class FakePluginRegistry implements PluginRegistry {
  readonly #plugins = new Map<string, Held>();
  readonly #listeners = new Listeners<RegistryChange>();
  readonly #catalog: (name: string) => PointDecl | undefined;
  #adultConfirmed: boolean;
  #snap: Snapshot = { records: new Map(), entries: new Map(), points: [] };

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

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.#mustGet(id).enabled = enabled;
    this.#update();
  }

  async approve(id: string, treeHash: string, selection: Readonly<Record<string, boolean>> = {}): Promise<ApproveResult> {
    const held = this.#mustGet(id);
    if (held.hash !== treeHash) return "changed";
    held.approved = true;
    held.refused = false;
    held.okHash = treeHash;
    held.cardHeld = false;
    for (const [child, on] of Object.entries(selection)) {
      const c = this.#plugins.get(child);
      if (c && parentOf(child) === id) c.enabled = on;
    }
    this.#update();
    return "approved";
  }

  async refuse(id: string): Promise<void> {
    this.#mustGet(id).refused = true;
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
    const after = this.#compute();
    this.#snap = after;
    const pluginChanges: RegistryChange[] = [];
    const removed: RegistryChange[] = [];
    let anyStopped = false;
    for (const [id, rec] of after.records) {
      const was = before.records.get(id);
      if (!was || was.state !== rec.state || was.reason !== rec.reason || JSON.stringify(was.waitingFor) !== JSON.stringify(rec.waitingFor)) {
        pluginChanges.push({ type: "plugin", id, state: rec.state });
        if (was && (was.state === "running" || was.state === "waiting") && rec.state !== "running" && rec.state !== "waiting") anyStopped = true;
      }
    }
    for (const id of before.records.keys()) if (!after.records.has(id)) {
      removed.push({ type: "removed", id });
      anyStopped = true;
    }
    const entryChanges: RegistryChange[] = [];
    for (const point of new Set([...before.entries.keys(), ...after.entries.keys()])) {
      if (JSON.stringify(before.entries.get(point) ?? []) !== JSON.stringify(after.entries.get(point) ?? [])) entryChanges.push({ type: "entries", point });
    }
    // Stopping: the entries that depended on what stopped change first, then the dependents, then what stopped.
    const live = (c: RegistryChange) => c.type === "plugin" && (c.state === "running" || c.state === "waiting");
    const order = anyStopped
      ? [...entryChanges, ...pluginChanges.filter(live), ...pluginChanges.filter((c) => !live(c)), ...removed]
      : [...pluginChanges, ...removed, ...entryChanges];
    for (const change of order) this.#listeners.emit(change);
  }

  #compute(): Snapshot {
    const ids = [...this.#plugins.keys()];
    const topOf = (id: string) => this.#plugins.get(parentOf(id) ?? id);
    // Who is on, before points: approved, valid, not blocked, refused, stopped or off, its parent on too, and its
    // namespace not taken by a plugin earlier in the synced list (§6.7).
    const offReason = new Map<string, { state: PluginState; reason?: string }>();
    const namespaces = new Map<string, string>();
    const namespaceOf = (id: string) => topOf(id)?.input.manifest.namespace ?? (parentOf(id) ?? id);
    for (const id of ids) {
      const held = this.#plugins.get(id)!;
      const top = topOf(id);
      const parentId = parentOf(id);
      const parentOff = parentId !== undefined && offReason.has(parentId);
      const adult = top?.input.manifest.adult === true;
      if (held.input.blocked !== undefined) offReason.set(id, { state: "blocked", reason: held.input.blocked });
      else if (held.input.invalid !== undefined) offReason.set(id, { state: "invalid", reason: held.input.invalid });
      else if (held.refused || (top?.refused ?? false)) offReason.set(id, { state: "refused" });
      else if (!held.approved || !(top?.approved ?? true)) offReason.set(id, { state: "found", reason: "waiting for your OK" });
      else if (held.stopped !== undefined) offReason.set(id, { state: "stopped", reason: `plugin stopped: ${held.stopped}` });
      else if (!held.enabled) offReason.set(id, { state: "off" });
      else if (parentOff) offReason.set(id, { state: "off", reason: "its parent is off" });
      else if (adult && !this.#adultConfirmed) offReason.set(id, { state: "off", reason: "may contain adult content: off until you confirm you are 18 or older" });
      else if (parentId === undefined && namespaces.has(namespaceOf(id))) {
        offReason.set(id, { state: "off", reason: `the namespace \`${namespaceOf(id)}\` is \`${namespaces.get(namespaceOf(id))}\`'s` });
      }
      if (parentId === undefined && !offReason.has(id)) namespaces.set(namespaceOf(id), id);
    }
    const on = ids.filter((id) => !offReason.has(id));

    // Every entry of every plugin that is on.
    const all: Contribution[] = [];
    for (const id of on) all.push(...this.#entriesOf(id));

    // Unique entry ids among enabled plugins: the first in the synced order keeps one (§5.1).
    const owners = new Map<string, string>();
    for (const c of all) {
      const field = UNIQUE_ENTRY_FIELD[c.point as keyof CoreEntries];
      const unique = field !== undefined || c.point === "commands";
      if (!unique || c.entryId === undefined) continue;
      const k = `${c.point}\u0000${c.entryId}`;
      const owner = owners.get(k);
      if (owner === undefined) owners.set(k, c.pluginId);
      else if (owner !== c.pluginId) {
        c.state = "refused";
        c.reason = `\`${c.entryId}\` is taken by \`${owner}\``;
      }
    }

    // Points: the core's, then what active entries and running hosts declare, grown to a fixed point.
    const declarations = (active: Contribution[]) => {
      const out: { name: string; decl: PointDecl; pluginId: string; ref: string }[] = [];
      for (const id of on) {
        const host = this.#plugins.get(id)!.input.manifest.host;
        for (const [name, decl] of Object.entries(host?.declares ?? {})) out.push({ name, decl, pluginId: id, ref: "host" });
      }
      for (const c of active) {
        const decl = isObject(c.value) ? (c.value as { declares?: Record<string, PointDecl> }).declares : undefined;
        for (const [name, d] of Object.entries(decl ?? {})) out.push({ name, decl: d, pluginId: c.pluginId, ref: c.ref });
      }
      return out;
    };
    const needsPoint = (c: Contribution): string | undefined => {
      if (c.point === "ui") {
        const spot = (c.value as { spot?: string }).spot ?? "";
        return CORE_SPOTS.includes(spot) ? undefined : spot;
      }
      return c.point.includes(".") ? c.point : undefined;
    };
    const treeOf = (id: string) => parentOf(id) ?? id;
    for (const c of all) if (c.state !== "refused" && needsPoint(c) === undefined) c.state = "active";
    for (;;) {
      const declared = new Map<string, { decl: PointDecl; pluginId: string }>();
      for (const d of declarations(all.filter((c) => c.state === "active"))) if (!declared.has(d.name)) declared.set(d.name, d);
      let grew = false;
      for (const c of all) {
        if (c.state !== "waiting") continue;
        const need = needsPoint(c);
        const point = need === undefined ? undefined : declared.get(need);
        if (point === undefined) continue;
        if (point.decl.private === true && treeOf(point.pluginId) !== treeOf(c.pluginId)) {
          c.state = "refused";
          c.reason = `\`${need}\` is private to \`${treeOf(point.pluginId)}\``;
          continue;
        }
        c.state = "active";
        delete c.reason;
        grew = true;
      }
      if (!grew) break;
    }
    for (const c of all) if (c.state === "waiting") c.reason = `waiting for \`${needsPoint(c)}\``;

    const points: RegisteredPoint[] = [];
    const firstDeclarer = new Map<string, string>();
    for (const d of declarations(all.filter((c) => c.state === "active"))) {
      // A well-known name is recorded with the catalog's declaration, whatever the declarer wrote (review S2).
      const decl = this.#catalog(d.name) ?? d.decl;
      const spot = decl.props !== undefined;
      const prior = firstDeclarer.get(d.name);
      if (prior === undefined) firstDeclarer.set(d.name, d.pluginId);
      points.push({
        name: d.name, shape: decl.shape, declaredBy: { pluginId: d.pluginId, ref: d.ref }, spot,
        // A point other than a UI spot has one active declarer; a second one waits until the user picks (§5.4).
        active: spot || prior === undefined || prior === d.pluginId,
        decl: structuredClone(decl),
      });
    }

    const entries = new Map<string, Contribution[]>();
    for (const c of all) {
      const list = entries.get(c.point) ?? [];
      list.push(c);
      entries.set(c.point, list);
    }

    const records = new Map<string, PluginRecord>();
    for (const id of ids) {
      const held = this.#plugins.get(id)!;
      const top = topOf(id)!;
      const mine = all.filter((c) => c.pluginId === id);
      const waitingFor = [...new Set(mine.filter((c) => c.state === "waiting").map((c) => needsPoint(c)!))];
      const off = offReason.get(id);
      let state: PluginState;
      let reason: string | undefined;
      if (off) ({ state, reason } = off);
      else if (mine.length > 0 && mine.every((c) => c.state === "waiting")) {
        state = "waiting";
        reason = `waiting for ${waitingFor.map((w) => `\`${w}\``).join(", ")}`;
      } else state = "running";
      const m = held.input.manifest;
      const hasCode = m.host !== undefined || m.client !== undefined || m.helper !== undefined;
      const parent = parentOf(id);
      records.set(id, {
        id,
        ...(parent === undefined ? {} : { parent }),
        name: m.name,
        version: m.version ?? top.input.manifest.version ?? "0.0.0",
        state,
        ...(reason === undefined ? {} : { reason }),
        ...(waitingFor.length > 0 && !off ? { waitingFor } : {}),
        enabled: held.enabled,
        source: held.input.source ?? top.input.source ?? "local",
        class: held.input.class ?? (hasCode ? "code" : "data"),
        treeHash: top.hash,
        ...(top.okHash === undefined ? {} : { okHash: top.okHash }),
        ...(top.cardHeld ? { cardStylingHeld: true } : {}),
        namespace: top.input.manifest.namespace ?? (parentOf(id) ?? id),
        scope: m.scope ?? "both",
        adult: top.input.manifest.adult === true,
        children: ids.filter((c) => parentOf(c) === id),
        dev: held.input.dev ?? false,
        folder: held.input.folder ?? `/plugins/${id.replace("/", "/plugins/")}`,
        manifest: held.input.invalid === undefined ? structuredClone(m) : undefined,
        capabilities: [...(m.capabilities ?? [])],
        issues: structuredClone(held.input.issues ?? []),
        provenance: held.input.provenance ?? { by: "user-app", at: 0 },
      });
    }
    return { records, entries, points };
  }

  #entriesOf(id: string): Contribution[] {
    const held = this.#plugins.get(id)!;
    const top = this.#plugins.get(parentOf(id) ?? id)!;
    const namespace = top.input.manifest.namespace ?? (parentOf(id) ?? id);
    const out: Contribution[] = [];
    const push = (point: string, ref: string, value: unknown, entryId?: string, key?: string) =>
      out.push({
        point, pluginId: id, ref, value: structuredClone(value), state: "waiting",
        ...(entryId === undefined ? {} : { entryId }), ...(key === undefined ? {} : { key }),
      });
    for (const [point, raw] of Object.entries(held.input.manifest.contributes ?? {})) {
      if (raw === undefined) continue;
      if (SINGLE_POINTS.has(point)) push(point, point, raw);
      else if (point === "mcpServers" && isObject(raw)) {
        for (const [name, server] of Object.entries(raw)) push(point, `mcpServers/${name}`, { ...(server as object), name }, name);
      } else if (ARRAY_POINTS.has(point) && Array.isArray(raw)) {
        (raw as unknown[]).forEach((value, i) => {
          const v: Record<string, unknown> = isObject(value) ? value : {};
          const field = UNIQUE_ENTRY_FIELD[point as keyof CoreEntries];
          let entryId: string | undefined = field ? (v[field] as string | undefined) : (v.id as string | undefined);
          let key: string | undefined;
          if (point === "commands") entryId = `${namespace}.${String(v.name)}`;
          if (point === "triggers") key = v.type as string;
          if (point === "locales") key = v.lang as string;
          if (point === "ui") key = v.key as string | undefined;
          push(point, `${point}/${i}`, value, entryId, key);
        });
      } else if (point.includes(".")) {
        if (Array.isArray(raw)) raw.forEach((value, i) => push(point, `${point}/${i}`, value, (value as { id?: string }).id));
        else push(point, point, raw, (raw as { id?: string }).id);
      }
    }
    return out;
  }
}
