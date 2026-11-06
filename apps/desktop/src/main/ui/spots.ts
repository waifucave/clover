// Which entry shows in a spot (spec §5.5 "UI spots" and "Which entry shows"). Pure: the app's main process resolves
// every `<Spot>` here, so a layer can only ever mount what the core chose, and the rules are unit-tested under Bun
// (test/spots.test.ts).
//
// A cell is one spot, or one key of a keyed spot. For a cell the resolver:
//   * finds the entries that may fill it: the plugin is running (only `clover` and `alpha` in safe mode), its `when`
//     holds in the cell's context, its plugin has every capability the spot `needs`, and its key covers the cell's
//     (an exact key, then a `*` pattern, then an entry with no key: "an entry with no `key` fills every key that has
//     no entry of its own");
//   * ranks them: (1) the user's pick, for this bot first, then globally; (2) the smaller part; (3) the bot layout's
//     `prefer`; (4) the most specific `when.bot`; (5) a plugin the user installed over a bundled one; (6) the most
//     recently enabled, which raises a conflict badge;
//   * a winning `hide` entry, or a pick of nothing, shows nothing, unless the key is one the spot `keep`s;
//   * collects the style-only entries, which never compete: they apply in the reverse of that order, so the one that
//     would win applies last.
// A list spot shows every entry, in the user's order, then `order` (default 500), then plugin id.
//
// "The smaller part": the part a plugin dresses is the smallest spot holding all its entries in that tab, a child
// counting as its own plugin (a send-button plugin dresses the button, a bot's tab look the whole tab, a shell the
// app). The spots form a tree: the catalog's declarations, and each plugin's `declares` under the spot its entry fills.
import { SPOTS, keyMatches, spotInfo } from "@waifucave/clover-plugin-sdk";
import { SAFE_MODE_PLUGINS, type PointDeclaration, type UiEntry, type UiPlugin } from "./model";

export type Os = "macos" | "windows" | "linux";

/** Where a cell is: the tab it is in (its bot), the surface, the OS, the session's kind, safe mode. */
export interface CellContext {
  bot?: string;
  surface?: string;
  os: Os;
  /** The kind of session the part shows (`coding`, `bot`, …), for `when.session`. */
  session?: string;
  safeMode?: boolean;
  /** The bot layout's `prefer` lists, by spot (rule 3), from the tab's bot's layout (layout.ts). */
  prefer?: Readonly<Record<string, readonly string[]>>;
  /** A plugin's setting, for `when.setting`; unknown settings don't hold an entry back. */
  setting?: (pluginId: string, key: string) => unknown;
}

/** The user's UI choices that the resolver reads (`UiSettings` in lane B's protocol). */
export interface UiChoices {
  picks: readonly { spot: string; key?: string; bot?: string; entry: string | null }[];
  lists: readonly { spot: string; bot?: string; order: readonly string[]; hidden: readonly string[] }[];
}

export const NO_CHOICES: UiChoices = { picks: [], lists: [] };

/** `<plugin-id>#<entry-id>`, the form `prefer` and the user's picks use. */
export function entryRef(e: Pick<UiEntry, "pluginId" | "id">): string {
  return `${e.pluginId}#${e.id}`;
}

/** Whether a reference (`<plugin-id>` or `<plugin-id>#<entry-id>`) names this entry. */
export function refNames(ref: string, e: Pick<UiEntry, "pluginId" | "id">): boolean {
  const hash = ref.indexOf("#");
  return hash < 0 ? ref === e.pluginId : ref.slice(0, hash) === e.pluginId && ref.slice(hash + 1) === e.id;
}

/** A spot's node in the tree, or one key's. */
export function nodeId(spot: string, key?: string): string {
  return key === undefined ? spot : `${spot}[${key}]`;
}

/** The keyed spots whose key is a bot, so the cell's context is that bot. */
const KEYED_BY_BOT = new Set(["bot.tab", "sidebar.bot"]);

