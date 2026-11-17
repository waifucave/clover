// MOSS's seam to the engine (spec §3.6 "What the engine gives MOSS as plain data", §6.10): every piece the window shows,
// read over the one protocol both apps speak, and folded into the plain view the window draws (shared/view.ts).
//
// The seam is the wire. The engine pieces behind this window are other lanes' (bots as records BT, the feed and the
// picture AF, the router RT, the tool setting TS); until one is served, its methods answer "not served yet" (-32601)
// and the window says it waits for that piece, never shows something made up. The tests and the renders run against a
// fake engine (test/fake-engine/) built from the contracts' own `Fake*`, so the same code here switches to the real
// engine piece by piece as each lane merges, with no change on MOSS's side.
//
// Pure apart from the client it is given: the tests drive it under Bun.
import {
  ACTIVITY_STATES, CardPlacement, CORE_EVENT_NOTIFICATION, PICTURE_FRAME_NOTIFICATION,
  type ActivityState, type ActivityView, type BotRecordView, type BotSummary, type PictureView, type RoutineView,
} from "@waifucave/moss-protocol";
import { RpcCallError } from "./client";
import { MAIN_WINDOW_ID } from "./identity";
import type { SealedFrames } from "./sealed";
import { talkCommandOf, type TalkCommand } from "./voice";
import type {
  BotEdit, BotRecordRow, BotRow, BotSetting, CardRow, ConnectionKind, ModelRow, SettingsView, ConversationPage, Message, MossView, Piece, PieceState, PictureFrameView, PictureRow, PluginRow, RoutineRow, ToolRow,
} from "../shared/view";

export interface EngineClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** The areas whose events MOSS follows. */
export const MOSS_EVENT_AREAS = ["bots", "activity", "approvals", "surfaces", "plugins"] as const;

/** Whether an error is the engine's "not served yet" (a method with no handler). */
export function notServed(err: unknown): boolean {
  return err instanceof RpcCallError && err.code === -32601;
}

/** One bot conversation event as a message, or undefined for what the window doesn't show as a bubble. The text stays
 *  text: it is drawn as a text node, never as markup. */
export function messageOf(e: Record<string, unknown>): Message | undefined {
  const seq = typeof e.seq === "number" ? e.seq : undefined;
  const at = typeof e.ts === "number" ? e.ts : 0;
  const id = `${String(e.sessionId ?? "s")}:${seq ?? at}`;
  if (e.type === "user_message" && typeof e.text === "string") {
    const files = Array.isArray(e.files) ? (e.files as { path?: unknown }[]).flatMap((f) => typeof f.path === "string" ? [{ name: baseName(f.path), kind: "file" as const }] : []) : [];
    const images = Array.isArray(e.images) ? (e.images as { path?: unknown }[]).flatMap((f) => typeof f.path === "string" ? [{ name: baseName(f.path), kind: "image" as const }] : []) : [];
    const all = [...files, ...images];
    return { id, from: "user", text: stripTokens(e.text), at, ...(all.length > 0 ? { files: all } : {}) };
  }
  if (e.type === "assistant_message" && typeof e.text === "string" && e.text.trim() !== "") return { id, from: "bot", text: e.text, at };
  if (e.type === "agent_error" && typeof e.message === "string") return { id, from: "note", text: e.message.slice(0, 500), at };
  return undefined;
}

