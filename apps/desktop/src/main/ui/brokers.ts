// The host's brokers for what crosses a layer's edge (S9 §3, "Design for M1"). Pure, so the rules are unit-tested.
//
// * **Menus:** a frame can't paint outside itself, so a menu goes through the core. The layer hands over data — items
//   with ids and labels, nothing to draw — and a point inside its own frame. The core checks the items, clamps the
//   point to the frame, finds the frame's place in the window, shows a native menu there, and answers only the frame
//   that asked, with the id picked or nothing.
// * **Drags:** text, links and files dragged by the user already cross frames through Chromium, and a dropped file
//   reaches a page as its bytes, never its path. Data a part offers another part (a file from the files panel, a
//   message) goes through the core as a grant: the offering part says what it is, the core checks that the offering
//   plugin may hand it out and hands back a single-use token for the drag's data; the part it's dropped on claims it,
//   and gets it only if its own plugin may hold it, within a minute, once.
// Sealed card frames are outside both (E-M3).
import type { OpenTarget } from "@waifucave/clover-plugin-sdk/ui/bridge";

export interface MenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  type?: "normal" | "separator" | "checkbox";
  submenu?: MenuItem[];
}

export interface MenuRequest {
  items: MenuItem[];
  /** A point in the asking frame's own viewport, in CSS pixels. */
  x: number;
  y: number;
}

export const MENU_LIMITS = { items: 100, depth: 3, label: 200, id: 128 } as const;

/** The items as the core shows them, or the reason they're refused. Labels are plain text; ids are unique. */
export function checkMenu(raw: unknown): { items: MenuItem[] } | { error: string } {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) return { error: "a menu is a list of items" };
  const ids = new Set<string>();
  let count = 0;
  const walk = (list: unknown[], depth: number): MenuItem[] | string => {
    if (depth > MENU_LIMITS.depth) return "menus nest three deep at most";
    const out: MenuItem[] = [];
    for (const v of list) {
      if (++count > MENU_LIMITS.items) return `a menu has ${MENU_LIMITS.items} items at most`;
      if (v === null || typeof v !== "object") return "an item is an object";
      const it = v as Record<string, unknown>;
      if (it.type === "separator") {
        out.push({ type: "separator" });
        continue;
      }
      if (typeof it.label !== "string" || it.label.length === 0 || it.label.length > MENU_LIMITS.label) return "an item needs a label of 200 characters at most";
      const item: MenuItem = { label: it.label.replace(/[\u0000-\u001f\u007f]/g, " "), enabled: it.enabled !== false };
      if (it.type === "checkbox") {
        item.type = "checkbox";
        item.checked = it.checked === true;
      }
      if (Array.isArray(it.submenu)) {
        const sub = walk(it.submenu, depth + 1);
        if (typeof sub === "string") return sub;
        item.submenu = sub;
      } else {
        if (typeof it.id !== "string" || it.id.length === 0 || it.id.length > MENU_LIMITS.id) return "an item needs an id";
        if (ids.has(it.id)) return `two items have the id ${it.id}`;
        ids.add(it.id);
        item.id = it.id;
      }
      out.push(item);
    }
    return out;
  };
  const items = walk((raw as { items: unknown[] }).items, 1);
  if (typeof items === "string") return { error: items };
  if (items.length === 0) return { error: "a menu has at least one item" };
  return { items };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The menu's point in the window: the asking frame's point, clamped inside its frame, plus each frame's offset from
 *  the window's top-left down to it (outermost first). */