/** Where each catalog spot's declarer sits (spec §5.5): the shell fills `app.root`, the settings part `main` keyed
 *  `settings`, a bot's tab `bot.tab`, and so on. */
const CATALOG_PARENT: Readonly<Record<string, string | undefined>> = {
  app: undefined,
  shell: "app.root",
  settings: "main[settings]",
  "bot-tab": "bot.tab",
  "bot-stage": "bot.stage",
  composer: "composer",
  conversation: "conversation",
  "file-view": undefined,
  island: "app.surface",
  pill: "app.surface",
};

/** The spot tree: the catalog's, with each plugin's own spots under the entry that declares them. */
export class SpotTree {
  private readonly parent = new Map<string, string>();

  constructor(plugins: readonly UiPlugin[]) {
    for (const s of SPOTS) {
      const p = s.name === "bot.tab" ? "main[bot]" : CATALOG_PARENT[s.declaredBy];
      if (p !== undefined) this.parent.set(s.name, p);
    }
    for (const plugin of plugins) {
      for (const e of plugin.entries) {
        for (const declared of Object.keys(e.declares)) {
          if (spotInfo(declared) !== undefined || this.parent.has(declared)) continue;
          this.parent.set(declared, nodeId(e.spot, e.key));
        }
      }
    }
  }

  /** The node's parent: a key's spot, or the spot's declarer's cell. */
  parentOf(node: string): string | undefined {
    const bracket = node.indexOf("[");
    if (bracket >= 0) return node.slice(0, bracket);
    return this.parent.get(node);
  }

  /** The node and its ancestors, nearest first. Cycles (a broken declaration) stop at the first repeat. */
  chain(node: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let at: string | undefined = node;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      out.push(at);
      at = this.parentOf(at);
    }
    return out;
  }

  depth(node: string): number {
    return this.chain(node).length - 1;
  }

  /** The deepest node holding all of these (each node counts as holding itself); undefined for none. */
  smallestHolding(nodes: readonly string[]): string | undefined {
    if (nodes.length === 0) return undefined;
    let common = this.chain(nodes[0]!);
    for (const n of nodes.slice(1)) {
      const ancestors = new Set(this.chain(n));
      common = common.filter((c) => ancestors.has(c));
    }
    return common[0];
  }

  /** The bot tab a node sits in (`bot.tab` or one of its keys), if any. */
  tabOf(node: string): string | undefined {
    return this.chain(node).find((n) => n === "bot.tab" || n.startsWith("bot.tab["));
  }
}

/** A spot's declaration as the resolver needs it: the catalog's for a catalog name (a plugin that declares one must
 *  use it), else the first plugin declaration found. */
export function declarationOf(spot: string, plugins: readonly UiPlugin[]): PointDeclaration | undefined {
  const info = spotInfo(spot);
  if (info !== undefined) {
    return {
      shape: info.shape,
      ...(info.needs ? { needs: info.needs } : {}),
      ...(info.keep ? { keep: info.keep } : {}),
      ...(info.context ? { context: info.context } : {}),
    };
  }
  for (const p of plugins) for (const e of p.entries) if (e.declares[spot] !== undefined) return e.declares[spot];
  return undefined;
}

/** The tree a `private` spot is open to (§5.4: "a `private` point is open only to the declaring plugin's own tree"):
 *  the declaring plugin's top-level id, or undefined for a spot anyone may fill. The catalog's spots are never private,
 *  and a plugin's own spots are named after it (`<top-level id>.<name>`), so only the plugin a spot's name belongs to
 *  can make it private: a plugin that declares another's spot name private locks nobody out. */
export function privateTo(spot: string, plugins: readonly UiPlugin[]): string | undefined {
  if (spotInfo(spot) !== undefined) return undefined;
  for (const p of plugins) {
    if (!spot.startsWith(`${p.topId}.`)) continue;
    for (const e of p.entries) if (e.declares[spot]?.private === true) return p.topId;
  }
  return undefined;
}

