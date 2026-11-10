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
//   and gets it only if its own plugin may hold it, within a minute, once. The core mints what a file or a message
//   grant holds (E-M2): a file is a place in the folder tree, which the core checks and names itself, and a message
//   its session and seq; nothing the offering plugin adds rides along, and no bytes do: the claiming part reads the
//   file or the message through its own plugin API, where the daemon checks its own access.
// Sealed card frames are outside both (E-M3).
import type { OpenTarget } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { SessionId, TreePath } from "@waifucave/clover-protocol";

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

/** A file grant as the core mints it: its place in the folder tree, and its name, which the core takes from that place. */
export interface FileGrant {
  path: string;
  name: string;
}

/** A message grant as the core mints it: the session and the message's seq there. */
export interface MessageGrant {
  session: string;
  seq: number;
}

/** What the core grants for a file the part names: the tree path, normalised (no `.` or `..`, no empty segment), and
 *  its last segment as the name; nothing else the part said. */
export function mintFileGrant(data: unknown): FileGrant | { error: string } {
  const raw = typeof data === "string" ? data : data !== null && typeof data === "object" ? (data as { path?: unknown }).path : undefined;
  if (typeof raw !== "string") return { error: "a file is named by its place in the folder tree" };
  const segments = raw.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\0"))) return { error: "not a place in the folder tree" };
  const path = segments.join("/");
  if (!TreePath.safeParse(path).success || segments.length < 2) return { error: "not a place in the folder tree" };
  return { path, name: segments.at(-1)! };
}

/** What the core grants for a message: its session and seq. */
export function mintMessageGrant(data: unknown): MessageGrant | { error: string } {
  const d = data !== null && typeof data === "object" ? (data as { session?: unknown; seq?: unknown }) : {};
  if (!SessionId.safeParse(d.session).success || typeof d.seq !== "number" || !Number.isInteger(d.seq) || d.seq < 0) return { error: "a message is named by its session and seq" };
  return { session: d.session as string, seq: d.seq };
}

/** An offer the core accepts: a known kind, data that fits, and a plugin that may hand it out. A file's or a
 *  message's data is the grant the core mints for it. */
export function checkDragOffer(raw: unknown, capabilities: ReadonlySet<string>): DragOffer | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "an offer is an object" };
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !(type in DRAG_KINDS)) return { error: "not a kind of data a drag may carry" };
  const needs = DRAG_KINDS[type];
  if (needs !== null && needs !== undefined && !capabilities.has(needs)) return { error: `the offering plugin lacks ${needs}` };
  const size = JSON.stringify(data ?? null).length;
  if (size > DRAG_DATA_MAX) return { error: "the data is too large" };
  if (type === "application/x-clover-file") {
    const grant = mintFileGrant(data);
    return "error" in grant ? grant : { type, data: grant };
  }
  if (type === "application/x-clover-message") {
    const grant = mintMessageGrant(data);
    return "error" in grant ? grant : { type, data: grant };
  }
  if (typeof data !== "string") return { error: "text and links are strings" };
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

/** How click-through follows the cursor where the OS doesn't forward its moves to an ignoring window (Linux). */
export const CLICK_THROUGH_POLL_MS = 120;

/** A surface's click-through (§5.5, G's ask): it takes clicks inside its regions and lets the rest through to what is
 *  under it. On macOS and Windows the OS forwards the cursor's moves to a window that ignores the mouse, so the window
 *  follows them with no timer; on Linux, where it doesn't, the cursor's place is read every `CLICK_THROUGH_POLL_MS`.
 *  It calls `apply` only when the answer changes. */
export class ClickThrough {
  private regions: readonly Rect[] = [];
  private on = false;
  private ignoring: boolean | undefined;

  constructor(private readonly apply: (ignore: boolean) => void) {}

  /** The surface's regions, and whether it shows; with none (or hidden) it takes every click, as a normal window. */
  set(regions: readonly Rect[], visible: boolean, at: { x: number; y: number } | undefined): void {
    this.regions = regions;
    this.on = visible && regions.length > 0;
    if (!this.on) {
      this.decide(false);
      return;
    }
    this.move(at);
  }

  /** The cursor, in the window's own space, moved (undefined: it left the window). */
  move(at: { x: number; y: number } | undefined): void {
    if (!this.on) return;
    this.decide(at === undefined || !inRegions(at, this.regions));
  }

  get active(): boolean {
    return this.on;
  }

  private decide(ignore: boolean): void {
    if (this.ignoring === ignore) return;
    this.ignoring = ignore;
    this.apply(ignore);
  }
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

/** How soon after the user's key press or click a send it started must reach the main process. */
export const SEND_INPUT_WINDOW_MS = 1_000;

/** Sends counted as the user's (§5.5): one key press or click the main process saw come to the window covers one
 *  send, within a second; any other send is refused. */
export class SendGate {
  private readonly lastInput = new Map<number, number>();

  constructor(private readonly now: () => number = Date.now) {}

  input(windowId: number): void {
    this.lastInput.set(windowId, this.now());
  }

  take(windowId: number): boolean {
    const at = this.lastInput.get(windowId);
    this.lastInput.delete(windowId);
    return at !== undefined && this.now() - at <= SEND_INPUT_WINDOW_MS;
  }

