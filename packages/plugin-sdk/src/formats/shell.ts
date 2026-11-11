// A bot's shell style (a theme's optional `shell` block): the window's own chrome wears the bot's palette while that bot's
// tab is the one showing, and the stock look returns on any other tab. Bounded to a handful of colours and paints: no layout,
// no content, no CSS; the shell reads them as `--clover-shell-*` variables and falls back to its own colours for a group
// whose pairs miss their contrast floors. Pure: the theme lint, the main process and the tests all call these.

/** The names a `shell` block may set, by group. A group is applied whole or not at all. */
export const SHELL_GROUPS = {
  /** The title bar: a paint (a colour or a gradient, translucent over the tab's backdrop if it likes), its text and its rule. */
  bar: ["bar", "bar.text", "bar.rule"],
  /** The sidebar: a paint, its text, its quiet text, the selected row's fill and a hovered row's fill. */
  sidebar: ["sidebar", "sidebar.text", "sidebar.muted", "sidebar.selected", "sidebar.hover"],
  /** The accent the chrome's marks and focus take. Optional on its own. */
  accent: ["accent"],
} as const;
export type ShellColourGroup = keyof typeof SHELL_GROUPS;
export type ShellGroup = ShellColourGroup | "shape";

/** The SHAPE of the chrome while a bot's tab shows: what the bar, the sidebar and the panels are like, as closed choices
 *  and bounded whole numbers (CSS pixels). Data only: the shell draws every one of its own parts in the shape these say,
 *  wherever the bot's layout places them (`chrome.*` spots, `formats/layout.ts`). Each name stands alone (a theme sets the
 *  ones it wants); a value outside its choices or range is dropped and that part stays the shell's own. */
export const SHELL_SHAPE: Readonly<Record<string, readonly string[] | { min: number; max: number }>> = {
  /** `standard`: the translucent bar over the tab's top, as every tab has. `none`: no bar; the layout places the parts (an unplaced part is not shown). `float`: a bar inset from the edges with rounded corners. */
  "bar.mode": ["standard", "none", "float"],
  "bar.height": { min: 28, max: 96 },
  "bar.inset": { min: 0, max: 32 },
  "bar.radius": { min: 0, max: 40 },
  /** `edge`: beside the page, edge to edge (as every tab has). `float`: inset over the page, with rounded corners, which then runs under it. `rail`: float, resting as a narrow rail of icons. `none`: no stock sidebar at all, so the bot's own parts (a dock, a strip) are the only navigation; it holds only while a part of the bot says it draws one (`shell.provide(["sidebar"])`), else the shell shows a floating sidebar so the user is never stranded. */
  "sidebar.mode": ["edge", "float", "rail", "none"],
  /** How it rests when the tab opens: the user's toggle (the sidebar part) changes it for as long as the tab is open. */
  "sidebar.start": ["expanded", "collapsed"],
  "sidebar.width": { min: 180, max: 360 },
  "sidebar.inset": { min: 0, max: 32 },
  "sidebar.radius": { min: 0, max: 40 },
  "sidebar.density": ["compact", "regular", "roomy"],
  /** `glass`: the window's material shows through (the default); `solid`: its paint fills it; `none`: nothing of its own: the page's scene shows through and the rows float on it. */
  "sidebar.material": ["glass", "solid", "none"],
  /** Where a panel the user opens shows: `column` (the standard right column), `drawer` (over the page's right edge), `float` (a card over the page), `sheet` (a sheet up from the bottom). A layout that places `chrome.panels` puts the panels in that spot instead. */
  "panel.mode": ["column", "drawer", "float", "sheet"],
  "panel.width": { min: 280, max: 720 },
  "panel.radius": { min: 0, max: 40 },
};

/** The shell token names, the shape's last. */
export const SHELL_SHAPE_NAMES: readonly string[] = Object.keys(SHELL_SHAPE);
export const SHELL_TOKEN_NAMES = [...(Object.values(SHELL_GROUPS).flat() as readonly string[]), ...SHELL_SHAPE_NAMES] as readonly string[];