const list = (v: string | readonly string[] | undefined): readonly string[] | undefined => (v === undefined ? undefined : typeof v === "string" ? [v] : v);

/** The bots an entry is limited to, or `all` (rule 4 and `when.bot`): a bot's own entries are limited to that bot; the
 *  user's ticks (the plugin's `bots`) replace `when.bot`. */
export function botScope(plugin: UiPlugin, e: UiEntry): "all" | readonly string[] {
  if (plugin.isBot) return [plugin.id];
  if (plugin.bots !== "all") return plugin.bots;
  return list(e.when?.bot) ?? "all";
}

/** Whether an entry's `when` holds in a context. Outside a bot's tab, an entry limited to some bots doesn't apply. */
export function applies(plugin: UiPlugin, e: UiEntry, ctx: CellContext): boolean {
  const scope = botScope(plugin, e);
  if (scope !== "all" && (ctx.bot === undefined || !scope.includes(ctx.bot))) return false;
  const surface = list(e.when?.surface);
  if (surface !== undefined && (ctx.surface === undefined || !surface.includes(ctx.surface))) return false;
  if (e.when?.os !== undefined && !e.when.os.includes(ctx.os)) return false;
  const session = list(e.when?.session);
  if (session !== undefined && (ctx.session === undefined || !session.includes(ctx.session))) return false;
  if (e.when?.setting !== undefined && ctx.setting !== undefined) {
    for (const [key, want] of Object.entries(e.when.setting)) {
      const have = ctx.setting(plugin.id, key);
      if (have !== undefined && have !== want) return false;
    }
  }
  return true;
}

/** The key an entry fills: its own, or in a bot's own plugin, a keyless `bot.tab` entry takes the bot's id. */
export function effectiveKey(plugin: UiPlugin, e: UiEntry): string | undefined {
  if (e.key !== undefined) return e.key;
  if (plugin.isBot && e.spot === "bot.tab") return plugin.id;
  return undefined;
}

/** How closely an entry's key covers a cell's key: 2 exact, 1 a `*` pattern, 0 no key; undefined when it doesn't. */
export function keyTier(entryKey: string | undefined, key: string | undefined): number | undefined {
  if (key === undefined) return entryKey === undefined ? 0 : undefined;
  if (entryKey === undefined) return 0;
  if (!keyMatches(entryKey, key)) return undefined;
  return entryKey.endsWith("*") ? 1 : 2;
}

export interface Candidate {
  plugin: UiPlugin;
  entry: UiEntry;
  /** 2 exact key, 1 pattern, 0 keyless. */
  tier: number;
}

/** Why an entry that names this cell isn't in the running for it. */
export interface Skipped {
  ref: string;
  reason: "safe-mode" | "needs" | "when" | "private";
  detail?: string;
}

export type Shape = "single" | "list" | "keyed";

export interface CellResult {
  spot: string;
  key?: string;
  shape: Shape;
  /** What shows: one entry at most in a single spot or keyed cell, every entry in order in a list spot. */
  shown: Candidate[];
  /** The style-only entries that dress what shows, in the order they apply (the would-be winner last). */
  styles: Candidate[];
  /** A hide entry or the user's pick of nothing won, so nothing shows (never for a kept key). */
  hidden: boolean;
  /** The winner was decided by "the most recently enabled": Settings shows a conflict badge with a picker. */
  conflict: boolean;
  /** Entries hidden by the user in a list spot. */
  hiddenByUser: Candidate[];
  skipped: Skipped[];
  /** Which rule decided the winner over the runner-up, 1–6; 0 when there was no contest or a key decided; 7 for a full
   *  tie, settled by plugin id. */
  decidedBy: number;
}

export interface ResolveInput {
  plugins: readonly UiPlugin[];
  choices?: UiChoices;
  ctx: CellContext;
  /** Built once per registry change; built here when absent. */
  tree?: SpotTree;
}

function runs(plugin: UiPlugin, ctx: CellContext): boolean {
  return ctx.safeMode !== true || SAFE_MODE_PLUGINS.includes(plugin.topId);
}