  forget(windowId: number): void {
    this.lastInput.delete(windowId);
  }
}

/** A gated call's gesture: the call's own frame had transient user activation (`active`, read in the preload, where a
 *  page's script can't set it), AND the main process saw a key press or click come to the window (`take`, which spends it).
 *  A call from a frame that was not activated spends nobody's gesture, so a plugin frame polling the bridge can neither
 *  use a click that went elsewhere nor starve the user's own send. */
export function frameGesture(active: unknown, take: () => boolean): boolean {
  return active === true && take();
}

/** A `pill.send` target, checked: a bot, a session, or a `pill.target` entry by its ref. */
export function sendTarget(v: unknown): { bot: string } | { session: string } | { target: string } | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const t = v as Record<string, unknown>;
  const keys = Object.keys(t);
  if (keys.length !== 1) return undefined;
  if (typeof t.bot === "string" && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/.test(t.bot)) return { bot: t.bot };
  if (typeof t.session === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(t.session)) return { session: t.session };
  if (typeof t.target === "string" && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?#[a-z0-9][a-z0-9._-]*$/.test(t.target)) return { target: t.target };
  return undefined;
}

/** The images that may go with the user's words: at most 4, PNG, JPEG or WebP, each at most 7.5 MB. */
export function sendImages(v: unknown): { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string }[] | { error: string } {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 4) return { error: "at most four pictures" };
  const out: { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string }[] = [];
  for (const i of v) {
    const m = (i as { mediaType?: unknown })?.mediaType;
    const d = (i as { data?: unknown })?.data;
    if ((m !== "image/png" && m !== "image/jpeg" && m !== "image/webp") || !(d instanceof Uint8Array) || d.length === 0 || d.length > 7_500_000) return { error: "a picture is a PNG, JPEG or WebP of at most 7.5 MB" };
    out.push({ mediaType: m, data: Buffer.from(d).toString("base64") });
  }
  return out;
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

/** A native view's frame in the window: the rect the part reported in its own frame, clipped to that frame (a part
 *  never places a view outside itself), then offset by each frame's place, outermost first. Undefined when nothing of
 *  it is left. */
export function viewRect(rect: Rect, chain: readonly Rect[]): Rect | undefined {
  const own = chain[chain.length - 1];
  if (own === undefined || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return undefined;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(own.width, rect.x + rect.width);
  const y1 = Math.min(own.height, rect.y + rect.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return undefined;
  let dx = 0;
  let dy = 0;
  for (const r of chain) {
    dx += r.x;
    dy += r.y;
  }
  return { x: Math.round(x0 + dx), y: Math.round(y0 + dy), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

/** Who places the Clover Browser's live view: a part whose plugin has `browser`. */
export function mayPlaceView(capabilities: ReadonlySet<string>): boolean {
  return capabilities.has("browser");
}

export interface ViewTargetRef {
  windowId: number;
  bounds: Rect;
}

/** Where each named native view goes (ruling R8): every part that placed it reports its frame; the view follows the
 *  one the person used last (a newly placed one counts as used), and goes nowhere while that one has no place. */
export class ViewFrames {
  private readonly frames = new Map<string, Map<string, { windowId: number; bounds?: Rect; usedAt: number }>>();
  private readonly current = new Map<string, string>();
  private tick = 0;

  /** `changed(name, target)` hears each view's new target (undefined: none). */
  constructor(private readonly changed: (name: string, target: ViewTargetRef | undefined) => void) {}

  report(name: string, mount: string, windowId: number, bounds: Rect | undefined, used: boolean): void {
    const byMount = this.frames.get(name) ?? new Map();
    this.frames.set(name, byMount);
    const was = byMount.get(mount);
    byMount.set(mount, { windowId, ...(bounds !== undefined ? { bounds } : {}), usedAt: used || was === undefined ? ++this.tick : was.usedAt });
    this.update(name);
  }

  /** A part, or its document, is gone: its frames go with it. */
  drop(mount: string): void {
    for (const [name, byMount] of this.frames) if (byMount.delete(mount)) this.update(name);
  }

  /** A window closed. */
  dropWindow(windowId: number): void {
    for (const [name, byMount] of this.frames) {
      let any = false;
      for (const [m, f] of byMount) if (f.windowId === windowId) any = byMount.delete(m) || any;
      if (any) this.update(name);
    }
  }

  /** The view's target now. */
  target(name: string): ViewTargetRef | undefined {
    const byMount = this.frames.get(name);
    if (byMount === undefined) return undefined;
    let best: { windowId: number; bounds?: Rect; usedAt: number } | undefined;
    for (const f of byMount.values()) if (best === undefined || f.usedAt > best.usedAt) best = f;
    return best?.bounds === undefined ? undefined : { windowId: best.windowId, bounds: best.bounds };
  }

  private update(name: string): void {
    const t = this.target(name);
    const key = JSON.stringify(t ?? null);
    if (this.current.get(name) === key) return;
    this.current.set(name, key);
    this.changed(name, t);
  }
}

/** How long after the person's mouse-down a part may say they used its native view. */
export const VIEW_USE_WINDOW_MS = 2_000;

/** The person's mouse-downs in each window, as main saw them (`before-mouse-event`): a part's word that the person
 *  used its native view counts only when main saw a mouse-down in that window, inside the view's place, just before. */
export class PointerLog {
  private readonly last = new Map<number, { x: number; y: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  down(windowId: number, x: number, y: number): void {
    this.last.set(windowId, { x, y, at: this.now() });
  }

  /** Whether the person just pressed inside `rect` (window coordinates) in that window. */
  pressedIn(windowId: number, rect: Rect): boolean {
    const p = this.last.get(windowId);
    return p !== undefined && this.now() - p.at <= VIEW_USE_WINDOW_MS && inRegions(p, [rect]);
  }

  forget(windowId: number): void {
    this.last.delete(windowId);
  }
}