/** Whether `value` is allowed for a shape name: one of its choices, or a whole number in its range. */
export function isShapeValue(name: string, value: unknown): value is string {
  const rule = SHELL_SHAPE[name];
  if (rule === undefined || typeof value !== "string") return false;
  if (Array.isArray(rule)) return (rule as readonly string[]).includes(value);
  const r = rule as { min: number; max: number };
  return /^\d{1,3}$/.test(value) && Number(value) >= r.min && Number(value) <= r.max;
}
/** The names whose value may be a gradient: the two paints. */
export const SHELL_PAINTS: ReadonlySet<string> = new Set(["bar", "sidebar"]);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const GRADIENT = /^linear-gradient\((?:\s*(?:to (?:top|bottom|left|right)(?: (?:top|bottom|left|right))?|-?\d+(?:\.\d+)?deg)\s*,)?(?:\s*#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})(?:\s+\d+(?:\.\d+)?%)?\s*,?)+\)$/i;

/** A value a shell token may hold: a hex colour, or for a paint `transparent` or a gradient of hex colours. */
export function isShellValue(name: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (SHELL_SHAPE[name] !== undefined) return isShapeValue(name, value);
  if (HEX.test(value)) return true;
  return SHELL_PAINTS.has(name) && (value === "transparent" || GRADIENT.test(value));
}

import { TOKENS } from "../catalogs/tokens";

interface Rgba { r: number; g: number; b: number; a: number }
function hexToRgba(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
const over = (top: Rgba, ground: Rgba): Rgba => ({ r: top.r * top.a + ground.r * (1 - top.a), g: top.g * top.a + ground.g * (1 - top.a), b: top.b * top.a + ground.b * (1 - top.a), a: 1 });
function luminance(c: Rgba): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
export function shellContrast(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colours a paint shows, each laid over `ground` (a translucent or `transparent` paint shows its ground). */
export function paintColours(value: string, ground: string | readonly string[]): Rgba[] {
  const unders = (typeof ground === "string" ? [ground] : ground).map(hexToRgba);
  const stops = value === "transparent" ? [] : [...value.matchAll(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])/gi)].map((m) => hexToRgba(m[0]));
  return unders.flatMap((u) => (value === "transparent" ? [u] : stops.map((c) => over(c, u))));
}

/** The title bar floats over whatever the bot draws under it, so its pairs are checked worst case: the paint laid over
 *  pure black and over pure white, each gradient stop on its own. The bot's pixels never carry the bar's legibility. */
export const BAR_GROUNDS = ["#000000", "#FFFFFF"] as const;

/** Every pair a group paints, with the floor it must reach: text on its paint (4.5), the rule and a selected row's text. */
export function shellProblems(group: ShellColourGroup, values: Readonly<Record<string, string>>, ground: string): string[] {
  const out: string[] = [];
  const need = (fgName: string, bgName: string, floor: number, bgColours?: Rgba[]) => {
    const fg = values[fgName];
    const bg = bgColours ?? paintColours(values[bgName]!, ground);
    if (fg === undefined || !HEX.test(fg)) return;
    for (const b of bg) {
      const got = shellContrast(over(hexToRgba(fg), b), b);
      if (got < floor) { out.push(`${fgName} on ${bgName} is ${got.toFixed(2)}:1; it needs ${floor}:1`); return; }
    }
  };
  if (group === "bar") {
    const worst = paintColours(values["bar"]!, BAR_GROUNDS);
    need("bar.text", "bar", 4.5, worst);
    need("bar.rule", "bar", 1.15, worst);
  } else if (group === "sidebar") {
    need("sidebar.text", "sidebar", 4.5);
    need("sidebar.muted", "sidebar", 4.5);
    // The selected and hovered rows carry the text over their own fill, laid on the paint.
    for (const row of ["sidebar.selected", "sidebar.hover"] as const) {
      const fill = values[row];
      if (fill === undefined || !HEX.test(fill)) continue;
      const rows = paintColours(values["sidebar"]!, ground).map((p) => over(hexToRgba(fill), p));
      need("sidebar.text", row, 4.5, rows);
    }
  } else {
    need("accent", "accent", 0, [hexToRgba("#FFFFFF")]);
  }
  return out;
}

/** Clover's own marks, which no skin can change: waiting (attention), failed (danger), the running dot's stock accent and
 *  the focus ring. Each must reach 3:1 on every ground the skin supplies where it is drawn, or that group is dropped. The
 *  values are the catalog's for the appearance. */
const MARK_TOKENS = ["color.attention", "color.attention.text", "color.danger", "color.accent", "color.focus"] as const;
function marksProblems(group: "bar" | "sidebar", values: Readonly<Record<string, string>>, appearance: "light" | "dark", ground: string): string[] {
  const grounds: [string, Rgba[]][] = [];
  if (group === "bar") grounds.push(["the bar", paintColours(values["bar"]!, BAR_GROUNDS)]);
  else {
    const paint = paintColours(values["sidebar"]!, ground);
    grounds.push(["the sidebar", paint]);
    for (const row of ["sidebar.selected", "sidebar.hover"]) grounds.push([`the ${row.slice(8)} row`, paint.map((p) => over(hexToRgba(values[row]!), p))]);
  }
  for (const name of MARK_TOKENS) {
    const t = TOKENS.find((x) => x.name === name);
    const hex = appearance === "dark" ? t?.dark ?? t?.default : t?.default;
    if (typeof hex !== "string") continue;
    const mark = hexToRgba(hex);
    for (const [where, colours] of grounds) {
      for (const c of colours) {
        const got = shellContrast(over(mark, c), c);
        if (got < 3) return [`Clover's ${name.replace("color.", "")} mark on ${where} is ${got.toFixed(2)}:1; it needs 3:1`];
      }
    }
  }
  return [];
}

/** The accent must read at 3:1 on every ground it is drawn on: the bar (worst case), the sidebar paint, the selected and
 *  hovered rows laid on it, or the shell's own surface when the skin has no sidebar group. `values` holds the groups that
 *  already passed. */
function accentProblems(accent: string, values: Readonly<Record<string, string>>, ground: string): string[] {
  const a = hexToRgba(accent);
  const grounds: [string, Rgba[]][] = [];
  if (values["bar"] !== undefined) grounds.push(["the bar", paintColours(values["bar"], BAR_GROUNDS)]);
  if (values["sidebar"] !== undefined) {
    const paint = paintColours(values["sidebar"], ground);
    grounds.push(["the sidebar", paint]);
    for (const row of ["sidebar.selected", "sidebar.hover"]) {
      const fill = values[row];
      if (fill !== undefined) grounds.push([`the ${row.slice(8)} row`, paint.map((p) => over(hexToRgba(fill), p))]);
    }
  } else grounds.push(["the surface", [hexToRgba(ground)]]);
  for (const [where, colours] of grounds) {
    for (const c of colours) {
      const got = shellContrast(over(a, c), c);
      if (got < 3) return [`accent on ${where} is ${got.toFixed(2)}:1; it needs 3:1`];
    }
  }
  return [];
}

/** A theme's shell values for one appearance, checked: only the groups that are whole and legible survive (a group that
 *  misses a pair is dropped, so that part of the chrome stays the shell's own). `ground` is the colour a translucent paint
 *  lies over (the theme's own surface); the accent must read at 3:1 on it. */
export function resolveShell(
  shell: { tokens: Readonly<Record<string, unknown>>; dark?: { tokens: Readonly<Record<string, unknown>> } } | undefined,
  appearance: "light" | "dark",
  ground: string,
  themeAppearance: "light" | "dark" | "both" = "both",
): { values: Record<string, string>; dropped: { group: ShellGroup; why: string }[] } {
  const values: Record<string, string> = {};
  const dropped: { group: ShellGroup; why: string }[] = [];
  if (shell === undefined || (themeAppearance !== "both" && themeAppearance !== appearance)) return { values, dropped };
  const merged: Record<string, unknown> = { ...shell.tokens, ...(appearance === "dark" ? shell.dark?.tokens ?? {} : {}) };
  // The shape: each name on its own, no colours to check.
  for (const n of SHELL_SHAPE_NAMES) {
    const v = merged[n];
    if (v === undefined) continue;
    if (isShapeValue(n, v)) values[n] = v;
    else dropped.push({ group: "shape", why: `${n} is not one of its choices or range` });
  }
  for (const group of Object.keys(SHELL_GROUPS) as ShellColourGroup[]) {
    const names = SHELL_GROUPS[group];
    const got: Record<string, string> = {};
    let any = false;
    let whole = true;
    for (const n of names) {
      const v = merged[n];
      if (v === undefined) { whole = false; continue; }
      any = true;
      if (isShellValue(n, v)) got[n] = v;
      else whole = false;
    }
    if (!any) continue;
    if (!whole) { dropped.push({ group, why: "a name is missing or its value is not allowed" }); continue; }
    const problems = group === "accent" ? accentProblems(got["accent"]!, values, ground) : shellProblems(group, got, ground);
    if (problems.length === 0 && group !== "accent") problems.push(...marksProblems(group, got, appearance, ground));
    if (problems.length > 0) { dropped.push({ group, why: problems.join("; ") }); continue; }
    Object.assign(values, got);
  }
  return { values, dropped };
}