/** The part each plugin dresses around a cell: the smallest node holding its entries in that tab (or in the whole
 *  window outside tabs), a bot's own tab look counting as the whole tab. */
export function partOf(plugin: UiPlugin, cellNode: string, input: Pick<ResolveInput, "ctx">, tree: SpotTree): string | undefined {
  const tab = tree.tabOf(cellNode);
  const nodes: string[] = [];
  for (const e of plugin.entries) {
    if (!applies(plugin, e, input.ctx)) continue;
    const node = nodeId(e.spot, effectiveKey(plugin, e));
    if (tab !== undefined && tree.tabOf(node) === undefined) continue;
    nodes.push(node);
  }
  if (plugin.isBot && input.ctx.bot === plugin.id && tab !== undefined) nodes.push(nodeId("bot.tab", plugin.id));
  return tree.smallestHolding(nodes);
}

function specificity(scope: "all" | readonly string[]): number {
  if (scope === "all") return 0;
  return scope.length === 1 ? 2 : 1;
}

/** Ranks a cell's contenders by rules 2–6 (rule 1, the user's pick, is applied before), best first, and says which
 *  rule separated the top two. */
export function rank(cands: readonly Candidate[], cellNode: string, input: ResolveInput, tree: SpotTree): { ranked: Candidate[]; decidedBy: number } {
  const prefer = input.ctx.prefer?.[cellNode] ?? input.ctx.prefer?.[cellNode.replace(/\[.*$/, "")] ?? [];
  const facts = new Map<Candidate, number[]>();
  for (const c of cands) {
    const part = partOf(c.plugin, cellNode, input, tree);
    const preferAt = prefer.findIndex((r) => refNames(r, c.entry));
    facts.set(c, [
      // Keys first: an exact key over a pattern over none ("after exact ones").
      c.tier,
      // 2. The smaller part: the deeper node.
      part === undefined ? -1 : tree.depth(part),
      // 3. The bot layout's preference: listed beats unlisted, earlier beats later.
      preferAt < 0 ? -1 : prefer.length - preferAt,
      // 4. The most specific `when.bot`.
      specificity(botScope(c.plugin, c.entry)),
      // 5. A plugin the user installed over a bundled one.
      c.plugin.source === "bundled" ? 0 : 1,
      // 6. The most recently enabled.
      c.plugin.enabledAt,
    ]);
  }
  const ranked = [...cands].sort((a, b) => {
    const fa = facts.get(a)!;
    const fb = facts.get(b)!;
    for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return fb[i]! - fa[i]!;
    return a.plugin.id < b.plugin.id ? -1 : a.plugin.id > b.plugin.id ? 1 : a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });
  let decidedBy = 0;
  if (ranked.length > 1) {
    const fa = facts.get(ranked[0]!)!;
    const fb = facts.get(ranked[1]!)!;
    const i = fa.findIndex((v, n) => v !== fb[n]);
    // The tier is not one of the six rules (a key covers its cell before any rule runs: 0); a full tie falls to the
    // plugin id, which is no rule either (7) and raises the conflict badge like rule 6.
    decidedBy = i < 0 ? 7 : i === 0 ? 0 : i + 1;
  }
  return { ranked, decidedBy };
}

function userPick(choices: UiChoices, spot: string, key: string | undefined, bot: string | undefined): { entry: string | null } | undefined {
  const matches = (p: UiChoices["picks"][number]) => p.spot === spot && (p.key ?? undefined) === key;
  if (bot !== undefined) {
    const forBot = choices.picks.find((p) => matches(p) && p.bot === bot);
    if (forBot !== undefined) return forBot;
  }
  return choices.picks.find((p) => matches(p) && p.bot === undefined);
}

/** Resolves one cell: what shows there, what dresses it, and why. */
export function resolveCell(input: ResolveInput, spot: string, key?: string): CellResult {
  const tree = input.tree ?? new SpotTree(input.plugins);
  const decl = declarationOf(spot, input.plugins);
  const shape: Shape = decl?.shape ?? "single";
  const cellKey = shape === "keyed" ? key : undefined;
  const ctx: CellContext = cellKey !== undefined && KEYED_BY_BOT.has(spot) ? { ...input.ctx, bot: cellKey } : input.ctx;
  const inner: ResolveInput = { ...input, ctx, tree };
  const node = nodeId(spot, cellKey);
  const choices = input.choices ?? NO_CHOICES;
  const result: CellResult = { spot, ...(cellKey !== undefined ? { key: cellKey } : {}), shape, shown: [], styles: [], hidden: false, conflict: false, hiddenByUser: [], skipped: [], decidedBy: 0 };

  const fill: Candidate[] = [];
  const style: Candidate[] = [];
  const owner = privateTo(spot, input.plugins);
  for (const plugin of input.plugins) {
    for (const entry of plugin.entries) {
      if (entry.spot !== spot) continue;
      const tier = keyTier(effectiveKey(plugin, entry), cellKey);
      if (tier === undefined) continue;
      const ref = entryRef(entry);
      if (owner !== undefined && plugin.topId !== owner) {
        result.skipped.push({ ref, reason: "private" });
        continue;
      }
      if (!runs(plugin, ctx)) {
        result.skipped.push({ ref, reason: "safe-mode" });
        continue;
      }
      if (!applies(plugin, entry, ctx)) {
        result.skipped.push({ ref, reason: "when" });
        continue;
      }
      if (entry.kind === "style") {
        style.push({ plugin, entry, tier });
        continue;
      }
      const missing = (decl?.needs ?? []).filter((cap) => !plugin.capabilities.has(cap));
      if (missing.length > 0) {
        result.skipped.push({ ref, reason: "needs", detail: missing.join(", ") });
        continue;
      }
      fill.push({ plugin, entry, tier });
    }
  }

  // Style entries never compete; each applies inside the part, the would-be winner last.
  result.styles = rank(style, node, inner, tree).ranked.reverse();

  if (shape === "list") {
    const own = choices.lists.find((l) => l.spot === spot && l.bot !== undefined && l.bot === ctx.bot) ?? choices.lists.find((l) => l.spot === spot && l.bot === undefined);
    const shown = fill.filter((c) => c.entry.kind !== "hide");
    const userAt = (c: Candidate) => {
      const i = own?.order.findIndex((r) => refNames(r, c.entry)) ?? -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    shown.sort((a, b) => userAt(a) - userAt(b) || (a.entry.order ?? 500) - (b.entry.order ?? 500) || (a.plugin.id < b.plugin.id ? -1 : a.plugin.id > b.plugin.id ? 1 : 0) || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
    for (const c of shown) {
      if (own?.hidden.some((r) => refNames(r, c.entry))) result.hiddenByUser.push(c);
      else result.shown.push(c);
    }
    return result;
  }

  const kept = cellKey !== undefined && (decl?.keep ?? []).includes(cellKey);
  const contenders = kept ? fill.filter((c) => c.entry.kind !== "hide") : fill;

  // 1. The user's pick, for this bot first, then globally.
  const pick = userPick(choices, spot, cellKey, ctx.bot);
  if (pick !== undefined) {
    if (pick.entry === null && !kept) {
      result.hidden = true;
      result.decidedBy = 1;
      return result;
    }
    const picked = pick.entry === null ? undefined : contenders.find((c) => refNames(pick.entry!, c.entry));
    if (picked !== undefined) {
      if (picked.entry.kind === "hide") result.hidden = true;
      else result.shown = [picked];
      result.decidedBy = 1;
      return result;
    }
  }

  const { ranked, decidedBy } = rank(contenders, node, inner, tree);
  result.decidedBy = decidedBy;
  result.conflict = decidedBy >= 6;
  const winner = ranked[0];
  if (winner === undefined) return result;
  if (winner.entry.kind === "hide") result.hidden = true;
  else result.shown = [winner];
  return result;
}
