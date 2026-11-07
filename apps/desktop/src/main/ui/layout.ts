// A bot's layout (spec §5.5): how its tab arranges its parts, as data the core reads and the runtime draws, in any
// layer it dresses (a data-only bot has no layer of its own). The core checks the file against lane B's format, turns
// sizes into CSS lengths, prefixes classes with the plugin's id, points images at the core's asset URLs, picks text in
// the user's language and reads markdown files; the layout's CSS goes through the cleaner with its classes prefixed,
// scoped to the tab, as a sheet. Its `{ spot }` nodes' `prefer` lists are the resolver's rule 3 in that tab. A layout
// has no events, scripts or outside URLs. Pure apart from reading the plugin's files.
import { readFileSync } from "node:fs";
import { LayoutSchema, type Layout, type LayoutNode } from "@waifucave/clover-plugin-sdk";
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

export class LayoutStore {
  private readonly layouts = new Map<string, Layout | null>();
  private readonly views = new Map<string, LayoutView>();
  private readonly sheets = new Map<string, string>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

  clear(): void {
    this.layouts.clear();
    this.views.clear();
    this.sheets.clear();
  }

  /** The layout file, checked; null when it is missing or invalid (logged once). */
  read(plugin: UiPlugin, file: string): Layout | null {
    const key = `${plugin.id}\0${plugin.treeHash}\0${file}`;
    const hit = this.layouts.get(key);
    if (hit !== undefined) return hit;
    let layout: Layout | null = null;
    try {
      const parsed = LayoutSchema.safeParse(JSON.parse(readFileSync(pluginFile(plugin, file), "utf8")));
      if (parsed.success) layout = parsed.data;
      else this.log(`layout: ${plugin.id}/${file} is not a valid layout (${parsed.error.issues[0]?.message ?? "invalid"})`);
    } catch (err) {
      this.log(`layout: ${plugin.id}/${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.layouts.set(key, layout);
    return layout;
  }

  /** The layout as the runtime draws it, in a language. */
  view(plugin: UiPlugin, file: string, lang: string): LayoutView | null {
    const key = `${plugin.id}\0${plugin.treeHash}\0${file}\0${lang}`;
    const hit = this.views.get(key);
    if (hit !== undefined) return hit;
    const layout = this.read(plugin, file);
    if (layout === null) return null;
    const view = this.node(plugin, layout.root, lang);
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

  private node(plugin: UiPlugin, n: LayoutNode, lang: string): LayoutView {
    const attrs = {
      ...(cssLength(n.size) !== undefined ? { size: cssLength(n.size)! } : {}),
      ...(cssLength(n.min) !== undefined ? { min: cssLength(n.min)! } : {}),
      ...(cssLength(n.max) !== undefined ? { max: cssLength(n.max)! } : {}),
      ...(n.grow !== undefined ? { grow: n.grow } : {}),
      ...(n.hideBelow !== undefined ? { hideBelow: n.hideBelow } : {}),
      ...(n.class !== undefined ? { className: prefixedClass(plugin.id, n.class) } : {}),
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

  /** The layout's sheet for its tab: its background and its CSS, cleaned with its classes prefixed, scoped to the tab
   *  and stopping at the parts inside it. */
  sheet(plugin: UiPlugin, file: string, scope: SheetScope): string {
    const ROOT = "\u0000root\u0000";
    const LIMIT = "\u0000limit\u0000";
    const key = `${plugin.id}\0${plugin.treeHash}\0${file}\0${scope.limit !== undefined}`;
    let template = this.sheets.get(key);
    if (template === undefined) {
      const layout = this.read(plugin, file);
      const parts: string[] = [];
      const at = `@scope (${ROOT})${scope.limit !== undefined ? ` to (${LIMIT})` : ""}`;
      if (layout?.background !== undefined) parts.push(`${at}{:scope{background-image:url("${themeAssetUrl(plugin.id, layout.background)}");background-size:cover;background-position:center}}`);
      if (layout?.css !== undefined) {
        try {
          const raw = readFileSync(pluginFile(plugin, layout.css), "utf8");
          const cleaned = cleanCss(raw, {
            pluginId: plugin.id,
            file: layout.css,
            assetUrl: (path) => themeAssetUrl(plugin.id, path),
            scope: { root: ROOT, ...(scope.limit !== undefined ? { limit: LIMIT } : {}) },
            prefixClasses: true,
          });
          if (cleaned.dropped.length > 0) this.log(`layout: ${plugin.id}/${layout.css}: dropped ${[...new Set(cleaned.dropped)].slice(0, 12).join("; ")}`);
          parts.push(cleaned.css);
        } catch (err) {
          this.log(`layout: ${plugin.id}/${layout.css} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      template = parts.join("\n");
      this.sheets.set(key, template);
    }
    return template.split(ROOT).join(scope.root).split(LIMIT).join(scope.limit ?? "");
  }

  /** The layout's `prefer` lists, by the spot (or keyed cell) each `{ spot }` node places: the resolver's rule 3. */
  prefer(plugin: UiPlugin, file: string): Record<string, readonly string[]> {
    const layout = this.read(plugin, file);
    const out: Record<string, readonly string[]> = {};
    const walk = (n: LayoutNode) => {
      if ("spot" in n && n.prefer !== undefined && n.prefer.length > 0) out[nodeId(n.spot, n.key)] ??= n.prefer;
      if ("row" in n) n.row.forEach(walk);
      if ("column" in n) n.column.forEach(walk);
      if ("stack" in n) n.stack.forEach(walk);
      if ("tabs" in n) n.tabs.forEach((t) => walk(t.node));
    };
    if (layout !== null) walk(layout.root);
    return out;
  }
}
