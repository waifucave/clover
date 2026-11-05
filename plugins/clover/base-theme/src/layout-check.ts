// Layout format 1 (spec §5.9), checked: `{ layout: 1, root: Node, background?: Path, css?: Path }`, where a
// Node is a row, column or stack of nodes, tabs, a spot, an image, text, markdown or a spacer, plus size,
// min, max, grow, hideBelow, class, gap, padding and align on any node. Lane B pins the format; this is what a
// layout written today must hold to, and what Alpha's tab is tested against.

import { isPluginPath } from "./theme";

export interface LayoutCheck {
  problems: string[];
  /** Every spot the layout places, in order. */
  spots: string[];
  /** Every file it names (images, markdown, background, css), relative to the plugin folder. */
  paths: string[];
}

const KINDS = ["row", "column", "stack", "tabs", "spot", "image", "text", "markdown", "spacer"] as const;
const COMMON = ["size", "min", "max", "grow", "hideBelow", "class", "gap", "padding", "align"] as const;
const NUMBERS = ["size", "min", "max", "grow", "hideBelow", "gap", "padding"] as const;
const ALIGN = new Set(["start", "center", "end", "stretch"]);

/** The spots a bot's tab holds (`bot.tab`, spec §5.5). */
export const BOT_TAB_SPOTS: readonly string[] = ["bot.header", "bot.stage", "bot.side", "conversation", "composer"];

export function checkLayout(json: unknown, options: { spots?: readonly string[] } = {}): LayoutCheck {
  const problems: string[] = [];
  const spots: string[] = [];
  const paths: string[] = [];
  const known = options.spots ? new Set(options.spots) : null;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isObj(json)) return { problems: ["A layout is a JSON object."], spots, paths };
  if (json.layout !== 1) problems.push("`layout` must be 1.");
  for (const key of Object.keys(json)) if (!["layout", "root", "background", "css"].includes(key)) problems.push(`Unknown key \`${key}\`.`);
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
      if (key !== kind && !(COMMON as readonly string[]).includes(key) && !(kind === "spot" && key === "prefer")) problems.push(`${where}: unknown key \`${key}\`.`);
    }
    for (const key of NUMBERS) {
      const v = node[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) problems.push(`${where}: \`${key}\` must be a number, 0 or more.`);
    }
    if (typeof node.min === "number" && typeof node.max === "number" && node.min > node.max) problems.push(`${where}: \`min\` is more than \`max\`.`);
    if (node.class !== undefined && (typeof node.class !== "string" || !/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(node.class))) problems.push(`${where}: \`class\` must be lowercase class names.`);
    if (node.align !== undefined && !ALIGN.has(String(node.align))) problems.push(`${where}: \`align\` is one of ${[...ALIGN].join(", ")}.`);
    const value = node[kind];
    switch (kind) {
      case "row":
      case "column":
      case "stack":
        if (!Array.isArray(value) || value.length === 0) problems.push(`${where}: a ${kind} holds a list of nodes.`);
        else value.forEach((child, i) => walk(child, `${where}.${kind}[${i}]`, depth + 1));
        break;
      case "tabs":
        if (!Array.isArray(value) || value.length === 0) problems.push(`${where}: tabs hold a list of { title, node }.`);
        else
          value.forEach((tab, i) => {
            if (!isObj(tab) || typeof tab.title !== "string" || !("node" in tab)) problems.push(`${where}.tabs[${i}]: a tab is { title, node }.`);
            else walk(tab.node, `${where}.tabs[${i}]`, depth + 1);
          });
        break;
      case "spot":
        if (typeof value !== "string" || value.length === 0) problems.push(`${where}: a spot names one.`);
        else {
          if (known && !known.has(value)) problems.push(`${where}: \`${value}\` is not a spot here.`);
          if (spots.includes(value)) problems.push(`${where}: \`${value}\` is placed twice.`);
          spots.push(value);
        }
        if (node.prefer !== undefined && (!Array.isArray(node.prefer) || !node.prefer.every((p) => typeof p === "string"))) problems.push(`${where}: \`prefer\` lists plugin ids.`);
        break;
      case "image":
      case "markdown":
        if (typeof value !== "string" || !isPluginPath(value)) problems.push(`${where}: \`${kind}\` is a path inside the plugin.`);
        else paths.push(value);
        break;
      case "text":
        if (typeof value !== "string") problems.push(`${where}: \`text\` is words.`);
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
