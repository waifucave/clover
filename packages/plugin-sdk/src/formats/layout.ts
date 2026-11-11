// Layout format 1 (spec §5.5, §5.9): how a bot's tab arranges its parts, as a small tree of rows, columns, stacks,
// tabs, spots, images, text and spacers, with sizes and rules for narrow windows. A layout has no events, scripts or
// outside URLs, so the bot editor, and bots themselves, can write one safely.
import { z } from "zod";
import { utf16 } from "@waifucave/clover-protocol";
import { Path, PointName, Text } from "../manifest/fields";

/** A size: CSS pixels, or a CSS length (`240px`, `30%`, `12rem`). */
const Size = z.union([z.number().nonnegative().max(100_000), utf16(32).regex(/^(\d+(\.\d+)?)(px|%|rem|em|vh|vw|fr)$/)]);

/** Attributes any node may carry. `hideBelow` hides it when the window is narrower than that many CSS pixels. */
const NodeAttrs = {
  size: Size.optional(),
  min: Size.optional(),
  max: Size.optional(),
  grow: z.number().nonnegative().max(1000).optional(),
  hideBelow: z.number().int().nonnegative().max(100_000).optional(),
  /** A class for the layout's own CSS; the cleaner prefixes it with the plugin's id. */
  class: utf16(64, 1).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/).optional(),
  gap: Size.optional(),
  padding: Size.optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
};

/** `<plugin-id>` or `<plugin-id>#<entry-id>` (§5.5 `prefer`). */
export const EntryPreference = utf16(300, 2).regex(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?(#[a-z0-9][a-z0-9._-]*)?$/);

export type LayoutNode =
  | ({ row: LayoutNode[] } & NodeAttrsT)
  | ({ column: LayoutNode[] } & NodeAttrsT)
  | ({ stack: LayoutNode[] } & NodeAttrsT)
  | ({ tabs: { title: z.infer<typeof Text>; node: LayoutNode }[] } & NodeAttrsT)
  | ({ spot: string; key?: string; prefer?: string[] } & NodeAttrsT)
  | ({ image: string } & NodeAttrsT)
  | ({ text: z.infer<typeof Text> } & NodeAttrsT)
  | ({ markdown: string } & NodeAttrsT)
  | ({ spacer: true } & NodeAttrsT);
type NodeAttrsT = { [K in keyof typeof NodeAttrs]?: z.infer<(typeof NodeAttrs)[K]> };

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.strictObject({ row: z.array(LayoutNodeSchema).max(64), ...NodeAttrs }),
    z.strictObject({ column: z.array(LayoutNodeSchema).max(64), ...NodeAttrs }),
    z.strictObject({ stack: z.array(LayoutNodeSchema).max(64), ...NodeAttrs }),
    z.strictObject({ tabs: z.array(z.strictObject({ title: Text, node: LayoutNodeSchema })).min(1).max(32), ...NodeAttrs }),
    z.strictObject({ spot: PointName, key: utf16(256, 1).optional(), prefer: z.array(EntryPreference).max(32).optional(), ...NodeAttrs }),
    z.strictObject({ image: Path, ...NodeAttrs }),
    z.strictObject({ text: Text, ...NodeAttrs }),
    z.strictObject({ markdown: Path, ...NodeAttrs }),
    z.strictObject({ spacer: z.literal(true), ...NodeAttrs }),
  ]),
);

export const LayoutSchema = z.strictObject({
  $schema: utf16(2048).optional(),
  layout: z.literal(1),
  root: LayoutNodeSchema,
  background: Path.optional(),
  css: Path.optional(),
});
export type Layout = z.infer<typeof LayoutSchema>;

/** Every spot a layout places, for the check that a bot's layout names only spots of its tab. */
export function layoutSpots(node: LayoutNode): string[] {
  const out: string[] = [];
  const walk = (n: LayoutNode) => {
    if ("spot" in n) out.push(n.spot);
    if ("row" in n) n.row.forEach(walk);
    if ("column" in n) n.column.forEach(walk);
    if ("stack" in n) n.stack.forEach(walk);
    if ("tabs" in n) n.tabs.forEach((t) => walk(t.node));
  };
  walk(node);
  return out;
}