/** A path's last segment: an attachment card shows the file's name alone. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return (parts[parts.length - 1] ?? path).slice(0, 200);
}

/** The `[File #n]` and `[Image #n]` tokens in the person's own words: the attachment card stands in for them. */
function stripTokens(text: string): string {
  return text.replace(/\s*\[(?:File|Image) #\d+\]\s*/g, " ").trim();
}

/** A name the engine sent as text or as a table of languages: its English. */
export function textOf(t: string | { en: string }): string {
  return typeof t === "string" ? t : t.en;
}

/** A routine's triggers in a few words. */
export function scheduleOf(r: Pick<RoutineView, "triggers">): string {
  const words = r.triggers.map((t) => t.summary.trim()).filter((s) => s !== "");
  return words.length === 0 ? "No trigger" : words.join(" · ").slice(0, 200);
}

export class MossEngine {
  private client: EngineClient | undefined;
  private connection: { kind: ConnectionKind; reason?: string } = { kind: "connecting" };
  private engineRelease: string | undefined;
  private readonly pieces: Partial<Record<Piece, PieceState>> = {};
  private records = new Map<string, BotRecordView>();
  private summaries = new Map<string, BotSummary>();
  private activity = new Map<string, ActivityView>();
  /** The pending cards MOSS knows (ids, bots, kinds), and where the router put each. */
  private cards = new Map<string, { id: string; bot?: string; kind: string }>();
  private placements = new Map<string, CardPlacement>();
  private viewListeners = new Set<(v: MossView) => void>();
  private messageListeners = new Set<(bot: string, m: Message) => void>();
  private frameListeners = new Set<(f: PictureFrameView) => void>();
  /** Which bot's main session is which, for the conversation's live events. */
  private sessionBot = new Map<string, string>();
  /** The live pictures this window follows: stream → picture id. */
  private streams = new Map<string, string>();
  /** A stream's latest frame that came before `picture.open`'s answer named it (the engine sends the picture's latest frame
   *  at once, and a still picture sends no other): kept until the answer comes, a few streams at most. */
  private early = new Map<string, PictureFrameView & { stream: string }>();
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The bot session the window follows live now. */
  private attached: string | undefined;
  /** The voice plugin's talk command, from the plugins' declarations (voice.ts `talkCommandOf`). */
  private talk: TalkCommand = { why: "Talking waits for the engine's voice plugin list." };

  constructor(private readonly sealed: SealedFrames, private readonly log: (line: string) => void = () => {}) {}

  // ---------------------------------------------------------------------------------------------
  // The view
  // ---------------------------------------------------------------------------------------------

  view(): MossView {
    const bots: BotRow[] = [...this.records.values()].map((r) => {
      const s = this.summaries.get(r.id);
      const a = this.activity.get(r.id);
      const mood: ActivityState = a !== undefined && (ACTIVITY_STATES as readonly string[]).includes(a.state) ? a.state : "idle";
      return {
        id: r.id, name: textOf(r.name), ...(r.face !== undefined ? { face: r.face } : {}), mood,
        ...(mood === "working" && a?.tool !== undefined ? { tool: a.tool } : {}),
        ...(s?.last !== undefined ? { last: s.last } : {}), unread: s?.unread === true,
      };
    });
    // Newest activity first, as a list of conversations is.
    bots.sort((x, y) => (y.last?.at ?? 0) - (x.last?.at ?? 0) || x.name.localeCompare(y.name));
    const cards: CardRow[] = [];
    for (const c of this.cards.values()) {
      if (!this.sealed.isPending(c.id)) continue;
      const p = this.placements.get(c.id);
      if (p === undefined || (p.kind !== "conversation" && p.kind !== "strip") || p.program !== "moss" || p.window !== MAIN_WINDOW_ID) continue;
      cards.push({ id: c.id, ...(c.bot !== undefined ? { bot: c.bot } : {}), kind: c.kind, place: p.kind });
    }
    const talk = "command" in this.talk ? { ready: true as const } : { ready: false as const, why: this.talk.why };
    return { connection: this.connection, pieces: { ...this.pieces }, bots, cards, talk, ...(this.engineRelease !== undefined ? { engine: this.engineRelease } : {}) };
  }

  onView(fn: (v: MossView) => void): () => void {
    this.viewListeners.add(fn);
    return () => this.viewListeners.delete(fn);
  }

  onMessage(fn: (bot: string, m: Message) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onPictureFrame(fn: (f: PictureFrameView) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /** Changes are folded into one view a beat later. */
  private changed(): void {
    if (this.emitTimer !== undefined) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      const v = this.view();
      for (const l of this.viewListeners) l(v);
    }, 16);
  }

  setConnection(kind: ConnectionKind, reason?: string, engine?: string): void {
    this.connection = { kind, ...(reason !== undefined ? { reason } : {}) };
    if (engine !== undefined) this.engineRelease = engine;
    if (kind !== "connected") this.client = undefined;
    this.changed();
  }

  /** The placement of a card, for the press path's stacking rule: the router's word alone. */
  placementOf(id: string): CardPlacement | undefined {
    return this.placements.get(id);
  }

  /** A bot this window knows: presence names only those. */
  hasBot(id: string): boolean {
    return this.records.has(id);
  }

  private piece(p: Piece, s: PieceState): void {
    if (this.pieces[p] === s) return;
    this.pieces[p] = s;
    this.changed();
  }

  /** Runs one read for a piece: its answer, or undefined with the piece marked waiting (not served) or failed. */
  private async read<T>(p: Piece, method: string, params: unknown = {}): Promise<T | undefined> {
    const client = this.client;
    if (client === undefined) return undefined;
    try {
      const r = await client.request<T>(method, params, 10_000);
      this.piece(p, "ready");
      return r;
    } catch (err) {
      this.piece(p, notServed(err) ? "waiting" : "failed");
      if (!notServed(err)) this.log(`engine: ${method} failed (${err instanceof Error ? err.message.slice(0, 160) : "error"})`);
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // A connection
  // ---------------------------------------------------------------------------------------------

  /** A new connection: follow the events, then read every piece afresh (a reconnect re-reads `card.placement`, since
   *  `card_placed` is transient and a placement made while MOSS was away is in no event it will hear). */
  async attach(client: EngineClient): Promise<void> {
    this.client = client;
    this.attached = undefined;
    this.placements.clear();
    await client.request("events.subscribe", { areas: MOSS_EVENT_AREAS }, 10_000).catch((err: unknown) => this.log(`engine: events.subscribe failed (${err instanceof Error ? err.message.slice(0, 120) : "error"})`));
    await Promise.all([this.loadBots(), this.loadSummaries(), this.loadActivity(), this.loadCards(), this.loadTalk()]);
    this.changed();
  }

  /** The talk command the microphone runs now, or why there is none. */
  talkCommand(): TalkCommand {
    return this.talk;
  }

  /** Reads which plugin fills the voice point and its held command (again at each plugin change). */
  private async loadTalk(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    const [points, commands] = await Promise.all([
      client.request<{ points: { point: string; declaredBy: string; active?: { pluginId: string } }[] }>("point.active.list", {}, 10_000).catch(() => undefined),
      client.request<{ commands: { name: string; pluginId: string; hold?: true }[] }>("command.list", {}, 10_000).catch(() => undefined),
    ]);
    if (client !== this.client) return;
    const next = talkCommandOf(points?.points, commands?.commands);
    if (JSON.stringify(next) !== JSON.stringify(this.talk)) {
      this.talk = next;
      this.log("command" in next ? `voice: the talk command is ${next.command} (${next.pluginId})` : `voice: no talk command (${next.why})`);
      this.changed();
    }
  }

  private async loadBots(): Promise<void> {
    const r = await this.read<{ bots: BotRecordView[] }>("bots", "bot.records");
    if (r === undefined) return;
    this.records = new Map(r.bots.map((b) => [b.id, b]));
    this.sessionBot = new Map(r.bots.map((b) => [b.mainSession, b.id]));
  }

  private async loadSummaries(): Promise<void> {
    const r = await this.read<{ summaries: BotSummary[] }>("summaries", "bot.summaries");
    if (r !== undefined) this.summaries = new Map(r.summaries.map((s) => [s.id, s]));
  }

  private async loadActivity(): Promise<void> {
    const r = await this.read<{ activity: ActivityView[] }>("activity", "activity.list", { kind: "bots" });
    if (r === undefined) return;
    this.activity = new Map(r.activity.filter((a) => a.subject.kind === "bots").map((a) => [a.subject.id, a]));
  }

  private async loadCards(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    const listed = await client.request<{ cards?: unknown[] }>("card.list", {}, 10_000).catch(() => undefined);
    for (const c of listed?.cards ?? []) this.cardArrived(c);
    await this.loadPlacements();
  }

  private async loadPlacements(): Promise<void> {
    const r = await this.read<{ placements: { card: string; place: unknown }[] }>("router", "card.placement", {});
    if (r === undefined) return;
    for (const p of r.placements) {
      const place = CardPlacement.safeParse(p.place);
      if (place.success) this.placements.set(p.card, place.data);
    }
  }

  private cardArrived(card: unknown): void {
    this.sealed.fromCore(card);
    const c = card as { id?: unknown; bot?: unknown; kind?: unknown };
    if (typeof c?.id !== "string") return;
    this.cards.set(c.id, { id: c.id, ...(typeof c.bot === "string" ? { bot: c.bot } : {}), kind: typeof c.kind === "string" ? c.kind : "tool" });
  }

  /** The engine's notifications on MOSS's connection: core events and picture frames. */
  notification(method: string, params: unknown): void {
    if (method === PICTURE_FRAME_NOTIFICATION) return this.frame(params);
    if (method === "event") return this.sessionEvent(params);
    if (method !== CORE_EVENT_NOTIFICATION) return;
    const e = params as Record<string, unknown>;
    switch (e?.type) {
      case "bot_record_changed": {
        const b = e.bot as BotRecordView;
        if (typeof b?.id !== "string") return;
        this.records.set(b.id, b);
        this.sessionBot.set(b.mainSession, b.id);
        break;
      }
      case "bot_record_removed":
        if (typeof e.id === "string") { this.records.delete(e.id); this.summaries.delete(e.id); this.activity.delete(e.id); }
        break;
      case "bot_summary_changed": {
        const s = e.summary as BotSummary;
        if (typeof s?.id === "string") this.summaries.set(s.id, s);
        break;
      }
      case "activity_changed": {
        const a = e.activity as ActivityView;
        if (a?.subject?.kind === "bots") this.activity.set(a.subject.id, a);
        break;
      }
      case "card_requested":
        this.cardArrived(e.card);
        // A card heard before its placement: ask the router where it goes (its `card_placed` may come first or not at all).
        void this.loadPlacements().then(() => this.changed());
        break;
      case "card_resolved":
        if (typeof e.id === "string") {
          this.sealed.resolvedOutcome(e.id, (typeof e.outcome === "string" ? e.outcome : "cancelled") as "approved");
          this.cards.delete(e.id);
          this.placements.delete(e.id);
        }
        break;
      case "plugin_changed":
      case "plugin_point_changed":
        // A plugin on, off or changed may change who fills the voice point or which command holds the key.
        void this.loadTalk();
        return;
      case "card_placed": {
        const place = CardPlacement.safeParse(e.place);
        if (typeof e.card === "string" && place.success) this.placements.set(e.card, place.data);
        break;
      }
      default:
        return;
    }
    this.changed();
  }

  /** A bot's main session's own event: a new bubble in its conversation. */
  private sessionEvent(params: unknown): void {
    const e = params as Record<string, unknown>;
    const bot = typeof e?.sessionId === "string" ? this.sessionBot.get(e.sessionId) : undefined;
    if (bot === undefined) return;
    const m = messageOf(e);
    if (m === undefined) return;
    for (const l of this.messageListeners) l(bot, m);
  }

  private frame(params: unknown): void {
    const f = params as { stream?: unknown; seq?: unknown; format?: unknown; data?: unknown };
    if (typeof f?.stream !== "string" || typeof f.data !== "string" || typeof f.seq !== "number") return;
    if (f.format !== "jpeg" && f.format !== "png" && f.format !== "webp") return;
    // Inert pixels: a data URL of the declared image type, base64 only.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(f.data)) return;
    const url = `data:image/${f.format};base64,${f.data}`;
    const id = this.streams.get(f.stream);
    if (id === undefined) {
      // Before `picture.open`'s answer: the latest one kept for it (a stream nobody opened is dropped with the oldest).
      this.early.delete(f.stream);
      this.early.set(f.stream, { stream: f.stream, id: "", seq: f.seq, url });
      while (this.early.size > 4) this.early.delete(this.early.keys().next().value!);
      return;
    }
    for (const l of this.frameListeners) l({ id, seq: f.seq, url });
  }

  // ---------------------------------------------------------------------------------------------
  // What the window asks
  // ---------------------------------------------------------------------------------------------

  async conversation(bot: string, before?: number): Promise<ConversationPage | { waiting: true }> {
    const r = await this.read<{ session: string; events: Record<string, unknown>[]; hasMore: boolean }>("bots", "bot.conversation", { id: bot, limit: 100, ...(before !== undefined ? { before } : {}) });
    if (r === undefined) return { waiting: true };
    this.sessionBot.set(r.session, bot);
    const messages = r.events.flatMap((e) => { const m = messageOf(e); return m === undefined ? [] : [m]; });
    const first = r.events.find((e) => typeof e.seq === "number");
    const last = [...r.events].reverse().find((e) => typeof e.seq === "number");
    // Follow the conversation live from the last event read (MOSS's own connection; the window draws what comes).
    if (before === undefined) {
      if (this.attached !== undefined && this.attached !== r.session) void this.client?.request("session.detach", { id: this.attached }, 5_000).catch(() => undefined);
      this.attached = r.session;
      void this.client?.request("session.attach", { id: r.session, ...(last !== undefined ? { since: last.seq as number } : {}) }, 10_000).catch(() => undefined);
    }
    return { bot, messages, hasMore: r.hasMore, ...(first !== undefined ? { before: first.seq as number } : {}) };
  }

  async send(bot: string, text: string, clientMessageId: string, images: readonly { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string }[] = []): Promise<{ ok: true } | { ok: false; why: string }> {
    const client = this.client;
    if (client === undefined) return { ok: false, why: "MOSS isn't connected to its engine." };
    try {
      await client.request("user.send", { to: { bot }, text, clientMessageId, ...(images.length > 0 ? { images } : {}) }, 30_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, why: notServed(err) ? "Sending isn't served by this engine yet." : "The engine didn't take the message." };
    }
  }

  async createBot(name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
    const client = this.client;
    if (client === undefined) return { ok: false, why: "MOSS isn't connected to its engine." };
    try {
      const r = await client.request<{ bot: BotRecordView }>("bot.create", { name }, 15_000);
      this.records.set(r.bot.id, r.bot);
      this.sessionBot.set(r.bot.mainSession, r.bot.id);
      this.changed();
      return { ok: true, id: r.bot.id };
    } catch (err) {
      return { ok: false, why: notServed(err) ? "Making bots isn't served by this engine yet." : "The engine didn't make the bot." };
    }
  }

  markRead(bot: string, at: number): void {
    const s = this.summaries.get(bot);
    if (s !== undefined && s.unread) {
      this.summaries.set(bot, { ...s, unread: false });
      this.changed();
    }
    void this.client?.request("bot.markRead", { id: bot, at }, 5_000).catch(() => undefined);
  }

  async routines(bot: string): Promise<RoutineRow[] | { waiting: true }> {
    const r = await this.read<{ routines: RoutineView[] }>("routines", "routine.list", { bot });
    if (r === undefined) return { waiting: true };
    return r.routines.filter((x) => x.bot === bot).map((x) => ({
      id: x.id, name: x.name, schedule: scheduleOf(x), paused: x.state !== "active", ...(x.nextRunAt !== undefined ? { nextRunAt: x.nextRunAt } : {}),
    }));
  }

  async pictures(bot: string): Promise<PictureRow[] | { waiting: true }> {
    const r = await this.read<{ pictures: PictureView[] }>("pictures", "picture.list", { kind: "bots", bot });
    if (r === undefined) return { waiting: true };
    // The publisher's name from the plugin list, best effort (the id is always there).
    const listed = await this.client?.request<{ plugins: { id: string; name: string | { en: string } }[] }>("plugin.list", {}, 5_000).catch(() => undefined);
    const names = new Map((listed?.plugins ?? []).map((p) => [p.id, textOf(p.name)]));
    return r.pictures.map((p) => ({ id: p.id, publisher: p.publisher, ...(names.has(p.publisher) ? { publisherName: names.get(p.publisher)! } : {}), ...(p.tool !== undefined ? { tool: p.tool } : {}), width: p.width, height: p.height, screen: p.screen }));
  }

  async openPicture(id: string): Promise<boolean> {
    const r = await this.read<{ stream: string }>("pictures", "picture.open", { id, maxFps: 10 });
    if (r === undefined) return false;
    this.streams.set(r.stream, id);
    const first = this.early.get(r.stream);
    this.early.delete(r.stream);
    if (first !== undefined) for (const l of this.frameListeners) l({ id, seq: first.seq, url: first.url });
    return true;
  }

  closePicture(id: string): void {
    for (const [stream, pic] of [...this.streams]) {
      if (pic !== id) continue;
      this.streams.delete(stream);
      void this.client?.request("picture.close", { stream }, 5_000).catch(() => undefined);
    }
  }

  async plugins(): Promise<PluginRow[] | { waiting: true }> {
    const list = await this.read<{ plugins: { id: string; name: string | { en: string }; enabled: boolean; parent?: string }[] }>("plugins", "plugin.list");
    if (list === undefined) return { waiting: true };
    const perms = await this.read<{ plugins: { pluginId: string; server: string; tools: { name: string; permission: "allow" | "ask" | "deny"; availability?: ToolRow["availability"]; declared?: "preload" | "on-demand" }[] }[] }>("tools", "tool.permissions");
    const toolsOf = new Map<string, ToolRow[]>();
    for (const p of perms?.plugins ?? []) {
      const rows = p.tools.map((t) => {
        const declared = t.declared === undefined ? undefined : t.declared === "on-demand" ? "on-demand" as const : "always" as const;
        return { server: p.server, tool: t.name, permission: t.permission, availability: t.availability ?? declared ?? "always", ...(declared !== undefined ? { declared } : {}) };
      });
      toolsOf.set(p.pluginId, [...(toolsOf.get(p.pluginId) ?? []), ...rows]);
    }
    return list.plugins.filter((p) => p.parent === undefined).map((p) => ({ id: p.id, name: textOf(p.name), enabled: p.enabled, tools: toolsOf.get(p.id) ?? [] }));
  }

  async setAvailability(server: string, tool: string, availability: ToolRow["availability"]): Promise<boolean> {
    return (await this.read("tools", "tool.setAvailability", { server, tool, availability })) !== undefined;
  }

  /** Adds a plugin behind its OK card (the engine raises it; the router places it in this window, the card having no
   *  session). A link that is an `npm:` name installs from npm; any other `https://` link is wrapped as an MCP server. */
  async addPlugin(from: { link: string } | { folder: string }): Promise<{ ok: true } | { ok: false; why: string }> {
    const client = this.client;
    if (client === undefined) return { ok: false, why: "MOSS isn't connected to its engine." };
    let source: unknown;
    if ("folder" in from) source = { from: "folder", path: from.folder };
    else {
      const link = from.link.trim();
      if (link.startsWith("npm:")) source = { from: "npm", name: link.slice(4) };
      else if (/^https:\/\/\S+$/.test(link)) source = { from: "wrap", kind: "mcp-url", value: link };
      else return { ok: false, why: "That isn't a link MOSS can add a plugin from." };
    }
    try {
      await client.request("plugin.install", { source }, 60_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, why: notServed(err) ? "Adding plugins isn't served by this engine yet." : "The plugin couldn't be added." };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Settings (spec §6.10, R8): MOSS's own, built in; a section waits while its piece isn't served
  // ---------------------------------------------------------------------------------------------

  async settings(): Promise<SettingsView> {
    const [account, devices, computers, plugins] = await Promise.all([
      this.read<{ signedIn: boolean; user?: { name?: string; email?: string } }>("account", "account.status"),
      this.read<{ devices: { id: string; name: string; kind: string }[] }>("devices", "device.list"),
      this.read<{ computers: { name: string; level: string; self?: boolean }[] }>("devices", "computer.list"),
      this.read<{ plugins: { id: string; name: string | { en: string }; enabled: boolean; parent?: string }[] }>("plugins", "plugin.list"),
    ]);
    let signIns: SettingsView["signIns"] = "waiting";
    if (plugins !== undefined) {
      const rows: Exclude<SettingsView["signIns"], "waiting"> = [];
      for (const p of plugins.plugins.filter((x) => x.enabled)) {
        const r = await this.client?.request<{ auth: { index: number; method: "api-key" | "oauth-pkce" | "custom" | "core"; state: string; account?: string }[] }>("plugin.auth.list", { id: p.id }, 5_000).catch(() => undefined);
        for (const a of r?.auth ?? []) rows.push({ pluginId: p.id, name: textOf(p.name), index: a.index, method: a.method, state: a.state, ...(a.account !== undefined ? { account: a.account } : {}) });
      }
      signIns = rows;
    }
    return {
      account: account === undefined ? "waiting" : { signedIn: account.signedIn, ...(account.user?.name !== undefined ? { name: account.user.name } : {}), ...(account.user?.email !== undefined ? { email: account.user.email } : {}) },
      signIns,
      computers: computers === undefined ? "waiting" : computers.computers.map((c) => ({ name: c.name, level: String(c.level) })),
      devices: devices === undefined ? "waiting" : devices.devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
    };
  }

  /** Every plugin's bot-scoped settings for one bot (a voice plugin's voice), with this bot's values (`bot.pluginSettings`),
   *  for the window to draw from their schema. A secret is never drawn here. */
  async botSettings(bot: string): Promise<BotSetting[] | { waiting: true }> {
    type Row = Omit<BotSetting, "pluginId" | "pluginName" | "options"> & { scope?: string; options?: (string | { value: string; title: string | { en: string } })[]; title: string | { en: string }; description?: string | { en: string } };
    const r = await this.read<{ plugins: { pluginId: string; name: string | { en: string }; settings: Row[] }[] }>("bots", "bot.pluginSettings", { id: bot });
    if (r === undefined) return { waiting: true };
    const out: BotSetting[] = [];
    for (const p of r.plugins) {
      for (const s of p.settings) {
        if ((s.scope !== undefined && s.scope !== "bot") || s.type === "secret") continue;
        const { scope: _scope, options, title, description, ...rest } = s;
        out.push({
          ...rest, title: textOf(title), ...(description !== undefined ? { description: textOf(description) } : {}), pluginId: p.pluginId, pluginName: textOf(p.name),
          ...(options !== undefined ? { options: options.map((o) => typeof o === "string" ? { value: o, title: o } : { value: o.value, title: textOf(o.title) }) } : {}),
        });
      }
    }
    return out;
  }

  async setBotSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<boolean> {
    return (await this.read("plugins", "plugin.settings.set", { id: pluginId, key, value, bot, noSecret: true })) !== undefined;
  }

  async setLevel(computer: string, level: string): Promise<boolean> {
    return (await this.read("devices", "computer.setLevel", { name: computer, level })) !== undefined;
  }

  async setPermission(server: string, tool: string, permission: "allow" | "ask" | "deny"): Promise<boolean> {
    return (await this.read("tools", "tool.setPermission", { server, tool, permission })) !== undefined;
  }

  /** One `auth` entry's sign-in: the key goes to the engine's credential store and never comes back; a browser sign-in
   *  answers the page to open, which the caller (main) opens itself. */
  async signIn(pluginId: string, index: number, key?: string): Promise<{ state: string; authorizeUrl?: string } | { ok: false; why: string }> {
    const client = this.client;
    if (client === undefined) return { ok: false, why: "MOSS isn't connected to its engine." };
    try {
      return await client.request<{ state: string; authorizeUrl?: string }>("plugin.auth.signIn", { id: pluginId, index, ...(key !== undefined ? { key } : {}) }, 30_000);
    } catch (err) {
      return { ok: false, why: notServed(err) ? "Signing in isn't served by this engine yet." : "The engine didn't take the sign-in." };
    }
  }

  async signOut(pluginId: string, index: number): Promise<boolean> {
    return (await this.read("account", "plugin.auth.signOut", { id: pluginId, index, card: true })) !== undefined;
  }

  async botRecord(id: string): Promise<BotRecordRow | { waiting: true }> {
    const r = await this.read<{ bots: BotRecordView[] }>("bots", "bot.records");
    if (r === undefined) return { waiting: true };
    for (const b of r.bots) this.records.set(b.id, b);
    const b = r.bots.find((x) => x.id === id);
    if (b === undefined) return { waiting: true };
    return { id: b.id, name: textOf(b.name), ...(b.model !== undefined ? { model: b.model } : {}), ...(b.effort !== undefined ? { effort: b.effort } : {}), ...(b.face !== undefined ? { face: b.face } : {}), instructionsBytes: b.instructionsBytes };
  }

  async botInstructions(id: string): Promise<{ text: string } | { waiting: true }> {
    const r = await this.read<{ text: string }>("bots", "bot.instructions.get", { id });
    return r === undefined || typeof r.text !== "string" ? { waiting: true } : { text: r.text };
  }

  async editBot(id: string, patch: BotEdit): Promise<boolean> {
    return (await this.read("bots", "bot.edit", { id, patch })) !== undefined;
  }

  /** Archives a bot (`bot.remove`, §6.1: nothing is deleted; its conversation, memory and routines stay with it). */
  async archiveBot(id: string): Promise<boolean> {
    const ok = (await this.read("bots", "bot.remove", { id })) !== undefined;
    if (ok) { this.records.delete(id); this.changed(); }
    return ok;
  }

  /** The archived bots, to bring one back. */
  async archivedBots(): Promise<{ id: string; name: string }[] | { waiting: true }> {
    const r = await this.read<{ bots: { id: string; name: string | { en: string } }[] }>("bots", "bot.archived");
    return r === undefined ? { waiting: true } : r.bots.map((b) => ({ id: b.id, name: textOf(b.name) }));
  }

  /** Brings an archived bot back, with its conversation whole (`bot.restore`). */
  async restoreBot(id: string): Promise<boolean> {
    const ok = (await this.read("bots", "bot.restore", { id })) !== undefined;
    if (ok) await this.loadBots().then(() => this.changed());
    return ok;
  }

  async models(): Promise<ModelRow[] | { waiting: true }> {
    const r = await this.read<{ models: { id: string; name: string | { en: string }; providerName: string | { en: string }; signedIn?: boolean }[] }>("models", "models.list", {});
    if (r === undefined) return { waiting: true };
    return r.models.map((m) => ({ id: m.id, title: textOf(m.name), provider: textOf(m.providerName), ready: m.signedIn !== false }));
  }

  /** For the tests and renders' facts: the placements MOSS holds now. */
  placementsNow(): Record<string, CardPlacement> {
    return Object.fromEntries(this.placements);
  }
}
