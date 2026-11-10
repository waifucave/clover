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
import type { LayerMessage, LocaleValue, MountContext, MountInfo, PendingQuestion, SpotEntryView, SpotItem, SpotView, StringTable, ThemeSheet } from "@waifucave/clover-plugin-sdk/ui/bridge";
import type { Appearance, TokenValue } from "@waifucave/clover-plugin-sdk";
import { spotInfo } from "@waifucave/clover-plugin-sdk";
import { SAFE_MODE_PLUGINS, type UiEntry, type UiPlugin } from "./model";
import { NO_CHOICES, SpotTree, entryRef, resolveCell, type CellContext, type Candidate, type Os, type UiChoices } from "./spots";
import { DRAG_GRANT_TTL_MS, checkDragOffer, mayClaim, type DragOffer } from "./brokers";
import { botTheme, defaultFrameMetrics, partSelector, partTokens, stackThemes, ThemeStore, type FrameMetrics, type ThemeChoices } from "./theme";
import { cleanCss } from "./css";
import { StringStore, stringTable } from "./strings";
import { LayoutStore } from "./layout";
import { CORE_STRINGS } from "./core-strings";
import { fieldPage, buttonPage, ownCardPage, labelOf } from "../sealed-pages";
import { sealHeaders } from "./documents";
import type { SealedFrames, SealedValue } from "../sealed";

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
  /** A frame's document: the layers its `Connection-Allowlist` names, as it was served (B1: each installed layer by
   *  name, never a `*` host, since Chromium matches a document's DNS lookups against the list by host only). */
  allowedLayers?: readonly string[];
  /** A document: its themes' sheets as last sent. */
  sheetsKey?: string;
  /** A document: its strings as last sent. */
  stringsKey?: string;
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
  /** A mount's document, or the mount itself, is gone (its native views go with it). */
  onGone?: (mount: string) => void;
  /** The system's language, until the user picks one in Settings. */
  systemLanguage?: string;
  /** The sealed frames' store (E-M3): the cards' own book, its mint and its serves. */
  sealed?: SealedFrames;
  /** The core's own string tables, by language (`core-strings.ts` by default). */
  builtInStrings?: Readonly<Record<string, Readonly<Record<string, LocaleValue>>>>;
  /** Whether a plugin's tree hash matches the official index's, for the strings of sealed cards (lane B's registry). */
  official?: (plugin: UiPlugin) => boolean;
}

export class LayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerError";
  }
}

