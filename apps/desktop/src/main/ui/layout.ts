// A bot's layout (spec §5.5): how its tab arranges its parts, as data the core reads and the runtime draws, in any
// layer it dresses (a data-only bot has no layer of its own). The core checks the file against lane B's format, turns
// sizes into CSS lengths, prefixes classes with the plugin's id, points images at the core's asset URLs, picks text in
// the user's language and reads markdown files; the layout's CSS goes through the cleaner with its classes prefixed,
// scoped to the tab, as a sheet. Its `{ spot }` nodes' `prefer` lists are the resolver's rule 3 in that tab. A layout
// has no events, scripts or outside URLs. Pure apart from reading the plugins' files.
//
// A tab is made in turns (`TabSpec`): the stock tab, or the bot's own layout (whole, or a patch on the stock tab); then
// each other plugin's patch for that bot (by `order`, then plugin id; the user can switch one off); then the user's own
// layout (whole, or a patch on the bot's tab as made so far, or on the stock tab). A change whose node isn't there is
// said once and skipped. Every class is prefixed with its owner's id as the tab is made: the bot's for its own nodes
// and for any class a change names (`.talk` is the bot's box), a patch's own for the nodes it adds and the boxes it
// wraps, so each plugin's CSS reaches only its own classes. Each plugin's CSS is its own sheet, cleaned with its id.
import { readFileSync } from "node:fs";
import {
  DEFAULT_TAB_LAYOUT, LayoutContributionSchema, LayoutFileSchema, LayoutSchema, applyLayoutPatch, contributionProblems, isLayoutPatch, parseJsonc, resolveLayoutFile,
  type Layout, type LayoutChange, type LayoutNode, type LayoutTarget,
} from "@waifucave/clover-plugin-sdk";
import type { LayoutView } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { cleanCss, prefixedClass } from "./css";
import { pluginFile } from "./files";
import type { UiPlugin } from "./model";
import { nodeId } from "./spots";
import { textIn } from "./strings";
import { themeAssetUrl, type SheetScope } from "./theme";

/** The most of a markdown file a layout shows. */
export const LAYOUT_MARKDOWN_MAX = 64 * 1024;

const cssLength = (v: string | number | undefined): string | undefined => (v === undefined ? undefined : typeof v === "number" ? `${v}px` : v);

/** A bot's tab, as it is made: the bot's plugin, the file its layout entry names ("" for the stock tab), the other
 *  plugins' patches for it in their turn, and the user's own layout. */
export interface TabSpec {
  bot: UiPlugin;
  file: string;
  patches: readonly { plugin: UiPlugin; id: string; file: string }[];
  userLayout?: string;
}

/** A tab as made: its layout (classes already prefixed by owner) and each plugin's sheet, in turn order. */
interface Made {
  layout: Layout | null;
  sheets: { plugin: UiPlugin; css?: string; background?: string }[];
  /** The patches that changed it, by `<plugin>#<entry>`. */
  applied: string[];
}

type Node = Record<string, unknown> & LayoutNode;

const kidsOf = (n: LayoutNode): LayoutNode[] | undefined => ("row" in n ? n.row : "column" in n ? n.column : "stack" in n ? n.stack : undefined);

/** Every node of a tree, the tabs' own nodes included. */
function eachNode(n: LayoutNode, fn: (n: Node) => void): void {
  fn(n as Node);
  kidsOf(n)?.forEach((k) => eachNode(k, fn));
  if ("tabs" in n) n.tabs.forEach((t) => eachNode(t.node, fn));
}

/** A copy of a node with every class prefixed with an owner's id. */
function owned(n: LayoutNode, ownerId: string): LayoutNode {
  const copy = structuredClone(n);
  eachNode(copy, (x) => {
    if (typeof x.class === "string") x.class = prefixedClass(ownerId, x.class);
  });
  return copy;
}

/** A change as made in a tab: the classes it names are the bot's; the classes it gives (an added node's, a wrapping
 *  box's) are its owner's. */
