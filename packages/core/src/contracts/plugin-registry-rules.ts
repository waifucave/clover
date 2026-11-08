// The registry's rules, as pure functions over the plugins it holds (lane B): states, children, waiting points and
// spots, unique entry ids and namespaces, private points, the catalog's declarations, and the order changes come in.
// The fake and the real registry (`packages/core/src/registry/`) both compute their snapshots here, so the rules the
// conformance suite pins are written once; what differs is where plugins come from (folders, OKs, the synced list).
import { type PluginClass, type PluginProvenance, type PluginSource, type PluginState, type ValidationIssue } from "@waifucave/clover-protocol";
import { CORE_SPOTS, UNIQUE_ENTRY_FIELD, type Contribution, type PluginRecord, type RegisteredPoint, type RegistryChange } from "./plugin-registry";
import type { CoreEntries, Manifest, PointDecl } from "./sdk-types";

/** A plugin as the rules see it, in the synced list's order (a child after its parent). */
export interface RegistryPlugin {
  /** `<id>`, or `<parent>/<folder>` for a child. */
  id: string;
  /** As validated: refused contributions and entries left out. */
  manifest: Manifest;
  source?: PluginSource;
  /** Its tree's OK: the user's, an install's, or none yet (found). */
  approved: boolean;
  /** The user refused this tree. */
  refused: boolean;
  enabled: boolean;
  /** The top-level folder's tree hash now (`sha256:<hex>`). */
  hash: string;
  okHash?: string;
  /** A card-styling change waits for its OK. */
  cardHeld: boolean;
  /** The validator refused it: its reason. */
  invalid?: string;
  /** The index revoked it: the revocation's reason. */
  blocked?: string;
  /** The plugin host stopped it after crashes: the reason. */
  stopped?: string;
  folder?: string;
  issues?: ValidationIssue[];
  class?: PluginClass;
  provenance?: PluginProvenance;
  dev?: boolean;
}

export interface RegistryRuleOptions {
  /** The catalog's declaration of a well-known name (the plugin SDK's `catalogPointDecl`). */
  catalog: (name: string) => PointDecl | undefined;
  /** The user confirmed they are 18 or older (§5.7). */
  adultConfirmed: boolean;
}

export interface RegistrySnapshot {
  records: Map<string, PluginRecord>;
  entries: Map<string, Contribution[]>;
  points: RegisteredPoint[];
}

export const EMPTY_SNAPSHOT: RegistrySnapshot = { records: new Map(), entries: new Map(), points: [] };