export interface UiSettingsLike extends UiChoices, ThemeChoices {
  /** The user's language (Settings); the system's until then. */
  language?: string;
  /** The pack the user chose for a language, by language, when two translate the same keys. */
  packs?: Readonly<Record<string, string>>;
}

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
  private readonly strings: StringStore;
  private readonly layouts: LayoutStore;
  private readonly tables = new Map<string, StringTable>();
  private questions: readonly PendingQuestion[] = [];
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
    this.strings = new StringStore(this.log);
    this.layouts = new LayoutStore(this.log);
    this.sealed = opts.sealed;
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
    this.strings.clear();
    this.layouts.clear();
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
    this.tables.clear();
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
    for (const m of this.mounts.values()) if (m.frame !== undefined) {
      this.restyle(m);
      this.restring(m);
    }
    if (respot) for (const m of this.mounts.values()) if (m.frame !== undefined) this.post(m.id, { type: "respot" });
  }

  // ----------------------------------------------------------------------------------------------
  // The themes' CSS (E-M2): one sheet per place a theme dresses, in the stack's order, after the part's own CSS
  // ----------------------------------------------------------------------------------------------

  /** A part that starts a bot's tab in its document: its bot. A frame inside a tab is its own document's tab root. */
  private tabOf(m: Mount): string | undefined {
    if (m.ctx.bot === undefined) return undefined;
    if (m.kind !== "inline") return m.ctx.bot;
    const parent = m.parent === undefined ? undefined : this.mounts.get(m.parent);
    return parent?.ctx.bot === m.ctx.bot ? undefined : m.ctx.bot;
  }

  private entryOf(m: Mount): UiEntry | undefined {
    return m.plugin?.entries.find((e) => e.id === m.entryId);
  }

  /** A bot's layout's `prefer` lists, for the cells in its tab (rule 3). */
  private preferFor(bot: string): Readonly<Record<string, readonly string[]>> | undefined {
    const plugin = this.plugins.find((p) => p.isBot && p.id === bot);
    if (plugin?.botLayout === undefined) return undefined;
    const prefer = this.layouts.prefer(plugin, plugin.botLayout);
    return Object.keys(prefer).length > 0 ? prefer : undefined;
  }

  private styledOf(m: Mount): boolean {
    return m.styles.some((c) => c.entry.style !== undefined);
  }

  /** A document's sheets (§5.5's stack): the base and global themes over the whole document, each bot's theme in its
   *  tab (stopping at another tab), each style entry in its part (stopping at a smaller part another dresses, the
   *  would-be winner last), then the user's own CSS. The core root takes none (its CSP allows no inline style). */
  sheetsFor(doc: Mount): ThemeSheet[] {
    if (doc.kind !== "frame") return [];
    const inDoc = [...this.mounts.values()].filter((m) => this.docOf(m)?.id === doc.id);
    const out: ThemeSheet[] = [];
    const whole = { root: partSelector(doc.id) };
    const theme = stackThemes(this.themes, { plugins: this.plugins, choices: this.choices, styles: [], appearance: this.appearance, frame: defaultFrameMetrics("darwin") });
    for (const t of theme) {
      const css = this.themes.themeSheet(t.plugin, t.theme, whole);
      if (css !== "") out.push({ id: `${t.kind}:${t.plugin.id}`, css });
    }
    for (const m of inDoc) {
      const bot = this.tabOf(m);
      if (bot === undefined) continue;
      const b = botTheme(this.themes, this.plugins, bot);
      if (b === undefined) continue;
      const css = this.themes.themeSheet(b.plugin, b.theme, { root: partSelector(m.id), limit: "[data-clover-tab]:not(:scope)" });
      if (css !== "") out.push({ id: `bot:${bot}:${m.id}`, css });
    }
    for (const m of inDoc) {
      const file = this.entryOf(m)?.layout;
      if (file === undefined || m.plugin === undefined) continue;
      // The layout's own CSS dresses its own nodes: it stops at every part inside it.
      const css = this.layouts.sheet(m.plugin, file, { root: partSelector(m.id), limit: "[data-clover-part]:not(:scope)" });
      if (css !== "") out.push({ id: `layout:${m.plugin.id}:${m.id}`, css });
    }
    for (const m of inDoc) {
      for (const c of m.styles) {
        if (c.entry.style === undefined) continue;
        const t = this.themes.read(c.plugin, c.entry.style);
        if (t === null) continue;
        const css = this.themes.themeSheet(c.plugin, t, { root: partSelector(m.id), limit: "[data-clover-styled]:not(:scope)" });
        if (css !== "") out.push({ id: `style:${c.plugin.id}#${c.entry.id}:${m.id}`, css });
      }
      // The part a style entry dresses is contained, as a tab's root is (a frame's root; an inline part has no box).
      if (m.id === doc.id && this.styledOf(m)) out.push({ id: `contain:${m.id}`, css: `${partSelector(m.id)}{contain:layout paint}` });
    }
    const own = this.choices.overrides?.css;
    if (own !== undefined && own !== "") {
      const cleaned = cleanCss(own, { pluginId: "user", scope: whole });
      if (cleaned.css !== "") out.push({ id: "user", css: cleaned.css });
    }
    return out;
  }

  /** The language the app speaks: the user's pick, else the system's. */
  get language(): string {
    return this.choices.language ?? this.opts.systemLanguage ?? "en";
  }

  /** A document's strings: its plugin's keys (the core root and the `clover` layer: `clover.…`). */
  stringsFor(doc: Mount): StringTable {
    return this.tableFor(doc.plugin?.topId ?? "clover");
  }

  private tableFor(owner: string): StringTable {
    let t = this.tables.get(owner);
    if (t === undefined) {
      t = stringTable(this.strings, { plugins: this.plugins, lang: this.language, ...(this.choices.packs !== undefined ? { packs: this.choices.packs } : {}), builtIn: this.opts.builtInStrings ?? CORE_STRINGS, ...(this.opts.official !== undefined ? { official: this.opts.official } : {}) }, owner);
      this.tables.set(owner, t);
    }
    return t;
  }

  /** The core's own strings in the app's language, for the main process's menus and dialogs. */
  coreStrings(): StringTable {
    return this.tableFor("clover");
  }

  /** Sends a document its strings when they changed. */
  private restring(doc: Mount): void {
    if (doc.frame === undefined || (doc.kind !== "frame" && doc.kind !== "root")) return;
    const strings = this.stringsFor(doc);
    const key = JSON.stringify(strings);
    if (key === doc.stringsKey) return;
    doc.stringsKey = key;
    this.post(doc.id, { type: "strings", strings });
  }

  /** Sends a document its sheets when they changed. */
  private restyle(doc: Mount): void {
    if (doc.frame === undefined || doc.kind !== "frame") return;
    const sheets = this.sheetsFor(doc);
    const key = JSON.stringify(sheets);
    if (key === doc.sheetsKey) return;
    doc.sheetsKey = key;
    this.post(doc.id, { type: "sheets", sheets });
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
    m.allowedLayers = this.layerLabels();
    return m;
  }

  /** Every layer the registry has, by its origin label: what a document served now may frame. */
  layerLabels(): string[] {
    return [...new Set(["clover", ...this.plugins.map((p) => p.layer)])].sort();
  }

  /** A document served before a layer it now has to frame was installed: Chromium holds the frame's navigation to the
   *  document's own allowlist, so the document is loaded again (a fresh single-use token), and its parent swaps it in. */
  private refreshDocument(doc: Mount): void {
    if (doc.kind !== "frame" || doc.parent === undefined) return;
    const parentDoc = this.docOf(this.mounts.get(doc.parent)!);
    if (parentDoc === undefined) return;
    const url = this.reissue(doc);
    this.log(`layers: ${doc.id} loads again to frame a layer installed after it was served`);
    this.post(parentDoc.id, { type: "child-reload", child: doc.id, url });
  }

  /** A document asks what it is: the root of its window, or the frame its token was issued for. */
  describe(frame: FrameRef, windowId: number, token: string | undefined): MountInfo {
    if (token === undefined || token === "") {
      const root = this.bindRoot(frame, windowId);
      const strings = this.stringsFor(root);
      root.stringsKey = JSON.stringify(strings);
      return { ...this.info(root), strings };
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
    const sheets = this.sheetsFor(m);
    m.sheetsKey = JSON.stringify(sheets);
    const strings = this.stringsFor(m);
    m.stringsKey = JSON.stringify(strings);
    // The questions waiting, for a plugin that may read them.
    if (this.questions.length > 0 && this.readsQuestions(m)) queueMicrotask(() => this.post(m.id, { type: "questions", questions: this.questions }));
    return { ...this.info(m), sheets, strings };
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
      ...(this.tabOf(m) !== undefined ? { tab: this.tabOf(m)! } : {}),
      ...(this.styledOf(m) ? { styled: true } : {}),
    };
  }

  // ----------------------------------------------------------------------------------------------
  // Spots
  // ----------------------------------------------------------------------------------------------

  /** Whether a part declares a spot: its entry's `declares` or the root's own. `bot.tab`, the app's core point, is
   *  shown by the shell (it shows it in `main`, the panel an agent's), so the `clover` tree's parts may show it without
   *  declaring it; any other part must declare it. A bot's whole tab, composer included, in a frame whose size and
   *  covering a third party controls would be a clickjacking surface for the sends E-M3 counts as the user's. */
  private declares(m: Mount, spot: string): boolean {
    if (m.kind === "root") return m.rootSpots?.includes(spot) ?? false;
    if (spot === "bot.tab" && m.plugin?.topId === "clover") return true;
    const entry = m.plugin?.entries.find((e) => e.id === m.entryId);
    return entry?.declares[spot] !== undefined;
  }

  /** The cell a part's spot is, in its context: its shape and what may show there, with the cell's context. */
  private cellOf(doc: Mount, part: Mount, spot: string, key: string | undefined, hints: { session?: string }) {
    const shape = spotInfo(spot)?.shape ?? part.plugin?.entries.find((e) => e.id === part.entryId)?.declares[spot]?.shape ?? "single";
    const cellKey = shape === "keyed" ? key : undefined;
    const session = doc.layer === "clover" && hints.session !== undefined ? hints.session : part.session ?? part.ctx.session;
    const ctx: CellContext = { ...part.ctx, safeMode: this.safeModeValue, ...(session !== undefined ? { session } : {}) };
    if (cellKey !== undefined && KEYED_BY_BOT.has(spot)) ctx.bot = cellKey;
    const prefer = ctx.bot === undefined ? undefined : this.preferFor(ctx.bot);
    if (prefer !== undefined) ctx.prefer = prefer;
    else delete ctx.prefer;
    return { shape, cellKey, session, ctx };
  }

  /** A spot the part declares, as its entries (lane B's `useSpotEntries`, lane G's ask): for a part that draws them
   *  one at a time with `<Spot entry>` (the island's tabs, the pill's targets). In the spot's order; only the
   *  declaring part lists it. */
  entries(frame: FrameRef, mountId: string, spot: string, key?: string): SpotEntryView[] {
    const doc = this.requireDoc(frame);
    const part = this.partIn(frame, mountId);
    if (!this.declares(part, spot)) return [];
    const { cellKey, ctx } = this.cellOf(doc, part, spot, key, {});
    const cell = resolveCell({ plugins: this.plugins, choices: this.choices, ctx, tree: this.tree }, spot, cellKey);
    return cell.shown.map((c) => ({
      ref: entryRef(c.entry),
      id: c.entry.id,
      pluginId: c.plugin.id,
      pluginName: c.plugin.name ?? c.plugin.id,
      bundled: c.plugin.source === "bundled",
      ...(c.entry.key !== undefined ? { key: c.entry.key } : {}),
      fields: c.entry.fields,
    }));
  }

  /** Resolves a spot that the part `mountId` declares, for the document `frame`. With `entry`, only that entry shows
   *  (`<Spot entry>`). */
  resolve(frame: FrameRef, mountId: string, spot: string, key?: string, hints: { session?: string; entry?: string } = {}): SpotView {
    const doc = this.requireDoc(frame);
    const part = this.mounts.get(mountId);
    if (part === undefined || this.docOf(part)?.id !== doc.id) throw new LayerError("that part isn't in this document");
    // Only the trusted `clover` layer may say which kind of session a part shows (`when.session`).
    const { shape, cellKey, session, ctx } = this.cellOf(doc, part, spot, key, hints);
    if (!this.declares(part, spot)) return { spot, ...(cellKey !== undefined ? { key: cellKey } : {}), shape, items: [], hidden: false, conflict: false, undeclared: true };
    const cell = resolveCell({ plugins: this.plugins, choices: this.choices, ctx, tree: this.tree }, spot, cellKey);
    let shown = cell.shown;
    if (part.surfaceRef !== undefined) shown = shown.filter((c) => entryRef(c.entry) === part.surfaceRef);
    if (hints.entry !== undefined) shown = shown.filter((c) => entryRef(c.entry) === hints.entry);
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
    if (doc.allowedLayers !== undefined && items.some((i) => i.kind === "frame" && i.layer !== doc.layer && !doc.allowedLayers!.includes(i.layer))) this.refreshDocument(doc);
    // A part placed or restyled inline changes the document's sheets.
    this.restyle(doc);
    return { spot, ...(cellKey !== undefined ? { key: cellKey } : {}), shape: cell.shape, items, hidden: cell.hidden, conflict: cell.conflict };
  }

  private place(parent: Mount, doc: Mount, c: Candidate, spot: string, key: string | undefined, ctx: CellContext, styles: Candidate[], session: string | undefined): Mount {
    // A layout is data: it draws inline in whatever document shows the tab.
    const inline = (c.plugin.layer === doc.layer && c.entry.kind === "component") || c.entry.layout !== undefined;
    const kind: Mount["kind"] = c.entry.kind === "web" ? "web" : inline ? "inline" : "frame";
    const m: Mount = {
      id: this.mountId(),
      kind,
      parent: parent.id,
      windowId: parent.windowId,
      layer: inline ? doc.layer : c.plugin.layer,
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
    const layout = this.entryOf(m)?.layout;
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
      ...(this.tabOf(m) !== undefined ? { tab: this.tabOf(m)! } : {}),
      ...(this.styledOf(m) ? { styled: true } : {}),
      ...(layout !== undefined ? { layout: (m.plugin && this.layouts.view(m.plugin, layout, this.language)) || { kind: "text", text: "" } } : {}),
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
    return this.reissue(m);
  }

  /** Drops a frame's document and everything under it, and issues a fresh single-use token for its next load. */
  private reissue(m: Mount): string {
    this.opts.onGone?.(m.id);
    for (const id of [...m.children.values()]) this.drop(id);
    m.children.clear();
    if (m.frame !== undefined) this.byFrame.delete(m.frame.key);
    delete m.frame;
    if (m.token !== undefined) this.byToken.delete(m.token);
    delete m.allowedLayers;
    m.token = this.token();
    m.tokenState = "issued";
    m.issuedAt = this.now();
    this.byToken.set(m.token, m.id);
    return this.frameUrl(m);
  }

  private drop(id: string): void {
    const m = this.mounts.get(id);
    if (m === undefined) return;
    this.opts.onGone?.(id);
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
    this.opts.onGone?.(m.id);
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

  /** Checks that a part is in the document `frame` (throws otherwise) and gives its plugin's id. A part whose
   *  document isn't its own plugin's layer — a layout part drawn inline in another plugin's document — acts in no
   *  plugin's name: api, open and the terminal hand-over all refused for it (the review's S1). */
  partOf(frame: FrameRef, mountId: string): string {
    return this.actInThisLayer(frame, mountId).plugin?.id ?? "core";
  }

  /** The capabilities of a part's plugin, the part being in the document `frame` (throws otherwise). A layout part in
   *  another plugin's document doesn't act for its plugin, so its capabilities count for nothing (the review's S1). */
  capabilitiesOf(frame: FrameRef, mountId: string): ReadonlySet<string> {
    return this.actInThisLayer(frame, mountId).plugin?.capabilities ?? new Set();
  }

  /** A part whose document isn't its own plugin's layer acts in no plugin's name (the review's S1): every door that
   *  would run as the plugin refuses it. Data-only reads stay on `partIn`. */
  private actInThisLayer(frame: FrameRef, mountId: string): Mount {
    const part = this.partIn(frame, mountId);
    const doc = this.docOf(part);
    if (part.kind === "inline" && part.plugin !== undefined && doc !== undefined && part.plugin.layer !== doc.layer) throw new LayerError("a layout part acts only in its own layer's document");
    return part;
  }

  /** A web page part placed by the document `frame` (throws otherwise): its plugin, its page and its window. */
  webOf(frame: FrameRef, mountId: string): { plugin: UiPlugin; web: Readonly<Record<string, unknown>>; windowId: number } {
    const doc = this.requireDoc(frame);
    const m = this.mounts.get(mountId);
    const parent = m?.parent === undefined ? undefined : this.mounts.get(m.parent);
    if (m === undefined || m.kind !== "web" || parent === undefined || this.docOf(parent)?.id !== doc.id || m.plugin === undefined) throw new LayerError("that web part isn't in this document");
    const web = this.entryOf(m)?.web;
    if (web === undefined) throw new LayerError("that part has no page");
    return { plugin: m.plugin, web, windowId: doc.windowId };
  }

  private partIn(frame: FrameRef, mountId: string): Mount {
    const doc = this.requireDoc(frame);
    const part = this.mounts.get(mountId);
    if (part === undefined || this.docOf(part)?.id !== doc.id) throw new LayerError("that part isn't in this document");
    return part;
  }

  /** A part offers data for a drag: a single-use token for the drag's data, or the reason it can't. */
  dragOffer(frame: FrameRef, mountId: string, raw: unknown): { token: string } | { error: string } {
    const part = this.actInThisLayer(frame, mountId);
    const offer = checkDragOffer(raw, part.plugin?.capabilities ?? new Set());
    if ("error" in offer) return offer;
    for (const [t, g] of this.grants) if (this.now() - g.at > DRAG_GRANT_TTL_MS) this.grants.delete(t);
    const token = this.token();
    this.grants.set(token, { offer, windowId: part.windowId, at: this.now() });
    return { token };
  }

  /** The part a drag was dropped on claims its data: once, within a minute, in the same window, if its plugin may. */
  dragClaim(frame: FrameRef, mountId: string, token: string): DragOffer | { error: string } {
    const part = this.actInThisLayer(frame, mountId);
    const grant = this.grants.get(token);
    this.grants.delete(token);
    if (grant === undefined || this.now() - grant.at > DRAG_GRANT_TTL_MS || grant.windowId !== part.windowId) return { error: "no such drag" };
    if (!mayClaim(grant.offer.type, part.plugin?.capabilities ?? new Set())) return { error: "this part's plugin may not hold that" };
    return grant.offer;
  }

  // ----------------------------------------------------------------------------------------------
  // Sealed frames (spec §5.5; E-M3): the parts' holes for a card's fields and buttons, one frame each, from the
  // app's own scheme. A part with the `approvals` capability places and positions them, and sees nothing of them.
  // ----------------------------------------------------------------------------------------------

  /** A seal frame is private (the puzzle's own promise), kept by the app's own store rather than this one; the
   *  `sealed(seed)` handler fills it at boot. */
  sealed?: SealedFrames;

  /** A part asks for one sealed element's frame: `field:<name>` or `button:<option>`. Refused for a part whose
   *  plugin lacks `approvals` (§5.5: a component gets sealed frames only then; the OK carries it), and for a draft
   *  asked outside the plugin's own layer's document. Returns the single-use URL the part puts in the iframe's src. */
  sealedFrameOf(frame: FrameRef, mountId: string, cardId: string, element: string): string | undefined {
    const part = this.actInThisLayer(frame, mountId);
    if (!part.plugin?.capabilities.has("approvals")) throw new LayerError("placing a sealed frame takes the approvals capability");
    if (this.sealed === undefined) throw new LayerError("the sealed frames aren't there");
    // The card tokens go in alone (§5.5): the part's resolved ones, clipped to `card.*` names.
    const tokens: Record<string, TokenValue> = {};
    for (const [name, value] of Object.entries(part.tokens)) if (name.startsWith("card.")) tokens[name] = value;
    // The binding: the frame whose sender's sealed page may answer is this document's own (B4's parent rule).
    const doc = this.docOf(part);
    const bind = doc?.frame !== undefined ? { parent: { processId: doc.frame.processId, routingId: doc.frame.routingId } } : undefined;
    const made = this.sealed.mint(cardId, element, bind, doc?.windowId, tokens);
    if (made === undefined) return undefined;
    const url = `clover-sealed://card/${encodeURIComponent(cardId)}/${encodeURIComponent(element)}?token=${encodeURIComponent(made.token)}`;
    return url;
  }

  /** Who a sealed token's channel belongs to, for the sender's binding check (E-M3 check 3). */
  boundOf(token: string): string | undefined {
    return this.sealed?.boundOf(token);
  }

  /** The scheme's serving: the page's own HTML for one token, once (the store marks it), with its own headers. */
  serveSeal(token: string): { html: string; headers: Readonly<Record<string, string>> } | undefined {
    if (this.sealed === undefined) return undefined;
    const serving = this.sealed.serve(token);
    if (serving === undefined) return undefined;
    const { card, element, tokens } = serving;
    if (element.startsWith("field:")) {
      const value = card.fields[element.slice("field:".length)];
      if (value === undefined || typeof value !== "object") return undefined;
      return { html: fieldPage({ cardId: card.id, token, field: element.slice("field:".length), tokens, value: value as { type: "text"; text: string } }), headers: sealHeaders() };
    }
    if (element.startsWith("button:")) {
      const option = card.options.find((o) => o.id === element.slice("button:".length));
      if (option === undefined) return undefined;
      return { html: buttonPage({ cardId: card.id, token, option: option.id, label: labelOf(option.label), kind: option.kind, tokens }), headers: sealHeaders() };
    }
    if (element === "own") {
      return { html: ownCardPage({ cardId: card.id, token, origin: card.origin, issuedAt: card.issuedAt, expiresAt: card.expiresAt, fields: card.fields, tokens, options: card.options, ...(card.pluginId !== undefined ? { who: { pluginId: card.pluginId } } : {}) }), headers: sealHeaders() };
    }
    return undefined;
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
      this.opts.onGone?.(m.id);
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
  command(windowId: number, name: string, args?: Readonly<Record<string, string>>): void {
    for (const m of this.mounts.values()) if (m.windowId === windowId && m.frame !== undefined) this.post(m.id, { type: "command", name, ...(args !== undefined ? { args } : {}) });
  }

  /** A message to the part a surface window's root placed (the one `surfaceOf` lets steer it). */
  surfaceMessage(windowId: number, message: LayerMessage): void {
    for (const m of this.mounts.values()) {
      const parent = m.parent === undefined ? undefined : this.mounts.get(m.parent);
      if (m.windowId === windowId && m.kind === "frame" && m.frame !== undefined && parent?.kind === "root" && parent.surfaceRef !== undefined) this.post(m.id, message);
    }
  }

  /** The questions waiting in every session (lane D's): each document whose plugin has `conversation.read` hears them,
   *  with their text; no other does. */
  setQuestions(questions: readonly PendingQuestion[]): void {
    this.questions = questions;
    for (const m of this.mounts.values()) {
      if (m.kind === "frame" && m.frame !== undefined && this.readsQuestions(m)) this.post(m.id, { type: "questions", questions });
    }
  }

  private readsQuestions(doc: Mount): boolean {
    // The `clover` layer is the whole tree's: it hears them when any of its parts' plugins may read conversations.
    if (doc.plugin?.topId === "clover") return this.plugins.some((p) => p.topId === "clover" && p.capabilities.has("conversation.read"));
    return doc.plugin?.capabilities.has("conversation.read") === true;
  }

  /** The bundled `clover` tree's part in the document `frame`, or undefined for any other (throws if it isn't in the
   *  document). Decided here from what the main process holds, never from what the page says: the plugin came from the
   *  app's own bundle, renders in the `clover` layer, and its top-level id is `clover`. */
  treePart(frame: FrameRef, mountId: string): { windowId: number; pluginId: string } | undefined {
    const part = this.actInThisLayer(frame, mountId);
    const p = part.plugin;
    if (p === undefined || p.topId !== "clover" || p.layer !== "clover" || p.source !== "bundled") return undefined;
    return { windowId: part.windowId, pluginId: p.id };
  }

  /** The shell the core mounted in `app.root` of the window, when `mountId` in `frame` is it (throws if the mount isn't in
   *  the document): the bundled `clover/shell` part, from the core's own record. */
  mainShell(frame: FrameRef, mountId: string): { windowId: number } | undefined {
    const part = this.actInThisLayer(frame, mountId);
    if (part.spot !== "app.root" || this.treePart(frame, mountId)?.pluginId !== "clover/shell") return undefined;
    return { windowId: part.windowId };
  }

  /** The composer entry the core mounted in the document `frame` (throws if the mount isn't in it), or undefined for a
   *  mount that isn't in the `composer` spot. The session and bot are the props the declaring document gave the core
   *  for this mount, never anything the page says. */
  composerOf(frame: FrameRef, mountId: string): import("./composer-calls").ComposerMount | undefined {
    const part = this.actInThisLayer(frame, mountId);
    if (part.spot !== "composer" || part.plugin === undefined) return undefined;
    // The session and bot are the declaring document's say (props), so they count only when that document is the bundled
    // clover tree's: a third-party bot tab that fills the spot (with the default composer, or any) could name any session.
    const parent = part.parent === undefined ? undefined : this.mounts.get(part.parent);
    const pp = parent?.plugin;
    if (pp === undefined || pp.topId !== "clover" || pp.layer !== "clover" || pp.source !== "bundled") return undefined;
    const props = (part.props ?? {}) as { session?: unknown; bot?: unknown };
    const session = typeof props.session === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(props.session) ? props.session : undefined;
    if (session === undefined) return undefined;
    const bot = (props.bot as { id?: unknown } | undefined)?.id;
    return { windowId: part.windowId, pluginId: part.plugin.id, session, ...(typeof bot === "string" ? { bot } : {}), tree: this.treePart(frame, mountId) !== undefined };
  }

  /** The part sending the user's own words, in the document `frame` (throws otherwise): the entry the core mounted in
   *  the `composer` spot, whichever plugin's it is (it sends only to its own session), or a surface part of the bundled
   *  `clover` tree (the Dispatch pill's). The key press or click is the core's to check. */
  userSender(frame: FrameRef, mountId: string): { windowId: number; pluginId: string; only?: { session: string } } {
    const composer = this.composerOf(frame, mountId);
    if (composer !== undefined) return { windowId: composer.windowId, pluginId: composer.pluginId, only: { session: composer.session } };
    const tree = this.treePart(frame, mountId);
    if (tree === undefined) throw new LayerError("only the composer's entry and the app's own parts send the user's words");
    return tree;
  }

  /** A message to every document that holds a part of this plugin (its connection's events). An inline part whose
   *  document isn't its plugin's layer hears nothing: its own layer's documents do (the review's S1). */
  pluginMessage(pluginId: string, message: LayerMessage): void {
    const docs = new Set<string>();
    for (const m of this.mounts.values()) {
      if (m.plugin?.id !== pluginId) continue;
      if (m.kind === "inline" && m.plugin.layer !== this.docOf(m)?.layer) continue;
      const doc = this.docOf(m);
      if (doc?.frame !== undefined && doc.kind === "frame") docs.add(doc.id);
    }
    for (const id of docs) this.post(id, message);
  }

  /** A message to a window's core root only (the core's own pages). */
  rootMessage(windowId: number, message: LayerMessage): void {
    for (const m of this.mounts.values()) if (m.windowId === windowId && m.kind === "root" && m.frame !== undefined) this.post(m.id, message);
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
  mountForDocument(m: Mount): { pluginId: string; layer: string; assets: { module?: string; css: string[] }; layers: readonly string[] } {
    return { pluginId: m.plugin?.id ?? "core", layer: m.layer, assets: this.assets(m), layers: m.allowedLayers ?? this.layerLabels() };
  }
}
