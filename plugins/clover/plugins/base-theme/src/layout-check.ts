// Layout format 1 (spec §5.9), checked as lane B's `LayoutSchema` pins it (packages/plugin-sdk/src/formats/
// layout.ts): `{ $schema?, layout: 1, root: Node, background?: Path, css?: Path }`, where a Node is exactly one
// of a row, column or stack of nodes, tabs (`{ title: Text, node }`), a spot (`{ spot, key?, prefer? }`), an
// image, text (`Text`: words, or `{ en, … }` by language), markdown or a spacer, plus size, min, max, grow,
// hideBelow, class, gap, padding and align on any node. A size is CSS pixels or a CSS length. This is what a
// layout written today must hold to, and what Alpha's tab is tested against, until the parts import the SDK.

import { isPluginPath } from "./theme";

export interface LayoutCheck {
  problems: string[];
  /** Every spot the layout places, in order (`spot` or `spot#key`). */
  spots: string[];
  /** Every file it names (images, markdown, background, css), relative to the plugin folder. */
  paths: string[];
}

const KINDS = ["row", "column", "stack", "tabs", "spot", "image", "text", "markdown", "spacer"] as const;
const COMMON = ["size", "min", "max", "grow", "hideBelow", "class", "gap", "padding", "align"] as const;
const SIZES = ["size", "min", "max", "gap", "padding"] as const;
const ALIGN = new Set(["start", "center", "end", "stretch"]);
const SIZE = /^(\d+(\.\d+)?)(px|%|rem|em|vh|vw|fr)$/;
const CLASS = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SPOT_NAME = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;
const PREFERENCE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?(#[a-z0-9][a-z0-9._-]*)?$/;

/**
 * The spot catalog's names and whether a bot's tab may place each, mirrored from lane B's `SPOTS`
 * (packages/plugin-sdk/src/catalogs/spots.ts at B-M0 bc01d25ea) until the parts import the SDK.
 */
export const SPOTS: readonly { readonly name: string; readonly inBotTab: boolean }[] = [
  { name: "app.root", inBotTab: false },
  { name: "app.surface", inBotTab: false },
  { name: "bot.tab", inBotTab: true },
  { name: "sidebar", inBotTab: false },
  { name: "sidebar.bot", inBotTab: false },
  { name: "sidebar.app", inBotTab: false },
  { name: "main", inBotTab: false },
  { name: "panel", inBotTab: false },
  { name: "panel.view", inBotTab: false },
  { name: "settings.section", inBotTab: false },
  { name: "status", inBotTab: false },
  { name: "bot.header", inBotTab: true },
  { name: "bot.header.action", inBotTab: true },
  { name: "bot.stage", inBotTab: true },
  { name: "bot.side", inBotTab: true },
  { name: "conversation", inBotTab: true },
  { name: "composer", inBotTab: true },
  { name: "avatar", inBotTab: true },
  { name: "composer.action", inBotTab: true },
  { name: "conversation.message", inBotTab: true },
  { name: "conversation.message.extra", inBotTab: true },
  { name: "tool.result", inBotTab: true },
  { name: "menu.message", inBotTab: true },
  { name: "file.preview", inBotTab: true },
  { name: "island.tab", inBotTab: false },
  { name: "pill.target", inBotTab: false },
];

/** The spots a bot's layout may place: every catalog spot marked `inBotTab` (lane B), `avatar` included. */
export const BOT_TAB_SPOTS: readonly string[] = SPOTS.filter((spot) => spot.inBotTab).map((spot) => spot.name);

/** Words for the screen: a string, or `{ en, … }` by language (lane B's `Text`). */
export function isText(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const byLanguage = value as Record<string, unknown>;
  return typeof byLanguage.en === "string" && Object.values(byLanguage).every((v) => typeof v === "string");
}

const isSize = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000) || (typeof v === "string" && v.length <= 32 && SIZE.test(v));

