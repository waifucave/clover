// What MOSS's main process hands its window (spec §3.6 "What the engine gives MOSS as plain data", §6.10): plain data,
// states and names, never a sealed card's text and never markup. The window draws it with React text nodes only. Types
// alone, shared by the main process and the window (no Node, no DOM).
import type { ActivityState, BotFace, ToolAvailability } from "@waifucave/moss-protocol";

/** The engine pieces the window stands on, each served by its own lane: until a piece is served, the window says it is
 *  waiting for it, never shows something made up. */
export type Piece = "bots" | "summaries" | "activity" | "routines" | "pictures" | "router" | "tools" | "plugins" | "account" | "devices" | "key";
export type PieceState = "ready" | "waiting" | "failed";

export type ConnectionKind = "connecting" | "starting-engine" | "connected" | "reconnecting" | "behind" | "refused" | "unavailable" | "stopped";

export interface BotRow {
  id: string;
  name: string;
  /** The traits the person pinned (shape, colour); the rest comes from the name. */
  face?: BotFace;
  /** From the activity feed; `idle` until the feed says otherwise. */
  mood: ActivityState;
  /** The tool's wire name while `working`, never its arguments. */
  tool?: string;
  last?: { text: string; from: "user" | "bot" | "note"; at: number };
  unread: boolean;
}

/** A card the router placed in MOSS's window: its ids only (its words are sealed, drawn by its own frame). */
export interface CardRow {
  id: string;
  bot?: string;
  kind: string;
  /** In the conversation of the bot it belongs to, or in the window's own strip. */
  place: "conversation" | "strip";
}

export interface MossView {
  connection: { kind: ConnectionKind; reason?: string };
  pieces: Partial<Record<Piece, PieceState>>;
  bots: BotRow[];
  cards: CardRow[];
  /** The engine's release, when connected. */
  engine?: string;
}

export interface Attachment {
  /** The file's name as shown (its last path segment), never its contents. */
  name: string;
  kind: "file" | "image";
}

export interface Message {
  id: string;
  from: "user" | "bot" | "note";
  /** Plain text: the window shows it as text, never as markup. */
  text: string;
  at: number;
  files?: Attachment[];
}

export interface ConversationPage {
  bot: string;
  messages: Message[];
  hasMore: boolean;
  /** The seq to page back from. */
  before?: number;
}

export interface RoutineRow {
  id: string;
  name: string;
  /** Its triggers in words (`Every day at 9:00`). */
  schedule: string;
  paused: boolean;
  nextRunAt?: number;
}

export interface PictureRow {
  id: string;
  /** The plugin that publishes it, shown beside the picture. */
  publisher: string;
  tool?: string;
  width: number;
  height: number;
  screen: boolean;
}

/** One frame of a live picture: inert pixels, a data URL of an image the engine checked. */
export interface PictureFrameView {
  id: string;
  seq: number;
  url: string;
}

export interface ToolRow {
  server: string;
  tool: string;
  availability: ToolAvailability;
  permission: "allow" | "ask" | "deny";
}

export interface PluginRow {
  id: string;
  name: string;
  enabled: boolean;
  tools: ToolRow[];
}

/** MOSS's own Settings (spec §6.10, R8): each section is the engine's data, or "waiting" while its piece isn't served. */
export interface SettingsView {
  account: { signedIn: boolean; name?: string; email?: string } | "waiting";
  /** The keys and sign-ins of the plugins that have any (models, voices): their state, never a key. */
  signIns: { pluginId: string; name: string; index: number; method: "api-key" | "oauth-pkce" | "custom" | "core"; state: string; account?: string }[] | "waiting";
  /** The approval level of each computer (this one first). */
  computers: { name: string; level: string }[] | "waiting";
  devices: { id: string; name: string; kind: string }[] | "waiting";
}

/** One of a plugin's declared bot-scoped settings (a voice plugin's voice for this bot), drawn generically from its schema. */
export interface BotSetting {
  pluginId: string;
  pluginName: string;
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "color" | "secret";
  title: string;
  description?: string;
  options?: { value: string; title: string }[];
  min?: number;
  max?: number;
  value?: unknown;
  set: boolean;
}

/** What the window may ask MOSS's main process: a fixed list, never a generic call (preload.ts). */
export interface MossBridge {
  view(): Promise<MossView>;
  onView(fn: (view: MossView) => void): () => void;
  /** What the window shows now: a bot's conversation, or a page with none (presence's `showing`). */
  showing(page: { bot: string } | { page: "plugins" | "settings" | "none" }): void;
  conversation(bot: string, before?: number): Promise<ConversationPage | { waiting: true }>;
  onMessage(fn: (bot: string, message: Message) => void): () => void;
  /** Sends the person's words to a bot; main takes it only right after their own key press or click. */
  send(bot: string, text: string): Promise<{ ok: true } | { ok: false; why: string }>;
  createBot(name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  markRead(bot: string): void;
  routines(bot: string): Promise<RoutineRow[] | { waiting: true }>;
  pictures(bot: string): Promise<PictureRow[] | { waiting: true }>;
  openPicture(id: string): Promise<boolean>;
  closePicture(id: string): void;
  onPictureFrame(fn: (frame: PictureFrameView) => void): () => void;
  /** A card's sealed frame for this window: its single-use `moss-sealed://` URL, or undefined. */
  cardFrame(cardId: string): Promise<string | undefined>;
  onCardHeight(fn: (cardId: string, height: number) => void): () => void;
  /** The microphone button: held down and let go (main runs the voice plugin's talk command). */
  talk(phase: "down" | "up"): void;
  plugins(): Promise<PluginRow[] | { waiting: true }>;
  setAvailability(server: string, tool: string, availability: ToolAvailability): Promise<boolean>;
  /** Adds a plugin from a link, behind the normal OK card (the router draws it here); a file is picked by main. */
  addPlugin(from: { link: string } | { file: true }): Promise<{ ok: true } | { ok: false; why: string }>;
  settings(): Promise<SettingsView>;
  botSettings(bot: string): Promise<BotSetting[] | { waiting: true }>;
  /** A person's change to a bot's plugin setting; main takes it only right after their own press. */
  setBotSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<boolean>;
  /** A computer's approval level: the engine raises a sealed card (a sensitive change), which the router places here. */
  setLevel(computer: string, level: string): Promise<boolean>;
}

/** A mood in words, said beside every face (the kit's README: "a mood is shown by motion alone"). */
export const MOOD_WORDS: Readonly<Record<ActivityState, string>> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  working: "Working",
  asking: "Needs you",
  stuck: "Stuck",
  done: "Done",
  asleep: "Asleep",
};
