// The app's plugin runtime in the main process (spec §5.5, §5.8): the registry the daemon hands over, the user's
// choices, and every mount — one entry in one place. Decision 77: one origin and process per plugin layer, one frame
// per place a part appears, state held by the core, each frame themed by its tab.
//
// A mount is a document (the window's core root, or a frame from a plugin's layer) or a part inline in its parent's
// document. A frame is loaded only with a single-use token the core issued for that place: the protocol handler serves
// the document once for it, and the document then binds itself to the mount from the very frame the URL was loaded
// in, whose parent must be the document that placed it. A reload after a crash takes a fresh token (S9 review).
//
// Electron-free: the Electron glue (ipc.ts) hands frames in as `FrameRef`s and delivers what `send` produces, so the
// tests drive the whole runtime under Bun.
import { randomBytes } from "node:crypto";
import type { LayerMessage, MountContext, MountInfo, SpotItem, SpotView } from "@waifucave/clover-plugin-sdk/ui/bridge";
import type { Appearance, TokenValue } from "@waifucave/clover-plugin-sdk";
import { spotInfo } from "@waifucave/clover-plugin-sdk";
import { SAFE_MODE_PLUGINS, type UiEntry, type UiPlugin } from "./model";
import { NO_CHOICES, SpotTree, entryRef, resolveCell, type CellContext, type Candidate, type Os, type UiChoices } from "./spots";
import { DRAG_GRANT_TTL_MS, checkDragOffer, mayClaim, type DragOffer } from "./brokers";
import { defaultFrameMetrics, partTokens, ThemeStore, type FrameMetrics, type ThemeChoices } from "./theme";

/** A frame as Electron describes it. */
export interface FrameRef {
  processId: number;
  routingId: number;
  url: string;
  /** The frame's OS process id, for the crash census. */
  osPid?: number;
  parent?: FrameRef | null;
}

export type Material = MountContext["material"];

export const MOUNT_TOKEN_TTL_MS = 60_000;

const frameKey = (f: Pick<FrameRef, "processId" | "routingId">) => `${f.processId}:${f.routingId}`;

/** The spots keyed by bot: the cell's context is that bot's tab. */
const KEYED_BY_BOT = new Set(["bot.tab", "sidebar.bot"]);

interface Mount {
  id: string;
  kind: "root" | "frame" | "inline" | "web";
  parent?: string;
  windowId: number;
  /** The layer whose document holds it ("core" for a window's root). */
  layer: string;
  plugin?: UiPlugin;
  entryId: string;
  component?: string;
  spot: string;
  key?: string;
  ctx: CellContext;
  /** The style-only entries that dress it. */
  styles: Candidate[];
  tokens: Record<string, TokenValue>;
  tokensKey: string;
  props: unknown;
  /** A window's root: the spots it declares. A surface window's root shows one entry. */
  rootSpots?: readonly string[];
  surfaceRef?: string;
  // A frame's document.
  token?: string;
  tokenState?: "issued" | "served" | "bound" | "gone" | "asleep";
  issuedAt?: number;
  frame?: { key: string; processId: number; routingId: number; osPid?: number };
  /** Children by place: `<spot>|<key>|<entry ref>`. */
  children: Map<string, string>;
  /** Placed by the clover layer with a session kind (`when.session`). */
  session?: string;
}

export interface WindowInfo {
  material: Material;
  frame: FrameMetrics;
}

export interface RuntimeOptions {
  os: Os;
  platform?: NodeJS.Platform;
  safeMode?: boolean;
  log?: (line: string) => void;
  now?: () => number;
  token?: () => string;
  /** Delivers a message to a bound document. */
  send?: (frame: { processId: number; routingId: number }, message: LayerMessage) => void;
  themes?: ThemeStore;
}

export class LayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerError";
  }
}

export interface UiSettingsLike extends UiChoices, ThemeChoices {}