function ownedChange(c: LayoutChange, botId: string, ownerId: string): LayoutChange {
  const t = (x: LayoutTarget | undefined): LayoutTarget | undefined =>
    x === undefined ? undefined : typeof x === "string" ? (x.startsWith(".") ? `.${prefixedClass(botId, x.slice(1))}` : x) : "class" in x ? { class: prefixedClass(botId, x.class) } : x;
  const out = { ...c } as Record<string, unknown>;
  for (const k of ["set", "move", "remove", "wrap", "before", "after", "into"] as const) if (out[k] !== undefined) out[k] = t(out[k] as LayoutTarget);
  if ("add" in c) out.add = owned(c.add, ownerId);
  if (("wrap" in c || "set" in c) && typeof out.class === "string") out.class = prefixedClass("wrap" in c ? ownerId : botId, out.class);
  return out as LayoutChange;
}

/** Whether a made tree is a valid layout: checked as the format checks one, its (prefixed, maybe longer) classes aside. */
function validLayout(l: Layout): string | undefined {
  const copy = structuredClone(l);
  eachNode(copy.root, (x) => {
    if (x.class !== undefined) x.class = "c";
  });
  const r = LayoutSchema.safeParse(copy);
  return r.success ? undefined : (r.error.issues[0]?.message ?? "invalid");
}

export class LayoutStore {
  private readonly made = new Map<string, Made>();
  private readonly views = new Map<string, LayoutView>();
  private readonly sheets = new Map<string, string>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

  clear(): void {
    this.made.clear();
    this.views.clear();
    this.sheets.clear();
  }

  private keyOf(tab: TabSpec): string {
    return JSON.stringify([tab.bot.id, tab.bot.treeHash, tab.file, tab.patches.map((p) => [p.plugin.id, p.plugin.treeHash, p.id, p.file]), tab.userLayout ?? null]);
  }

  private readJson(plugin: UiPlugin, file: string): unknown {
    const parsed = parseJsonc(readFileSync(pluginFile(plugin, file), "utf8"));
    if (!parsed.ok) throw new Error(`not JSON: ${parsed.error.message}`);
    return parsed.value;
  }

