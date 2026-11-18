// Layout format 1 (spec §5.5, §5.9): how a bot's tab arranges its parts, as a small tree of rows, columns, stacks,
// tabs, spots, images, text and spacers, with sizes and rules for narrow windows. A layout has no events, scripts or
// outside URLs, so the bot editor, and bots themselves, can write one safely.
import { z } from "zod";
import { utf16 } from "@waifucave/moss-protocol";
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