export class UiRuntime {
  private plugins: UiPlugin[] = [];
  private choices: UiSettingsLike = { ...NO_CHOICES };
  private tree = new SpotTree([]);
  private readonly mounts = new Map<string, Mount>();
  private readonly byToken = new Map<string, string>();
  private readonly byFrame = new Map<string, string>();
  private readonly windows = new Map<number, WindowInfo>();
  private appearance: Appearance = "light";
  private systemAccent: string | undefined;
  private safeModeValue: boolean;
  private nextId = 1;
  private readonly grants = new Map<string, { offer: DragOffer; windowId: number; at: number }>();
  private readonly themes: ThemeStore;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly log: (line: string) => void;
  send: (frame: { processId: number; routingId: number }, message: LayerMessage) => void;

  constructor(private readonly opts: RuntimeOptions) {
    this.safeModeValue = opts.safeMode ?? false;
    this.now = opts.now ?? Date.now;
    this.token = opts.token ?? (() => randomBytes(24).toString("hex"));
    this.log = opts.log ?? (() => {});
    this.send = opts.send ?? (() => {});
    this.themes = opts.themes ?? new ThemeStore(this.log);
  }

  get safeMode(): boolean {
    return this.safeModeValue;
  }

  get registry(): readonly UiPlugin[] {
    return this.plugins;
  }

  // ----------------------------------------------------------------------------------------------
  // State from the daemon and the OS
  // ----------------------------------------------------------------------------------------------

  setRegistry(plugins: readonly UiPlugin[]): void {
    this.plugins = [...plugins];
    this.tree = new SpotTree(this.plugins);
    this.themes.clear();
    this.changed(true);
  }

  setChoices(choices: UiSettingsLike): void {
    this.choices = { ...choices, picks: choices.picks ?? [], lists: choices.lists ?? [] };
    this.changed(true);
  }

  /** Safe mode, when the daemon says the app started in it (§5.8). */
  setSafeMode(on: boolean): void {
    if (on === this.safeModeValue) return;
    this.safeModeValue = on;
    for (const m of this.mounts.values()) m.ctx = { ...m.ctx, safeMode: on };
    this.changed(true);
  }

  setAppearance(appearance: Appearance, systemAccent: string | undefined): void {
    if (appearance === this.appearance && systemAccent === this.systemAccent) return;
    this.appearance = appearance;
    this.systemAccent = systemAccent;
    this.changed(false);
  }

  setFrameMetrics(windowId: number, frame: FrameMetrics): void {
    const w = this.windows.get(windowId);
    if (w === undefined) return;
    w.frame = frame;
    this.changed(false);
  }

  /** Recomputes every mount's tokens and tells each document what changed; with `respot`, every spot resolves again. */
  private changed(respot: boolean): void {
    const updates = new Map<string, Record<string, Record<string, TokenValue>>>();
    for (const m of this.mounts.values()) {
      if (m.kind === "web") continue;
      const before = m.tokensKey;
      this.retheme(m);
      if (m.tokensKey === before) continue;
      const doc = this.docOf(m);
      if (doc?.frame === undefined) continue;
      const u = updates.get(doc.id) ?? {};
      u[m.id] = m.tokens;
      updates.set(doc.id, u);
    }
    for (const [docId, tokens] of updates) this.post(docId, { type: "tokens", tokens });
    if (respot) for (const m of this.mounts.values()) if (m.frame !== undefined) this.post(m.id, { type: "respot" });
  }

  private retheme(m: Mount): void {
    const w = this.windows.get(m.windowId);
    const styles = m.styles.filter((c) => c.entry.style !== undefined).map((c) => ({ plugin: c.plugin, file: c.entry.style! }));
    m.tokens = partTokens(this.themes, {
      plugins: this.plugins,
      choices: this.choices,
      ...(m.ctx.bot !== undefined ? { bot: m.ctx.bot } : {}),
      styles,
      appearance: this.appearance,
      ...(this.systemAccent !== undefined ? { systemAccent: this.systemAccent } : {}),
      frame: w?.frame ?? defaultFrameMetrics(this.opts.platform ?? "darwin"),
    });
    m.tokensKey = JSON.stringify(m.tokens);
  }