export function checkLayout(json: unknown, options: { spots?: readonly string[] } = {}): LayoutCheck {
  const problems: string[] = [];
  const spots: string[] = [];
  const paths: string[] = [];
  const known = options.spots ? new Set(options.spots) : null;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isObj(json)) return { problems: ["A layout is a JSON object."], spots, paths };
  if (json.layout !== 1) problems.push("`layout` must be 1.");
  for (const key of Object.keys(json)) if (!["$schema", "layout", "root", "background", "css"].includes(key)) problems.push(`Unknown key \`${key}\`.`);
  if (json.$schema !== undefined && (typeof json.$schema !== "string" || json.$schema.length > 2048)) problems.push("`$schema` is a URL.");
  for (const key of ["background", "css"] as const) {
    const v = json[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !isPluginPath(v)) problems.push(`\`${key}\` must be a path inside the plugin.`);
    else paths.push(v);
  }

  const walk = (node: unknown, where: string, depth: number): void => {
    if (depth > 32) {
      problems.push(`${where}: nested too deep.`);
      return;
    }
    if (!isObj(node)) {
      problems.push(`${where}: a node is an object.`);
      return;
    }
    const kinds = KINDS.filter((k) => k in node);
    if (kinds.length !== 1) {
      problems.push(`${where}: a node is exactly one of ${KINDS.join(", ")}.`);
      return;
    }
    const kind = kinds[0]!;
    for (const key of Object.keys(node)) {
      if (key !== kind && !(COMMON as readonly string[]).includes(key) && !(kind === "spot" && (key === "prefer" || key === "key"))) problems.push(`${where}: unknown key \`${key}\`.`);
    }
    for (const key of SIZES) {
      if (node[key] !== undefined && !isSize(node[key])) problems.push(`${where}: \`${key}\` is CSS pixels or a CSS length (px, %, rem, em, vh, vw, fr).`);
    }
    if (node.grow !== undefined && (typeof node.grow !== "number" || !Number.isFinite(node.grow) || node.grow < 0 || node.grow > 1000)) problems.push(`${where}: \`grow\` is a number from 0 to 1000.`);
    if (node.hideBelow !== undefined && (typeof node.hideBelow !== "number" || !Number.isInteger(node.hideBelow) || node.hideBelow < 0 || node.hideBelow > 100_000)) problems.push(`${where}: \`hideBelow\` is a whole number of CSS pixels.`);
    if (typeof node.min === "number" && typeof node.max === "number" && node.min > node.max) problems.push(`${where}: \`min\` is more than \`max\`.`);
    if (node.class !== undefined && (typeof node.class !== "string" || node.class.length > 64 || !CLASS.test(node.class))) problems.push(`${where}: \`class\` is one class name.`);
    if (node.align !== undefined && !ALIGN.has(String(node.align))) problems.push(`${where}: \`align\` is one of ${[...ALIGN].join(", ")}.`);
    const value = node[kind];
    switch (kind) {
      case "row":
      case "column":
      case "stack":
        if (!Array.isArray(value) || value.length > 64) problems.push(`${where}: a ${kind} holds a list of at most 64 nodes.`);
        else value.forEach((child, i) => walk(child, `${where}.${kind}[${i}]`, depth + 1));
        break;
      case "tabs":
        if (!Array.isArray(value) || value.length === 0 || value.length > 32) problems.push(`${where}: tabs hold a list of 1 to 32 { title, node }.`);
        else
          value.forEach((tab, i) => {
            if (!isObj(tab) || !isText(tab.title) || !("node" in tab) || Object.keys(tab).some((k) => k !== "title" && k !== "node")) problems.push(`${where}.tabs[${i}]: a tab is { title, node }, its title words.`);
            else walk(tab.node, `${where}.tabs[${i}]`, depth + 1);
          });
        break;
      case "spot": {
        if (typeof value !== "string" || !SPOT_NAME.test(value)) {
          problems.push(`${where}: a spot names one.`);
          break;
        }
        if (node.key !== undefined && (typeof node.key !== "string" || node.key.length === 0 || node.key.length > 256)) problems.push(`${where}: a spot's \`key\` is a name.`);
        const placed = typeof node.key === "string" ? `${value}#${node.key}` : value;
        if (known && !known.has(value)) problems.push(`${where}: \`${value}\` is not a spot here.`);
        if (spots.includes(placed)) problems.push(`${where}: \`${placed}\` is placed twice.`);
        spots.push(placed);
        if (node.prefer !== undefined && (!Array.isArray(node.prefer) || node.prefer.length > 32 || !node.prefer.every((p) => typeof p === "string" && p.length <= 300 && PREFERENCE.test(p)))) problems.push(`${where}: \`prefer\` lists plugin ids (\`id\` or \`id#entry\`).`);
        break;
      }
      case "image":
      case "markdown":
        if (typeof value !== "string" || !isPluginPath(value)) problems.push(`${where}: \`${kind}\` is a path inside the plugin.`);
        else paths.push(value);
        break;
      case "text":
        if (!isText(value)) problems.push(`${where}: \`text\` is words, or { en, … } by language.`);
        break;
      case "spacer":
        if (value !== true) problems.push(`${where}: \`spacer\` is true.`);
        break;
    }
  };
  if (!("root" in json)) problems.push("A layout needs a `root`.");
  else walk(json.root, "root", 0);
  return { problems, spots, paths };
}