const ARRAY_POINTS = new Set([
  "models", "skills", "agents", "agentBackends", "hooks", "commands", "triggers", "voices", "computerProviders",
  "relays", "notifiers", "companions", "themes", "locales", "ui",
]);
const SINGLE_POINTS = new Set(["bot", "computer"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A child's parent id, or undefined for a top-level plugin. */
export const parentOf = (id: string): string | undefined => (id.includes("/") ? id.slice(0, id.indexOf("/")) : undefined);

/** What changed between two snapshots, in dependency order (§5.4): when something stops, the entries that depended on
 *  it change first, then its dependents, then what stopped; when something starts, the declarer comes first. */
export function registryChanges(before: RegistrySnapshot, after: RegistrySnapshot): RegistryChange[] {
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
  return order;
}

export function computeRegistry(plugins: ReadonlyMap<string, RegistryPlugin>, opts: RegistryRuleOptions): RegistrySnapshot {
  const ids = [...plugins.keys()];
  const topOf = (id: string) => plugins.get(parentOf(id) ?? id);
  // Who is on, before points: approved, valid, not blocked, refused, stopped or off, its parent on too, and its
  // namespace not taken by a plugin earlier in the synced list (§6.7).
  const offReason = new Map<string, { state: PluginState; reason?: string }>();
  const namespaces = new Map<string, string>();
  const namespaceOf = (id: string) => topOf(id)?.manifest.namespace ?? (parentOf(id) ?? id);
  for (const id of ids) {
    const held = plugins.get(id)!;
    const top = topOf(id);
    const parentId = parentOf(id);
    const parentOff = parentId !== undefined && offReason.has(parentId);
    const adult = top?.manifest.adult === true;
    if (held.blocked !== undefined) offReason.set(id, { state: "blocked", reason: held.blocked });
    else if (held.invalid !== undefined) offReason.set(id, { state: "invalid", reason: held.invalid });
    else if (held.refused || (top?.refused ?? false)) offReason.set(id, { state: "refused" });
    else if (!held.approved || !(top?.approved ?? true)) offReason.set(id, { state: "found", reason: "waiting for your OK" });
    else if (held.stopped !== undefined) offReason.set(id, { state: "stopped", reason: `plugin stopped: ${held.stopped}` });
    else if (!held.enabled) offReason.set(id, { state: "off" });
    else if (parentOff) offReason.set(id, { state: "off", reason: "its parent is off" });
    else if (adult && !opts.adultConfirmed) offReason.set(id, { state: "off", reason: "may contain adult content: off until you confirm you are 18 or older" });
    else if (parentId === undefined && namespaces.has(namespaceOf(id))) {
      offReason.set(id, { state: "off", reason: `the namespace \`${namespaceOf(id)}\` is \`${namespaces.get(namespaceOf(id))}\`'s` });
    }
    if (parentId === undefined && !offReason.has(id)) namespaces.set(namespaceOf(id), id);
  }
  const on = ids.filter((id) => !offReason.has(id));

  // Every entry of every plugin that is on.
  const all: Contribution[] = [];
  for (const id of on) all.push(...entriesOf(plugins, id));

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
      const host = plugins.get(id)!.manifest.host;
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
    const decl = opts.catalog(d.name) ?? d.decl;
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
    const held = plugins.get(id)!;
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
    const m = held.manifest;
    const hasCode = m.host !== undefined || m.client !== undefined || m.helper !== undefined;
    const parent = parentOf(id);
    records.set(id, {
      id,
      ...(parent === undefined ? {} : { parent }),
      name: m.name,
      version: m.version ?? top.manifest.version ?? "0.0.0",
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(waitingFor.length > 0 && !off ? { waitingFor } : {}),
      enabled: held.enabled,
      source: held.source ?? top.source ?? "local",
      class: held.class ?? (hasCode ? "code" : "data"),
      treeHash: top.hash,
      ...(top.okHash === undefined ? {} : { okHash: top.okHash }),
      ...(top.cardHeld ? { cardStylingHeld: true } : {}),
      namespace: top.manifest.namespace ?? (parentOf(id) ?? id),
      scope: m.scope ?? "both",
      adult: top.manifest.adult === true,
      children: ids.filter((c) => parentOf(c) === id),
      dev: held.dev ?? false,
      folder: held.folder ?? `/plugins/${id.replace("/", "/plugins/")}`,
      manifest: held.invalid === undefined ? structuredClone(m) : undefined,
      capabilities: [...(m.capabilities ?? [])],
      // Granted: what the user's OK covers and the plugin may use now. A change that adds a capability asks again
      // (§5.6), so an OK'd tree's capabilities are always the OK's or fewer; nothing is granted before the OK, after a
      // refusal or a block, or for an invalid plugin.
      granted: held.approved && top.approved && !["found", "refused", "invalid", "blocked"].includes(state) ? [...(m.capabilities ?? [])] : [],
      issues: structuredClone(held.issues ?? []),
      provenance: held.provenance ?? { by: "user-app", at: 0 },
    });
  }
  return { records, entries, points };
}

function entriesOf(plugins: ReadonlyMap<string, RegistryPlugin>, id: string): Contribution[] {
  const held = plugins.get(id)!;
  const top = plugins.get(parentOf(id) ?? id)!;
  const namespace = top.manifest.namespace ?? (parentOf(id) ?? id);
  // A bot's plugin: its tree holds the bot, whose id is the top-level plugin's.
  const botOfTree = top.manifest.contributes?.bot !== undefined ? (parentOf(id) ?? id) : undefined;
  const out: Contribution[] = [];
  const push = (point: string, ref: string, value: unknown, entryId?: string, key?: string) =>
    out.push({
      point, pluginId: id, ref, value: structuredClone(value), state: "waiting",
      ...(entryId === undefined ? {} : { entryId }), ...(key === undefined ? {} : { key }),
    });
  for (const [point, raw] of Object.entries(held.manifest.contributes ?? {})) {
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
        if (point === "ui") key = (v.key as string | undefined) ?? (v.spot === "bot.tab" ? botOfTree : undefined);
        push(point, `${point}/${i}`, value, entryId, key);
      });
    } else if (point.includes(".")) {
      if (Array.isArray(raw)) raw.forEach((value, i) => push(point, `${point}/${i}`, value, (value as { id?: string }).id));
      else push(point, point, raw, (raw as { id?: string }).id);
    }
  }
  return out;
}