  // ----------------------------------------------------------------------------------------------
  // Windows and their roots
  // ----------------------------------------------------------------------------------------------

  /** A window's core root: `app.root` for the main window, one `app.surface` entry for a surface window. */
  openWindow(windowId: number, input: { material: Material; surface?: { id: string; ref: string } }): string {
    this.windows.set(windowId, { material: input.material, frame: defaultFrameMetrics(this.opts.platform ?? "darwin") });
    const id = this.mountId();
    const m: Mount = {
      id,
      kind: "root",
      windowId,
      layer: "core",
      entryId: "root",
      spot: input.surface === undefined ? "app.root" : "app.surface",
      ctx: { os: this.opts.os, safeMode: this.safeModeValue, ...(input.surface !== undefined ? { surface: input.surface.id } : {}) },
      styles: [],
      tokens: {},
      tokensKey: "",
      props: {},
      rootSpots: [input.surface === undefined ? "app.root" : "app.surface"],
      ...(input.surface !== undefined ? { surfaceRef: input.surface.ref } : {}),
      children: new Map(),
    };
    this.retheme(m);
    this.mounts.set(id, m);
    return id;
  }

  closeWindow(windowId: number): void {
    for (const m of [...this.mounts.values()]) if (m.windowId === windowId) this.drop(m.id);
    this.windows.delete(windowId);
  }

  /** Binds a window's root document to its main frame, the first time it asks (its URL must be the core's). */
  private bindRoot(frame: FrameRef, windowId: number): Mount {
    if (!frame.url.startsWith("clover-core://app/") || (frame.parent !== undefined && frame.parent !== null)) throw new LayerError("not the core's root document");
    const root = [...this.mounts.values()].find((m) => m.kind === "root" && m.windowId === windowId);
    if (root === undefined) throw new LayerError("this window has no root");
    if (root.frame !== undefined && root.frame.key !== frameKey(frame)) this.byFrame.delete(root.frame.key);
    root.frame = { key: frameKey(frame), processId: frame.processId, routingId: frame.routingId, ...(frame.osPid !== undefined ? { osPid: frame.osPid } : {}) };
    this.byFrame.set(root.frame.key, root.id);
    return root;
  }

  // ----------------------------------------------------------------------------------------------
  // Documents
  // ----------------------------------------------------------------------------------------------

  private mountId(): string {
    return `m${this.nextId++}`;
  }

  private docOf(m: Mount): Mount | undefined {
    let at: Mount | undefined = m;
    while (at !== undefined && at.kind === "inline") at = at.parent === undefined ? undefined : this.mounts.get(at.parent);
    return at;
  }

  private docByFrame(frame: FrameRef): Mount | undefined {
    const id = this.byFrame.get(frameKey(frame));
    return id === undefined ? undefined : this.mounts.get(id);
  }

  /** The document a frame is, or the error a layer gets. */
  private requireDoc(frame: FrameRef): Mount {
    const doc = this.docByFrame(frame);
    if (doc === undefined) throw new LayerError("this document isn't bound to a mount");
    return doc;
  }