export function menuPoint(point: { x: number; y: number }, chain: readonly Rect[]): { x: number; y: number } | undefined {
  const own = chain[chain.length - 1];
  if (own === undefined) return undefined;
  const fin = (n: number) => (Number.isFinite(n) ? n : 0);
  let x = Math.min(Math.max(0, fin(point.x)), own.width);
  let y = Math.min(Math.max(0, fin(point.y)), own.height);
  for (const r of chain) {
    x += r.x;
    y += r.y;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** What a dragged grant may carry, and the capability a plugin needs to offer or claim it. */
export const DRAG_KINDS: Readonly<Record<string, string | null>> = {
  "text/plain": null,
  "text/uri-list": null,
  "application/x-clover-file": "files",
  "application/x-clover-message": "conversation.read",
};

export const DRAG_GRANT_TTL_MS = 60_000;
export const DRAG_DATA_MAX = 256_000;

export interface DragOffer {
  type: string;
  data: unknown;
}

/** An offer the core accepts: a known kind, data that fits, and a plugin that may hand it out. */
export function checkDragOffer(raw: unknown, capabilities: ReadonlySet<string>): DragOffer | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "an offer is an object" };
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !(type in DRAG_KINDS)) return { error: "not a kind of data a drag may carry" };
  const needs = DRAG_KINDS[type];
  if (needs !== null && needs !== undefined && !capabilities.has(needs)) return { error: `the offering plugin lacks ${needs}` };
  const size = JSON.stringify(data ?? null).length;
  if (size > DRAG_DATA_MAX) return { error: "the data is too large" };
  return { type, data };
}

/** Whether a plugin may claim a grant of this kind. */
export function mayClaim(type: string, capabilities: ReadonlySet<string>): boolean {
  const needs = DRAG_KINDS[type];
  return needs === null || (needs !== undefined && capabilities.has(needs));
}

/** Where a surface window sits on its display (`window.placement`, else by the surface: the island at the top centre
 *  (at the notch, where there is one), the pill at the bottom centre, anything else centred). */
export function surfacePlacement(input: { surface: string; placement?: string; size: { width: number; height: number }; display: Rect; workArea: Rect }): Rect {
  const where = input.placement ?? (input.surface === "island" ? "top" : input.surface === "pill" ? "bottom" : "center");
  const { width, height } = input.size;
  const w = input.workArea;
  const x = Math.round(input.display.x + (input.display.width - width) / 2);
  if (where.startsWith("top")) return { x, y: input.display.y, width, height };
  if (where.startsWith("bottom")) return { x, y: Math.round(w.y + w.height - height - 24), width, height };
  return { x, y: Math.round(w.y + (w.height - height) / 2), width, height };
}

/** A surface's click regions, checked: rects inside the window, a few dozen at most. */
export function checkRegions(raw: unknown, bounds: { width: number; height: number }): Rect[] {
  if (!Array.isArray(raw)) return [];
  const out: Rect[] = [];
  for (const r of raw.slice(0, 64)) {
    if (r === null || typeof r !== "object") continue;
    const { x, y, width, height } = r as Record<string, unknown>;
    if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const rx = Math.max(0, x as number);
    const ry = Math.max(0, y as number);
    const rw = Math.min(bounds.width - rx, width as number);
    const rh = Math.min(bounds.height - ry, height as number);
    if (rw > 0 && rh > 0) out.push({ x: rx, y: ry, width: rw, height: rh });
  }
  return out;
}

/** Whether a point (in the window) is in any region. */
export function inRegions(point: { x: number; y: number }, regions: readonly Rect[]): boolean {
  return regions.some((r) => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height);
}

/** Surfaces the `clover` tree ships may float above everything, on every Space (the island, the pill); in 1.111.1 any
 *  other plugin's surface is an ordinary window level (the E-M1 review's ruling). */
export function surfaceMayFloat(pluginId: string): boolean {
  return pluginId.split("/")[0] === "clover";
}

/** The largest surface a plugin outside the `clover` tree may have. */
export const THIRD_PARTY_SURFACE_MAX = { width: 800, height: 600 } as const;

/** A surface's size, as asked, kept to the display's work area, and for a plugin outside the `clover` tree to
 *  `THIRD_PARTY_SURFACE_MAX`; each side at least 40 by 24. A side not asked keeps `current`'s. */
