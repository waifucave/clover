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