  private post(mountId: string, message: LayerMessage): void {
    const m = this.mounts.get(mountId);
    if (m?.frame === undefined) return;
    try {
      this.send({ processId: m.frame.processId, routingId: m.frame.routingId }, message);
    } catch (err) {
      this.log(`layers: a message to ${mountId} was lost: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The protocol handler's question: may this layer serve a document for this token now? Spends the token's one
   *  load; undefined for a spent, unknown, expired or foreign token (403). */
  serveDocument(layer: string, token: string | null): Mount | undefined {
    if (token === null) return undefined;
    const id = this.byToken.get(token);
    const m = id === undefined ? undefined : this.mounts.get(id);
    if (m === undefined || m.kind !== "frame" || m.layer !== layer || m.tokenState !== "issued") return undefined;
    if (this.now() - (m.issuedAt ?? 0) > MOUNT_TOKEN_TTL_MS) return undefined;
    m.tokenState = "served";
    return m;
  }

  /** A document asks what it is: the root of its window, or the frame its token was issued for. */
  describe(frame: FrameRef, windowId: number, token: string | undefined): MountInfo {
    if (token === undefined || token === "") {
      const root = this.bindRoot(frame, windowId);
      return this.info(root);
    }
    const id = this.byToken.get(token);
    const m = id === undefined ? undefined : this.mounts.get(id);
    if (m === undefined || m.kind !== "frame" || m.tokenState !== "served") throw new LayerError("no mount for this token");
    if (m.windowId !== windowId) throw new LayerError("the token belongs to another window");
    let url: URL;
    try {
      url = new URL(frame.url);
    } catch {
      throw new LayerError("not a layer document");
    }
    if (url.protocol !== "clover-plugin:" || url.host !== m.layer || url.searchParams.get("mount") !== token) throw new LayerError("the token was loaded elsewhere");
    const parentDoc = m.parent === undefined ? undefined : this.docOf(this.mounts.get(m.parent)!);
    if (parentDoc?.frame === undefined || frame.parent === undefined || frame.parent === null || frameKey(frame.parent) !== parentDoc.frame.key) {
      throw new LayerError("the frame isn't where the token placed it");
    }
    m.tokenState = "bound";
    m.frame = { key: frameKey(frame), processId: frame.processId, routingId: frame.routingId, ...(frame.osPid !== undefined ? { osPid: frame.osPid } : {}) };
    this.byFrame.set(m.frame.key, m.id);
    this.byToken.delete(token);
    return this.info(m);
  }

  private context(m: Mount): MountContext {
    const w = this.windows.get(m.windowId);
    const bots = this.plugins.filter((p) => p.isBot && (!this.safeModeValue || SAFE_MODE_PLUGINS.includes(p.topId))).map((p) => ({ id: p.id, name: p.name ?? p.id }));
    return {
      ...(m.ctx.bot !== undefined ? { bot: m.ctx.bot } : {}),
      ...(m.ctx.surface !== undefined ? { surface: m.ctx.surface } : {}),
      ...(m.ctx.session !== undefined ? { session: m.ctx.session } : {}),
      os: m.ctx.os,
      material: w?.material ?? "none",
      safeMode: this.safeModeValue,
      bots,
    };
  }

  /** The module and stylesheets a plugin's document loads, served from its own origin. */
  assets(m: Mount): { module?: string; css: string[] } {
    if (m.plugin === undefined) return { css: [] };
    if (m.plugin.topId === "clover") return { module: "/_clover/clover.js", css: ["/_clover/clover.css"] };
    const base = `/_p/${encodeURIComponent(m.plugin.id)}/`;
    const entry = m.plugin.clientEntry;
    return {
      ...(entry !== undefined && /\.m?js$/.test(entry) ? { module: base + entry } : {}),
      css: m.plugin.css.map((c) => base + c),
    };
  }

  private info(m: Mount): MountInfo {
    const a = this.assets(m);
    return {
      mount: m.id,
      pluginId: m.plugin?.id ?? "core",
      entryId: m.entryId,
      ...(m.component !== undefined ? { component: m.component } : {}),
      spot: m.spot,
      ...(m.key !== undefined ? { key: m.key } : {}),
      props: m.props,
      tokens: m.tokens,
      context: this.context(m),
      ...(a.module !== undefined ? { module: a.module } : {}),
      css: a.css,
    };
  }

  // ----------------------------------------------------------------------------------------------
  // Spots
  // ----------------------------------------------------------------------------------------------

  /** Whether a part declares a spot: its entry's `declares`, the root's own, or `bot.tab`, the app's core point that
   *  any part may show (the shell shows it in `main`, the panel an agent's). */
  private declares(m: Mount, spot: string): boolean {
    if (m.kind === "root") return m.rootSpots?.includes(spot) ?? false;
    if (spot === "bot.tab") return true;
    const entry = m.plugin?.entries.find((e) => e.id === m.entryId);
    return entry?.declares[spot] !== undefined;
  }

  /** Resolves a spot that the part `mountId` declares, for the document `frame`. */
  resolve(frame: FrameRef, mountId: string, spot: string, key?: string, hints: { session?: string } = {}): SpotView {
    const doc = this.requireDoc(frame);
    const part = this.mounts.get(mountId);
    if (part === undefined || this.docOf(part)?.id !== doc.id) throw new LayerError("that part isn't in this document");
    const shape = spotInfo(spot)?.shape ?? part.plugin?.entries.find((e) => e.id === part.entryId)?.declares[spot]?.shape ?? "single";
    const cellKey = shape === "keyed" ? key : undefined;
    if (!this.declares(part, spot)) return { spot, ...(cellKey !== undefined ? { key: cellKey } : {}), shape, items: [], hidden: false, conflict: false, undeclared: true };
    // Only the trusted `clover` layer may say which kind of session a part shows (`when.session`).
    const session = doc.layer === "clover" && hints.session !== undefined ? hints.session : part.session ?? part.ctx.session;
    const ctx: CellContext = { ...part.ctx, safeMode: this.safeModeValue, ...(session !== undefined ? { session } : {}) };
    if (cellKey !== undefined && KEYED_BY_BOT.has(spot)) ctx.bot = cellKey;
    const cell = resolveCell({ plugins: this.plugins, choices: this.choices, ctx, tree: this.tree }, spot, cellKey);
    let shown = cell.shown;
    if (part.surfaceRef !== undefined) shown = shown.filter((c) => entryRef(c.entry) === part.surfaceRef);
    const places = new Set<string>();
    const items: SpotItem[] = [];
    for (const c of shown) {
      const place = `${spot}|${cellKey ?? ""}|${entryRef(c.entry)}`;
      places.add(place);
      const existing = part.children.get(place);
      const child = existing === undefined ? undefined : this.mounts.get(existing);
      const m = child ?? this.place(part, doc, c, spot, cellKey, ctx, cell.styles, session);
      if (child !== undefined) {
        m.styles = cell.styles;
        this.retheme(m);
      }
      part.children.set(place, m.id);
      items.push(this.item(m, part));
    }
    for (const [place, id] of [...part.children]) {
      if (place.startsWith(`${spot}|${cellKey ?? ""}|`) && !places.has(place)) {
        part.children.delete(place);
        this.drop(id);
      }
    }
    return { spot, ...(cellKey !== undefined ? { key: cellKey } : {}), shape: cell.shape, items, hidden: cell.hidden, conflict: cell.conflict };
  }

  private place(parent: Mount, doc: Mount, c: Candidate, spot: string, key: string | undefined, ctx: CellContext, styles: Candidate[], session: string | undefined): Mount {
    const inline = c.plugin.layer === doc.layer && c.entry.kind === "component";
    const kind: Mount["kind"] = c.entry.kind === "web" ? "web" : inline ? "inline" : "frame";
    const m: Mount = {
      id: this.mountId(),
      kind,
      parent: parent.id,
      windowId: parent.windowId,
      layer: c.plugin.layer,
      plugin: c.plugin,
      entryId: c.entry.id,
      ...(c.entry.component !== undefined ? { component: c.entry.component } : {}),
      spot,
      ...(key !== undefined ? { key } : {}),
      ctx: { ...ctx },
      styles,
      tokens: {},
      tokensKey: "",
      props: {},
      children: new Map(),
      ...(session !== undefined ? { session } : {}),
    };
    if (kind === "frame") {
      m.token = this.token();
      m.tokenState = "issued";
      m.issuedAt = this.now();
      this.byToken.set(m.token, m.id);
    }
    this.retheme(m);
    this.mounts.set(m.id, m);
    return m;
  }

  private item(m: Mount, parent: Mount): SpotItem {
    const ref = `${m.plugin!.id}#${m.entryId}`;
    if (m.kind === "web") return { kind: "web", mount: m.id, ref, pluginId: m.plugin!.id, entryId: m.entryId };
    if (m.kind === "frame") {
      if (m.tokenState === "asleep") return { kind: "frame", mount: m.id, ref, pluginId: m.plugin!.id, entryId: m.entryId, layer: m.layer, url: "", asleep: true };
      return { kind: "frame", mount: m.id, ref, pluginId: m.plugin!.id, entryId: m.entryId, layer: m.layer, url: this.frameUrl(m) };
    }
    return {
      kind: "inline",
      mount: m.id,
      ref,
      pluginId: m.plugin!.id,
      entryId: m.entryId,
      component: m.component ?? "",
      ...(m.tokensKey !== parent.tokensKey ? { tokens: m.tokens } : {}),
      context: this.context(m),
    };
  }

  private frameUrl(m: Mount): string {
    // A frame already loaded keeps its URL (its iframe doesn't reload); a new one carries its fresh token.
    return `clover-plugin://${m.layer}/?mount=${m.token ?? "spent"}`;
  }

  // ----------------------------------------------------------------------------------------------
  // Across a frame's edge
  // ----------------------------------------------------------------------------------------------

  private childOf(frame: FrameRef, child: string): Mount {
    const doc = this.requireDoc(frame);
    const m = this.mounts.get(child);
    const parent = m?.parent === undefined ? undefined : this.mounts.get(m.parent);
    if (m === undefined || parent === undefined || this.docOf(parent)?.id !== doc.id) throw new LayerError("not a child of this document");
    return m;
  }

  /** New props for a child frame, from the document that placed it. */
  setProps(frame: FrameRef, child: string, props: unknown): void {
    const m = this.childOf(frame, child);
    m.props = props;
    if (m.kind === "frame") this.post(m.id, { type: "props", mount: m.id, props });
  }

  /** A frame calls a callback its parent handed it: the call goes to the parent's document. */
  callback(frame: FrameRef, id: string, args: unknown[]): void {
    const m = this.requireDoc(frame);
    if (m.kind !== "frame" || m.parent === undefined) return;
    const parentDoc = this.docOf(this.mounts.get(m.parent)!);
    if (parentDoc !== undefined) this.post(parentDoc.id, { type: "callback", child: m.id, id, args });
  }

  /** A frame's content height, for its parent to size it. */
  reportSize(frame: FrameRef, height: number): void {
    const m = this.requireDoc(frame);
    if (m.kind !== "frame" || m.parent === undefined || !Number.isFinite(height)) return;
    const parentDoc = this.docOf(this.mounts.get(m.parent)!);
    if (parentDoc !== undefined) this.post(parentDoc.id, { type: "child-size", child: m.id, height: Math.max(0, Math.min(100_000, Math.round(height))) });
  }

  /** Parts the document no longer shows. */
  release(frame: FrameRef, mounts: readonly string[]): void {
    for (const id of mounts) {
      let m: Mount;
      try {
        m = this.childOf(frame, id);
      } catch {
        continue;
      }
      const parent = this.mounts.get(m.parent!);
      for (const [place, child] of [...(parent?.children ?? [])]) if (child === id) parent!.children.delete(place);
      this.drop(id);
    }
  }

  /** A fresh single-use URL for a child frame, after its layer stopped. */
  reload(frame: FrameRef, child: string): string | undefined {
    const m = this.childOf(frame, child);
    if (m.kind !== "frame") return undefined;
    for (const id of [...m.children.values()]) this.drop(id);
    m.children.clear();
    if (m.frame !== undefined) this.byFrame.delete(m.frame.key);
    delete m.frame;
    if (m.token !== undefined) this.byToken.delete(m.token);
    m.token = this.token();
    m.tokenState = "issued";
    m.issuedAt = this.now();
    this.byToken.set(m.token, m.id);
    return this.frameUrl(m);
  }

  private drop(id: string): void {
    const m = this.mounts.get(id);
    if (m === undefined) return;
    for (const child of m.children.values()) this.drop(child);
    if (m.token !== undefined) this.byToken.delete(m.token);
    if (m.frame !== undefined) this.byFrame.delete(m.frame.key);
    this.mounts.delete(id);
  }

  /** A frame far from the screen for a while sleeps (§5.5): its document and everything under it go, and its process
   *  with them once no other frame of that layer is left; it wakes rebuilt from the core's state, with a fresh token. */
  sleep(frame: FrameRef, child: string): boolean {
    const m = this.childOf(frame, child);
    if (m.kind !== "frame" || m.tokenState === "asleep") return false;
    for (const id of [...m.children.values()]) this.drop(id);
    m.children.clear();
    if (m.frame !== undefined) this.byFrame.delete(m.frame.key);
    delete m.frame;
    if (m.token !== undefined) this.byToken.delete(m.token);
    delete m.token;
    m.tokenState = "asleep";
    return true;
  }

  /** Wakes a sleeping frame (or reloads one whose layer stopped): a fresh single-use URL. */
  wake(frame: FrameRef, child: string): string | undefined {
    return this.reload(frame, child);
  }

  // ----------------------------------------------------------------------------------------------
  // Surfaces (the island, the pill: `app.surface` entries with a `window`)
  // ----------------------------------------------------------------------------------------------

  /** The surfaces to open: every `app.surface` entry with a `window` that may run now. Its id is the surface's. */
  surfaceEntries(): { id: string; ref: string; pluginId: string; window: NonNullable<UiEntry["window"]> }[] {
    const out: { id: string; ref: string; pluginId: string; window: NonNullable<UiEntry["window"]> }[] = [];
    for (const p of this.plugins) {
      if (this.safeModeValue && !SAFE_MODE_PLUGINS.includes(p.topId)) continue;
      for (const e of p.entries) {
        if (e.spot !== "app.surface" || e.window === undefined || e.kind !== "component") continue;
        const os = e.when?.os;
        if (os !== undefined && !os.includes(this.opts.os)) continue;
        out.push({ id: e.id, ref: entryRef(e), pluginId: p.id, window: e.window });
      }
    }
    return out;
  }

  /** The surface window a document may steer: the frame its window's root placed, and only that one. */
  surfaceOf(frame: FrameRef): number | undefined {
    const doc = this.docByFrame(frame);
    const parent = doc?.parent === undefined ? undefined : this.mounts.get(doc.parent);
    return doc !== undefined && doc.kind === "frame" && parent?.kind === "root" && parent.surfaceRef !== undefined ? doc.windowId : undefined;
  }

  // ----------------------------------------------------------------------------------------------
  // The menu and drag brokers (brokers.ts)
  // ----------------------------------------------------------------------------------------------

  /** Where a document sits in its window: each step from the root down, the document holding a frame and that frame's
   *  mount, so the core can ask each for its child's place (the menu broker). */
  placeOf(frame: FrameRef): { windowId: number; steps: { parent: { processId: number; routingId: number }; child: string }[] } {
    const doc = this.requireDoc(frame);
    const steps: { parent: { processId: number; routingId: number }; child: string }[] = [];
    let at: Mount | undefined = doc;
    while (at !== undefined && at.kind !== "root") {
      const parentDoc: Mount | undefined = at.parent === undefined ? undefined : this.docOf(this.mounts.get(at.parent)!);
      if (parentDoc?.frame === undefined) throw new LayerError("the document has no place in a window");
      steps.unshift({ parent: { processId: parentDoc.frame.processId, routingId: parentDoc.frame.routingId }, child: at.id });
      at = parentDoc;
    }
    return { windowId: doc.windowId, steps };
  }

  private partIn(frame: FrameRef, mountId: string): Mount {
    const doc = this.requireDoc(frame);
    const part = this.mounts.get(mountId);
    if (part === undefined || this.docOf(part)?.id !== doc.id) throw new LayerError("that part isn't in this document");
    return part;
  }

  /** A part offers data for a drag: a single-use token for the drag's data, or the reason it can't. */
  dragOffer(frame: FrameRef, mountId: string, raw: unknown): { token: string } | { error: string } {
    const part = this.partIn(frame, mountId);
    const offer = checkDragOffer(raw, part.plugin?.capabilities ?? new Set());
    if ("error" in offer) return offer;
    for (const [t, g] of this.grants) if (this.now() - g.at > DRAG_GRANT_TTL_MS) this.grants.delete(t);
    const token = this.token();
    this.grants.set(token, { offer, windowId: part.windowId, at: this.now() });
    return { token };
  }

  /** The part a drag was dropped on claims its data: once, within a minute, in the same window, if its plugin may. */
  dragClaim(frame: FrameRef, mountId: string, token: string): DragOffer | { error: string } {
    const part = this.partIn(frame, mountId);
    const grant = this.grants.get(token);
    this.grants.delete(token);
    if (grant === undefined || this.now() - grant.at > DRAG_GRANT_TTL_MS || grant.windowId !== part.windowId) return { error: "no such drag" };
    if (!mayClaim(grant.offer.type, part.plugin?.capabilities ?? new Set())) return { error: "this part's plugin may not hold that" };
    return grant.offer;
  }

  // ----------------------------------------------------------------------------------------------
  // Crashes (S9: Electron 45 raises nothing when a subframe's renderer is killed; the census finds it)
  // ----------------------------------------------------------------------------------------------

  /** Marks every frame whose process is gone, and tells the document that placed it. Returns the mounts found. */
  census(alive: (frame: { processId: number; routingId: number; osPid?: number }) => boolean): string[] {
    const gone: string[] = [];
    for (const m of this.mounts.values()) {
      if (m.kind !== "frame" || m.frame === undefined || m.tokenState !== "bound") continue;
      if (alive(m.frame)) continue;
      gone.push(m.id);
      m.tokenState = "gone";
      this.byFrame.delete(m.frame.key);
      for (const id of [...m.children.values()]) this.drop(id);
      m.children.clear();
      const parentDoc = m.parent === undefined ? undefined : this.docOf(this.mounts.get(m.parent)!);
      if (parentDoc !== undefined) this.post(parentDoc.id, { type: "child-gone", child: m.id, reason: "its layer stopped" });
    }
    if (gone.length > 0) this.log(`layers: ${gone.length} frame(s) lost their process: ${gone.join(", ")}`);
    return gone;
  }

  /** Every bound document: for the census and for messages to all of them. */
  documents(): { mount: string; layer: string; windowId: number; frame: { processId: number; routingId: number; osPid?: number } }[] {
    return [...this.mounts.values()].filter((m) => m.frame !== undefined).map((m) => ({ mount: m.id, layer: m.layer, windowId: m.windowId, frame: m.frame! }));
  }

  /** Sends an app command (a shortcut, a menu item) to every document of a window. */
  command(windowId: number, name: string): void {
    for (const m of this.mounts.values()) if (m.windowId === windowId && m.frame !== undefined) this.post(m.id, { type: "command", name });
  }

  /** Tells a window's documents the focus came back after the core's own overlay. */
  focusReturned(windowId: number): void {
    for (const m of this.mounts.values()) if (m.windowId === windowId && m.frame !== undefined) this.post(m.id, { type: "focus-returned" });
  }

  /** For the tests and the smoke run: how many mounts of each kind exist. */
  stats(): Record<Mount["kind"], number> {
    const out = { root: 0, frame: 0, inline: 0, web: 0 };
    for (const m of this.mounts.values()) out[m.kind]++;
    return out;
  }

  /** The frame mount a document's mount token names, for the protocol handler's document. */
  mountForDocument(m: Mount): { pluginId: string; layer: string; assets: { module?: string; css: string[] } } {
    return { pluginId: m.plugin?.id ?? "core", layer: m.layer, assets: this.assets(m) };
  }
}