  /** The bot's own layout: the stock tab for "", else its file, checked; null when it is missing or invalid. */
  private botBase(plugin: UiPlugin, file: string): Layout | null {
    if (file === "") return DEFAULT_TAB_LAYOUT;
    try {
      const parsed = LayoutFileSchema.safeParse(this.readJson(plugin, file));
      if (parsed.success) {
        // A plugin's own layout extends the stock tab; the bot's own layout is the base only of the user's.
        const made = resolveLayoutFile(parsed.data, { default: DEFAULT_TAB_LAYOUT });
        for (const note of made.notes) this.log(`layout: ${plugin.id}/${file}: ${note}`);
        return made.layout;
      }
      this.log(`layout: ${plugin.id}/${file} is not a valid layout (${parsed.error.issues[0]?.message ?? "invalid"})`);
    } catch (err) {
      this.log(`layout: ${plugin.id}/${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  /** The tab made in its turns (see the header); once per spec, so each note is said once. */
  make(tab: TabSpec): Made {
    const key = this.keyOf(tab);
    const hit = this.made.get(key);
    if (hit !== undefined) return hit;
    const bot = tab.bot;
    const base = this.botBase(bot, tab.file);
    const out: Made = { layout: null, sheets: [], applied: [] };
    if (base === null) {
      this.made.set(key, out);
      return out;
    }
    let layout: Layout = { ...base, root: owned(base.root, bot.id) };
    out.sheets.push({ plugin: bot, ...(base.css !== undefined ? { css: base.css } : {}), ...(base.background !== undefined ? { background: base.background } : {}) });
    const turn = (who: string, changes: readonly LayoutChange[], ownerId: string, start: Layout = layout): boolean => {
      const r = applyLayoutPatch(start, { layout: 1, extends: "bot", changes: changes.map((c) => ownedChange(c, bot.id, ownerId)) });
      for (const note of r.skipped) this.log(`layout: ${bot.id}'s tab: ${who}: ${note}`);
      const bad = validLayout(r.layout);
      if (bad !== undefined) {
        this.log(`layout: ${bot.id}'s tab: ${who}: what it makes isn't a valid layout (${bad}); skipped`);
        return false;
      }
      // The patch carries no css or background here, so the made layout keeps the bot's.
      layout = r.layout;
      return true;
    };
    for (const p of tab.patches) {
      const who = `${p.plugin.id}#${p.id} (${p.file})`;
      let patch;
      try {
        const parsed = LayoutContributionSchema.safeParse(this.readJson(p.plugin, p.file));
        if (!parsed.success) {
          this.log(`layout: ${bot.id}'s tab: ${who} is not a tab patch (${parsed.error.issues[0]?.message ?? "invalid"}); skipped`);
          continue;
        }
        patch = parsed.data;
      } catch (err) {
        this.log(`layout: ${bot.id}'s tab: ${who} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const reach = contributionProblems(patch);
      if (reach.length > 0) {
        this.log(`layout: ${bot.id}'s tab: ${who}: ${reach.join("; ")}; skipped`);
        continue;
      }
      if (!turn(who, patch.changes, p.plugin.id)) continue;
      out.applied.push(`${p.plugin.id}#${p.id}`);
      if (patch.css !== undefined) out.sheets.push({ plugin: p.plugin, css: patch.css });
    }
    if (tab.userLayout !== undefined) {
      const who = "the user's layout";
      let file;
      try {
        const parsed = LayoutFileSchema.safeParse(JSON.parse(tab.userLayout));
        if (parsed.success) file = parsed.data;
        else this.log(`layout: ${bot.id}'s tab: ${who} is not a valid layout (${parsed.error.issues[0]?.message ?? "invalid"})`);
      } catch {
        this.log(`layout: ${bot.id}'s tab: ${who} is not JSON`);
      }
      if (file !== undefined) {
        // The user layer has no folder: its layout's own CSS and background aren't drawn; the bot's stay.
        if (file.css !== undefined || file.background !== undefined) this.log(`layout: ${bot.id}'s tab: ${who}: its css and background aren't drawn (the user layer has no files)`);
        if (!isLayoutPatch(file)) {
          const whole = { ...file, root: owned(file.root, bot.id) };
          layout = { layout: 1, root: whole.root, ...(layout.css !== undefined ? { css: layout.css } : {}), ...(layout.background !== undefined ? { background: layout.background } : {}) };
        } else turn(who, file.changes, bot.id, file.extends === "default" ? { ...layout, root: owned(DEFAULT_TAB_LAYOUT.root, bot.id) } : layout);
      }
    }
    out.layout = layout;
    this.made.set(key, out);
    return out;
  }

  /** The layout as the runtime draws it, in a language. */
  view(tab: TabSpec, lang: string): LayoutView | null {
    const key = `${this.keyOf(tab)}\0${lang}`;
    const hit = this.views.get(key);
    if (hit !== undefined) return hit;
    const layout = this.make(tab).layout;
    if (layout === null) return null;
    const view = this.node(tab.bot, layout.root, lang);
    this.views.set(key, view);
    return view;
  }

  private markdown(plugin: UiPlugin, path: string): string {
    try {
      const text = readFileSync(pluginFile(plugin, path), "utf8");
      return text.length > LAYOUT_MARKDOWN_MAX ? text.slice(0, LAYOUT_MARKDOWN_MAX) : text;
    } catch (err) {
      this.log(`layout: ${plugin.id}/${path} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  }

  /** A node as drawn: its class is already its owner's; images and markdown are the bot's files (a patch adds none). */
  private node(plugin: UiPlugin, n: LayoutNode, lang: string): LayoutView {
    const attrs = {
      ...(cssLength(n.size) !== undefined ? { size: cssLength(n.size)! } : {}),
      ...(cssLength(n.min) !== undefined ? { min: cssLength(n.min)! } : {}),
      ...(cssLength(n.max) !== undefined ? { max: cssLength(n.max)! } : {}),
      ...(n.grow !== undefined ? { grow: n.grow } : {}),
      ...(n.hideBelow !== undefined ? { hideBelow: n.hideBelow } : {}),
      ...(n.class !== undefined ? { className: n.class } : {}),
      ...(cssLength(n.gap) !== undefined ? { gap: cssLength(n.gap)! } : {}),
      ...(cssLength(n.padding) !== undefined ? { padding: cssLength(n.padding)! } : {}),
      ...(n.align !== undefined ? { align: n.align } : {}),
    };
    if ("row" in n) return { kind: "row", children: n.row.map((c) => this.node(plugin, c, lang)), ...attrs };
    if ("column" in n) return { kind: "column", children: n.column.map((c) => this.node(plugin, c, lang)), ...attrs };
    if ("stack" in n) return { kind: "stack", children: n.stack.map((c) => this.node(plugin, c, lang)), ...attrs };
    if ("tabs" in n) return { kind: "tabs", tabs: n.tabs.map((t) => ({ title: textIn(t.title, lang), node: this.node(plugin, t.node, lang) })), ...attrs };
    if ("spot" in n) return { kind: "spot", spot: n.spot, ...(n.key !== undefined ? { key: n.key } : {}), ...attrs };
    if ("image" in n) return { kind: "image", src: themeAssetUrl(plugin.id, n.image), ...attrs };
    if ("text" in n) return { kind: "text", text: textIn(n.text, lang), ...attrs };
    if ("markdown" in n) return { kind: "markdown", markdown: this.markdown(plugin, n.markdown), ...attrs };
    return { kind: "spacer", ...attrs };
  }

  /** The tab's sheets: the bot's background and CSS, then each patch's CSS, each cleaned with its own plugin's id and
   *  its classes prefixed, scoped to the tab and stopping at the parts inside it. */
  sheet(tab: TabSpec, scope: SheetScope): string {
    const ROOT = "\u0000root\u0000";
    const LIMIT = "\u0000limit\u0000";
    const key = `${this.keyOf(tab)}\0${scope.limit !== undefined}`;
    let template = this.sheets.get(key);
    if (template === undefined) {
      const parts: string[] = [];
      const at = `@scope (${ROOT})${scope.limit !== undefined ? ` to (${LIMIT})` : ""}`;
      for (const s of this.make(tab).sheets) {
        if (s.background !== undefined) parts.push(`${at}{:scope{background-image:url("${themeAssetUrl(s.plugin.id, s.background)}");background-size:cover;background-position:center}}`);
        if (s.css === undefined) continue;
        try {
          const raw = readFileSync(pluginFile(s.plugin, s.css), "utf8");
          const cleaned = cleanCss(raw, {
            pluginId: s.plugin.id,
            file: s.css,
            assetUrl: (path) => themeAssetUrl(s.plugin.id, path),
            scope: { root: ROOT, ...(scope.limit !== undefined ? { limit: LIMIT } : {}) },
            prefixClasses: true,
          });
          if (cleaned.dropped.length > 0) this.log(`layout: ${s.plugin.id}/${s.css}: dropped ${[...new Set(cleaned.dropped)].slice(0, 12).join("; ")}`);
          parts.push(cleaned.css);
        } catch (err) {
          this.log(`layout: ${s.plugin.id}/${s.css} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      template = parts.join("\n");
      this.sheets.set(key, template);
    }
    return template.split(ROOT).join(scope.root).split(LIMIT).join(scope.limit ?? "");
  }

  /** The layout's `prefer` lists, by the spot (or keyed cell) each `{ spot }` node places: the resolver's rule 3. */
  prefer(tab: TabSpec): Record<string, readonly string[]> {
    const layout = this.make(tab).layout;
    const out: Record<string, readonly string[]> = {};
    if (layout !== null) eachNode(layout.root, (x) => {
      const n = x as LayoutNode;
      if ("spot" in n && n.prefer !== undefined && n.prefer.length > 0) out[nodeId(n.spot, n.key)] ??= n.prefer;
    });
    return out;
  }
}