export function surfaceSize(asked: { width?: unknown; height?: unknown }, current: { width: number; height: number }, input: { trusted: boolean; workArea: { width: number; height: number } }): { width: number; height: number } {
  const maxW = Math.max(40, input.trusted ? input.workArea.width : Math.min(THIRD_PARTY_SURFACE_MAX.width, input.workArea.width));
  const maxH = Math.max(24, input.trusted ? input.workArea.height : Math.min(THIRD_PARTY_SURFACE_MAX.height, input.workArea.height));
  const side = (v: unknown, fallback: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, typeof v === "number" && Number.isFinite(v) ? v : fallback)));
  return { width: side(asked.width, current.width, 40, maxW), height: side(asked.height, current.height, 24, maxH) };
}

/** How long after the user's last click or key press in a window a part may open a menu there. */
export const MENU_INPUT_WINDOW_MS = 5_000;

/** The menu broker's gate: one menu at a time, and only right after the user's own input in that window, which the
 *  menu then uses up (one click, one menu). */
export class MenuGate {
  private readonly lastInput = new Map<number, number>();
  private open = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** The user clicked or pressed a key in a window (`before-mouse-event`, `before-input-event`). */
  input(windowId: number): void {
    this.lastInput.set(windowId, this.now());
  }

  /** Takes the gate for a menu in a window, or says why not. */
  take(windowId: number): { ok: true } | { ok: false; reason: string } {
    if (this.open) return { ok: false, reason: "another menu is open" };
    const at = this.lastInput.get(windowId);
    if (at === undefined || this.now() - at > MENU_INPUT_WINDOW_MS) return { ok: false, reason: "a menu needs the user's recent click or key press in its window" };
    this.lastInput.delete(windowId);
    this.open = true;
    return { ok: true };
  }

  /** The menu closed. */
  done(): void {
    this.open = false;
  }

  forget(windowId: number): void {
    this.lastInput.delete(windowId);
  }
}

function text(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** A place a part may ask the app to open, checked. */
export function openTarget(v: unknown): OpenTarget | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const t = v as Record<string, unknown>;
  if (t.kind === "settings") {
    const section = text(t.section, 64);
    const item = text(t.item, 256);
    if (t.section !== undefined && (section === undefined || !/^[a-z][a-z0-9.-]*$/.test(section))) return undefined;
    if (t.item !== undefined && item === undefined) return undefined;
    return { kind: "settings", ...(section !== undefined ? { section } : {}), ...(item !== undefined ? { item } : {}) };
  }
  if (t.kind === "bot") {
    const bot = text(t.bot, 81);
    return bot !== undefined && /^[a-z][a-z0-9/-]*$/.test(bot) ? { kind: "bot", bot } : undefined;
  }
  return undefined;
}


/** Who may ask the app to open a place: in 1.111.1, the `clover` tree's parts only (the island's Usage and Devices
 *  tabs); a third party's would bring the main window up over whatever the person is doing. */
export function mayOpen(pluginId: string): boolean {
  return pluginId.split("/")[0] === "clover";
}

/** Where a surface asked to be, kept on its display: inside the display's bounds for the `clover` tree, inside the work
 *  area and `THIRD_PARTY_SURFACE_MAX` for anyone else. */
export function surfaceBounds(asked: unknown, display: { bounds: Rect; workArea: Rect }, trusted: boolean): Rect | undefined {
  if (asked === null || typeof asked !== "object") return undefined;
  const { x, y, width, height } = asked as Record<string, unknown>;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  const area = trusted ? display.bounds : display.workArea;
  const size = surfaceSize({ width, height }, { width: 40, height: 24 }, { trusted, workArea: { width: area.width, height: area.height } });
  const cx = Math.round(Math.min(Math.max(area.x, x as number), area.x + area.width - size.width));
  const cy = Math.round(Math.min(Math.max(area.y, y as number), area.y + area.height - size.height));
  return { x: cx, y: cy, ...size };
}