/** Every file a layout reads, for the check that its paths stay inside the folder. */
export function layoutPaths(layout: Layout): string[] {
  const out: string[] = [];
  if (layout.background) out.push(layout.background);
  if (layout.css) out.push(layout.css);
  const walk = (n: LayoutNode) => {
    if ("image" in n) out.push(n.image);
    if ("markdown" in n) out.push(n.markdown);
    if ("row" in n) n.row.forEach(walk);
    if ("column" in n) n.column.forEach(walk);
    if ("stack" in n) n.stack.forEach(walk);
    if ("tabs" in n) n.tabs.forEach((t) => walk(t.node));
  };
  walk(layout.root);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The stock tab, and layout patches
// ---------------------------------------------------------------------------------------------------------------------

/** The tab the shell gives a bot with no layout of its own, as data: the stage (it shows only when the bot has an
 *  avatar), then the conversation over the composer. What `extends: "default"` starts from; the shell's default tab
 *  draws the same parts in the same order (its test pins that). Classes `tab`, `stage` and `talk` name its three
 *  boxes, for a patch to address and a layout's CSS to style. */
export const DEFAULT_TAB_LAYOUT: Layout = {
  layout: 1,
  root: {
    column: [
      { spot: "bot.stage", class: "stage" },
      { column: [{ spot: "conversation", grow: 1 }, { spot: "composer" }], grow: 1, class: "talk" },
    ],
    grow: 1,
    class: "tab",
  },
};

/** A node a change names: `{ spot, key? }`, `{ class }`, or as a string a spot's name (`"bot.stage"`) or, after a
 *  dot, a class (`".talk"`). The first such node, in reading order, is the one meant. */
const ClassName = utf16(64, 1).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
export const LayoutTarget = z.union([
  utf16(129, 1).regex(/^(\.[A-Za-z_][A-Za-z0-9_-]*|[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*)$/),
  z.strictObject({ spot: PointName, key: utf16(256, 1).optional() }),
  z.strictObject({ class: ClassName }),
]);
export type LayoutTarget = z.infer<typeof LayoutTarget>;

const Container = z.enum(["row", "column", "stack"]);
/** Where a moved or added node goes: just `before` or `after` a node, or `into` a row, column or stack, `at` its
 *  `start`, its `end` (the default) or an index. Exactly one of the three. */
const Placement = {
  before: LayoutTarget.optional(),
  after: LayoutTarget.optional(),
  into: LayoutTarget.optional(),
  at: z.union([z.enum(["start", "end"]), z.number().int().nonnegative().max(64)]).optional(),
};
const onePlace = (c: { before?: unknown; after?: unknown; into?: unknown; at?: unknown }, ctx: z.RefinementCtx) => {
  const n = [c.before, c.after, c.into].filter((x) => x !== undefined).length;
  if (n !== 1) ctx.addIssue({ code: "custom", message: "a move or an add says exactly one of before, after or into" });
  if (c.at !== undefined && c.into === undefined) ctx.addIssue({ code: "custom", message: "`at` goes with `into`" });
};

/** One change, in the order the patch lists them:
 *  * `{ set: T, size?, min?, max?, grow?, hideBelow?, class?, gap?, padding?, align?, as? }`: the node's attributes
 *    (`as` turns a row, column or stack into another of the three);
 *  * `{ move: T, before | after | into: T, at? }`; `{ remove: T }`; `{ add: Node, before | after | into: T, at? }`;
 *  * `{ wrap: T, in: "row" | "column" | "stack", …attributes }`: the node goes inside a new box in its place. */
export const LayoutChange = z.union([
  z.strictObject({ set: LayoutTarget, ...NodeAttrs, as: Container.optional() }),
  z.strictObject({ move: LayoutTarget, ...Placement }).superRefine(onePlace),
  z.strictObject({ remove: LayoutTarget }),
  z.strictObject({ add: LayoutNodeSchema, ...Placement }).superRefine(onePlace),
  z.strictObject({ wrap: LayoutTarget, in: Container, ...NodeAttrs }),
]);
export type LayoutChange = z.infer<typeof LayoutChange>;

/** A layout that starts from another and states only its changes. `extends: "default"` is the stock tab
 *  (`DEFAULT_TAB_LAYOUT`), for a bot plugin's own layout; `extends: "bot"` is the bot plugin's own layout, for the
 *  user's. `background` and `css` replace the base's, as in a whole layout. */
export const LayoutPatchSchema = z.strictObject({
  $schema: utf16(2048).optional(),
  layout: z.literal(1),
  extends: z.enum(["default", "bot"]),
  changes: z.array(LayoutChange).max(64),
  background: Path.optional(),
  css: Path.optional(),
});
export type LayoutPatch = z.infer<typeof LayoutPatchSchema>;

/** A layout file: a whole layout, or a patch to one. */
export const LayoutFileSchema = z.union([LayoutSchema, LayoutPatchSchema]);
export type LayoutFile = z.infer<typeof LayoutFileSchema>;

export const isLayoutPatch = (f: LayoutFile): f is LayoutPatch => "extends" in f;

/** A patch any plugin adds to a bot's tab: a `ui` entry on `bot.tab` with `layout` (its file), for the bots its
 *  `when.bot` names. Only changes, made on the tab as it stands at its turn: the stock tab or the bot's own layout,
 *  then the other plugins' patches before it (by `order`, then plugin id); the user's own layout comes last. So it has
 *  no `extends` and no `background` (the bot's and the user's), and its `css` is its own sheet, its classes prefixed
 *  with its own plugin's id. */
export const LayoutContributionSchema = z.strictObject({
  $schema: utf16(2048).optional(),
  layout: z.literal(1),
  changes: z.array(LayoutChange).max(64),
  css: Path.optional(),
});
export type LayoutContribution = z.infer<typeof LayoutContributionSchema>;

/** What a patch to another plugin's bot tab may not say, which the bot's own layout may: a class on a node it didn't
 *  add (`set … class`: the class is the bot's, for the bot's CSS; `wrap` the node in a box of its own instead), and in a
 *  node it adds a `prefer` list (the tab's own word on who fills a spot), an image or a markdown file (a tab's files are
 *  its bot's). Each with the change's number. */
export function contributionProblems(c: LayoutContribution): string[] {
  const out: string[] = [];
  const walk = (n: LayoutNode, i: number) => {
    if ("spot" in n && n.prefer !== undefined) out.push(`change ${i + 1}: a node it adds has \`prefer\`, which only the bot's own layout says`);
    if ("image" in n) out.push(`change ${i + 1}: a node it adds is an image; a tab's files are its bot's`);
    if ("markdown" in n) out.push(`change ${i + 1}: a node it adds is a markdown file; a tab's files are its bot's`);
    childrenOf(n)?.forEach((k) => walk(k, i));
    if ("tabs" in n) n.tabs.forEach((t) => walk(t.node, i));
  };
  c.changes.forEach((ch, i) => {
    if ("set" in ch && ch.class !== undefined) out.push(`change ${i + 1}: \`set\` gives a class to a node it didn't add; wrap the node in a box with its own class instead`);
    if ("add" in ch) walk(ch.add, i);
  });
  return out;
}

type Box = { row: LayoutNode[] } | { column: LayoutNode[] } | { stack: LayoutNode[] };
const childrenOf = (n: LayoutNode): LayoutNode[] | undefined => ("row" in n ? n.row : "column" in n ? n.column : "stack" in n ? n.stack : undefined);

/** How a change names its node, for a note. */
const named = (t: LayoutTarget): string => (typeof t === "string" ? t : "spot" in t ? `${t.spot}${t.key !== undefined ? `#${t.key}` : ""}` : `.${t.class}`);

function matches(n: LayoutNode, t: LayoutTarget): boolean {
  if (typeof t === "string") return t.startsWith(".") ? n.class === t.slice(1) : "spot" in n && n.spot === t && n.key === undefined;
  if ("spot" in t) return "spot" in n && n.spot === t.spot && n.key === t.key;
  return n.class === t.class;
}

interface Found { node: LayoutNode; siblings?: LayoutNode[]; index: number }

/** The first node, in reading order, that a target names; with the list it sits in (none for the root or a tab's own
 *  node, which can be changed but not moved, removed or placed beside). */
function find(root: LayoutNode, t: LayoutTarget): Found | undefined {
  let hit: Found | undefined;
  const walk = (n: LayoutNode, siblings: LayoutNode[] | undefined, index: number): void => {
    if (hit !== undefined) return;
    if (matches(n, t)) {
      hit = { node: n, ...(siblings ? { siblings } : {}), index };
      return;
    }
    const kids = childrenOf(n);
    if (kids) kids.forEach((k, i) => walk(k, kids, i));
    if ("tabs" in n) n.tabs.forEach((tab) => walk(tab.node, undefined, -1));
  };
  walk(root, undefined, -1);
  return hit;
}

const contains = (outer: LayoutNode, inner: LayoutNode): boolean => outer === inner || (childrenOf(outer)?.some((k) => contains(k, inner)) ?? false) || ("tabs" in outer && outer.tabs.some((t) => contains(t.node, inner)));

const ATTR_KEYS = ["size", "min", "max", "grow", "hideBelow", "class", "gap", "padding", "align"] as const;

/** A base layout with a patch's changes made, in order. A change whose node isn't there (the stock tab may gain or
 *  lose parts over time), or that can't be made where it points, is skipped and said in `skipped`; it is never an
 *  error. The result is an ordinary layout, which the caller checks as any other. */
export function applyLayoutPatch(base: Layout, patch: LayoutPatch): { layout: Layout; skipped: string[] } {
  let root = structuredClone(base.root) as LayoutNode;
  const skipped: string[] = [];
  const place = (node: LayoutNode, c: { before?: LayoutTarget; after?: LayoutTarget; into?: LayoutTarget; at?: "start" | "end" | number }): string | undefined => {
    if (c.into !== undefined) {
      const box = find(root, c.into);
      if (box === undefined) return `no ${named(c.into)} here`;
      const kids = childrenOf(box.node);
      if (kids === undefined) return `${named(c.into)} isn't a row, column or stack`;
      const at = c.at === "start" ? 0 : c.at === undefined || c.at === "end" ? kids.length : Math.min(c.at, kids.length);
      kids.splice(at, 0, node);
      return undefined;
    }
    const anchor = (c.before ?? c.after)!;
    const where = find(root, anchor);
    if (where === undefined) return `no ${named(anchor)} here`;
    if (where.siblings === undefined) return `${named(anchor)} has no row, column or stack around it`;
    where.siblings.splice(where.index + (c.before !== undefined ? 0 : 1), 0, node);
    return undefined;
  };
  patch.changes.forEach((c, i) => {
    const say = (verb: string, t: LayoutTarget | undefined, why: string) => skipped.push(`change ${i + 1} (${verb}${t === undefined ? "" : ` ${named(t)}`}): ${why}; skipped`);
    if ("set" in c) {
      const hit = find(root, c.set);
      if (hit === undefined) return say("set", c.set, "no such node");
      const n = hit.node as Record<string, unknown>;
      for (const k of ATTR_KEYS) if (c[k] !== undefined) n[k] = c[k];
      if (c.as !== undefined) {
        const kids = childrenOf(hit.node);
        if (kids === undefined) return say("set", c.set, `only a row, column or stack can become a ${c.as}`);
        delete n.row;
        delete n.column;
        delete n.stack;
        n[c.as] = kids;
      }
      return;
    }
    if ("remove" in c) {
      const hit = find(root, c.remove);
      if (hit === undefined) return say("remove", c.remove, "no such node");
      if (hit.siblings === undefined) return say("remove", c.remove, "the root or a tab's own node stays");
      hit.siblings.splice(hit.index, 1);
      return;
    }
    if ("move" in c) {
      const hit = find(root, c.move);
      if (hit === undefined) return say("move", c.move, "no such node");
      if (hit.siblings === undefined) return say("move", c.move, "the root or a tab's own node stays where it is");
      const dest = (c.into ?? c.before ?? c.after)!;
      const there = find(root, dest);
      if (there !== undefined && contains(hit.node, there.node) && c.into !== undefined) return say("move", c.move, `${named(dest)} is inside it`);
      if (there !== undefined && there.node === hit.node) return say("move", c.move, "it is the place it would go");
      hit.siblings.splice(hit.index, 1);
      const why = place(hit.node, c);
      if (why !== undefined) {
        hit.siblings.splice(hit.index, 0, hit.node); // back where it was
        return say("move", c.move, why);
      }
      return;
    }
    if ("add" in c) {
      const why = place(structuredClone(c.add), c);
      if (why !== undefined) say("add", undefined, why);
      return;
    }
    const hit = find(root, c.wrap);
    if (hit === undefined) return say("wrap", c.wrap, "no such node");
    const box = { [c.in]: [hit.node] } as Box & Record<string, unknown>;
    for (const k of ATTR_KEYS) if (c[k] !== undefined) box[k] = c[k];
    if (hit.siblings === undefined) {
      if (hit.node !== root) return say("wrap", c.wrap, "a tab's own node stays as it is");
      root = box as LayoutNode;
    } else hit.siblings[hit.index] = box as LayoutNode;
  });
  const background = patch.background ?? base.background;
  const css = patch.css ?? base.css;
  return { layout: { layout: 1, root, ...(background !== undefined ? { background } : {}), ...(css !== undefined ? { css } : {}) }, skipped };
}

/** A layout file as the tab is drawn from it: a whole layout as it is; a patch made on its base (`bases.default`, the
 *  stock tab, or `bases.bot`, the bot plugin's own) and the result checked as a whole layout. A patch whose base isn't
 *  there gives null; one whose result isn't a valid layout gives its base. `notes` says what was skipped or why. */
export function resolveLayoutFile(file: LayoutFile, bases: { default: Layout; bot?: Layout }): { layout: Layout | null; notes: string[] } {
  if (!isLayoutPatch(file)) return { layout: file, notes: [] };
  const base = bases[file.extends];
  if (base === undefined) return { layout: null, notes: [`it extends "${file.extends}", and there is no such layout here`] };
  const { layout, skipped } = applyLayoutPatch(base, file);
  const checked = LayoutSchema.safeParse(layout);
  if (!checked.success) return { layout: base, notes: [...skipped, `the patched layout isn't valid (${checked.error.issues[0]?.message ?? "invalid"}); its base is used`] };
  return { layout: checked.data, notes: skipped };
}
